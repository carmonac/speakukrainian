import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import {
  SEED_LOCALES,
  type CreateLocaleInput,
  type ListLocalesQuery,
  type Locale,
  type UpdateLocaleInput,
} from '@speakukrainian/shared';
import { LocalesRepository } from './locales.repository.js';
import { SEED_ACTOR, SEED_LOCALE_DEFINITIONS, isSeedDefault } from './locales.seed.js';

@Injectable()
export class LocalesService implements OnModuleInit {
  private readonly logger = new Logger(LocalesService.name);

  constructor(private readonly repository: LocalesRepository) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seed();
    } catch (error) {
      // A Firestore hiccup at boot must not put the revision into a crash loop:
      // every route works again as soon as Firestore does.
      this.logger.error(
        'Locale seeding failed; the API will serve whatever is already stored.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Writes any seed locale that is not already there and returns how many were
   * written, which is what makes idempotency assertable. An existing document is
   * never overwritten, so an admin who moved the default to `uk` does not find
   * `en` back as the default after the next deploy.
   */
  async seed(): Promise<number> {
    let written = 0;
    for (const code of SEED_LOCALES) {
      const created = await this.repository.create(
        SEED_LOCALE_DEFINITIONS[code],
        SEED_ACTOR,
        isSeedDefault(code),
      );
      if (created) {
        written += 1;
      }
    }

    if (written > 0) {
      this.logger.log(`Seeded ${written} locale(s)`);
    }
    return written;
  }

  /** `?enabled=false` is "no filter": the flag exists for the public site's read. */
  async list(query: ListLocalesQuery): Promise<Locale[]> {
    const all = await this.repository.list();
    return query.enabled === true ? all.filter((locale) => locale.enabled) : all;
  }

  async create(input: CreateLocaleInput, actorId: string): Promise<Locale> {
    const created = await this.repository.create(input, actorId);
    if (!created) {
      throw new ConflictException(`Locale "${input.code}" already exists`);
    }
    return created;
  }

  async update(code: string, input: UpdateLocaleInput, actorId: string): Promise<Locale> {
    const existing = await this.requireLocale(code);
    if (input.enabled === false && existing.isDefault) {
      throw new ConflictException(
        'The default locale cannot be disabled. Make another locale the default first.',
      );
    }

    const updated = await this.repository.update(code, input, actorId);
    if (!updated) {
      throw new NotFoundException(`Locale "${code}" not found`);
    }
    return updated;
  }

  /** Already-default is a successful no-op; the transaction still runs once. */
  async setDefault(code: string, actorId: string): Promise<Locale> {
    const existing = await this.requireLocale(code);
    if (!existing.enabled) {
      throw new ConflictException('A disabled locale cannot be made the default. Enable it first.');
    }

    const updated = await this.repository.setDefault(code, actorId);
    if (!updated) {
      throw new NotFoundException(`Locale "${code}" not found`);
    }
    return updated;
  }

  /**
   * Content authored in the removed locale stays in Firestore untouched — see
   * ADR-009; nothing reads a locale key it was not told about.
   */
  async remove(code: string): Promise<void> {
    const existing = await this.requireLocale(code);
    if (existing.isDefault) {
      throw new ConflictException(
        `Locale "${code}" is the default and cannot be deleted. Make another locale the default first.`,
      );
    }
    await this.repository.delete(code);
  }

  private async requireLocale(code: string): Promise<Locale> {
    const existing = await this.repository.findById(code);
    if (!existing) {
      throw new NotFoundException(`Locale "${code}" not found`);
    }
    return existing;
  }
}
