import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { firstValueFrom } from 'rxjs';
import { pageTypeSchema, type ContentPage, type PageType } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { navigationState } from '../../core/router/navigation-state';
import {
  ALL_SECTIONS_OPTION,
  PAGES_LOAD_FAILED,
  PAGE_TYPE_LABELS,
  PICK_SECTION_FIRST,
  SECTION_CANNOT_HOLD_PAGES,
} from './page-messages';
import { PAGE_LIST_LIMIT, type PagesListData } from './pages-list.resolver';
import { pageTitle, sectionChoices } from './pages.model';
import { PagesApi } from './pages.api';

/**
 * Every page, filterable by section through `?sectionId=` in the URL — a real
 * route, so the filter deep-links and survives a refresh (rule 5).
 */
@Component({
  selector: 'app-pages-page',
  imports: [
    DatePipe,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatMenuModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTableModule,
    MatTooltipModule,
  ],
  templateUrl: './pages-page.html',
  styleUrl: './pages-page.scss',
})
export class PagesPage {
  private readonly api = inject(PagesApi);
  private readonly router = inject(Router);
  private readonly defaultCode = inject(LocalesStore).defaultCode;

  /** Resolved by `pagesListResolver` and bound by `withComponentInputBinding()`. */
  readonly listData = input.required<PagesListData>();

  /**
   * Seeded from the resolver and rewritten by Load more. `linkedSignal`, so a
   * filter change — which re-resolves — resets both rather than appending the
   * new section's pages under the old section's.
   */
  protected readonly items = linkedSignal(() => this.listData().result.items);
  protected readonly cursor = linkedSignal(() => this.listData().result.nextCursor);

  protected readonly loading = signal(false);
  protected readonly columns = ['title', 'type', 'status', 'path', 'updated'];
  protected readonly allSectionsOption = ALL_SECTIONS_OPTION;
  protected readonly loadFailed = PAGES_LOAD_FAILED;
  protected readonly pickSectionFirst = PICK_SECTION_FIRST;
  protected readonly sectionCannotHoldPages = SECTION_CANNOT_HOLD_PAGES;

  /**
   * Set by the form page on save, so the row the admin just touched is obvious.
   * It travels in the navigation state, never in a service, so it survives a
   * refresh of `/pages` (rule 5).
   */
  protected readonly savedId = signal<string | null>(
    navigationState<string>(this.router, 'savedId') ?? null,
  );

  protected readonly sections = computed(() =>
    sectionChoices(this.listData().sections, this.defaultCode()),
  );

  protected readonly selectedSection = computed(() => {
    const id = this.listData().sectionId;
    return id === null ? null : (this.sections().find((choice) => choice.id === id) ?? null);
  });

  /**
   * The API refuses a page under a link section with a 422, so the action is not
   * offered for one — the `canAddChild` precedent of never offering an action the
   * API would refuse.
   */
  protected readonly canAddPage = computed(() => this.selectedSection()?.canHoldPages === true);

  protected readonly addPageReason = computed(() => {
    const section = this.selectedSection();
    if (section === null) {
      return PICK_SECTION_FIRST;
    }
    return section.canHoldPages ? '' : SECTION_CANNOT_HOLD_PAGES;
  });

  /**
   * "New page" is a menu over these rather than a shortcut to one type: a body
   * type reachable only by hand-typing `?type=` in the address bar is not a type
   * an author can create.
   *
   * Every page type, straight from the schema, now that each one has an editor
   * on the form. A fourth variant added to `pageTypeSchema` is therefore offered
   * here the moment it exists — which is the right default for a menu, and is
   * caught by `PAGE_TYPE_LABELS` failing to compile without a label for it.
   */
  protected readonly authorableTypes: readonly PageType[] = pageTypeSchema.options;

  protected newPageParams(type: PageType): Record<string, string> {
    return { sectionId: this.selectedSection()?.id ?? '', type };
  }

  protected title(page: ContentPage): string {
    return pageTitle(page, this.defaultCode());
  }

  protected typeLabel(page: ContentPage): string {
    return PAGE_TYPE_LABELS[page.body.type];
  }

  /** The menu labels a type; {@link typeLabel} labels a stored page. */
  protected pageTypeLabel(type: PageType): string {
    return PAGE_TYPE_LABELS[type];
  }

  /** The filter lives in the URL, so choosing one is a navigation and re-resolves. */
  protected async filterBy(sectionId: string | null): Promise<void> {
    await this.router.navigate(['/pages'], {
      queryParams: sectionId === null ? {} : { sectionId },
    });
  }

  /** A failure leaves the list as it was; the interceptor has already toasted. */
  protected async loadMore(): Promise<void> {
    const cursor = this.cursor();
    if (cursor === null || this.loading()) {
      return;
    }

    this.loading.set(true);
    try {
      const { sectionId } = this.listData();
      const next = await firstValueFrom(
        this.api.list({
          limit: PAGE_LIST_LIMIT,
          cursor,
          ...(sectionId === null ? {} : { sectionId }),
        }),
      );
      this.items.update((current) => [...current, ...next.items]);
      this.cursor.set(next.nextCursor);
    } catch {
      // Reported by the HTTP error interceptor.
    } finally {
      this.loading.set(false);
    }
  }
}
