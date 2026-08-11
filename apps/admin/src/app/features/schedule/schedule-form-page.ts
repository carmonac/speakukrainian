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
import type { RichText, ScheduleSlot } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import type { HasUnsavedChanges } from '../../core/router/unsaved-changes.guard';
import { SUPPORTED_TIME_ZONES } from '../../core/time/supported-time-zones';
import { LocalizedRichTextEditor } from '../../shared/rich-text/localized-rich-text-editor';
import { showOnceEdited } from '../../shared/forms/show-once-edited';
import {
  ALSO_IN_BROWSER_ZONE_PREFIX,
  ALSO_IN_BROWSER_ZONE_SUFFIX,
  BOOKED_READ_ONLY,
  CROSSES_MIDNIGHT,
  EDITING_ONE_OCCURRENCE,
  OVERLAP_FALLBACK,
  REPEAT_DAYS_HINT,
  REPEAT_UNTIL_HINT,
  SLOT_SAVED,
  TIMES_ARE_IN,
  WEEKDAY_LABELS,
  slotsCreatedMessage,
} from './schedule-messages';
import {
  WEEKDAY_ORDER,
  buildSlotCreate,
  buildSlotPatch,
  conflictSlotId,
  composeInterval,
  initialFormValue,
  timeZoneOptions,
  type SlotFormValue,
} from './schedule-form.model';
import type { ScheduleFormData } from './schedule-form.resolver';
import { ScheduleApi } from './schedule.api';
import {
  atLeastOneDayValidator,
  civilDateValidator,
  clockTimeValidator,
  distinctTimesValidator,
  localesOverNoteLength,
  noteLengthValidator,
  timeZoneValidator,
  untilNotBeforeValidator,
} from './schedule-validators';
import {
  civilDateIn,
  formatCivilDate,
  intervalLabel,
  sameZone,
  startOfWeek,
} from './schedule.model';

/** What one save produced, so `submit` says the same thing about both routes. */
interface SavedSlot {
  slot: ScheduleSlot;
  message: string;
}

/**
 * Authors one slot, on `/schedule/new` and on `/schedule/:id` alike — the
 * `SectionFormPage` shape. Every decision is a pure function in
 * `schedule-form.model.ts`; this component measures and dispatches.
 *
 * **The fields are on the slot's own clock, never the browser's** (ADR-014). A
 * slot stored `2026-03-06T08:00:00Z` in `Europe/Madrid`, opened from a
 * `Europe/Kyiv` browser, reads 09:00 and not 10:00, and the browser's own
 * reading is drawn beside it as a labelled second line. That is the one decision
 * on this screen that can corrupt data by doing nothing.
 */
@Component({
  selector: 'app-schedule-form-page',
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
  templateUrl: './schedule-form-page.html',
  styleUrl: './schedule-form-page.scss',
  providers: [{ provide: ErrorStateMatcher, useValue: showOnceEdited }],
})
export class ScheduleFormPage implements OnInit, HasUnsavedChanges {
  private readonly api = inject(ScheduleApi);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly supportedZones = inject(SUPPORTED_TIME_ZONES);

  /** Resolved by `scheduleFormResolver` and bound by `withComponentInputBinding()`. */
  readonly formData = input.required<ScheduleFormData>();

  protected readonly locales = inject(LocalesStore).codes;

  protected readonly saving = signal(false);
  /** The API's own sentence about an overlapping slot, bound to the time fields. */
  protected readonly overlapMessage = signal<string | null>(null);
  protected readonly conflictId = signal<string | null>(null);

  protected readonly bookedReadOnly = BOOKED_READ_ONLY;
  protected readonly crossesMidnight = CROSSES_MIDNIGHT;
  protected readonly editingOneOccurrence = EDITING_ONE_OCCURRENCE;
  protected readonly repeatDaysHint = REPEAT_DAYS_HINT;
  protected readonly repeatUntilHint = REPEAT_UNTIL_HINT;
  protected readonly timesAreIn = TIMES_ARE_IN;
  protected readonly browserZonePrefix = ALSO_IN_BROWSER_ZONE_PREFIX;
  protected readonly browserZoneSuffix = ALSO_IN_BROWSER_ZONE_SUFFIX;
  protected readonly weekdayOrder = WEEKDAY_ORDER;

  /**
   * Declared ahead of the form because the `until` validator reads it: the start
   * date is that validator's parameter, not something it digs out of whatever
   * group it happens to be in — and a form whose own initializer refers back to
   * itself has no inferable type.
   */
  private readonly dateControl = this.fb.nonNullable.control('', [
    Validators.required,
    civilDateValidator,
  ]);

  protected readonly form = this.fb.group(
    {
      date: this.dateControl,
      startTime: this.fb.nonNullable.control('', [Validators.required, clockTimeValidator]),
      endTime: this.fb.nonNullable.control('', [Validators.required, clockTimeValidator]),
      timeZone: this.fb.nonNullable.control('', [Validators.required, timeZoneValidator]),
      note: this.fb.nonNullable.control<RichText>({}, noteLengthValidator),
      repeats: this.fb.nonNullable.control(false),
      /**
       * Disabled whenever it is not on screen — when the slot does not repeat,
       * and on the edit route always. A disabled group's required controls stay
       * out of `form.invalid`, which is what keeps Save from being dead with no
       * field visible to explain it (`syncLinkGroup`'s reason).
       */
      repeat: this.fb.group({
        daysOfWeek: this.fb.nonNullable.control<number[]>([], atLeastOneDayValidator),
        until: this.fb.nonNullable.control('', [
          Validators.required,
          untilNotBeforeValidator(() => this.dateControl.value),
        ]),
      }),
    },
    { validators: distinctTimesValidator },
  );

  /**
   * Change detection is zoneless, so anything the template derives from a form
   * control has to reach it as a signal: a `setValue` after an `await` notifies
   * nothing on its own (`SectionFormPage` documents this).
   */
  private readonly dateValue = toSignal(this.form.controls.date.valueChanges, {
    initialValue: '',
  });
  private readonly startValue = toSignal(this.form.controls.startTime.valueChanges, {
    initialValue: '',
  });
  private readonly endValue = toSignal(this.form.controls.endTime.valueChanges, {
    initialValue: '',
  });
  protected readonly zoneValue = toSignal(this.form.controls.timeZone.valueChanges, {
    initialValue: '',
  });
  private readonly noteValue = toSignal(this.form.controls.note.valueChanges, {
    initialValue: {} as RichText,
  });
  protected readonly repeatsValue = toSignal(this.form.controls.repeats.valueChanges, {
    initialValue: false,
  });
  private readonly daysValue = toSignal(
    this.form.controls.repeat.controls.daysOfWeek.valueChanges,
    {
      initialValue: [] as number[],
    },
  );

  protected readonly isEdit = computed(() => this.formData().slot !== null);
  protected readonly isSeries = computed(() => this.formData().slot?.recurrenceId != null);

  /**
   * A booked slot is read-only here, and this guard is the **only** thing that
   * makes it so. `patchableSlotStatusSchema` excludes `booked`, which stops this
   * screen creating one; nothing in `ScheduleSlotsRepository.update` refuses a
   * patch to a slot that already is one. So the refusal is the admin's, not the
   * API's — and that schema is exactly the reasoning that would justify deleting
   * this guard once Phase 2 owns `bookedBy`/`bookedAt` and can reschedule a
   * booking properly.
   */
  protected readonly isBooked = computed(() => this.formData().slot?.status === 'booked');

  /**
   * Built from the zone the form opened on rather than from the live control, so
   * a spelling the runtime's list does not carry — `Europe/Kyiv`, `US/Eastern` —
   * stays in the list for as long as the form is open.
   */
  protected readonly zoneOptions = computed(() => {
    const data = this.formData();
    return timeZoneOptions(this.supportedZones, data.slot?.timeZone ?? data.viewZone);
  });

  protected readonly interval = computed(() =>
    composeInterval({
      date: this.dateValue(),
      startTime: this.startValue(),
      endTime: this.endValue(),
      timeZone: this.zoneValue(),
    }),
  );

  /** The interval on the slot's own clock — the primary line. */
  protected readonly ownIntervalLabel = computed(() => {
    const interval = this.interval();
    return interval === null
      ? null
      : intervalLabel(interval.startsAt, interval.endsAt, this.zoneValue());
  });

  /**
   * The same interval on the browser's clock, drawn only when it would say
   * something the line above does not — decided on the rendered string and not
   * on the two zone names, for `viewIntervalFor`'s reason: Chromium answers
   * `Europe/Kiev` for a machine set to `Europe/Kyiv`, so comparing names would
   * draw the identical line twice for this product's primary audience.
   */
  protected readonly browserIntervalLabel = computed(() => {
    const interval = this.interval();
    const viewZone = this.formData().viewZone;
    if (interval === null || sameZone(this.zoneValue(), viewZone)) {
      return null;
    }
    const inViewZone = intervalLabel(interval.startsAt, interval.endsAt, viewZone);
    return inViewZone === this.ownIntervalLabel() ? null : inViewZone;
  });

  protected readonly noteTooLong = computed(() => localesOverNoteLength(this.noteValue()));

  /**
   * Where "Back to the week" goes: the week holding the slot as the form
   * currently describes it, falling back to the stored one while the fields are
   * still incomplete.
   */
  protected readonly weekParams = computed<Record<string, string>>(() => {
    const anchor = this.interval()?.startsAt ?? this.formData().slot?.startsAt ?? null;
    return anchor === null ? {} : this.weekOf(anchor);
  });

  ngOnInit(): void {
    const data = this.formData();
    this.form.setValue(
      toControlValue(
        initialFormValue(
          data.slot,
          data.requestedDate,
          data.requestedTime,
          data.viewZone,
          new Date(),
        ),
      ),
    );
    this.form.markAsPristine();

    if (this.isBooked()) {
      this.form.disable();
    }
    this.syncRepeatGroup(this.form.controls.repeats.value);

    this.form.controls.repeats.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((repeats) => this.syncRepeatGroup(repeats));

    // The `until` rule depends on `date`, and Angular does not re-run a
    // control's validators when a sibling changes.
    this.form.controls.date.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.form.controls.repeat.controls.until.updateValueAndValidity());

    // Self-clearing, the way `applySlugConflict` is: the next value change
    // re-runs the validators, which replace the whole `errors` object, and this
    // drops the bound sentence alongside it.
    this.form.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.overlapMessage.set(null);
      this.conflictId.set(null);
    });
  }

  hasUnsavedChanges(): boolean {
    return this.form.dirty;
  }

  /**
   * `mat-select` compares option values with `===` by default, and ADR-014
   * stores a zone as the admin spelled it — so a slot stored `europe/madrid`
   * would open on a blank select and be re-zoned by the next save. Folding case
   * here selects the list's own spelling while the control keeps the stored one,
   * which is what keeps an untouched save out of `buildSlotPatch`'s `timeZone`
   * branch.
   */
  protected compareZones(a: string, b: string): boolean {
    return sameZone(a, b);
  }

  protected weekdayLabelFor(day: number): string {
    return WEEKDAY_LABELS[day] ?? '';
  }

  protected isDayChecked(day: number): boolean {
    return this.daysValue().includes(day);
  }

  protected toggleDay(day: number): void {
    const days = this.daysValue();
    const next = days.includes(day) ? days.filter((entry) => entry !== day) : [...days, day];
    this.form.controls.repeat.controls.daysOfWeek.setValue(next);
    // `setValue` marks nothing dirty, and without this the `canDeactivate` guard
    // would let a ticked day be navigated away from in silence.
    this.form.markAsDirty();
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid || this.saving()) {
      return;
    }

    const value = this.formValue();
    const stored = this.formData().slot;

    this.saving.set(true);
    try {
      const saved =
        stored === null ? await this.createSlot(value) : await this.updateSlot(stored, value);
      if (saved === null) {
        return;
      }

      // Before the navigation, or the guard prompts on the way out of a form
      // that was just saved.
      this.form.markAsPristine();
      this.notifications.success(saved.message);

      // The week that actually holds the slot just written, derived from it —
      // not a `?from=` carried on the form's own URL. There is nothing to keep
      // in sync, and after a save the week the admin wants is the one the slot
      // landed in. For a series that is not the anchor's week: an anchor on a
      // Friday with Mondays ticked produces no Friday at all.
      await this.router.navigate(['/schedule'], {
        queryParams: this.weekOf(saved.slot.startsAt),
        state: { savedId: saved.slot.id },
      });
    } catch (error) {
      this.applyOverlapConflict(error);
    } finally {
      this.saving.set(false);
    }
  }

  private async createSlot(value: SlotFormValue): Promise<SavedSlot | null> {
    const input = buildSlotCreate(value);
    // Unreachable behind `form.invalid`: `composeInterval` refuses exactly what
    // the date, time and zero-length validators refuse. Checked rather than
    // asserted, because a non-null assertion here would be a claim about two
    // files agreeing.
    if (input === null) {
      return null;
    }
    const slots = await firstValueFrom(this.api.create(input));
    if (slots.length === 0) {
      return null;
    }
    return { slot: slots[0], message: slotsCreatedMessage(slots.length) };
  }

  private async updateSlot(stored: ScheduleSlot, value: SlotFormValue): Promise<SavedSlot> {
    const slot = await firstValueFrom(this.api.update(stored.id, buildSlotPatch(value, stored)));
    return { slot, message: SLOT_SAVED };
  }

  /** The `?from=` of the week an instant falls in, on the clock the grid uses. */
  private weekOf(instant: string): Record<string, string> {
    return {
      from: formatCivilDate(startOfWeek(civilDateIn(instant, this.formData().viewZone))),
    };
  }

  private formValue(): SlotFormValue {
    const raw = this.form.getRawValue();
    return {
      date: raw.date,
      startTime: raw.startTime,
      endTime: raw.endTime,
      timeZone: raw.timeZone,
      note: raw.note,
      repeats: raw.repeats,
      daysOfWeek: raw.repeat.daysOfWeek,
      until: raw.repeat.until,
    };
  }

  private syncRepeatGroup(repeats: boolean): void {
    const group = this.form.controls.repeat;
    // Never on the edit route: `updateScheduleSlotSchema` omits `recurrence`, so
    // there is nothing a repeat could be saved through from there.
    const wanted = repeats && !this.isEdit() && !this.isBooked();
    if (wanted && group.disabled) {
      group.enable();
    } else if (!wanted && group.enabled) {
      group.disable();
    }
  }

  /**
   * Binds the API's overlap refusal to the time fields, with a link to the slot
   * it collided with.
   *
   * **Gated on the status before the id is extracted.** Both `overlap` and
   * `self-overlap` are 409, and three *422* messages quote a backticked token
   * that `documentIdSchema` would accept — so an ungated extraction would offer
   * a link to a slot named `until`.
   *
   * It binds **in addition to** the interceptor's toast rather than instead of
   * it: the toast says the save failed, the bound message says which field to
   * change (the pair #5 settled).
   */
  private applyOverlapConflict(error: unknown): void {
    if (!(error instanceof HttpErrorResponse) || error.status !== 409) {
      return;
    }
    const body = error.error as { message?: string } | null;
    this.overlapMessage.set(body?.message ?? OVERLAP_FALLBACK);
    this.conflictId.set(conflictSlotId(body?.message));
    // The refusal is about the interval, so it lands on the field the admin
    // would change first; marking both touched is what shows it under the
    // `showOnceEdited` policy.
    this.form.controls.startTime.setErrors({ overlap: true });
    this.form.controls.startTime.markAsTouched();
    this.form.controls.endTime.markAsTouched();
  }
}

/** The form's shape from the model's, which nests the repeat controls. */
function toControlValue(value: SlotFormValue): {
  date: string;
  startTime: string;
  endTime: string;
  timeZone: string;
  note: RichText;
  repeats: boolean;
  repeat: { daysOfWeek: number[]; until: string };
} {
  return {
    date: value.date,
    startTime: value.startTime,
    endTime: value.endTime,
    timeZone: value.timeZone,
    note: value.note,
    repeats: value.repeats,
    repeat: { daysOfWeek: value.daysOfWeek, until: value.until },
  };
}
