/**
 * Publish Calendar
 *
 * One question, asked constantly and previously unanswerable: what is going out, on which
 * channel, when — and what have I not scheduled? Three channels plus a podcast, every
 * schedule set by hand from inside a per-item panel that shows only that item.
 *
 * Its own route rather than a tab of the reports page: it is a different SCOPE (all items,
 * all channels, over time), and the two would otherwise fight for the same width. They are
 * round-trippable — every chip and every tray row links to `/metadata-reports?item=<id>`,
 * and the reports header links back here.
 *
 * DATA: one call, `publish-list-index`, which joins the generated items (output volume) to
 * their publish records (userData) IN THE MAIN PROCESS. Nothing here scans a directory,
 * and nothing here reads a second source: a calendar built on a renderer-side scan was the
 * thing PR 4.1 existed to prevent.
 *
 * WRITES: exactly one path, `PublishState.setPublishAtOn` → `publish-set-fields`, which is
 * the same composition and the same validators the report panel's schedule boxes use. The
 * calendar has no rules of its own; a refusal is shown verbatim, in the popover that
 * caused it, with the typed value still in the box.
 *
 * The pre-filled time is the last time SET on that channel, and it is labelled as such.
 * When there is no history the box is empty and required — a publish time that appeared by
 * itself, unremarked, is exactly the class of unexpected production path the no-fallbacks
 * rule exists to prevent.
 *
 * Two clicks on a chip, two meanings, and they are kept apart deliberately: the chip body
 * opens the schedule popover (this page's own gesture), while the ↗ button opens the
 * report. A single click that did both would make "look at this" and "change when this
 * goes out" the same gesture.
 */

import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AnalyticsChannel, ElectronService } from '../../services/electron';
import { PublishState } from '../../features/publish/publish-state';
import type { PublishFacts, ReportIndexEntry } from '../../features/publish/publish.types';
import {
  offsetLabel,
  offsetStringFor,
  splitPublishAt,
} from '../../features/publish/publish-schedule';
// The §2.5 state table, kept pure so it can be exercised without an Angular test bed.
import {
  ChipState,
  channelTag,
  chipStateOf,
  dateKeyOf,
  distance,
  isSchedulable,
  startOfMonth,
} from './calendar-states';

/**
 * Channel hues, assigned IN REGISTRY ORDER.
 *
 * Orange / teal / violet is the triad the design settled on: distinguishable from each
 * other and from the app's orange chrome, and safe under the common colour-vision
 * deficiencies (no red-green pair). Orange goes to the first registered channel, which on
 * this install is Owen Morgan (Telltale) — the flagship, whose brand colour it literally
 * is.
 *
 * Assigned by POSITION rather than by matching channel names, because a name match is a
 * guess: it would break the day a channel is renamed and would silently give two channels
 * the same hue. The legend at the top of the page is the key, so the encoding is always
 * readable rather than remembered.
 */
const CHANNEL_HUES = ['#ff6b35', '#2dd4bf', '#a78bfa', '#f59e0b', '#38bdf8', '#f472b6'];

/** What a day cell / agenda row renders for one scheduled item. */
export interface CalendarChip {
  itemId: string;
  /** The video's title (variant 1), else the item's own label. Never invented. */
  title: string;
  /** Local wall time of the schedule, `HH:MM`. */
  time: string;
  /** ISO instant, as stored. */
  publishAt: string;
  dateKey: string;
  /**
   * scheduled — in the future, not published yet.
   * stale     — the moment has passed and nothing recorded a publish.
   * published — status says published, or a video id exists and the time has passed.
   */
  state: ChipState;
  /** `channelId === null`: not routed. Rendered grey and dashed, not dropped. */
  unrouted: boolean;
  isPodcast: boolean;
  /** A full A/B slate is picked and the video is not out yet. */
  abPending: boolean;
  abCount: number;
  hasThumbnail: boolean;
  channelName: string;
  channelTag: string;
  hue: string;
  /** False for published rows: they offer no scheduling control at all. */
  schedulable: boolean;
  /** For a stale row: when it was due and when the intent was recorded. */
  staleNote: string | null;
  status: string;
  videoId: string | null;
}

/** A publish record with no date on it — the calendar's real work surface. */
export interface TrayItem {
  itemId: string;
  title: string;
  createdAt: string;
  channelName: string;
  channelTag: string;
  hue: string;
  unrouted: boolean;
  isPodcast: boolean;
  abCount: number;
  hasThumbnail: boolean;
  status: string;
  /** A published item with no schedule is finished, not pending — it cannot be armed. */
  schedulable: boolean;
}

interface DayCell {
  dateKey: string;
  dayOfMonth: number;
  inMonth: boolean;
  isToday: boolean;
  /** A day before today can never take a schedule (the writer requires ≥15 min ahead). */
  isPast: boolean;
  chips: CalendarChip[];
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

@Component({
  selector: 'app-publish-calendar',
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
  ],
  templateUrl: './publish-calendar.html',
  styleUrl: './publish-calendar.scss',
})
export class PublishCalendar implements OnInit, OnDestroy {
  private electron = inject(ElectronService);
  private router = inject(Router);
  /**
   * The single publishAt writer, shared with the report panel.
   *
   * Injected as the whole state object rather than reimplementing the write: the calendar
   * must not grow a second set of scheduling rules, and this is the one that already
   * exists.
   */
  readonly publish = inject(PublishState);

  readonly weekdays = WEEKDAYS;

  // ---------------------------------------------------------------- loaded state

  readonly entries = signal<ReportIndexEntry[]>([]);
  readonly channels = signal<AnalyticsChannel[]>([]);
  readonly loading = signal(false);

  /**
   * The page's one error line. Carries the main process's refusal text verbatim, and is
   * dismissed by clicking it — same contract as the reports page's banner.
   */
  readonly error = signal<string | null>(null);

  /** Report files the index could not read, named. Never a quietly shorter calendar. */
  readonly problems = signal<Array<{ file: string; message: string }>>([]);
  /** Selection records whose report is gone: nothing to render, so they are counted. */
  readonly orphanedSelections = signal<string[]>([]);

  /**
   * Now, refreshed once a minute.
   *
   * A signal rather than a `new Date()` inside the derivations, so the TODAY marker and
   * the scheduled → stale transition actually happen on a page left open, instead of
   * freezing at whatever time the page was opened.
   */
  private readonly now = signal(new Date());
  private clock: ReturnType<typeof setInterval> | null = null;

  // ---------------------------------------------------------------- view state

  readonly view = signal<'month' | 'agenda'>('month');
  /** First day of the displayed month. Month navigation moves this and nothing else. */
  readonly monthAnchor = signal(startOfMonth(new Date()));

  /** The tray item (or chip) waiting for a day to be clicked, by item id. */
  readonly armedItemId = signal<string | null>(null);

  /** The open inline confirm: which item, which day, and where the prefill came from. */
  readonly popover = signal<{ itemId: string; dateKey: string; existing: boolean } | null>(null);
  readonly timeDraft = signal('');
  /** What the prefilled time IS — shown next to the box, never left to be assumed. */
  readonly timeHint = signal('');
  readonly popoverError = signal<string | null>(null);
  readonly popoverSaving = signal(false);

  // ---------------------------------------------------------------- derivations

  /** Registry order decides the hue; the legend prints the key. */
  readonly legend = computed(() =>
    this.channels().map((channel, index) => ({
      channelId: channel.channelId,
      name: channel.name,
      tag: channelTag(channel.name),
      hue: CHANNEL_HUES[index % CHANNEL_HUES.length],
    }))
  );

  /** Every item that has a publish record and a date on it, as chips. */
  private readonly scheduledChips = computed<CalendarChip[]>(() => {
    const now = this.now();
    return this.entries()
      .filter((entry) => entry.publish !== null && entry.publish.publishAt !== null)
      .map((entry) => this.toChip(entry, entry.publish as PublishFacts, now))
      .sort((a, b) => a.publishAt.localeCompare(b.publishAt));
  });

  /** Chips by local day, which is how the grid asks for them. */
  private readonly chipsByDay = computed(() => {
    const map = new Map<string, CalendarChip[]>();
    for (const chip of this.scheduledChips()) {
      const list = map.get(chip.dateKey);
      if (list) list.push(chip);
      else map.set(chip.dateKey, [chip]);
    }
    return map;
  });

  readonly monthLabel = computed(() =>
    this.monthAnchor().toLocaleDateString([], { month: 'long', year: 'numeric' })
  );

  /** Six weeks of cells covering the anchor month, Sunday-first. */
  readonly weeks = computed<DayCell[][]>(() => {
    const anchor = this.monthAnchor();
    const byDay = this.chipsByDay();
    const todayKey = dateKeyOf(this.now());

    const first = startOfMonth(anchor);
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - first.getDay());

    const weeks: DayCell[][] = [];
    const cursor = new Date(gridStart);
    for (let week = 0; week < 6; week++) {
      const row: DayCell[] = [];
      for (let day = 0; day < 7; day++) {
        const key = dateKeyOf(cursor);
        row.push({
          dateKey: key,
          dayOfMonth: cursor.getDate(),
          inMonth: cursor.getMonth() === anchor.getMonth(),
          isToday: key === todayKey,
          isPast: key < todayKey,
          chips: byDay.get(key) ?? [],
        });
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(row);
    }
    return weeks;
  });

  /** How many scheduled items fall inside the displayed month. Drives the empty state. */
  readonly chipsThisMonth = computed(() =>
    this.weeks().reduce(
      (total, week) => total + week.reduce((n, cell) => n + (cell.inMonth ? cell.chips.length : 0), 0),
      0
    )
  );

  /**
   * The agenda: every scheduled item in chronological order, whatever month it is in.
   *
   * Deliberately NOT month-scoped. The agenda's job is "the next ten things", and clipping
   * it to the grid's month would answer a different question badly — so the month arrows
   * are hidden while it is showing rather than left there doing nothing.
   */
  readonly agenda = computed(() => this.scheduledChips());

  /**
   * The unscheduled tray: publish records with no date.
   *
   * Records, not items. An item the operator has never opened has no record and is not a
   * draft — listing all 111 generated items here would bury the seven that are actually
   * waiting for a date.
   */
  readonly tray = computed<TrayItem[]>(() => {
    return this.entries()
      .filter((entry) => entry.publish !== null && entry.publish.publishAt === null)
      .map((entry) => {
        const facts = entry.publish as PublishFacts;
        const channel = this.channelOf(facts.channelId);
        return {
          itemId: entry.itemId,
          title: facts.mainTitle ?? entry.displayTitle,
          createdAt: entry.dateIso,
          channelName: channel.name,
          channelTag: channel.tag,
          hue: channel.hue,
          unrouted: facts.channelId === null,
          isPodcast: facts.isPodcast,
          abCount: facts.abCount,
          hasThumbnail: facts.hasThumbnail,
          status: facts.status,
          schedulable: facts.status !== 'published',
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  /** Items whose selection record could not be read. Shown, never dropped. */
  readonly faultyRecords = computed(() =>
    this.entries()
      .filter((entry) => entry.publishFault !== null)
      .map((entry) => ({ itemId: entry.itemId, message: entry.publishFault as string }))
  );

  readonly armedTitle = computed(() => {
    const id = this.armedItemId();
    if (!id) return null;
    const item = this.tray().find((t) => t.itemId === id);
    if (item) return item.title;
    const chip = this.scheduledChips().find((c) => c.itemId === id);
    return chip ? chip.title : null;
  });

  // ---------------------------------------------------------------- lifecycle

  async ngOnInit(): Promise<void> {
    this.clock = setInterval(() => this.now.set(new Date()), 60_000);
    await this.reload();
  }

  ngOnDestroy(): void {
    if (this.clock) clearInterval(this.clock);
  }

  /**
   * Read the index and the channel registry.
   *
   * Both are required. An index without the registry would render every chip as unrouted,
   * which is a lie about the data rather than a degraded view, so a failure of either is
   * reported and the page shows what it has plus the reason.
   */
  async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [indexed, registry] = await Promise.all([
        this.electron.publishListIndex(),
        this.electron.analyticsListChannels(),
      ]);

      if (!indexed.success || !indexed.data) {
        this.entries.set([]);
        this.problems.set([]);
        this.orphanedSelections.set([]);
        this.error.set(indexed.error ?? 'The report index could not be read.');
      } else {
        this.entries.set(indexed.data.entries);
        this.problems.set(indexed.data.problems);
        this.orphanedSelections.set(indexed.data.orphanedSelections);
        if (indexed.data.directoryMissing) {
          this.error.set(
            `There is no reports directory at ${indexed.data.directory}, so there is nothing to schedule yet.`
          );
        }
      }

      if (!registry.success || !registry.channels) {
        this.channels.set([]);
        this.report(registry.error ?? 'The channel registry could not be read, so no chip can name its channel.');
      } else {
        this.channels.set(registry.channels);
      }
    } finally {
      this.loading.set(false);
    }
  }

  /** Append rather than replace: two failed reads are two facts, not one. */
  private report(message: string): void {
    const existing = this.error();
    this.error.set(existing ? `${existing}\n${message}` : message);
  }

  dismissError(): void {
    this.error.set(null);
  }

  // ---------------------------------------------------------------- navigation

  setView(view: 'month' | 'agenda'): void {
    this.view.set(view);
  }

  stepMonth(delta: number): void {
    const anchor = this.monthAnchor();
    this.monthAnchor.set(new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1));
  }

  goToday(): void {
    this.monthAnchor.set(startOfMonth(new Date()));
  }

  /** The deep link the whole round trip is built on. */
  openReport(itemId: string): void {
    void this.router.navigate(['/metadata-reports'], { queryParams: { item: itemId } });
  }

  // ---------------------------------------------------------------- arming

  /**
   * Arm (or disarm) an item. While something is armed, the grid dims the days that cannot
   * take it — days in the past, which the writer's ≥15-minutes-ahead rule refuses.
   */
  toggleArm(itemId: string): void {
    this.closePopover();
    this.armedItemId.set(this.armedItemId() === itemId ? null : itemId);
  }

  /**
   * Arm a tray row, unless it is published.
   *
   * A published item exposes no scheduling affordance at all rather than a disabled one:
   * YouTube will not accept a `publishAt` on a video that has been public, so a control
   * that looked available would be a promise the app cannot keep.
   */
  armTray(item: TrayItem): void {
    if (!item.schedulable) return;
    this.toggleArm(item.itemId);
  }

  disarm(): void {
    this.armedItemId.set(null);
    this.closePopover();
  }

  /**
   * "Move…" from an agenda row: show the month that row lives in, then open its popover.
   *
   * The anchor has to move too — the popover renders inside its day cell, and a cell that
   * is not on screen is a confirm the operator cannot see.
   */
  moveFromAgenda(chip: CalendarChip, event: Event): void {
    event.stopPropagation();
    if (!chip.schedulable) return;
    const at = new Date(chip.publishAt);
    this.monthAnchor.set(startOfMonth(at));
    this.view.set('month');
    this.editChip(chip, event);
  }

  isArmed(itemId: string): boolean {
    return this.armedItemId() === itemId;
  }

  /** True when a cell is a legal drop for whatever is armed. Only past days are not. */
  cellTakesArmed(cell: DayCell): boolean {
    return this.armedItemId() !== null && !cell.isPast;
  }

  // ---------------------------------------------------------------- the popover

  /**
   * A day was clicked while something is armed: open the confirm on that cell.
   *
   * The time is prefilled from the last schedule SET on that item's channel and labelled
   * with where it came from. With no history — including an item that has no channel, and
   * so no history to have — the box is left EMPTY and the label says it is required. It is
   * never filled with "now plus an hour" or any other invention: the operator sees the
   * value that is about to be written, or there is no value.
   */
  clickDay(cell: DayCell): void {
    const itemId = this.armedItemId();
    if (!itemId) return;
    if (cell.isPast) {
      this.report(
        `${cell.dateKey} has already passed. A schedule has to be at least 15 minutes in the future.`
      );
      return;
    }

    const facts = this.factsOf(itemId);
    if (!facts) {
      this.report(`Item ${itemId} no longer has a publish record — reload the calendar.`);
      return;
    }

    const last = this.lastTimeUsedOn(facts.channelId, itemId);
    this.timeDraft.set(last ? last.time : '');
    this.timeHint.set(
      last
        ? `last used on ${last.channelName}`
        : facts.channelId === null
          ? 'no channel yet, so there is no last-used time — required'
          : `no earlier schedule on ${this.channelOf(facts.channelId).name} — required`
    );
    this.popoverError.set(null);
    this.popover.set({ itemId, dateKey: cell.dateKey, existing: facts.publishAt !== null });
  }

  /**
   * Open the same popover on an existing chip, to move or clear it.
   *
   * Published rows never get here: they render no clickable body at all (§2.5 — controls
   * absent, not disabled and lying about it).
   */
  editChip(chip: CalendarChip, event: Event): void {
    event.stopPropagation();
    if (!chip.schedulable) return;
    this.armedItemId.set(chip.itemId);
    this.timeDraft.set(chip.time);
    this.timeHint.set('current schedule');
    this.popoverError.set(null);
    this.popover.set({ itemId: chip.itemId, dateKey: chip.dateKey, existing: true });
  }

  closePopover(): void {
    this.popover.set(null);
    this.popoverError.set(null);
    this.popoverSaving.set(false);
  }

  /** The offset in effect on the day being scheduled, printed beside the box. */
  popoverOffsetLabel(): string {
    const open = this.popover();
    if (!open) return '';
    const time = /^\d{2}:\d{2}$/.test(this.timeDraft()) ? this.timeDraft() : '12:00';
    const at = new Date(`${open.dateKey}T${time}:00`);
    if (Number.isNaN(at.getTime())) return '';
    return offsetLabel(offsetStringFor(at));
  }

  /**
   * Write the schedule.
   *
   * A refusal — from the composer here or from the validators in the main process — is
   * shown IN THE POPOVER, verbatim, and the popover stays open with the typed value. The
   * operator's next attempt starts from what they wrote, not from a blank box.
   */
  async confirmSchedule(): Promise<void> {
    const open = this.popover();
    if (!open) return;

    this.popoverSaving.set(true);
    this.popoverError.set(null);
    try {
      await this.publish.setPublishAtOn(open.itemId, open.dateKey, this.timeDraft());
      this.popover.set(null);
      this.armedItemId.set(null);
      await this.reload();
    } catch (err: any) {
      this.popoverError.set(err?.message || String(err));
    } finally {
      this.popoverSaving.set(false);
    }
  }

  /** Drop a schedule. The record still records when it was dropped. */
  async clearSchedule(): Promise<void> {
    const open = this.popover();
    if (!open) return;

    this.popoverSaving.set(true);
    this.popoverError.set(null);
    try {
      await this.publish.clearPublishAtOn(open.itemId);
      this.popover.set(null);
      this.armedItemId.set(null);
      await this.reload();
    } catch (err: any) {
      this.popoverError.set(err?.message || String(err));
    } finally {
      this.popoverSaving.set(false);
    }
  }

  // ---------------------------------------------------------------- helpers

  private factsOf(itemId: string): PublishFacts | null {
    const entry = this.entries().find((e) => e.itemId === itemId);
    return entry?.publish ?? null;
  }

  /**
   * The most recently SET schedule on a channel, as a wall-clock time.
   *
   * Ordered by `publishAtSetAt` — when the operator recorded the intent — rather than by
   * the scheduled instant itself, because "the time I usually use on this channel" is a
   * fact about recent decisions, not about which upload happens to be furthest out. A
   * record with no `publishAtSetAt` is skipped: it cannot say when it was decided, and
   * guessing would put a number in the box with the wrong story attached to it.
   */
  private lastTimeUsedOn(
    channelId: string | null,
    exceptItemId: string
  ): { time: string; channelName: string } | null {
    if (channelId === null) return null;

    let best: { setAt: string; publishAt: string } | null = null;
    for (const entry of this.entries()) {
      const facts = entry.publish;
      if (!facts || entry.itemId === exceptItemId) continue;
      if (facts.channelId !== channelId) continue;
      if (!facts.publishAt || !facts.publishAtSetAt) continue;
      if (!best || facts.publishAtSetAt > best.setAt) {
        best = { setAt: facts.publishAtSetAt, publishAt: facts.publishAt };
      }
    }
    if (!best) return null;

    return {
      time: splitPublishAt(best.publishAt).time,
      channelName: this.channelOf(channelId).name,
    };
  }

  /** Name, tag and hue for a channel id — including the unrouted case, which is a state. */
  private channelOf(channelId: string | null): { name: string; tag: string; hue: string } {
    if (channelId === null) {
      return { name: 'no channel', tag: '—', hue: 'var(--ch-none)' };
    }
    const index = this.channels().findIndex((c) => c.channelId === channelId);
    if (index === -1) {
      // A stored id that is not in the registry. Named rather than coloured in as if it
      // were fine — the report panel warns about the same condition.
      return { name: `unknown channel ${channelId}`, tag: '?', hue: 'var(--ch-none)' };
    }
    const channel = this.channels()[index];
    return {
      name: channel.name,
      tag: channelTag(channel.name),
      hue: CHANNEL_HUES[index % CHANNEL_HUES.length],
    };
  }

  private toChip(entry: ReportIndexEntry, facts: PublishFacts, now: Date): CalendarChip {
    const publishAt = facts.publishAt as string;
    const at = new Date(publishAt);
    const channel = this.channelOf(facts.channelId);
    const state = chipStateOf(facts, now);
    const published = state === 'published';

    return {
      itemId: entry.itemId,
      title: facts.mainTitle ?? entry.displayTitle,
      time: splitPublishAt(publishAt).time,
      publishAt,
      dateKey: dateKeyOf(at),
      state,
      unrouted: facts.channelId === null,
      isPodcast: facts.isPodcast,
      abPending: facts.abCount === 3 && !published,
      abCount: facts.abCount,
      hasThumbnail: facts.hasThumbnail,
      channelName: channel.name,
      channelTag: channel.tag,
      hue: channel.hue,
      // Published rows are not schedulable, and the template gives them no control at
      // all rather than a disabled one that lies about what is possible.
      schedulable: isSchedulable(facts) && !published,
      staleNote:
        state === 'stale'
          ? `was due ${distance(at, now)}` +
            (facts.publishAtSetAt ? ` · set ${distance(new Date(facts.publishAtSetAt), now)}` : '')
          : null,
      status: facts.status,
      videoId: facts.videoId,
    };
  }

  /** `Mon, Aug 24` for an agenda row. */
  agendaDate(chip: CalendarChip): string {
    return new Date(chip.publishAt).toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  }
}

