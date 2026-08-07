import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  MAX_SECTION_DEPTH,
  type CreateSectionInput,
  type ListSectionsQuery,
  type MoveSectionInput,
  type Page,
  type Section,
  type SectionTreeNode,
  type UpdateSectionInput,
} from '@speakukrainian/shared';
import { RichTextSanitizer } from '../common/rich-text.sanitizer.js';
import {
  MAX_TREE_SECTIONS,
  SectionsRepository,
  type SectionListResult,
  type SectionWriteFailure,
  type SectionWriteResult,
} from './sections.repository.js';
import { buildTree } from './sections.tree.js';

@Injectable()
export class SectionsService {
  constructor(
    private readonly repository: SectionsRepository,
    private readonly sanitizer: RichTextSanitizer,
  ) {}

  /**
   * ADR-003: `description` is the only rich text a section carries. `title` and
   * `menuLabel` are plain localized text — running them through the sanitizer
   * would HTML-escape legitimate characters and turn "Tom & Jerry" into
   * "Tom &amp; Jerry" on every save.
   */
  async create(input: CreateSectionInput, actorId: string): Promise<Section> {
    const sanitized = {
      ...input,
      description: this.sanitizer.sanitizeLocalized(input.description),
    };
    return this.unwrap(await this.repository.create(sanitized, actorId));
  }

  list(query: ListSectionsQuery): Promise<Page<Section>> {
    return this.repository.list(query);
  }

  findById(id: string): Promise<Section> {
    return this.repository.findByIdOrFail(id);
  }

  /**
   * A truncated tree renders as missing content in the admin, so an overflowing
   * collection is an error rather than a partial answer.
   */
  async tree(): Promise<SectionTreeNode[]> {
    return buildTree(await this.allSections());
  }

  /**
   * Every section, ordered by `sortOrder`. The admin tree and the public menu
   * are both projections of this one read: the menu needs the sections it does
   * *not* show as well, because a promoted child's place among its new siblings
   * comes from the ordering of the hidden ancestor it was promoted out of, and
   * `sortOrder` is only comparable between siblings (ADR-011).
   */
  async allSections(): Promise<Section[]> {
    const result: SectionListResult = await this.repository.listAllForTree();
    if (!result.ok) {
      throw new UnprocessableEntityException(
        `The section tree is limited to ${MAX_TREE_SECTIONS} sections and the collection holds more.`,
      );
    }
    return result.sections;
  }

  async update(id: string, input: UpdateSectionInput, actorId: string): Promise<Section> {
    const sanitized = {
      ...input,
      description: this.sanitizer.sanitizeLocalized(input.description),
    };
    return this.unwrap(await this.repository.update(id, sanitized, actorId));
  }

  async move(id: string, input: MoveSectionInput, actorId: string): Promise<Section> {
    return this.unwrap(await this.repository.move(id, input, actorId));
  }

  async remove(id: string): Promise<void> {
    const result = await this.repository.remove(id);
    if (!result.ok) {
      this.fail(result);
    }
  }

  private unwrap(result: SectionWriteResult): Section {
    if (!result.ok) {
      this.fail(result);
    }
    return result.section;
  }

  /** The whole error table in one place, so two routes cannot disagree. */
  private fail(failure: SectionWriteFailure): never {
    switch (failure.reason) {
      case 'not-found':
        throw new NotFoundException('Section not found');
      case 'parent-not-found':
        throw new NotFoundException(`Parent section "${failure.parentId}" not found`);
      case 'slug-taken':
        throw new ConflictException(
          `Another section under the same parent already uses the slug "${failure.slug}"`,
        );
      case 'has-children':
        throw new ConflictException(
          'This section still has subsections. Delete or move them first.',
        );
      case 'has-pages':
        throw new ConflictException('This section still holds pages. Delete or move them first.');
      case 'depth-exceeded':
        throw new UnprocessableEntityException(
          `Sections nest at most ${MAX_SECTION_DEPTH + 1} levels deep; this would reach depth ${failure.depth}.`,
        );
      case 'move-into-descendant':
        throw new UnprocessableEntityException(
          'A section cannot be moved into itself or one of its own subsections.',
        );
      case 'subtree-too-large':
        throw new UnprocessableEntityException(
          `This subtree has more than ${failure.limit} subsections and cannot be rewritten in one transaction.`,
        );
      case 'move-too-large':
        throw new UnprocessableEntityException(
          `Moving this section would rewrite more than ${failure.limit} documents in one transaction.`,
        );
      case 'pages-too-large':
        throw new UnprocessableEntityException(
          `Renaming or moving this section would rewrite its subtree and the pages under it in more than ${failure.limit} writes, which one transaction cannot commit.`,
        );
      case 'invalid':
        // The `errors` key matches what `ZodValidationPipe` produces, so a
        // client renders both kinds of validation failure the same way.
        throw new UnprocessableEntityException({
          message: 'The section is not valid',
          errors: failure.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          })),
        });
    }
  }
}
