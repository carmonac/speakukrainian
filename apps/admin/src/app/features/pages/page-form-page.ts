import {
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { ErrorStateMatcher } from '@angular/material/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { firstValueFrom } from 'rxjs';
import type {
  ContentPage,
  LocalizedText,
  PageBody,
  RichText,
  Seo,
  UpdateContentPageInput,
} from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import type { HasUnsavedChanges } from '../../core/router/unsaved-changes.guard';
import { showOnceEdited } from '../../shared/forms/show-once-edited';
import { slugValidator, slugify } from '../../shared/forms/slug';
import { LocalizedRichTextEditor } from '../../shared/rich-text/localized-rich-text-editor';
import {
  fromPlainLocalized,
  localizedRequired,
  toPlainLocalized,
} from '../../shared/rich-text/localized-plain-text';
import { sectionTitle } from '../sections/sections.model';
import {
  BODY_TYPE_UNAVAILABLE,
  PAGE_SLUG_TAKEN_FALLBACK,
  PAGE_TYPE_LABELS,
  PLAIN_SEO_HINT,
  PLAIN_TITLE_HINT,
  PUBLISH_NEEDS_SAVE,
} from './page-messages';
import { emptyBodyFor } from './page-body';
import type { PageFormData } from './page-form.resolver';
import { sortOrderValidator } from './page-validators';
import { sectionPathOfPage } from './pages.model';
import { RichTextPageBodyEditor } from './rich-text-page-body-editor';
import { PagesApi, type CreatePageBody } from './pages.api';

/** The form's raw value, which the two payload builders read. */
interface PageFormValue {
  title: RichText;
  slug: string;
  sortOrder: number | null;
  seo: { metaTitle: RichText; metaDescription: RichText; noIndex: boolean };
  body: PageBody;
}

/**
 * Authors one page, on `/pages/new` and on `/pages/:id` alike.
 *
 * It is a **shell**: it owns the title, slug, section, SEO, status and the
 * payloads, and it hands the body to a component chosen by the route's page type
 * through a single `FormControl<PageBody>`. It never imports a body schema,
 * never touches `body.content`, and knows nothing about rich text, audio,
 * images, H5P or subsection lists.
 *
 * Giving a body type an editor (#10, #13) touches three places and no others:
 * the component itself, the `@if` branch in the template that renders it, and
 * {@link bodyEditorAvailable}. What the control *starts* from is deliberately
 * not one of them — {@link emptyBodyFor} is keyed on `PageType`, so this form
 * cannot seed a page with the body of a type nobody asked for.
 */
@Component({
  selector: 'app-page-form-page',
  imports: [
    DatePipe,
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatTooltipModule,
    LocalizedRichTextEditor,
    RichTextPageBodyEditor,
  ],
  templateUrl: './page-form-page.html',
  styleUrl: './page-form-page.scss',
  providers: [{ provide: ErrorStateMatcher, useValue: showOnceEdited }],
})
export class PageFormPage implements OnInit, HasUnsavedChanges {
  private readonly api = inject(PagesApi);
  private readonly store = inject(LocalesStore);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  /** Resolved by `pageFormResolver` and bound by `withComponentInputBinding()`. */
  readonly formData = input.required<PageFormData>();

  protected readonly locales = this.store.codes;
  /**
   * Read once, at construction: the default locale does not change while a form
   * is open, and a validator that tracked it would have to be re-attached.
   */
  private readonly defaultCode = this.store.defaultCode();

  protected readonly saving = signal(false);
  protected readonly slugConflict = signal<string | null>(null);
  protected readonly plainTitleHint = PLAIN_TITLE_HINT;
  protected readonly plainSeoHint = PLAIN_SEO_HINT;
  protected readonly publishNeedsSave = PUBLISH_NEEDS_SAVE;
  protected readonly bodyTypeUnavailable = BODY_TYPE_UNAVAILABLE;

  /** Publish and Unpublish answer with the whole page, so this is rewritten. */
  protected readonly page = linkedSignal(() => this.formData().page);

  protected readonly form = this.fb.group({
    title: this.fb.nonNullable.control<RichText>({}, localizedRequired(this.defaultCode)),
    slug: this.fb.nonNullable.control('', [Validators.required, slugValidator]),
    /**
     * `null` on create means "append after the last sibling" — the API resolves
     * it. An edit always starts from a stored number, so `ngOnInit` adds
     * `required` on that route and an emptied field is an error, not a no-op.
     */
    sortOrder: this.fb.control<number | null>(null, sortOrderValidator),
    seo: this.fb.group({
      metaTitle: this.fb.nonNullable.control<RichText>({}),
      metaDescription: this.fb.nonNullable.control<RichText>({}),
      noIndex: this.fb.nonNullable.control(false),
    }),
    /**
     * One control for the whole body. The body component is its value accessor
     * *and* its validator, so `form.invalid` and `form.dirty` cover body edits
     * without the shell knowing what is in there.
     *
     * A control needs a value here and `formData()` is not readable yet, so this
     * is a placeholder: `ngOnInit` replaces it on both routes — with the stored
     * body on an edit, and with `emptyBodyFor(type)` on a create.
     */
    body: this.fb.nonNullable.control<PageBody>(emptyBodyFor('rich_text')),
  });

  /**
   * Change detection is zoneless, so anything the template reads out of a form
   * control has to reach it as a signal: a `setValue` after an `await` notifies
   * nothing on its own.
   */
  private readonly slugValue = toSignal(this.form.controls.slug.valueChanges, {
    initialValue: '',
  });

  protected readonly isEdit = computed(() => this.formData().page !== null);
  protected readonly typeLabel = computed(() => PAGE_TYPE_LABELS[this.formData().type]);
  /** #10 and #13 each delete one member of this condition. */
  protected readonly bodyEditorAvailable = computed(() => this.formData().type === 'rich_text');

  /**
   * A create with no section would post a `sectionId` the API refuses. The
   * resolver redirects rather than resolving one, so this is belt and braces —
   * but Save reaching for a field that is not there is worth refusing here
   * rather than at the API.
   */
  protected readonly canSave = computed(
    () => this.bodyEditorAvailable() && (this.isEdit() || this.formData().section !== null),
  );

  protected readonly sectionLabel = computed(() => {
    const section = this.formData().section;
    return section === null ? '' : sectionTitle(section, this.defaultCode);
  });

  /** Taken from whichever side is known — the stored page's path answers too. */
  protected readonly sectionPath = computed(() => {
    const { section, page } = this.formData();
    if (section !== null) {
      return section.path;
    }
    return page === null ? '' : sectionPathOfPage(page);
  });

  protected readonly derivedPath = computed(
    () => `${this.sectionPath()}/${this.slugValue() || '…'}`,
  );

  /**
   * Both ways out of this form lead to the same list: Cancel and a save on the
   * edit route. Leaving Cancel unfiltered would drop the section the author
   * arrived with and land them among every page in the site.
   */
  protected readonly listQueryParams = computed<Record<string, string>>(() => {
    const { section, page } = this.formData();
    const sectionId = section?.id ?? page?.sectionId ?? null;
    const params: Record<string, string> = {};
    if (sectionId !== null) {
      params['sectionId'] = sectionId;
    }
    return params;
  });

  protected readonly status = computed(() => this.page()?.status ?? 'draft');
  protected readonly publishedAt = computed(() => this.page()?.publishedAt ?? null);

  ngOnInit(): void {
    const page = this.formData().page;
    if (page === null) {
      // The type the route asked for, not the one this release can edit: a body
      // seeded as `rich_text` for a page requested as something else is the
      // wrong document, and an author who never touches the body would post it
      // without ever seeing it.
      this.form.controls.body.setValue(emptyBodyFor(this.formData().type));
      this.suggestSlugFromTitle();
    } else {
      // A stored page always carries a sort order, so an emptied field is a lost
      // edit rather than the create route's "append at the end".
      // `addValidators` does not re-run validation on its own; the `patchValue`
      // below is what applies it, so it has to stay after this line.
      this.form.controls.sortOrder.addValidators(Validators.required);
      this.form.patchValue({
        // `title` and the SEO text are stored plain and edited as HTML, so they
        // come back in through the inverse of what `submit` applies. Without
        // this a stored `Modal verbs <can>` opens truncated and the next save
        // writes the truncation back over the author's text.
        title: fromPlainLocalized(page.title),
        slug: page.slug,
        sortOrder: page.sortOrder,
        seo: {
          metaTitle: fromPlainLocalized(page.seo?.metaTitle),
          metaDescription: fromPlainLocalized(page.seo?.metaDescription),
          noIndex: page.seo?.noIndex ?? false,
        },
        body: page.body,
      });
      this.form.markAsPristine();
    }

    this.form.controls.slug.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.slugConflict.set(null));
  }

  hasUnsavedChanges(): boolean {
    return this.form.dirty;
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid || this.saving() || !this.canSave()) {
      return;
    }

    this.saving.set(true);
    const value = this.form.getRawValue();
    const { page: existing, section } = this.formData();

    try {
      const saved = await (existing === null
        ? this.createPage(value, section?.id ?? '')
        : this.updatePage(existing.id, value, existing));

      // Before the navigation, or the guard prompts on the way out of a form
      // that was just saved.
      this.form.markAsPristine();
      this.page.set(saved);
      this.notifications.success(existing === null ? 'Page created.' : 'Page saved.');

      if (existing === null) {
        // Stay on the new page's own route, so the form shows the stored path
        // and Back does not return to an empty create form.
        await this.router.navigate(['/pages', saved.id], { replaceUrl: true });
      } else {
        await this.router.navigate(['/pages'], {
          queryParams: { sectionId: saved.sectionId },
          state: { savedId: saved.id },
        });
      }
    } catch (error) {
      this.applySlugConflict(error);
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Publishing and unpublishing are the **only** way this form changes `status`,
   * and the save payloads carry no `status` at all: two controls writing one
   * field would let an author publish by pressing Save.
   *
   * Both are refused while the form is dirty. `POST /pages/:id/publish` patches
   * `status` alone, so unsaved body edits would not be written, and refreshing
   * the form from the response would either discard those edits or leave a form
   * claiming to be pristine when it is not.
   */
  protected async setPublished(published: boolean): Promise<void> {
    const current = this.page();
    if (current === null || this.form.dirty || this.saving()) {
      return;
    }

    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        published ? this.api.publish(current.id) : this.api.unpublish(current.id),
      );
      this.page.set(updated);
      this.notifications.success(published ? 'Page published.' : 'Page unpublished.');
    } catch {
      // Reported by the HTTP error interceptor.
    } finally {
      this.saving.set(false);
    }
  }

  private createPage(value: PageFormValue, sectionId: string): Promise<ContentPage> {
    const input: CreatePageBody = {
      // The create route is the only one that carries it: `updateContentPageSchema`
      // omits `sectionId`, so a page cannot be moved between sections here.
      sectionId,
      slug: value.slug,
      title: toPlainLocalized(value.title),
      body: value.body,
      seo: this.seoOf(value, null),
      // No `status`: `createContentPageSchema` defaults it to `draft`, and
      // publishing is a deliberate act on its own button.
      ...(value.sortOrder === null ? {} : { sortOrder: value.sortOrder }),
    };
    return firstValueFrom(this.api.create(input));
  }

  private updatePage(id: string, value: PageFormValue, stored: ContentPage): Promise<ContentPage> {
    const input: UpdateContentPageInput = {
      slug: value.slug,
      title: toPlainLocalized(value.title),
      body: value.body,
      seo: this.seoOf(value, stored),
      // Required on edit, so it is always a number by the time this runs.
      ...(value.sortOrder === null ? {} : { sortOrder: value.sortOrder }),
      // No `status`: `PagesRepository.update` merges the patch and re-runs
      // `nextPublishedAt`, so sending it would republish or unpublish a page
      // nobody asked to touch.
    };
    return firstValueFrom(this.api.update(id, input));
  }

  /**
   * The API **replaces `seo` whole**, it does not merge — so the stored value is
   * spread first, or a save from this form deletes an `ogImage` it never showed.
   * Any field added to `seoSchema` later that this form does not edit is carried
   * by that spread; do not replace it with an explicit field list.
   *
   * `metaTitle` and `metaDescription` are left out when nobody has typed one and
   * the stored page has none, the rule `SectionFormPage.menuLabelOf` states:
   * writing `{}` onto every page on every save would be noise. They are still
   * sent — empty — once the page has them, because that is the only way to clear
   * one.
   */
  private seoOf(value: PageFormValue, stored: ContentPage | null): Seo {
    const metaTitle = toPlainLocalized(value.seo.metaTitle);
    const metaDescription = toPlainLocalized(value.seo.metaDescription);

    return {
      ...stored?.seo,
      ...(typed(metaTitle) || stored?.seo?.metaTitle !== undefined ? { metaTitle } : {}),
      ...(typed(metaDescription) || stored?.seo?.metaDescription !== undefined
        ? { metaDescription }
        : {}),
      noIndex: value.seo.noIndex,
    };
  }

  /**
   * The only 409 the create and update routes raise is a sibling slug clash —
   * the whole error table is `PagesService.fail`. Binding it to the control is
   * what points at the field to change; the interceptor's toast carries the same
   * sentence and is not suppressed.
   *
   * It clears itself: the next value change re-runs the validators, which
   * replace the whole `errors` object, and the `valueChanges` subscription
   * clears the message alongside it.
   */
  private applySlugConflict(error: unknown): void {
    if (!(error instanceof HttpErrorResponse) || error.status !== 409) {
      return;
    }
    const body = error.error as { message?: string } | null;
    this.slugConflict.set(body?.message ?? PAGE_SLUG_TAKEN_FALLBACK);
    this.form.controls.slug.setErrors({ taken: true });
    this.form.controls.slug.markAsTouched();
  }

  /** Create only. Rewriting an existing page's slug from its title is a defect. */
  private suggestSlugFromTitle(): void {
    this.form.controls.title.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((title) => {
        const slug = this.form.controls.slug;
        // The author's own slug wins from then on: typing in the field marks it
        // dirty, and the `setValue` below never does.
        if (slug.dirty) {
          return;
        }
        const code = this.defaultCode;
        const text = code === null ? '' : (toPlainLocalized(title)[code] ?? '');
        const suggestion = slugify(text);
        slug.setValue(suggestion);
        // `slugify` folds away everything outside `[a-z0-9]`, so a title in a
        // non-Latin script — the ordinary case here — suggests nothing. That
        // leaves the field required-invalid but pristine and untouched, which
        // `showOnceEdited` reads as "not yet worth an error": Save is disabled
        // and no field says why. Touching it is what puts the author back
        // inside the policy.
        if (suggestion === '' && text !== '') {
          slug.markAsTouched();
        }
      });
  }
}

function typed(value: LocalizedText): boolean {
  return Object.values(value).some((text) => text.trim() !== '');
}
