import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  CreateLocaleInput,
  Locale,
  LocaleCode,
  UpdateLocaleInput,
} from '@speakukrainian/shared';
import { LocalesApi } from './locales.api';

/**
 * The one place the admin learns which languages exist. Every localized form
 * takes its tabs from {@link LocalesStore.codes}, so a locale added on the
 * locales screen shows up everywhere without any consumer subscribing.
 */
@Injectable({ providedIn: 'root' })
export class LocalesStore {
  private readonly api = inject(LocalesApi);

  private readonly all = signal<readonly Locale[]>([]);
  /** In flight or settled fetch, so concurrent `load()` calls share one request. */
  private request: Promise<readonly Locale[]> | null = null;

  readonly locales = this.all.asReadonly();
  readonly enabled = computed(() => this.all().filter((locale) => locale.enabled));
  readonly codes = computed(() => this.enabled().map((locale) => locale.code));
  /**
   * `null` rather than `DEFAULT_LOCALE`: importing that constant would be a
   * value import of the shared barrel here, and the API guarantees a default
   * whenever the list is non-empty.
   */
  readonly defaultCode = computed<LocaleCode | null>(
    () => this.all().find((locale) => locale.isDefault)?.code ?? null,
  );

  /** Fetches once. Later calls reuse the same promise. */
  load(): Promise<readonly Locale[]> {
    return (this.request ??= this.fetch());
  }

  refresh(): Promise<readonly Locale[]> {
    return (this.request = this.fetch());
  }

  async create(input: CreateLocaleInput): Promise<Locale> {
    const created = await firstValueFrom(this.api.create(input));
    await this.refresh();
    return created;
  }

  async update(code: string, input: UpdateLocaleInput): Promise<Locale> {
    const updated = await firstValueFrom(this.api.update(code, input));
    await this.refresh();
    return updated;
  }

  async setDefault(code: string): Promise<Locale> {
    const updated = await firstValueFrom(this.api.setDefault(code));
    await this.refresh();
    return updated;
  }

  async remove(code: string): Promise<void> {
    await firstValueFrom(this.api.remove(code));
    await this.refresh();
  }

  /**
   * Takes the full list of codes in the wanted order and writes `sortOrder` for
   * the entries that moved. Index-based values rather than swapping the two
   * stored numbers: equal `sortOrder`s would make a swap a no-op. The PATCHes
   * are not atomic, but a partial failure still leaves a total, stable order.
   */
  async reorder(codes: readonly string[]): Promise<void> {
    const current = this.all();
    for (const [index, code] of codes.entries()) {
      if (current.find((locale) => locale.code === code)?.sortOrder !== index) {
        await firstValueFrom(this.api.update(code, { sortOrder: index }));
      }
    }
    await this.refresh();
  }

  private async fetch(): Promise<readonly Locale[]> {
    try {
      const list = await firstValueFrom(this.api.list());
      this.all.set(list);
      return list;
    } catch (error) {
      // Without this, one failed load poisons the cache and every later
      // `load()` hands back the same rejected promise.
      this.request = null;
      throw error;
    }
  }
}
