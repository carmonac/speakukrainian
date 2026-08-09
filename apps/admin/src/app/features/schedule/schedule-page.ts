import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import type { SlotStatus } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { BROWSER_TIME_ZONE } from '../../core/time/browser-time-zone';
import {
  NO_SLOTS_THIS_WEEK,
  SLOTS_LOAD_FAILED,
  SLOT_STATUS_LABELS,
  STARTED_EARLIER,
  TIMES_SHOWN_IN,
  WEEK_OF,
} from './schedule-messages';
import type { ScheduleWeekData } from './schedule-week.resolver';
import {
  addCivilDays,
  buildWeek,
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
 * nothing here mutates, and a writable copy would be state with no writer. The
 * screen also links to neither `/schedule/new` nor `/schedule/:id` — creating
 * and editing slots are a separate issue and those routes do not exist yet, so
 * a link to one would land the admin on Not found.
 */
@Component({
  selector: 'app-schedule-page',
  imports: [RouterLink, MatButtonModule, MatIconModule],
  templateUrl: './schedule-page.html',
  styleUrl: './schedule-page.scss',
})
export class SchedulePage {
  private readonly defaultCode = inject(LocalesStore).defaultCode;

  /**
   * Read once, at construction, and only to decide which column is highlighted
   * and where Today points. Left open over midnight both go stale until the
   * next navigation, which is acceptable on an authoring screen and cheaper
   * than a timer waking a tab all night.
   */
  private readonly today = todayIn(inject(BROWSER_TIME_ZONE), new Date());

  /** Resolved by `scheduleWeekResolver` and bound by `withComponentInputBinding()`. */
  readonly weekData = input.required<ScheduleWeekData>();

  protected readonly loadFailed = SLOTS_LOAD_FAILED;
  protected readonly noSlots = NO_SLOTS_THIS_WEEK;
  protected readonly startedEarlier = STARTED_EARLIER;
  protected readonly timesShownIn = TIMES_SHOWN_IN;

  protected readonly columns = computed(() => {
    const data = this.weekData();
    return buildWeek(data.monday, data.viewZone, data.slots, this.defaultCode(), this.today);
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
  protected readonly thisWeek: Record<string, string> = {
    from: formatCivilDate(startOfWeek(this.today)),
  };

  protected statusLabel(status: SlotStatus): string {
    return SLOT_STATUS_LABELS[status];
  }

  private weekParams(days: number): Record<string, string> {
    return { from: formatCivilDate(addCivilDays(this.weekData().monday, days)) };
  }
}
