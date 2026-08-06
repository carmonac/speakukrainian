import { Injectable } from '@nestjs/common';
import {
  DEFAULT_LOCALE,
  type LocaleCode,
  type MenuEntry,
  type MenuQuery,
} from '@speakukrainian/shared';
import { LocalesService } from '../locales/locales.service.js';
import { SectionsService } from '../sections/sections.service.js';
import { buildMenu } from './menu.tree.js';

@Injectable()
export class MenuService {
  constructor(
    private readonly sections: SectionsService,
    private readonly locales: LocalesService,
  ) {}

  /**
   * A `?locale` the site does not have is not an error: ADR-009's fallback to
   * the default locale is the answer, and an absent one means the default.
   */
  async menu(query: MenuQuery): Promise<MenuEntry[]> {
    const defaultLocale = await this.defaultLocale();
    const sections = await this.sections.menuSections();
    return buildMenu(sections, query.locale ?? defaultLocale, defaultLocale);
  }

  /**
   * The constant is the last resort rather than the first: a collection with no
   * locale flagged default is a data problem, and the site still has to render a
   * menu instead of answering 500 to every anonymous reader.
   */
  private async defaultLocale(): Promise<LocaleCode> {
    const locales = await this.locales.list({});
    return locales.find((locale) => locale.isDefault)?.code ?? DEFAULT_LOCALE;
  }
}
