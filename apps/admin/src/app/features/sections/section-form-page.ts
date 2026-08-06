import { Component, DestroyRef, computed, inject, input, signal, type OnInit } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
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
import { MatSelectModule } from '@angular/material/select';
import { firstValueFrom } from 'rxjs';
import type {
  AssetRef,
  CreateSectionInput,
  LinkTarget,
  PublishStatus,
  RichText,
  Section,
  SectionKind,
  UpdateSectionInput,
} from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import type { HasUnsavedChanges } from '../../core/router/unsaved-changes.guard';
import { MediaPickerService } from '../../shared/media/media-picker.service';
import { LocalizedRichTextEditor } from '../../shared/rich-text/localized-rich-text-editor';
import {
  fromPlainLocalized,
  localizedRequired,
  toPlainLocalized,
} from '../../shared/rich-text/localized-plain-text';
import {
  LINK_REJECTED_FALLBACK,
  MENU_LABEL_HINT,
  PLAIN_TITLE_HINT,
  SLUG_TAKEN_FALLBACK,
} from './section-messages';
import type { SectionFormData } from './section-form.resolver';
import { sectionTitle } from './sections.model';
import { SectionsApi } from './sections.api';
import { linkHrefValidator, slugValidator, sortOrderValidator } from './section-validators';
import { slugify } from './slug';

/**
 * When a field on this form shows its error — one answer for all of them, so a
 * field added later inherits the policy instead of inventing a third variant.
 *
 * Material's default matcher waits for a blur or a submit, and this form offers
 * neither: Save is disabled while the form is invalid, so `ngSubmit` never
 * fires, and clicking a disabled button does not move focus, so an author who
 * types `1.5` or a slug with spaces and reaches for Save would be left with a
 * dead button and no reason for it. `dirty || touched` is what keeps a pristine
 * `/sections/new` from opening painted red with its hints replaced by errors.
 */
const showOnceEdited: ErrorStateMatcher = {
  isErrorState: (control) =>
    control !== null && control.invalid && (control.dirty || control.touched),
};

/** The form's raw value, which the two payload builders read. */
interface SectionFormValue {
  kind: SectionKind;
  title: RichText;
  slug: string;
  description: RichText;
  image: AssetRef | null;
  imageAlt: RichText;
  showInMenu: boolean;
  menuLabel: RichText;
  link: { type: LinkTarget['type']; href: string; openInNewTab: boolean };
  status: PublishStatus;
  sortOrder: number | null;
}

/**
 * Authors one section, on `/sections/new` and on `/sections/:id` alike. The two
 * differ only in what the resolver hands over and in whether the slug is
 * suggested from the title.
 */
@Component({
  selector: 'app-section-form-page',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    LocalizedRichTextEditor,
  ],
  templateUrl: './section-form-page.html',
  styleUrl: './section-form-page.scss',
  providers: [{ provide: ErrorStateMatcher, useValue: showOnceEdited }],
})
export class SectionFormPage implements OnInit, HasUnsavedChanges {
  private readonly api = inject(SectionsApi);
  private readonly store = inject(LocalesStore);
  private readonly mediaPicker = inject(MediaPickerService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  /** Resolved by `sectionFormResolver` and bound by `withComponentInputBinding()`. */
  readonly formData = input.required<SectionFormData>();

  protected readonly locales = this.store.codes;
  /**
   * Read once, at construction: the default locale does not change while a form
   * is open, and a validator that tracked it would have to be re-attached.
   */
  private readonly defaultCode = this.store.defaultCode();

  protected readonly saving = signal(false);
  protected readonly slugConflict = signal<string | null>(null);
  /** The API's own sentence about a link target it refused, bound to the href field. */
  protected readonly linkError = signal<string | null>(null);
  protected readonly plainTitleHint = PLAIN_TITLE_HINT;
  protected readonly menuLabelHint = MENU_LABEL_HINT;

  protected readonly form = this.fb.group({
    kind: this.fb.nonNullable.control<SectionKind>('content'),
    title: this.fb.nonNullable.control<RichText>({}, localizedRequired(this.defaultCode)),
    slug: this.fb.nonNullable.control('', [Validators.required, slugValidator]),
    description: this.fb.nonNullable.control<RichText>({}),
    image: this.fb.control<AssetRef | null>(null),
    imageAlt: this.fb.nonNullable.control<RichText>({}),
    showInMenu: this.fb.nonNullable.control(false),
    menuLabel: this.fb.nonNullable.control<RichText>({}),
    link: this.fb.group({
      type: this.fb.nonNullable.control<LinkTarget['type']>('internal'),
      href: this.fb.nonNullable.control('', [Validators.required, linkHrefValidator]),
      openInNewTab: this.fb.nonNullable.control(false),
    }),
    status: this.fb.nonNullable.control<PublishStatus>('draft'),
    /**
     * `null` on create means "append after the last sibling" — the API resolves
     * it. An edit always starts from a stored number, so `ngOnInit` adds
     * `required` on that route and an emptied field is an error, not a no-op.
     */
    sortOrder: this.fb.control<number | null>(null, sortOrderValidator),
  });

  /**
   * Change detection is zoneless, so anything the template reads out of a form
   * control has to reach it as a signal: a `setValue` after an `await` notifies
   * nothing on its own.
   *
   * These track `valueChanges`, so a future `setValue(…, { emitEvent: false })`
   * on one of those controls would leave the signal — and the template — behind.
   */
  private readonly slugValue = toSignal(this.form.controls.slug.valueChanges, {
    initialValue: '',
  });
  protected readonly image = toSignal(this.form.controls.image.valueChanges, {
    initialValue: null as AssetRef | null,
  });
  private readonly imageAltValue = toSignal(this.form.controls.imageAlt.valueChanges, {
    initialValue: {} as RichText,
  });
  protected readonly kindValue = toSignal(this.form.controls.kind.valueChanges, {
    initialValue: 'content' as SectionKind,
  });
  protected readonly showInMenuValue = toSignal(this.form.controls.showInMenu.valueChanges, {
    initialValue: false,
  });
  protected readonly linkTypeValue = toSignal(this.form.controls.link.controls.type.valueChanges, {
    initialValue: 'internal' as LinkTarget['type'],
  });

  protected readonly isEdit = computed(() => this.formData().section !== null);
  protected readonly parentTitle = computed(() => {
    const parent = this.formData().parent;
    return parent === null ? '' : sectionTitle(parent, this.defaultCode);
  });

  /** The path the section will hang off, taken from whichever side is known. */
  private readonly parentPath = computed(() => {
    const { section, parent } = this.formData();
    if (parent !== null) {
      return parent.path;
    }
    // A section's parent path is its own path minus the last segment, the same
    // trick `SectionsRepository.update` uses to rename without a second read.
    return section === null ? '' : section.path.slice(0, section.path.lastIndexOf('/'));
  });

  protected readonly derivedPath = computed(
    () => `${this.parentPath()}/${this.slugValue() || '…'}`,
  );

  /** The alt text as the public site would read it, for the preview's own `alt`. */
  protected readonly imageAltPreview = computed(() =>
    this.defaultCode === null
      ? ''
      : (toPlainLocalized(this.imageAltValue())[this.defaultCode] ?? ''),
  );

  ngOnInit(): void {
    const section = this.formData().section;
    if (section === null) {
      this.suggestSlugFromTitle();
    } else {
      // A stored section always carries a sort order, so an emptied field is a
      // lost edit rather than the create route's "append at the end".
      // `addValidators` does not re-run validation on its own; the `patchValue`
      // below is what applies it, so it has to stay after this line.
      this.form.controls.sortOrder.addValidators(Validators.required);
      this.form.patchValue({
        // `title`, `imageAlt` and `menuLabel` are stored plain and edited as
        // HTML, so they come back in through the inverse of what `submit`
        // applies.
        kind: section.kind,
        title: fromPlainLocalized(section.title),
        slug: section.slug,
        description: section.description ?? {},
        image: section.image ?? null,
        imageAlt: fromPlainLocalized(section.image?.alt),
        showInMenu: section.showInMenu,
        menuLabel: fromPlainLocalized(section.menuLabel),
        link: section.link ?? { type: 'internal', href: '', openInNewTab: false },
        status: section.status,
        sortOrder: section.sortOrder,
      });
      this.form.markAsPristine();
    }

    this.syncLinkGroup(this.form.controls.kind.value);

    this.form.controls.kind.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((kind) => {
        this.syncLinkGroup(kind);
        if (kind === 'link') {
          // The revealed href is empty and required, and clicking a disabled
          // Save does not blur it — the same trap `suggestSlugFromTitle`
          // documents, answered by the one `showOnceEdited` policy rather than
          // a second matcher.
          this.form.controls.link.controls.href.markAsTouched();
        }
      });

    // The href rule depends on `type`, and Angular does not re-run a control's
    // validators when a sibling changes.
    this.form.controls.link.controls.type.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.form.controls.link.controls.href.updateValueAndValidity());

    this.form.controls.link.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.linkError.set(null));

    this.form.controls.slug.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.slugConflict.set(null));
  }

  /**
   * Disabling the group is what keeps its empty, required `href` out of
   * `form.invalid` on a content section — without it Save would be dead on
   * every content section with no field on screen to explain why.
   */
  private syncLinkGroup(kind: SectionKind): void {
    const link = this.form.controls.link;
    if (kind === 'link' && link.disabled) {
      link.enable();
    } else if (kind === 'content' && link.enabled) {
      link.disable();
    }
  }

  hasUnsavedChanges(): boolean {
    return this.form.dirty;
  }

  protected async chooseImage(): Promise<void> {
    const asset = await this.mediaPicker.pickImage();
    if (asset === null) {
      // Cancelled, or a failed upload the picker has already reported.
      return;
    }

    this.form.controls.image.setValue(asset);
    this.form.controls.imageAlt.setValue(fromPlainLocalized(asset.alt));
    // `setValue` marks nothing dirty, and without this the `canDeactivate`
    // guard would let a picked image be navigated away from in silence.
    this.form.markAsDirty();
  }

  protected removeImage(): void {
    this.form.controls.image.setValue(null);
    this.form.controls.imageAlt.setValue({});
    this.form.markAsDirty();
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid || this.saving()) {
      return;
    }

    this.saving.set(true);
    const value = this.form.getRawValue();
    const image =
      value.image === null ? null : { ...value.image, alt: toPlainLocalized(value.imageAlt) };
    const existing = this.formData().section;

    try {
      const saved = await (existing === null
        ? this.createSection(value, image)
        : this.updateSection(existing.id, value, image));

      // Before the navigation, or the guard prompts on the way out of a form
      // that was just saved.
      this.form.markAsPristine();
      this.notifications.success(existing === null ? 'Section created.' : 'Section saved.');

      if (existing === null) {
        // Stay on the new section's own route, so the form shows the stored
        // path and Back does not return to an empty create form.
        await this.router.navigate(['/sections', saved.id], { replaceUrl: true });
      } else {
        await this.router.navigate(['/sections'], { state: { savedId: saved.id } });
      }
    } catch (error) {
      this.applySlugConflict(error);
      this.applyLinkRejection(error);
      // Anything else has already been toasted by the error interceptor.
    } finally {
      this.saving.set(false);
    }
  }

  private createSection(value: SectionFormValue, image: AssetRef | null): Promise<Section> {
    const input: CreateSectionInput = {
      parentId: this.formData().parent?.id ?? null,
      kind: value.kind,
      slug: value.slug,
      title: toPlainLocalized(value.title),
      description: value.description,
      showInMenu: value.showInMenu,
      menuLabel: toPlainLocalized(value.menuLabel),
      status: value.status,
      ...this.linkOf(value),
      ...(image === null ? {} : { image }),
      ...(value.sortOrder === null ? {} : { sortOrder: value.sortOrder }),
    };
    return firstValueFrom(this.api.create(input));
  }

  /**
   * Every field this form owns, which since #6 includes `kind`, `showInMenu`,
   * `menuLabel` and `link`. `link` is sent only for `kind === 'link'`: the API
   * refuses a content section that carries a target, and omitting it is exactly
   * what makes the repository drop a stored one when a link section becomes a
   * content section.
   */
  private updateSection(
    id: string,
    value: SectionFormValue,
    image: AssetRef | null,
  ): Promise<Section> {
    const input: UpdateSectionInput = {
      kind: value.kind,
      title: toPlainLocalized(value.title),
      slug: value.slug,
      description: value.description,
      // `null` clears a stored image; the schema and the repository both treat
      // it as "remove this", where an omitted key means "leave it alone".
      image,
      showInMenu: value.showInMenu,
      menuLabel: toPlainLocalized(value.menuLabel),
      status: value.status,
      ...this.linkOf(value),
      ...(value.sortOrder === null ? {} : { sortOrder: value.sortOrder }),
    };
    return firstValueFrom(this.api.update(id, input));
  }

  /**
   * Keyed on `kind`, never on whether the group holds a value: `getRawValue()`
   * answers for disabled controls too, so a content section whose author once
   * typed a target would otherwise ship a `link` and be refused with a 422 that
   * names a field they cannot see.
   */
  private linkOf(value: SectionFormValue): { link?: LinkTarget } {
    return value.kind === 'link' ? { link: value.link } : {};
  }

  /**
   * The only 409 the create and update routes raise is a sibling slug clash —
   * the whole error table is `SectionsService.fail`, and `has-children` belongs
   * to DELETE. Binding it to the control is what points at the field to change;
   * the interceptor's toast carries the same sentence.
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
    this.slugConflict.set(body?.message ?? SLUG_TAKEN_FALLBACK);
    this.form.controls.slug.setErrors({ taken: true });
    this.form.controls.slug.markAsTouched();
  }

  /**
   * Binds a refused link target to the href field. Keyed on the issue's `path`
   * rather than on the status: a missing target is a 422 raised by
   * `SectionsService.fail`, a malformed href is a 400 from `ZodValidationPipe`,
   * and both carry the same `errors` shape.
   *
   * It clears itself the way the slug conflict does — the `link` group's
   * `valueChanges` subscription drops the message, and the next validation run
   * replaces the whole `errors` object.
   */
  private applyLinkRejection(error: unknown): void {
    if (!(error instanceof HttpErrorResponse)) {
      return;
    }
    const body = error.error as { errors?: { path?: string; message?: string }[] } | null;
    const issue = body?.errors?.find(
      (entry) => entry.path === 'link' || entry.path?.startsWith('link.') === true,
    );
    if (issue === undefined) {
      return;
    }

    const href = this.form.controls.link.controls.href;
    this.linkError.set(issue.message ?? LINK_REJECTED_FALLBACK);
    href.setErrors({ rejected: true });
    href.markAsTouched();
  }

  /** Create only. Rewriting an existing section's slug from its title is a defect. */
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
