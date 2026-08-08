import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import {
  MAX_LOCALES,
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
   *
   * The default flag is claimed only when the collection holds none, so a seed
   * locale the admin deleted comes back as an ordinary locale instead of as a
   * second default. The conflict is still decided by `create()`, so two
   * instances booting at once cannot both write `en`.
   */
  async seed(): Promise<number> {
    const stored = await this.repository.list();
    const hasDefault = stored.some((locale) => locale.isDefault);

    let written = 0;
    for (const code of SEED_LOCALES) {
      if (stored.length + written >= MAX_LOCALES) {
        // Seeding obeys the same cap as `create`, or it would push the
        // collection past the window `list()` reads and hide a locale.
        this.logger.warn(
          `Skipped seeding "${code}": the site is already at ${MAX_LOCALES} locales.`,
        );
        break;
      }

      const created = await this.repository.create(
        SEED_LOCALE_DEFINITIONS[code],
        SEED_ACTOR,
        !hasDefault && isSeedDefault(code),
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

  /**
   * Every write path — this one and `seed()` — refuses past the cap, because
   * the list query truncates there: a locale beyond the window is invisible to
   * the admin, and a default beyond it is never cleared by the next default
   * switch. Documents written straight into Firestore bypass both checks, so
   * this bounds what the API produces, not what the collection can hold.
   */
  async create(input: CreateLocaleInput, actorId: string): Promise<Locale> {
    const stored = await this.repository.list();
    if (stored.length >= MAX_LOCALES) {
      throw new ConflictException(
        `The site is limited to ${MAX_LOCALES} locales. Delete one before adding another.`,
      );
    }

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
