import { Component, DestroyRef, computed, inject, input, signal, type OnInit } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { firstValueFrom } from 'rxjs';
import type {
  AssetRef,
  CreateSectionInput,
  PublishStatus,
  RichText,
  Section,
  UpdateSectionInput,
} from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import type { HasUnsavedChanges } from '../../core/router/unsaved-changes.guard';
import { MediaPickerService } from '../../shared/media/media-picker.service';
import { LocalizedRichTextEditor } from '../../shared/rich-text/localized-rich-text-editor';
import { localizedRequired, toPlainLocalized } from './localized-plain-text';
import { PLAIN_TITLE_HINT, SLUG_TAKEN_FALLBACK } from './section-messages';
import type { SectionFormData } from './section-form.resolver';
import { sectionTitle } from './sections.model';
import { SectionsApi } from './sections.api';
import { slugValidator, slugify } from './slug';

/** The form's raw value, which the two payload builders read. */
interface SectionFormValue {
  title: RichText;
  slug: string;
  description: RichText;
  image: AssetRef | null;
  imageAlt: RichText;
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
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    LocalizedRichTextEditor,
  ],
  templateUrl: './section-form-page.html',
  styleUrl: './section-form-page.scss',
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
  protected readonly plainTitleHint = PLAIN_TITLE_HINT;

  protected readonly form = this.fb.group({
    title: this.fb.nonNullable.control<RichText>({}, localizedRequired(this.defaultCode)),
    slug: this.fb.nonNullable.control('', [Validators.required, slugValidator]),
    description: this.fb.nonNullable.control<RichText>({}),
    image: this.fb.control<AssetRef | null>(null),
    imageAlt: this.fb.nonNullable.control<RichText>({}),
    status: this.fb.nonNullable.control<PublishStatus>('draft'),
    /** `null` on create means "append after the last sibling" — the API resolves it. */
    sortOrder: this.fb.control<number | null>(null),
  });

  /**
   * Change detection is zoneless, so anything the template reads out of a form
   * control has to reach it as a signal: a `setValue` after an `await` notifies
   * nothing on its own.
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
      this.form.patchValue({
        title: section.title,
        slug: section.slug,
        description: section.description ?? {},
        image: section.image ?? null,
        imageAlt: section.image?.alt ?? {},
        status: section.status,
        sortOrder: section.sortOrder,
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

  protected async chooseImage(): Promise<void> {
    const asset = await this.mediaPicker.pickImage();
    if (asset === null) {
      // Cancelled, or a failed upload the picker has already reported.
      return;
    }

    this.form.controls.image.setValue(asset);
    this.form.controls.imageAlt.setValue(asset.alt ?? {});
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
      // Anything else has already been toasted by the error interceptor.
    } finally {
      this.saving.set(false);
    }
  }

  private createSection(value: SectionFormValue, image: AssetRef | null): Promise<Section> {
    const input: CreateSectionInput = {
      parentId: this.formData().parent?.id ?? null,
      // `kind` and `showInMenu` become controls when link sections and the menu
      // settings land (#6); `CreateSectionInput` requires both today.
      kind: 'content',
      showInMenu: false,
      slug: value.slug,
      title: toPlainLocalized(value.title),
      description: value.description,
      status: value.status,
      ...(image === null ? {} : { image }),
      ...(value.sortOrder === null ? {} : { sortOrder: value.sortOrder }),
    };
    return firstValueFrom(this.api.create(input));
  }

  /**
   * Only the fields this form owns. `kind`, `showInMenu`, `menuLabel` and
   * `link` are left out on purpose: a patch that omits a field leaves it alone,
   * and sending them would let this form quietly undo #6's fields.
   */
  private updateSection(
    id: string,
    value: SectionFormValue,
    image: AssetRef | null,
  ): Promise<Section> {
    const input: UpdateSectionInput = {
      title: toPlainLocalized(value.title),
      slug: value.slug,
      description: value.description,
      // `null` clears a stored image; the schema and the repository both treat
      // it as "remove this", where an omitted key means "leave it alone".
      image,
      status: value.status,
      ...(value.sortOrder === null ? {} : { sortOrder: value.sortOrder }),
    };
    return firstValueFrom(this.api.update(id, input));
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
        slug.setValue(code === null ? '' : slugify(toPlainLocalized(title)[code] ?? ''));
      });
  }
}
