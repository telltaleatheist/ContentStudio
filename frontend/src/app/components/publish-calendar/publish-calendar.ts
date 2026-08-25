/**
 * Publish Calendar — the scheduling board.
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
 * SHAPE: a rolling list of days starting at TODAY, each with the three slots this install
 * actually publishes into (1 PM / 2 PM / 4 PM). No month grid — a month grid answers "what
 * does September look like", which is not a question anyone asks here; the work is always
 * "the next few weeks", and it always starts now. Days are appended, never navigated back
 * to: a schedule in the past cannot be written, so a control for reaching one would be a
 * promise the writer refuses.
 *
 * GESTURE: drag. A tray row onto a slot schedules it; a scheduled chip onto another slot
 * moves it; a scheduled chip back onto the tray clears it. There is exactly one gesture and
 * it is the same one in all three directions, so nothing has to be armed first.
 *
 * DATA: one call, `publish-list-index`, which joins the generated items (output volume) to
 * their publish records (userData) IN THE MAIN PROCESS. Nothing here scans a directory,
 * and nothing here reads a second source: a calendar built on a renderer-side scan was the
 * thing PR 4.1 existed to prevent.
 *
 * WRITES: exactly one path, `PublishState.setPublishAtOn` / `clearPublishAtOn`, which is
 * the same composition and the same validators the report panel's schedule boxes use. The
 * calendar has no rules of its own; a refusal is shown verbatim in the page's banner.
 *
 * NOTHING SCHEDULED IS EVER HIDDEN. Three places exist purely so the rolling window cannot
 * quietly shorten the truth: the "before today" strip, each day's "other times" area for a
 * chip that does not sit on one of the three slots, and the beyond-the-horizon count under
 * the Load-more button. A calendar that silently omits a row is indistinguishable from one
 * with nothing to show.
 */

import { Component, ElementRef, OnDestroy, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AnalyticsChannel, ElectronService } from '../../services/electron';
import { PublishState } from '../../features/publish/publish-state';
import type { PublishFacts, ReportIndexEntry } from '../../features/publish/publish.types';
import { splitPublishAt } from '../../features/publish/publish-schedule';
import { CADENCE_NOTES, cadenceKeyFor, isCadenceSlot } from '../../features/publish/publish-slots';
// The §2.5 state table, kept pure so it can be exercised without an Angular test bed.
import {
  ChipState,
  channelTag,
  chipStateOf,
  dateKeyOf,
  distance,
  isSchedulable,
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
 * the same hue. The channel tabs across the top are the key, so the encoding is always
 * readable rather than remembered.
 */
const CHANNEL_HUES = ['#ff6b35', '#2dd4bf', '#a78bfa', '#f59e0b', '#38bdf8', '#f472b6'];

/**
 * The three times of day this install releases into, as local wall clock.
 *
 * Not derived from CADENCES: the cadences say which DAYS each channel uses, and between
 * them they only ever land on these three hours. The board renders all three on every day
 * so a slot is a place to drop something rather than a thing that appears once a channel
 * has been chosen.
 */
const SLOTS: ReadonlyArray<{ time: string; label: string; hour: number }> = [
  { time: '13:00', label: '1 PM', hour: 13 },
  { time: '14:00', label: '2 PM', hour: 14 },
  { time: '16:00', label: '4 PM', hour: 16 },
];

/** Four weeks, today inclusive — the window the work actually happens in. */
const INITIAL_HORIZON_DAYS = 28;
/** What one press of Load more days adds. */
const HORIZON_STEP_DAYS = 14;

/**
 * The writer refuses anything less than fifteen minutes out, so a slot inside that window
 * is rendered inert rather than left to bounce off the main process. Same number, stated
 * here only because the client cannot ask the writer what its own rule is.
 */
const WRITER_LEAD_MS = 15 * 60_000;

/** Which channel tab was last in force. The id, because names get edited. */
const CHANNEL_TAB_KEY = 'publish-calendar.channel-tab';

/** What a slot cell or the before-today strip renders for one scheduled item. */
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
  channelId: string | null;
  /** `channelId === null`: not routed. Rendered grey and dashed, not dropped. */
  unrouted: boolean;
  /** A channel id the registry does not have. Named on screen, never coloured in. */
  unknownChannel: boolean;
  /** Belongs to a channel other than the active tab's: readable, but out of the way. */
  dimmed: boolean;
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
  channelId: string | null;
  channelName: string;
  channelTag: string;
  hue: string;
  unrouted: boolean;
  unknownChannel: boolean;
  dimmed: boolean;
  isPodcast: boolean;
  abCount: number;
  hasThumbnail: boolean;
  status: string;
}

/** One of the three release times, on one day. */
export interface SlotCell {
  /** `HH:MM`, exactly what the writer is handed. */
  time: string;
  label: string;
  /** The drop key, `dateKey HH:MM`. */
  key: string;
  /** Inside the writer's fifteen-minute lead: inert, and it says so rather than bouncing. */
  isPast: boolean;
  /** The active channel normally releases here. A hint, never a restriction. */
  isCadence: boolean;
  chips: CalendarChip[];
}

/** One day of the rolling list. */
export interface DayRow {
  dateKey: string;
  /** `Mon, Aug 25`. */
  label: string;
  isToday: boolean;
  slots: SlotCell[];
  /**
   * Chips whose stored time is none of the three slots. They are shown with their real
   * time rather than rounded into a slot they are not in, and never dropped.
   */
  otherChips: CalendarChip[];
}

@Component({
  selector: 'app-publish-calendar',
  standalone: true,
  imports: [
    NgTemplateOutlet,
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

  /** The three column headings, in the order every day row renders them. */
  readonly slotLabels = SLOTS.map((slot) => slot.label);

  /** Today's row, so the Today button has something to scroll to. */
  private readonly todayRow = viewChild<ElementRef<HTMLElement>>('todayRow');

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
   * A signal rather than a `new Date()` inside the derivations, so the TODAY marker, the
   * scheduled → stale transition and the fifteen-minute lead on the first slots of the day
   * actually happen on a page left open, instead of freezing at whatever time the page was
   * opened.
   */
  private readonly now = signal(new Date());
  private clock: ReturnType<typeof setInterval> | null = null;

  // ---------------------------------------------------------------- view state

  /** How many days the rolling list covers, today inclusive. Grows, never shrinks. */
  readonly horizonDays = signal(INITIAL_HORIZON_DAYS);

  /**
   * Which channel's tab is in force. Null only before the registry has arrived — with no
   * channels registered there is no tab to be on, and the board says so.
   */
  readonly activeChannelId = signal<string | null>(null);

  /** The item currently under the cursor's drag, so cells can offer themselves. */
  readonly draggingItemId = signal<string | null>(null);
  /** Which drop target the drag is over: a slot's key, or `tray`. */
  readonly dragOverKey = signal<string | null>(null);

  // ---------------------------------------------------------------- derivations

  /** Registry order decides the hue; the tabs print the key. */
  readonly channelTabs = computed(() =>
    this.channels().map((channel, index) => ({
      channelId: channel.channelId,
      name: channel.name,
      tag: channelTag(channel.name),
      hue: CHANNEL_HUES[index % CHANNEL_HUES.length],
    }))
  );

  readonly activeChannel = computed(() => {
    const id = this.activeChannelId();
    if (id === null) return null;
    return this.channelTabs().find((tab) => tab.channelId === id) ?? null;
  });

  /**
   * The cadence the active channel publishes on, or null when this app has none for it.
   *
   * Null is a real answer and the board simply marks no slots: giving a channel somebody
   * else's release days would be an invisible wrong answer.
   */
  readonly activeCadence = computed(() => {
    const channel = this.activeChannel();
    if (!channel) return null;
    const key = cadenceKeyFor(channel.name);
    if (key === null) return null;
    return { key, note: CADENCE_NOTES[key] };
  });

  /** Every item that has a publish record and a date on it, as chips. */
  private readonly scheduledChips = computed<CalendarChip[]>(() => {
    const now = this.now();
    const active = this.activeChannelId();
    return this.entries()
      .filter((entry) => entry.publish !== null && entry.publish.publishAt !== null)
      .map((entry) => this.toChip(entry, entry.publish as PublishFacts, now, active))
      .sort((a, b) => a.publishAt.localeCompare(b.publishAt));
  });

  readonly scheduledCount = computed(() => this.scheduledChips().length);

  /** Chips by local day, which is how the day rows ask for them. */
  private readonly chipsByDay = computed(() => {
    const map = new Map<string, CalendarChip[]>();
    for (const chip of this.scheduledChips()) {
      const list = map.get(chip.dateKey);
      if (list) list.push(chip);
      else map.set(chip.dateKey, [chip]);
    }
    return map;
  });

  /**
   * The rolling list: today first, `horizonDays` of them.
   *
   * Days are walked with the local date constructor rather than by adding milliseconds,
   * because a day is a wall-clock day and adding 24 hours across a daylight-saving
   * boundary moves the clock.
   */
  readonly dayRows = computed<DayRow[]>(() => {
    const now = this.now();
    const byDay = this.chipsByDay();
    const cadence = this.activeCadence();
    const earliest = now.getTime() + WRITER_LEAD_MS;
    const todayKey = dateKeyOf(now);

    const rows: DayRow[] = [];
    for (let offset = 0; offset < this.horizonDays(); offset++) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      const dateKey = dateKeyOf(day);
      const chips = byDay.get(dateKey) ?? [];

      const slots: SlotCell[] = SLOTS.map((slot) => {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.hour, 0, 0, 0);
        return {
          time: slot.time,
          label: slot.label,
          key: `${dateKey} ${slot.time}`,
          isPast: at.getTime() < earliest,
          isCadence: cadence !== null && isCadenceSlot(cadence.key, at),
          chips: chips.filter((chip) => chip.time === slot.time),
        };
      });

      rows.push({
        dateKey,
        label: day.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
        isToday: dateKey === todayKey,
        slots,
        otherChips: chips.filter((chip) => !SLOTS.some((slot) => slot.time === chip.time)),
      });
    }
    return rows;
  });

  /**
   * Scheduled items dated before today.
   *
   * The list starts at today and there is no way to scroll back to a day nobody can write
   * to, so these would otherwise disappear — and a lapsed schedule is exactly the row that
   * most needs looking at. They get their own strip above the rolling list.
   */
  readonly pastChips = computed(() => {
    const todayKey = dateKeyOf(this.now());
    return this.scheduledChips().filter((chip) => chip.dateKey < todayKey);
  });

  /** Scheduled beyond the loaded window. Counted under the button that would reach them. */
  readonly beyondHorizon = computed(() => {
    const rows = this.dayRows();
    if (rows.length === 0) return 0;
    const lastKey = rows[rows.length - 1].dateKey;
    return this.scheduledChips().filter((chip) => chip.dateKey > lastKey).length;
  });

  /**
   * The unscheduled tray: publish records with no date, on every channel.
   *
   * Records, not items. An item the operator has never opened has no record and is not a
   * draft — listing all 111 generated items here would bury the seven that are actually
   * waiting for a date.
   *
   * A published record with no schedule is finished rather than pending, and is left out:
   * it is not waiting for anything.
   */
  readonly tray = computed<TrayItem[]>(() => {
    const active = this.activeChannelId();
    return this.entries()
      .filter(
        (entry) =>
          entry.publish !== null &&
          entry.publish.publishAt === null &&
          entry.publish.status !== 'published'
      )
      .map((entry) => {
        const facts = entry.publish as PublishFacts;
        const channel = this.channelOf(facts.channelId);
        return {
          itemId: entry.itemId,
          title: facts.mainTitle ?? entry.displayTitle,
          createdAt: entry.dateIso,
          channelId: facts.channelId,
          channelName: channel.name,
          channelTag: channel.tag,
          hue: channel.hue,
          unrouted: facts.channelId === null,
          unknownChannel: !channel.known && facts.channelId !== null,
          dimmed: channel.known && facts.channelId !== active,
          isPodcast: facts.isPodcast,
          abCount: facts.abCount,
          hasThumbnail: facts.hasThumbnail,
          status: facts.status,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  /**
   * Whether the tray would take what is being dragged.
   *
   * Only a scheduled item can be unscheduled, so a tray row dragged over the tray it came
   * from lights nothing up — there is no such write.
   */
  readonly trayAcceptsDrag = computed(() => {
    const itemId = this.draggingItemId();
    if (itemId === null) return false;
    const facts = this.factsOf(itemId);
    return facts !== null && facts.publishAt !== null;
  });

  /** Items whose selection record could not be read. Shown, never dropped. */
  readonly faultyRecords = computed(() =>
    this.entries()
      .filter((entry) => entry.publishFault !== null)
      .map((entry) => ({ itemId: entry.itemId, message: entry.publishFault as string }))
  );

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
      this.settleActiveTab();
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

  // ---------------------------------------------------------------- channel tabs

  /**
   * Which tab is on after a load: the remembered one if the registry still has it, else
   * the first registered channel.
   *
   * A remembered id for a channel that has since been removed is not honoured — the tab
   * would show nothing and dim everything, which reads as an empty board rather than as a
   * stale preference.
   */
  private settleActiveTab(): void {
    const tabs = this.channelTabs();
    if (tabs.length === 0) {
      this.activeChannelId.set(null);
      return;
    }
    const remembered = localStorage.getItem(CHANNEL_TAB_KEY);
    const known = tabs.some((tab) => tab.channelId === remembered);
    this.activeChannelId.set(known ? remembered : tabs[0].channelId);
  }

  setActiveChannel(channelId: string): void {
    this.activeChannelId.set(channelId);
    localStorage.setItem(CHANNEL_TAB_KEY, channelId);
  }

  // ---------------------------------------------------------------- navigation

  /** The deep link the whole round trip is built on. */
  openReport(itemId: string): void {
    void this.router.navigate(['/metadata-reports'], { queryParams: { item: itemId } });
  }

  loadMoreDays(): void {
    this.horizonDays.set(this.horizonDays() + HORIZON_STEP_DAYS);
  }

  /**
   * Why a cadence slot is marked. Empty when there is nothing to say, which is what turns
   * the tooltip off rather than showing an empty bubble.
   */
  slotTooltip(slot: SlotCell): string {
    if (!slot.isCadence) return '';
    const channel = this.activeChannel();
    const cadence = this.activeCadence();
    if (!channel || !cadence) return '';
    return `${channel.name} — ${cadence.note}`;
  }

  scrollToToday(): void {
    this.todayRow()?.nativeElement.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // ---------------------------------------------------------------- drag and drop

  /**
   * Native HTML5 drag, not a CDK list.
   *
   * The drop targets here are a grid of cells and a sidebar, not a sortable list, and the
   * only thing that has to travel is an item id — which `dataTransfer` already carries.
   */
  onDragStart(itemId: string, event: DragEvent): void {
    if (!event.dataTransfer) {
      this.report('This drag carried no data transfer, so nothing can be dropped from it.');
      return;
    }
    event.dataTransfer.setData('text/plain', itemId);
    event.dataTransfer.effectAllowed = 'move';
    this.draggingItemId.set(itemId);
  }

  /** Always clears, including on a drag abandoned outside any target. */
  onDragEnd(): void {
    this.draggingItemId.set(null);
    this.dragOverKey.set(null);
  }

  /**
   * A slot takes a drop only while something is being dragged and only if it is still at
   * least fifteen minutes out. Not calling preventDefault is what makes a past slot inert:
   * the browser refuses the drop itself rather than letting the write bounce.
   */
  onSlotDragOver(slot: SlotCell, event: DragEvent): void {
    if (this.draggingItemId() === null || slot.isPast) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dragOverKey.set(slot.key);
  }

  onDragLeaveTarget(key: string): void {
    if (this.dragOverKey() === key) this.dragOverKey.set(null);
  }

  async onSlotDrop(row: DayRow, slot: SlotCell, event: DragEvent): Promise<void> {
    event.preventDefault();
    this.dragOverKey.set(null);
    this.draggingItemId.set(null);

    const itemId = event.dataTransfer?.getData('text/plain') ?? '';
    if (!itemId) {
      this.report('That drag arrived with no item id on it, so nothing was scheduled.');
      return;
    }

    const facts = this.factsOf(itemId);
    if (!facts) {
      this.report(`Item ${itemId} no longer has a publish record — refresh the calendar.`);
      return;
    }
    // Dropped back where it already is. Writing would restamp publishAtSetAt for no
    // change, which would then misreport when the decision was actually made.
    if (facts.publishAt !== null) {
      const at = splitPublishAt(facts.publishAt);
      if (at.date === row.dateKey && at.time === slot.time) return;
    }

    try {
      await this.publish.setPublishAtOn(itemId, row.dateKey, slot.time);
      await this.reload();
    } catch (err: any) {
      this.report(err?.message || String(err));
    }
  }

  /** The tray takes back anything that currently has a date, and nothing else. */
  onTrayDragOver(event: DragEvent): void {
    const itemId = this.draggingItemId();
    if (itemId === null) return;
    const facts = this.factsOf(itemId);
    if (!facts || facts.publishAt === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dragOverKey.set('tray');
  }

  async onTrayDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.dragOverKey.set(null);
    this.draggingItemId.set(null);

    const itemId = event.dataTransfer?.getData('text/plain') ?? '';
    if (!itemId) {
      this.report('That drag arrived with no item id on it, so nothing was unscheduled.');
      return;
    }

    const facts = this.factsOf(itemId);
    if (!facts) {
      this.report(`Item ${itemId} no longer has a publish record — refresh the calendar.`);
      return;
    }
    if (facts.publishAt === null) return;

    try {
      await this.publish.clearPublishAtOn(itemId);
      await this.reload();
    } catch (err: any) {
      this.report(err?.message || String(err));
    }
  }

  // ---------------------------------------------------------------- helpers

  private factsOf(itemId: string): PublishFacts | null {
    const entry = this.entries().find((e) => e.itemId === itemId);
    return entry?.publish ?? null;
  }

  /**
   * Name, tag and hue for a channel id — including the two cases that are states rather
   * than colours: no channel at all, and an id the registry does not hold. `known` is
   * false for both, and that is what keeps them out of the channel dimming: a chip that
   * needs routing attention must not fade into the background of somebody else's tab.
   */
  private channelOf(
    channelId: string | null
  ): { name: string; tag: string; hue: string; known: boolean } {
    if (channelId === null) {
      return { name: 'no channel', tag: '—', hue: 'var(--ch-none)', known: false };
    }
    const index = this.channels().findIndex((c) => c.channelId === channelId);
    if (index === -1) {
      // A stored id that is not in the registry. Named rather than coloured in as if it
      // were fine — the report panel warns about the same condition.
      return { name: `unknown channel ${channelId}`, tag: '?', hue: 'var(--ch-none)', known: false };
    }
    const channel = this.channels()[index];
    return {
      name: channel.name,
      tag: channelTag(channel.name),
      hue: CHANNEL_HUES[index % CHANNEL_HUES.length],
      known: true,
    };
  }

  private toChip(
    entry: ReportIndexEntry,
    facts: PublishFacts,
    now: Date,
    activeChannelId: string | null
  ): CalendarChip {
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
      channelId: facts.channelId,
      unrouted: facts.channelId === null,
      unknownChannel: !channel.known && facts.channelId !== null,
      dimmed: channel.known && facts.channelId !== activeChannelId,
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

  /** `Mon, Aug 24` for a before-today row, which is off the rolling list's calendar. */
  chipDate(chip: CalendarChip): string {
    return new Date(chip.publishAt).toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  }
}
