import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import type { SlotStatus } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import {
  NO_SLOTS_THIS_WEEK,
  SLOTS_LOAD_FAILED,
  SLOT_STATUS_LABELS,
  STARTED_EARLIER,
  TIMES_SHOWN_IN,
  WEEK_OF,
} from './schedule-messages';
import type { ScheduleWeekData } from './schedule-week.resolver';
import { DEFAULT_SLOT_START } from './schedule-form.model';
import {
  addCivilDays,
  buildWeek,
  defaultNewSlotDate,
  formatCivilDate,
  fullDateLabel,
  startOfWeek,
  todayIn,
} from './schedule.model';

/**
 * One week of bookable slots, laid out by day. The week lives in `?from=`, so it
 * deep-links, survives a refresh and moves with real links (rule 5) — nothing
 * about which week is showing is held in a field or a service, and everything
 * on screen is derived from the resolved week.
 *
 * Read-only, so there is no `linkedSignal` and no local copy of the slots:
 * nothing here mutates, and a writable copy would be state with no writer.
 * Authoring lives on `/schedule/new` and `/schedule/:id`, which this screen
 * links to — every one of those links is a real anchor carrying query params,
 * so a middle click opens a form in a new tab.
 */
@Component({
  selector: 'app-schedule-page',
  imports: [RouterLink, MatButtonModule, MatIconModule],
  templateUrl: './schedule-page.html',
  styleUrl: './schedule-page.scss',
})
export class SchedulePage {
  private readonly defaultCode = inject(LocalesStore).defaultCode;

  /** Resolved by `scheduleWeekResolver` and bound by `withComponentInputBinding()`. */
  readonly weekData = input.required<ScheduleWeekData>();

  /**
   * Which day the highlighted column and Today's link mean, on the clock the
   * grid is drawn on — read from the resolved week rather than from
   * `BROWSER_TIME_ZONE`, so the two cannot disagree. They are the same value
   * today, because the resolver reads that same token; the day a `?tz=`
   * override lands they stop being, and the failure would be "today" drawn on
   * the wrong column of a grid built for another zone.
   *
   * Recomputed per navigation, not on a clock: left open over midnight it goes
   * stale until the next one, which is acceptable on an authoring screen and
   * cheaper than a timer waking a tab all night.
   */
  private readonly today = computed(() => todayIn(this.weekData().viewZone, new Date()));

  protected readonly loadFailed = SLOTS_LOAD_FAILED;
  protected readonly noSlots = NO_SLOTS_THIS_WEEK;
  protected readonly startedEarlier = STARTED_EARLIER;
  protected readonly timesShownIn = TIMES_SHOWN_IN;

  protected readonly columns = computed(() => {
    const data = this.weekData();
    return buildWeek(data.monday, data.viewZone, data.slots, this.defaultCode(), this.today());
  });

  protected readonly weekLabel = computed(
    () => `${WEEK_OF}${fullDateLabel(this.weekData().monday)}`,
  );

  protected readonly slotCount = computed(() =>
    this.columns().reduce((total, column) => total + column.slots.length, 0),
  );

  // Prev/next/today are anchors carrying query params rather than click
  // handlers, so a middle click opens a week in a new tab.
  protected readonly previousWeek = computed(() => this.weekParams(-7));
  protected readonly nextWeek = computed(() => this.weekParams(7));
  protected readonly thisWeek = computed<Record<string, string>>(() => ({
    from: formatCivilDate(startOfWeek(this.today())),
  }));

  /**
   * What the header's New slot link opens on: today when it is in the visible
   * week, else that week's Monday, so the new slot lands in the week on screen.
   * A day column's own link carries that column's date instead.
   */
  protected readonly newSlotParams = computed<Record<string, string>>(() => ({
    date: formatCivilDate(defaultNewSlotDate(this.weekData().monday, this.today())),
    time: DEFAULT_SLOT_START,
  }));

  protected statusLabel(status: SlotStatus): string {
    return SLOT_STATUS_LABELS[status];
  }

  protected addSlotParams(date: string): Record<string, string> {
    return { date, time: DEFAULT_SLOT_START };
  }

  private weekParams(days: number): Record<string, string> {
    return { from: formatCivilDate(addCivilDays(this.weekData().monday, days)) };
  }
}
