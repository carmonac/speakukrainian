import {
  Component,
  computed,
  forwardRef,
  inject,
  input,
  linkedSignal,
  signal,
  type OnInit,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import {
  FormsModule,
  NG_VALIDATORS,
  NG_VALUE_ACCESSOR,
  type AbstractControl,
  type ControlValueAccessor,
  type ValidationErrors,
  type Validator,
} from '@angular/forms';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { concat, firstValueFrom, map, of, switchMap, catchError, type Observable } from 'rxjs';
import {
  resolveLocalized,
  subsectionListPageBodySchema,
  type LocaleCode,
  type PageBody,
  type RichText,
  type Section,
  type SectionTreeNode,
  type SubsectionListPageBody,
} from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { LocalizedRichTextEditor } from '../../shared/rich-text/localized-rich-text-editor';
import { SectionsApi } from '../sections/sections.api';
import {
  OWN_SECTION_HINT,
  PREVIEW_LOCALE_LABEL,
  SOURCE_MUST_BE_CONTENT,
  SOURCE_SECTION_MISSING,
  SUBSECTION_PREVIEW_EMPTY,
  SUBSECTION_PREVIEW_FAILED,
  SUBSECTION_PREVIEW_NO_SOURCE,
  SUBSECTION_PREVIEW_TRUNCATED,
  SUBSECTION_SOURCE_LOAD_FAILED,
} from './page-messages';
import { sourceOptions, sourceProblem, subsectionPreviewRows } from './subsection-list.model';

/** `paginationQuerySchema`'s ceiling. Paging the preview is out of scope. */
const PREVIEW_LIMIT = 100;

/** The schema's own defaults, so no default is restated in this file (rule 1). */
const EMPTY_BODY: SubsectionListPageBody = subsectionListPageBodySchema.parse({
  type: 'subsection_list',
});

/**
 * What the preview panel is showing. `idle` and `failed` are distinct from an
 * empty `ready` on purpose: an outage or a source that cannot be listed must
 * never read as "this section has nothing in it".
 */
interface PreviewState {
  status: 'idle' | 'loading' | 'ready' | 'failed';
  sections: Section[];
  nextCursor: string | null;
}

const IDLE: PreviewState = { status: 'idle', sections: [], nextCursor: null };
const LOADING: PreviewState = { status: 'loading', sections: [], nextCursor: null };
const FAILED: PreviewState = { status: 'failed', sections: [], nextCursor: null };

/**
 * The `subsection_list` half of the page form: which section's subsections to
 * list, how to lay them out, and a lead-in above them — plus a preview built
 * from the same query the public renderer will make, so the configuration is
 * verifiable before Phase 2 exists.
 *
 * Like the rich-text body editor it is a `ControlValueAccessor` **and** a
 * `Validator` over the shell's single `FormControl<PageBody>`, so the value's
 * shape, the data it needs and what makes it invalid all stay behind that one
 * control. The shell decides *whether* Save is enabled; this decides *why* its
 * own value is not.
 *
 * `…Editor` rather than `SubsectionListPageBody`: that name belongs to the
 * shared domain type this component edits.
 */
@Component({
  selector: 'app-subsection-list-page-body-editor',
  imports: [
    FormsModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatProgressBarModule,
    MatSelectModule,
    LocalizedRichTextEditor,
  ],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => SubsectionListPageBodyEditor),
      multi: true,
    },
    {
      provide: NG_VALIDATORS,
      useExisting: forwardRef(() => SubsectionListPageBodyEditor),
      multi: true,
    },
  ],
  templateUrl: './subsection-list-page-body-editor.html',
  styleUrl: './subsection-list-page-body-editor.scss',
})
export class SubsectionListPageBodyEditor implements OnInit, ControlValueAccessor, Validator {
  private readonly sections = inject(SectionsApi);
  private readonly store = inject(LocalesStore);

  /**
   * The section this page lives in, which the body's source defaults to. It is
   * not body-type knowledge on the shell's side — it is the section the shell
   * already renders in "In **Grammar points**" — and the binding lives on the
   * `@case`, so no other body editor sees it.
   */
  readonly ownSectionId = input.required<string | null>();

  protected readonly locales = this.store.codes;
  private readonly defaultCode = this.store.defaultCode;

  protected readonly ownSectionHint = OWN_SECTION_HINT;
  protected readonly previewLocaleLabel = PREVIEW_LOCALE_LABEL;
  protected readonly sourceLoadFailed = SUBSECTION_SOURCE_LOAD_FAILED;
  protected readonly previewEmpty = SUBSECTION_PREVIEW_EMPTY;
  protected readonly previewFailed = SUBSECTION_PREVIEW_FAILED;
  protected readonly previewNoSource = SUBSECTION_PREVIEW_NO_SOURCE;
  protected readonly previewTruncated = SUBSECTION_PREVIEW_TRUNCATED;

  /** `null` **is** "keep the default", which is what the schema's absent key means. */
  protected readonly sourceSectionId = signal<string | null>(null);
  protected readonly layout = signal<SubsectionListPageBody['layout']>(EMPTY_BODY.layout);
  protected readonly showImages = signal(EMPTY_BODY.showImages);
  protected readonly showDescriptions = signal(EMPTY_BODY.showDescriptions);
  protected readonly intro = signal<RichText>({});
  protected readonly disabled = signal(false);

  /** `null` means "not known yet, or the read failed", which fails the source check open. */
  private readonly tree = signal<SectionTreeNode[] | null>(null);
  protected readonly treeFailed = signal(false);

  /**
   * Derived view state with nothing shareable in it, so it is not routed:
   * ADR-005 is about state a refresh would *lose*, and a refresh re-derives this
   * from the default locale at no cost.
   */
  protected readonly previewLocale = linkedSignal<LocaleCode | null>(
    () => this.defaultCode() ?? this.locales()[0] ?? null,
  );

  /**
   * `[]` while the tree is unknown, which {@link sourceProblem} reads as "no
   * facts yet". Synthesizing a `missing` entry from an unloaded tree would
   * accuse a perfectly good stored id of being deleted.
   */
  protected readonly options = computed(() => {
    const tree = this.tree();
    return tree === null
      ? []
      : sourceOptions(tree, this.ownSectionId(), this.sourceSectionId(), this.defaultCode());
  });

  private readonly problem = computed(() => sourceProblem(this.options(), this.sourceSectionId()));

  protected readonly sourceMessage = computed(() => {
    switch (this.problem()) {
      case 'not-content':
        return SOURCE_MUST_BE_CONTENT;
      case 'missing':
        return SOURCE_SECTION_MISSING;
      default:
        return '';
    }
  });

  private readonly effectiveSource = computed(() => this.sourceSectionId() ?? this.ownSectionId());

  /**
   * The one input of the preview pipeline: an id, or `null` for "nothing to ask
   * the API about". Layout, the toggles, the intro and the preview locale are
   * not read here, so **no keystroke and no toggle can issue a request** — a
   * structural guarantee rather than a debounce.
   */
  private readonly previewSource = computed(() =>
    this.problem() === null ? this.effectiveSource() : null,
  );

  /**
   * `switchMap` and not an `effect()`: it cancels an in-flight request when the
   * source changes again, so a slow answer for section A can never land after
   * section B's.
   */
  private readonly preview = toSignal(
    toObservable(this.previewSource).pipe(
      switchMap((id) => (id === null ? of(IDLE) : this.load(id))),
    ),
    { initialValue: LOADING },
  );

  protected readonly previewStatus = computed(() => this.preview().status);
  protected readonly truncated = computed(() => this.preview().nextCursor !== null);

  protected readonly rows = computed(() => {
    const locale = this.previewLocale();
    if (locale === null) {
      return [];
    }
    // A `computed` is the memo: `descriptionExcerpt` runs a `DOMParser` per
    // locale per section, which is not something to redo on every pass.
    return subsectionPreviewRows(this.preview().sections, {
      locale,
      defaultCode: this.defaultCode(),
      showImages: this.showImages(),
      showDescriptions: this.showDescriptions(),
    });
  });

  /**
   * The one `[innerHTML]` in this component. It is rich text the API sanitizes
   * on write (`PagesService.sanitizeBody`), and Angular sanitizes it again on
   * the way into the DOM — which keeps `<audio controls src>` and drops the
   * editor's `data-asset-path`, that the preview does not need.
   */
  protected readonly introHtml = computed(() => {
    const locale = this.previewLocale();
    return locale === null
      ? ''
      : resolveLocalized(this.intro(), locale, this.defaultCode() ?? locale);
  });

  private onChange: (value: PageBody) => void = () => {};
  private onTouched: () => void = () => {};
  private onValidatorChange: () => void = () => {};

  async ngOnInit(): Promise<void> {
    try {
      this.tree.set(await firstValueFrom(this.sections.tree()));
    } catch {
      // Reported by the HTTP error interceptor. The stored source is still held
      // and still emitted, so nothing about the body is lost.
      this.treeFailed.set(true);
    } finally {
      // The source rule can now say something it could not say at first paint.
      this.onValidatorChange();
    }
  }

  /** Emits nothing: a `writeValue` that called `onChange` would dirty the form on load. */
  writeValue(value: PageBody | null): void {
    const body = value?.type === 'subsection_list' ? value : EMPTY_BODY;
    this.sourceSectionId.set(body.sourceSectionId ?? null);
    this.layout.set(body.layout);
    this.showImages.set(body.showImages);
    this.showDescriptions.set(body.showDescriptions);
    this.intro.set(body.intro ?? {});
  }

  registerOnChange(fn: (value: PageBody) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  registerOnValidatorChange(fn: () => void): void {
    this.onValidatorChange = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  /**
   * Reads the control for the schema half, exactly as the sibling does, so the
   * shell's `form.invalid` and this cannot disagree. The source half **fails
   * open while the tree is unknown**: a slow or failed tree read must not block
   * saving a page whose body is otherwise fine, and the check applies the moment
   * the facts arrive — which is what `registerOnValidatorChange` is for.
   */
  validate(control: AbstractControl): ValidationErrors | null {
    if (!subsectionListPageBodySchema.safeParse(control.value).success) {
      return { body: true };
    }
    const problem = this.problem();
    return problem === null ? null : { source: problem };
  }

  protected onSource(id: string | null): void {
    this.sourceSectionId.set(id);
    this.emit();
  }

  protected onLayout(layout: SubsectionListPageBody['layout']): void {
    this.layout.set(layout);
    this.emit();
  }

  protected onShowImages(show: boolean): void {
    this.showImages.set(show);
    this.emit();
  }

  protected onShowDescriptions(show: boolean): void {
    this.showDescriptions.set(show);
    this.emit();
  }

  protected onIntro(next: RichText): void {
    this.intro.set(next);
    this.emit();
  }

  private emit(): void {
    const source = this.sourceSectionId();
    const intro = this.intro();
    this.onChange({
      type: 'subsection_list',
      // "Keep the default" is the **absence** of the key, not a copy of the
      // section id: stored, the id would pin this page to a section it merely
      // happens to live in today. `subsectionListPageBodySchema` is a
      // `z.strictObject` whose `sourceSectionId` is `.optional()`, so absence is
      // exactly what it wants — and the spread is what makes it absent rather
      // than `undefined`.
      ...(source === null ? {} : { sourceSectionId: source }),
      layout: this.layout(),
      showImages: this.showImages(),
      showDescriptions: this.showDescriptions(),
      // Carried whenever the record has any key at all, including
      // `{ en: '<p></p>' }`: blank-but-present is what a tab the author opened
      // and left empty looks like (ADR-009), and testing for real text would
      // mean a `DOMParser` per locale per keystroke to answer a question
      // ADR-009 already answers at render time.
      ...(Object.keys(intro).length === 0 ? {} : { intro }),
    });
    this.onTouched();
  }

  private load(id: string): Observable<PreviewState> {
    return concat(
      of(LOADING),
      this.sections.list({ parentId: id, status: 'published', limit: PREVIEW_LIMIT }).pipe(
        map((page): PreviewState => ({
          status: 'ready',
          sections: page.items,
          nextCursor: page.nextCursor,
        })),
        // Swallowed so the panel can say so in its own words; the HTTP error
        // interceptor has already toasted the API's.
        catchError(() => of(FAILED)),
      ),
    );
  }
}
