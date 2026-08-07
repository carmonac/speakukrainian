import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  ContentPage,
  CreateContentPageInput,
  ListPagesQuery,
  Page,
  PageBody,
  UpdateContentPageInput,
} from '@speakukrainian/shared';
import { RichTextSanitizer } from '../common/rich-text.sanitizer.js';
import {
  PagesRepository,
  type PageWriteFailure,
  type PageWriteResult,
} from './pages.repository.js';

@Injectable()
export class PagesService {
  constructor(
    private readonly repository: PagesRepository,
    private readonly sanitizer: RichTextSanitizer,
  ) {}

  async create(input: CreateContentPageInput, actorId: string): Promise<ContentPage> {
    return this.unwrap(
      await this.repository.create({ ...input, body: this.sanitizeBody(input.body) }, actorId),
    );
  }

  list(query: ListPagesQuery): Promise<Page<ContentPage>> {
    return this.repository.list(query);
  }

  findById(id: string): Promise<ContentPage> {
    return this.repository.findByIdOrFail(id);
  }

  async update(id: string, input: UpdateContentPageInput, actorId: string): Promise<ContentPage> {
    // A `body: undefined` key spread into the patch would clobber the stored
    // body, so the key only exists when the request carried one.
    const sanitized: UpdateContentPageInput = {
      ...input,
      ...(input.body ? { body: this.sanitizeBody(input.body) } : {}),
    };
    return this.unwrap(await this.repository.update(id, sanitized, actorId));
  }

  /**
   * Publishing and unpublishing are status-only patches through the one write
   * path `PATCH /api/pages/:id` already uses, so the `publishedAt` rule and
   * `contentPageSchema`'s "an H5P page needs its content first" refinement
   * cannot disagree between the two routes.
   */
  publish(id: string, actorId: string): Promise<ContentPage> {
    return this.update(id, { status: 'published' }, actorId);
  }

  unpublish(id: string, actorId: string): Promise<ContentPage> {
    return this.update(id, { status: 'draft' }, actorId);
  }

  async remove(id: string): Promise<void> {
    const result = await this.repository.remove(id);
    if (!result.ok) {
      this.fail(result);
    }
  }

  /**
   * ADR-003: `content`, `intro` and `explanation` are the only rich text a page
   * carries. `title` and the `seo` text fields are `localizedTextSchema` and are
   * deliberately left alone — DOMPurify parses and re-serializes, so running
   * plain text through it would store "Tom &amp; Jerry" and render the escape
   * literally. `SectionsService` makes the same call for the same field.
   *
   * The exhaustive switch is deliberate over a list of field names: a fourth
   * body variant added later fails to compile here, instead of silently storing
   * unsanitized HTML.
   */
  private sanitizeBody(body: PageBody): PageBody {
    switch (body.type) {
      case 'rich_text':
        return { ...body, content: this.sanitizer.sanitizeLocalized(body.content) };
      case 'subsection_list':
        return { ...body, intro: this.sanitizer.sanitizeLocalized(body.intro) };
      case 'h5p_exercise':
        return { ...body, explanation: this.sanitizer.sanitizeLocalized(body.explanation) };
    }
  }

  private unwrap(result: PageWriteResult): ContentPage {
    if (!result.ok) {
      this.fail(result);
    }
    return result.page;
  }

  /** The whole error table in one place, so two routes cannot disagree. */
  private fail(failure: PageWriteFailure): never {
    switch (failure.reason) {
      case 'not-found':
        throw new NotFoundException('Page not found');
      case 'section-not-found':
        throw new NotFoundException(`Section "${failure.sectionId}" not found`);
      case 'section-is-link':
        throw new UnprocessableEntityException(
          'A link section has no body of its own, so it cannot hold pages.',
        );
      case 'slug-taken':
        throw new ConflictException(
          `Another page in this section already uses the slug "${failure.slug}"`,
        );
      case 'invalid':
        // The `errors` key matches what `ZodValidationPipe` produces, so a
        // client renders both kinds of validation failure the same way.
        throw new UnprocessableEntityException({
          message: 'The page is not valid',
          errors: failure.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          })),
        });
    }
  }
}
