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
 * SHAPE: a rolling list of days starting at TODAY, each with the slots this install
 * actually publishes into. TWO LANES, sectioned apart because they are two services and
 * not four columns of the same thing: 5 AM is the podcast's, every day, and 1 PM / 2 PM /
 * 4 PM are YouTube's. No month grid — a month grid answers "what
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
 * chip that does not sit on one of the slots, and the beyond-the-horizon count under
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
import { NotificationService } from '../../services/notification';
import type {
  LinkedVideo,
  PublishFacts,
  ReportIndexEntry,
  ScheduledSweep,
  ScheduledVideo,
} from '../../features/publish/publish.types';
import {
  SPREAKER_DESTINATION,
  SPREAKER_DESTINATION_LABEL,
} from '../../features/publish/publish.types';
import { splitPublishAt } from '../../features/publish/publish-schedule';
import { CADENCE_NOTES, cadenceKeyFor, isCadenceSlot } from '../../features/publish/publish-slots';
// The §2.5 state table, kept pure so it can be exercised without an Angular test bed.
import {
  ChipState,
  Destination,
  Readiness,
  channelTag,
  chipStateOf,
  dateKeyOf,
  destinationOf,
  dimmedFor,
  distance,
  isSchedulable,
  missingFor,
  readinessOf,
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
 * The times of day this install releases into, as local wall clock, and which lane each
 * one serves.
 *
 * Not derived from CADENCES: the cadences say which DAYS each YouTube channel uses, and
 * between them they only ever land on the three afternoon hours. The board renders every
 * slot on every day so a slot is a place to drop something rather than a thing that
 * appears once a channel has been chosen.
 *
 * 5 AM IS THE PODCAST'S, EVERY DAY. The episode drops in the morning and there is no
 * weekday pattern behind it, so there is no cadence to consult and none is marked — the
 * lane is simply always open. It carries its own destination because a slot that did not
 * declare one could only be told apart from the YouTube slots by its hour, which is a
 * coincidence of this install rather than a rule.
 */
const SLOTS: ReadonlyArray<{
  time: string;
  label: string;
  hour: number;
  destination: Destination;
}> = [
  { time: '05:00', label: '5 AM', hour: 5, destination: 'spreaker' },
  { time: '13:00', label: '1 PM', hour: 13, destination: 'youtube' },
  { time: '14:00', label: '2 PM', hour: 14, destination: 'youtube' },
  { time: '16:00', label: '4 PM', hour: 16, destination: 'youtube' },
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

/**
 * Which tab was last in force: a channel id, or `spreaker`.
 *
 * The id rather than the name, because names get edited. The key keeps its old name so a
 * remembered channel survives this build — the Spreaker value simply becomes another
 * legal thing to find in it.
 */
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
  /** Files under a tab other than the one in force: readable, but out of the way. */
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
  /**
   * The title of a video YOUTUBE already has at this exact moment on this same channel,
   * or null.
   *
   * Same channel and same instant only: two channels releasing at 1 PM is the normal
   * shape of the week, not a clash. Reported, never enforced — a deliberate double
   * release is the operator's call, and the confirm panel says it out loud instead of
   * refusing.
   */
  collision: string | null;
  /** Where this one is going. The bulk upload is YouTube-only and reads this. */
  destination: Destination;
  /** done / ready / incomplete — what the readiness pip and the bulk upload both read. */
  readiness: Readiness;
  /** What is still missing, when readiness is `incomplete`. Named, never just counted. */
  missing: string[];
  /**
   * Set when YouTube says this video is already out, whatever the record's date says.
   *
   * The record holds an INTENT; this is the event. When they disagree the event wins, and
   * the chip says when it actually went out rather than continuing to promise a release
   * that has already happened.
   */
  liveNote: string | null;
  /**
   * True when YouTube could still take this schedule and does not have it: the video is
   * linked, still private, and either holds a different moment or holds none at all.
   *
   * The "holds none at all" case is the ordinary result of dragging a chip — the local
   * record moves immediately, and nothing has told YouTube yet.
   */
  needsSchedulePush: boolean;
  /** For a stale row: when it was due and when the intent was recorded. */
  staleNote: string | null;
  /**
   * Set when YouTube holds a DIFFERENT moment for this same video.
   *
   * YouTube's is what will actually happen; this record is only what was intended. The
   * two are shown together rather than reconciled — silently preferring either one would
   * hide the fact that they disagree, and that fact is the whole warning.
   */
  mirrorDivergence: string | null;
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
  destination: Destination;
  readiness: Readiness;
  missing: string[];
}

/**
 * A video YOUTUBE says is scheduled, mirrored onto the board.
 *
 * Not a chip this app owns: it has no publish record behind it, no drag, and no write.
 * It is here so a slot that is already taken looks taken — including by videos scheduled
 * by hand in Studio, which is the case the operator cannot otherwise see at all.
 *
 * A mirror whose videoId belongs to a local record is NOT built: that item is already on
 * the board as its own chip, and drawing both would read as two releases.
 */
export interface MirrorChip {
  videoId: string;
  title: string;
  /** Local wall time, `HH:MM`. */
  time: string;
  dateKey: string;
  publishAt: string;
  channelId: string;
  channelName: string;
  channelTag: string;
  hue: string;
  dimmed: boolean;
  /**
   * The local item that claims this same video, when one does but draws no chip of its
   * own. Present exactly when the record has a video id and NO local date — the report is
   * still worth reaching, so the mirror carries the way in.
   */
  itemId: string | null;
  /** Still private with a date on it, i.e. genuinely pending rather than already out. */
  pending: boolean;
  /** As YouTube reports it, so the tooltip can name it rather than imply it. */
  privacyStatus: string;
}

/** One release time, on one day. */
export interface SlotCell {
  /** `HH:MM`, exactly what the writer is handed. */
  time: string;
  label: string;
  /** The drop key, `dateKey HH:MM`. */
  key: string;
  /**
   * Which lane this slot serves.
   *
   * A HINT, NEVER A RESTRICTION: a mismatched drop is still taken, because this app
   * reports and does not enforce, and a deliberate cross-drop is the operator's call. All
   * it changes is how strongly the slot offers itself while a drag is in flight.
   */
  destination: Destination;
  /** Inside the writer's fifteen-minute lead: inert, and it says so rather than bouncing. */
  isPast: boolean;
  /** The active channel normally releases here. A hint, never a restriction. */
  isCadence: boolean;
  chips: CalendarChip[];
  /** What YouTube already has here. Read-only, and the reason a slot can look full. */
  mirrors: MirrorChip[];
}

/** One day of the rolling list. */
export interface DayRow {
  dateKey: string;
  /** `Mon, Aug 25`. */
  label: string;
  isToday: boolean;
  slots: SlotCell[];
  /**
   * Chips whose stored time is none of the board's slots. They are shown with their real
   * time rather than rounded into a slot they are not in, and never dropped.
   */
  otherChips: CalendarChip[];
  /** The same, for YouTube-side videos scheduled at some other hour. */
  otherMirrors: MirrorChip[];
}

/** One item's outcome in a bulk run. Every attempt gets one, pass or fail. */
export interface UploadResult {
  itemId: string;
  title: string;
  /** For a Spreaker row this is the destination's name — the show is where it went. */
  channelName: string;
  ok: boolean;
  /** The main process's refusal, verbatim. Null on success. */
  error: string | null;
  /**
   * The id the destination now holds this item under: a YouTube video id, or a Spreaker
   * episode id. Null when there is none to name — a failed attempt creates nothing.
   */
  remoteId: string | null;
}

/**
 * One episode the Spreaker lane could send, dated or not.
 *
 * Drawn from BOTH halves of the board — the scheduled chips and the unscheduled tray —
 * because the undated ones are the entire reason this list exists. Spreaker has no draft
 * state: an episode uploaded with no publish date is live the moment its encode finishes.
 * A candidate list built only from dated chips could never name the episodes that would
 * go out immediately, and those are the ones the operator has to be told about.
 */
export interface SpreakerCandidate {
  itemId: string;
  title: string;
  /** ISO instant, or null — and null is the one state the run refuses outright. */
  publishAt: string | null;
  /** `Mon, Aug 31 · 05:00`, or null when there is no date to print. */
  when: string | null;
  readiness: Readiness;
  /** What is still missing, when readiness is `incomplete`. Named, never just counted. */
  missing: string[];
}

/** The live state of a bulk run. Null when nothing is uploading. */
export interface UploadRun {
  /** Items still to attempt, including the one in flight. */
  queue: string[];
  total: number;
  /** 1-based position of the item in flight. */
  index: number;
  currentItemId: string | null;
  currentTitle: string;
  sentBytes: number;
  totalBytes: number;
  /** Set when the operator asks to stop; the in-flight item is aborted and the rest skipped. */
  cancelling: boolean;
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
   * The app's own toast + bell, rather than a banner only this page knows how to draw.
   * A refusal here is worth the same attention as one from anywhere else, and it should
   * survive navigating away — the bell keeps it, a banner on a page you left does not.
   */
  private notify = inject(NotificationService);
  /**
   * The single publishAt writer, shared with the report panel.
   *
   * Injected as the whole state object rather than reimplementing the write: the calendar
   * must not grow a second set of scheduling rules, and this is the one that already
   * exists.
   */
  readonly publish = inject(PublishState);

  /** The column headings, in the order every day row renders them. */
  readonly slotHeads = SLOTS.map((slot) => ({ label: slot.label, destination: slot.destination }));

  /** The Spreaker tab's value and its label, so template and storage say the same word. */
  readonly spreakerTab = SPREAKER_DESTINATION;
  readonly spreakerLabel = SPREAKER_DESTINATION_LABEL;

  /** Today's row, so the Today button has something to scroll to. */
  private readonly todayRow = viewChild<ElementRef<HTMLElement>>('todayRow');

  // ---------------------------------------------------------------- loaded state

  readonly entries = signal<ReportIndexEntry[]>([]);
  readonly channels = signal<AnalyticsChannel[]>([]);
  readonly loading = signal(false);

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
  /** Unsubscribe for the main process's byte-progress ticks. */
  private stopProgress: (() => void) | null = null;

  // ---------------------------------------------------------------- view state

  /** How many days the rolling list covers, today inclusive. Grows, never shrinks. */
  readonly horizonDays = signal(INITIAL_HORIZON_DAYS);

  /**
   * Which tab is in force: a channel id, or `spreaker`. Null only before the first load
   * has settled it.
   *
   * One signal for both kinds of tab because they are one strip and one choice. What a
   * tab MEANS differs — a channel is a place a video is authorized against, Spreaker is a
   * destination with one show behind it — and every rule that cares reads
   * `activeDestination()` rather than comparing this string itself.
   */
  readonly activeTabId = signal<string | null>(null);

  /** The item currently under the cursor's drag, so cells can offer themselves. */
  readonly draggingItemId = signal<string | null>(null);
  /** Which drop target the drag is over: a slot's key, or `tray`. */
  readonly dragOverKey = signal<string | null>(null);

  // ------------------------------------------------------------ the YouTube mirror

  /**
   * What YouTube says is scheduled, or null before the first sweep has answered.
   *
   * Null and empty are different answers and the board says which it has: null means
   * nobody has asked YouTube yet, so an empty-looking slot is only empty as far as THIS
   * APP knows. An empty list means YouTube was asked and holds nothing.
   */
  readonly sweep = signal<ScheduledSweep | null>(null);
  readonly sweeping = signal(false);
  /**
   * Whether the last sweep failed, so the header can say the mirror is stale.
   *
   * A boolean, not the text: the text goes to the notifications like every other failure,
   * and what this page still needs to KNOW is only that what it is showing may be behind.
   */
  readonly sweepFailed = signal(false);

  // ------------------------------------------------------------ the bulk upload

  /**
   * The confirm panel's contents, or null when it is closed.
   *
   * A bulk upload CREATES videos on live channels and cannot be undone from here, so it
   * is never one click away: the panel names every item, grouped by the channel it will
   * be authorized against, and the operator reads that list before anything is sent.
   */
  readonly uploadConfirm = signal<CalendarChip[] | null>(null);
  readonly uploadRun = signal<UploadRun | null>(null);
  /** Results of the last run, kept until dismissed. Failures are the point of it. */
  readonly uploadResults = signal<UploadResult[]>([]);

  // ------------------------------------------------------------ the Spreaker run

  /**
   * The Spreaker lane's own confirm panel, or null when it is closed.
   *
   * A SEPARATE ACTION FROM THE YOUTUBE RUN, deliberately, and not one button with two
   * meanings: these are two services, two authorizations and two irreversible outcomes,
   * and the Spreaker one carries a rule the YouTube one does not have — an episode with
   * no date is live on contact.
   */
  readonly spreakerConfirm = signal<SpreakerCandidate[] | null>(null);
  /**
   * The Spreaker run in flight. No byte counter, because there is none to have: only
   * `publish-upload-youtube` reports progress, so a bar here would be a bar that never
   * moves.
   */
  readonly spreakerRun = signal<{ index: number; total: number; title: string } | null>(null);
  readonly spreakerResults = signal<UploadResult[]>([]);

  /** The schedule push in flight, or null. Simpler than an upload: no bytes to report. */
  readonly pushRun = signal<{ index: number; total: number; title: string } | null>(null);
  readonly pushResults = signal<UploadResult[]>([]);

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

  /**
   * Every tab id that currently exists, in strip order. The Spreaker one is ALWAYS last
   * and always there — an empty destination is the same shape of fact as an empty channel,
   * and a lane that appeared only once something was in it could never be dropped into.
   */
  readonly tabIds = computed(() => [
    ...this.channelTabs().map((tab) => tab.channelId),
    SPREAKER_DESTINATION,
  ]);

  /**
   * The active tab as a channel, or null when it is not one.
   *
   * Null on the Spreaker tab is the honest answer rather than an awkward one: Spreaker is
   * not a channel, has no hue in the registry order and has no YouTube release cadence, so
   * everything downstream that asks for a channel correctly gets nothing.
   */
  readonly activeChannel = computed(() => {
    const id = this.activeTabId();
    if (id === null) return null;
    return this.channelTabs().find((tab) => tab.channelId === id) ?? null;
  });

  /** Which lane the board is being read as. Every count and every drop hint reads this. */
  readonly activeDestination = computed<Destination>(() =>
    this.activeTabId() === SPREAKER_DESTINATION ? 'spreaker' : 'youtube'
  );

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

  /**
   * YouTube's schedule for the videos this app already knows by id, keyed by video id.
   *
   * Used for two different things and built once: the divergence warning on a local chip,
   * and knowing which mirrored videos are duplicates of a chip already on the board.
   */
  /** Every linked video's YouTube-side status, by video id. */
  private readonly linkedByVideoId = computed(() => {
    const map = new Map<string, LinkedVideo>();
    const swept = this.sweep();
    if (!swept) return map;
    for (const video of swept.linked) map.set(video.videoId, video);
    return map;
  });

  private readonly mirrorByVideoId = computed(() => {
    const map = new Map<string, ScheduledVideo>();
    const swept = this.sweep();
    if (!swept) return map;
    for (const video of swept.scheduled) map.set(video.videoId, video);
    return map;
  });

  /**
   * Whether this record is still the CALENDAR's business.
   *
   * A date, and nothing on YouTube yet. The moment an item has a video id, YouTube owns
   * its schedule — the stored publishAt becomes a record of intent rather than the thing
   * that will happen — and the item returns to the board from the other side, as a mirror
   * of what YouTube actually holds. An item the operator marked published is finished by
   * his own say-so and leaves for good.
   *
   * So a chip on this board always means one thing: something that still needs doing.
   */
  private isOpenWork(facts: PublishFacts, linked: ReadonlyMap<string, LinkedVideo>): boolean {
    if (facts.publishAt === null) return false;
    // The operator's own say-so. Marked published means finished, whatever else is true.
    if (facts.status === 'published') return false;

    const remote = facts.videoId !== null ? linked.get(facts.videoId) ?? null : null;
    if (remote === null) return true;

    // Already out. Nothing left to decide, and nothing YouTube would accept anyway.
    if (remote.privacyStatus !== 'private') return false;
    // Uploaded AND YouTube is holding a date for it. The plan has become a fact, so the
    // local chip gives way to the mirror of what YouTube actually has — in the same slot,
    // because the insert carried this very schedule.
    if (remote.publishAt !== null) return false;

    // Uploaded, private, and YouTube has NO date. This is the browser-upload case, where
    // a release was made outside the app and linked afterwards, and it is the one state
    // that must keep its chip: the mirror charts scheduled videos, so an unscheduled one
    // appears nowhere else, and dropping it here would leave it invisible and unable to
    // be given the date it is waiting for.
    return true;
  }

  /** Every item that has a publish record and a date on it, as chips. */
  private readonly scheduledChips = computed<CalendarChip[]>(() => {
    const now = this.now();
    const active = this.activeTabId();
    const mirror = this.mirrorByVideoId();
    const bySlot = this.mirrorBySlot();
    const linked = this.linkedByVideoId();
    return this.entries()
      .filter((entry) => entry.publish !== null && this.isOpenWork(entry.publish, linked))
      .map((entry) =>
        this.toChip(entry, entry.publish as PublishFacts, now, active, mirror, bySlot, linked)
      )
      .sort((a, b) => a.publishAt.localeCompare(b.publishAt));
  });

  /**
   * The mirror, minus everything already drawn as a local chip.
   *
   * A video id claimed by any publish record is dropped here whether or not that record
   * has a date: the item is the app's own, and its own chip (or its tray row) is where it
   * belongs. What survives is the genuinely external schedule — videos put on the
   * calendar in Studio that this app would otherwise draw an empty slot over.
   */
  private readonly mirrorChips = computed<MirrorChip[]>(() => {
    const swept = this.sweep();
    if (!swept) return [];

    // Suppressed only when the local record actually DRAWS a chip for this video, which
    // means it has a date of its own. A record that names a video but carries no date
    // renders nothing anywhere — it is not on a day and it is out of the tray — so
    // dropping its mirror too would leave a genuinely occupied slot looking empty. That
    // is not hypothetical: the backlog mark-as-published pass sets a status and a video
    // id without ever setting a publishAt.
    const drawn = new Set<string>();
    const itemByVideo = new Map<string, string>();
    for (const entry of this.entries()) {
      const facts = entry.publish;
      if (!facts?.videoId) continue;
      itemByVideo.set(facts.videoId, entry.itemId);
      // Suppressed only when a local chip is genuinely drawn for it — the SAME test the
      // board uses. A video id now ends local charting, so in practice this suppresses
      // nothing any more; it stays keyed to the predicate rather than hard-coded, because
      // the two must never drift apart and hide an item from both halves at once.
      if (this.isOpenWork(facts, this.linkedByVideoId())) drawn.add(facts.videoId);
    }

    const active = this.activeTabId();
    return swept.scheduled
      .filter((video) => !drawn.has(video.videoId))
      .map((video) => {
        const at = new Date(video.publishAt);
        if (Number.isNaN(at.getTime())) {
          throw new Error(
            `YouTube returned ${JSON.stringify(video.publishAt)} as the schedule for ` +
            `${video.videoId}, which is not a date this can read.`
          );
        }
        const channel = this.channelOf(video.channelId);
        return {
          videoId: video.videoId,
          title: video.title,
          time: splitPublishAt(video.publishAt).time,
          dateKey: dateKeyOf(at),
          publishAt: video.publishAt,
          channelId: video.channelId,
          channelName: channel.name,
          channelTag: channel.tag,
          hue: channel.hue,
          dimmed: channel.known && video.channelId !== active,
          itemId: itemByVideo.get(video.videoId) ?? null,
          pending: video.privacyStatus === 'private',
          privacyStatus: video.privacyStatus,
        };
      })
      .sort((a, b) => a.publishAt.localeCompare(b.publishAt));
  });

  /**
   * Mirrored videos keyed by channel and exact local slot, for the collision check.
   *
   * Built from the SAME chips the board draws rather than from the raw sweep, so anything
   * suppressed as a duplicate of a local chip cannot also be reported as colliding with
   * it — an item is never its own collision.
   */
  private readonly mirrorBySlot = computed(() => {
    const map = new Map<string, MirrorChip>();
    for (const chip of this.mirrorChips()) {
      map.set(`${chip.channelId}|${chip.dateKey}|${chip.time}`, chip);
    }
    return map;
  });

  private readonly mirrorsByDay = computed(() => {
    const map = new Map<string, MirrorChip[]>();
    for (const chip of this.mirrorChips()) {
      const list = map.get(chip.dateKey);
      if (list) list.push(chip);
      else map.set(chip.dateKey, [chip]);
    }
    return map;
  });

  /** How many local chips YouTube holds a different moment for. Drives the warning line. */
  readonly divergentCount = computed(
    () => this.scheduledChips().filter((chip) => chip.mirrorDivergence !== null).length
  );

  /** When the mirror was last read, for the line that says how fresh it is. */
  readonly sweptLabel = computed(() => {
    const swept = this.sweep();
    if (!swept) return null;
    return new Date(swept.sweptAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  });

  readonly scheduledCount = computed(() => this.scheduledChips().length);

  /**
   * Scheduled items that could be uploaded right now, in the order they will be sent.
   *
   * Scheduled, because that is what the operator asked for: a date on the board is the
   * decision that this video is going out. Order is chronological — the soonest release
   * is the one it hurts most to still be waiting on.
   */
  readonly uploadable = computed(() =>
    this.scheduledChips().filter(
      (chip) => chip.readiness === 'ready' && chip.destination === 'youtube'
    )
  );

  /**
   * The scheduled chips of the lane currently being LOOKED AT.
   *
   * Every header count is drawn from this rather than from the whole board. A single "12
   * ready" spanning both destinations answered a question nobody asked: the two lanes are
   * sent by two different buttons to two different services, so a number that mixes them
   * cannot be acted on by either one, and on the Spreaker tab it would have been mostly
   * describing YouTube.
   *
   * The lane, not the tab: on a channel tab this is every YouTube channel, because the
   * board itself still shows every channel and only dims the others.
   */
  private readonly laneChips = computed(() => {
    const lane = this.activeDestination();
    return this.scheduledChips().filter((chip) => chip.destination === lane);
  });

  /** Ready in the lane on screen. On YouTube this is exactly what the bulk button sends. */
  readonly laneReadyCount = computed(
    () => this.laneChips().filter((chip) => chip.readiness === 'ready').length
  );

  /** Scheduled but not sendable, so the header can say what is being left behind. */
  readonly incompleteCount = computed(
    () => this.laneChips().filter((chip) => chip.readiness === 'incomplete').length
  );

  /** Already at its destination — a video id, or an episode id — and waiting for its moment. */
  readonly uploadedCount = computed(
    () => this.laneChips().filter((chip) => chip.readiness === 'done').length
  );

  /**
   * Ready and scheduled in the OTHER lane, with that lane's name.
   *
   * The counts above deliberately speak for one lane, so this is what stops that from
   * being a silent omission: whichever tab is on, the header still says how much work is
   * ready in the half of the board it is not describing, and where to go to see it.
   */
  readonly otherLane = computed(() => {
    const here = this.activeDestination();
    const there: Destination = here === 'youtube' ? 'spreaker' : 'youtube';
    return {
      destination: there,
      name: there === 'spreaker' ? SPREAKER_DESTINATION_LABEL : 'YouTube',
      ready: this.scheduledChips().filter(
        (chip) => chip.destination === there && chip.readiness === 'ready'
      ).length,
    };
  });

  /** The confirm panel's list, grouped by the channel each upload authorizes against. */
  readonly confirmByChannel = computed(() => {
    const chips = this.uploadConfirm();
    if (!chips) return [];
    const groups = new Map<string, { channelName: string; hue: string; chips: CalendarChip[] }>();
    for (const chip of chips) {
      const key = chip.channelId ?? '';
      const group = groups.get(key);
      if (group) group.chips.push(chip);
      else groups.set(key, { channelName: chip.channelName, hue: chip.hue, chips: [chip] });
    }
    return [...groups.values()];
  });

  readonly uploadFailures = computed(() => this.uploadResults().filter((r) => !r.ok));

  /**
   * Linked, still-private videos whose YouTube schedule is not the one on the board.
   *
   * This is what makes the calendar a scheduler rather than a notepad: dragging an
   * already-uploaded video writes the record instantly, and until this is pushed YouTube
   * still holds the old date — or no date at all.
   */
  readonly needsSchedulePush = computed(() =>
    this.scheduledChips().filter((chip) => chip.needsSchedulePush)
  );

  /**
   * Scheduled items the run will NOT include, with the reason, grouped.
   *
   * The button counts what it can send, which is not the same number as what is on the
   * board — and the gap is exactly the kind of silent shortfall that reads as a bug. An
   * already-uploaded item is not a candidate (a second insert would duplicate the video,
   * which the planner refuses outright); an incomplete one is missing something named.
   */
  readonly excludedFromRun = computed(() => {
    const skipped = this.scheduledChips().filter(
      (chip) => chip.readiness !== 'ready' || chip.destination !== 'youtube'
    );
    if (skipped.length === 0) return [];

    const done = skipped.filter((chip) => chip.readiness === 'done');
    const incomplete = skipped.filter((chip) => chip.readiness === 'incomplete');
    // Ready, but not going to YouTube. This button creates YOUTUBE videos; a Spreaker
    // episode is a different call to a different service that publishes on contact, and
    // sweeping one into a batch labelled "upload to YouTube" would be a genuine mistake.
    const elsewhere = this.scheduledChips().filter(
      (chip) => chip.readiness === 'ready' && chip.destination !== 'youtube'
    );

    const groups: Array<{ reason: string; titles: string[] }> = [];
    if (elsewhere.length > 0) {
      groups.push({
        reason: `going to ${SPREAKER_DESTINATION_LABEL}, not YouTube — send it with the Spreaker button`,
        titles: elsewhere.map((chip) => chip.title),
      });
    }
    if (done.length > 0) {
      groups.push({
        reason:
          `already uploaded — a second insert would duplicate the video, so use Push to ` +
          `change one of these`,
        titles: done.map((chip) => chip.title),
      });
    }
    for (const chip of incomplete) {
      groups.push({ reason: `still needs ${chip.missing.join(', ')}`, titles: [chip.title] });
    }
    return groups;
  });

  /** Of the run about to be confirmed, how many land on a slot YouTube already holds. */
  readonly confirmCollisions = computed(
    () => (this.uploadConfirm() ?? []).filter((chip) => chip.collision !== null).length
  );

  // ------------------------------------------------------- the Spreaker lane's run

  /**
   * Every podcast episode the board holds, dated and undated together.
   *
   * Both halves, because the two halves are the two answers to the only question this run
   * asks. A dated episode is a scheduled release; an undated one is an immediate one, and
   * an immediate release is exactly what nobody meant to click. Reading only the dated
   * chips would have made the undated episodes invisible to a panel whose whole job is to
   * name them.
   */
  private readonly spreakerCandidates = computed<SpreakerCandidate[]>(() => {
    const scheduled: SpreakerCandidate[] = this.scheduledChips()
      .filter((chip) => chip.destination === 'spreaker')
      .map((chip) => ({
        itemId: chip.itemId,
        title: chip.title,
        publishAt: chip.publishAt,
        when: `${this.chipDate(chip)} · ${chip.time}`,
        readiness: chip.readiness,
        missing: chip.missing,
      }));
    const undated: SpreakerCandidate[] = this.tray()
      .filter((item) => item.destination === 'spreaker')
      .map((item) => ({
        itemId: item.itemId,
        title: item.title,
        publishAt: null,
        when: null,
        readiness: item.readiness,
        missing: item.missing,
      }));
    return [...scheduled, ...undated];
  });

  /**
   * What the Spreaker button will actually send, soonest first.
   *
   * TWO CONDITIONS, AND THE SECOND IS THE WHOLE POINT. Ready, as everywhere else on this
   * page — and dated, because Spreaker has no draft state: an episode uploaded without a
   * publish date is live as soon as its encode finishes. The date is the only thing
   * standing between this button and a release, so an episode without one is never in the
   * batch, however ready it otherwise is.
   */
  readonly spreakerUploadable = computed(() =>
    this.spreakerCandidates()
      .filter((item) => item.readiness === 'ready' && item.publishAt !== null)
      .sort((a, b) => (a.publishAt as string).localeCompare(b.publishAt as string))
  );

  /**
   * The episodes the Spreaker run leaves behind, by reason, named one by one.
   *
   * The undated group is first because it is the one that is not a housekeeping note: the
   * operator has an episode he believes is scheduled work, and what he is being told is
   * that sending it now would publish it now.
   */
  readonly spreakerExcluded = computed(() => {
    const all = this.spreakerCandidates();
    const groups: Array<{ reason: string; titles: string[] }> = [];

    const undated = all.filter((item) => item.readiness === 'ready' && item.publishAt === null);
    if (undated.length > 0) {
      groups.push({
        reason:
          `no publish date — Spreaker has no draft state, so uploading one of these would ` +
          `put it live immediately. Drop it on a 5 AM slot first`,
        titles: undated.map((item) => item.title),
      });
    }

    const done = all.filter((item) => item.readiness === 'done');
    if (done.length > 0) {
      groups.push({
        reason:
          `already on Spreaker — a second push creates a SECOND episode rather than ` +
          `replacing the first, and the main process refuses it by name`,
        titles: done.map((item) => item.title),
      });
    }

    for (const item of all.filter((i) => i.readiness === 'incomplete')) {
      groups.push({ reason: `still needs ${item.missing.join(', ')}`, titles: [item.title] });
    }
    return groups;
  });

  /**
   * Ready episodes the button is NOT counting because they carry no date.
   *
   * Said in the header rather than only inside the confirm panel, because the panel is
   * unreachable in exactly the case that most needs explaining: every ready episode is
   * undated, the button reads (0) and is disabled, and nothing on screen would otherwise
   * account for the podcast work the operator can plainly see on the board.
   */
  readonly spreakerHeldBack = computed(
    () =>
      this.spreakerCandidates().filter(
        (item) => item.readiness === 'ready' && item.publishAt === null
      ).length
  );

  readonly spreakerFailures = computed(() => this.spreakerResults().filter((r) => !r.ok));

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

    const byDayMirror = this.mirrorsByDay();

    const rows: DayRow[] = [];
    for (let offset = 0; offset < this.horizonDays(); offset++) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      const dateKey = dateKeyOf(day);
      const chips = byDay.get(dateKey) ?? [];
      const mirrors = byDayMirror.get(dateKey) ?? [];

      const slots: SlotCell[] = SLOTS.map((slot) => {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.hour, 0, 0, 0);
        return {
          time: slot.time,
          label: slot.label,
          key: `${dateKey} ${slot.time}`,
          destination: slot.destination,
          isPast: at.getTime() < earliest,
          // Cadences are YOUTUBE release patterns. Marking the podcast slot with one would
          // claim the episode follows a channel's schedule, which it does not — it is any
          // day at 5 AM, and an unmarked lane says that more honestly than a wrong mark.
          isCadence:
            slot.destination === 'youtube' && cadence !== null && isCadenceSlot(cadence.key, at),
          chips: chips.filter((chip) => chip.time === slot.time),
          mirrors: mirrors.filter((chip) => chip.time === slot.time),
        };
      });

      rows.push({
        dateKey,
        label: day.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
        isToday: dateKey === todayKey,
        slots,
        otherChips: chips.filter((chip) => !SLOTS.some((slot) => slot.time === chip.time)),
        otherMirrors: mirrors.filter((chip) => !SLOTS.some((slot) => slot.time === chip.time)),
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
   * Mirrored videos that land outside the rolling list entirely — before today, or past
   * its far end.
   *
   * Counted rather than rendered. They cannot collide with anything the operator can drop
   * (there is no cell for them to sit in), but a mirror that quietly held fewer videos
   * than YouTube does would undermine the one thing this mirror is for.
   */
  readonly mirrorsOutsideWindow = computed(() => {
    const rows = this.dayRows();
    if (rows.length === 0) return 0;
    const firstKey = rows[0].dateKey;
    const lastKey = rows[rows.length - 1].dateKey;
    return this.mirrorChips().filter(
      (chip) => chip.dateKey < firstKey || chip.dateKey > lastKey
    ).length;
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
    const active = this.activeTabId();
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
        const destination = destinationOf(facts);
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
          dimmed: dimmedFor({ destination, channelId: facts.channelId }, channel.known, active),
          isPodcast: facts.isPodcast,
          abCount: facts.abCount,
          hasThumbnail: facts.hasThumbnail,
          status: facts.status,
          destination,
          readiness: readinessOf(facts),
          missing: missingFor(facts),
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

  /**
   * Where the item under the cursor is going, or null when nothing is being dragged — and
   * also when the dragged item's record has gone, which is a real state and not a lane.
   */
  readonly draggingDestination = computed<Destination | null>(() => {
    const itemId = this.draggingItemId();
    if (itemId === null) return null;
    const facts = this.factsOf(itemId);
    if (facts === null) return null;
    return destinationOf(facts);
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
    // The same ~4 Hz tick the report panel's single upload draws, read here for whichever
    // item the run currently has in flight. Ticks for any other item are ignored rather
    // than assumed to be ours: a single upload can be running on the reports page.
    this.stopProgress = this.electron.onPublishUploadProgress((p) => {
      const run = this.uploadRun();
      if (!run || run.currentItemId !== p.itemId) return;
      this.uploadRun.set({ ...run, sentBytes: p.sentBytes, totalBytes: p.totalBytes });
    });
    await this.reload();
    // Not awaited: the board is already correct about this app's own records, and the
    // mirror is a live API sweep of three channels. Making the page wait for the network
    // would delay everything for the sake of an overlay.
    void this.refreshSweep();
  }

  ngOnDestroy(): void {
    if (this.clock) clearInterval(this.clock);
    if (this.stopProgress) this.stopProgress();
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
    try {
      const [indexed, registry] = await Promise.all([
        this.electron.publishListIndex(),
        this.electron.analyticsListChannels(),
      ]);

      if (!indexed.success || !indexed.data) {
        this.entries.set([]);
        this.problems.set([]);
        this.orphanedSelections.set([]);
        this.report(indexed.error ?? 'The report index could not be read.');
      } else {
        // PRIMARY SETS ONLY, filtered at the ONE point the signal is written so every
        // computed below it — the scheduled chips, the unscheduled tray, the deep-link
        // lookup — is talking about the same rows.
        //
        // A video can have several generated metadata sets (a re-run, a softening pass)
        // joined by source_key, and exactly one of them is the one this app publishes.
        // Drawing a chip for a set nobody promoted would put a date on the calendar that
        // no push would honour. The index deliberately carries all of them — the reports
        // page needs every sibling for its version picker — so the filter belongs here.
        const primaries = indexed.data.entries.filter((entry) => entry.isPrimary);
        this.entries.set(primaries);

        // A schedule set on a set that is NOT its source's primary now draws no chip. That
        // is right — no push would honour it — but it must not be silent: a date the
        // operator entered and cannot see is exactly the kind of thing found by missing an
        // upload. Named here, in the same fault strip the unreadable reports use.
        const withheld = indexed.data.entries.filter(
          (entry) => !entry.isPrimary && entry.publish?.publishAt,
        );
        this.problems.set([
          ...indexed.data.problems,
          ...withheld.map((entry) => ({
            file: entry.displayTitle || entry.itemId,
            message:
              `is scheduled for ${entry.publish!.publishAt} but is not the primary metadata ` +
              `set for "${entry.sourceKey}", so it is not on the calendar. Promote it on the ` +
              `metadata page to schedule it.`,
          })),
        ]);
        this.orphanedSelections.set(indexed.data.orphanedSelections);
        if (indexed.data.directoryMissing) {
          this.report(
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

  /**
   * Every refusal this page produces, sent to the app's notifications.
   *
   * One funnel, one destination. Previously these accumulated in a banner that only this
   * page rendered and that vanished the moment the operator navigated away — which for a
   * failed write is exactly backwards.
   */
  private report(message: string): void {
    this.notify.error('Publish calendar', message);
  }

  /**
   * Ask YouTube what it actually has scheduled.
   *
   * Its own call and its own error line, deliberately kept off `reload()`: the local
   * board must not go blank because a channel's token expired, and the mirror must not
   * look empty because it was never read. A failed sweep leaves the previous answer in
   * place — it is still the last thing YouTube said — and says that it failed.
   */
  async refreshSweep(): Promise<void> {
    this.sweeping.set(true);
    try {
      const res = await this.electron.publishListScheduled();
      if (!res.success || !res.data) {
        this.sweepFailed.set(true);
        this.notify.warning(
          'YouTube schedule not read',
          res.error ?? 'YouTube would not say what is scheduled.'
        );
        return;
      }
      this.sweep.set(res.data);
      this.sweepFailed.set(res.data.problems.length > 0);
      for (const problem of res.data.problems) {
        // One per channel: two channels failing for different reasons is two facts, and
        // a joined string makes neither of them actionable.
        this.notify.warning(`${problem.channelName} — schedule not read`, problem.message);
      }
    } catch (err: any) {
      this.sweepFailed.set(true);
      this.notify.warning('YouTube schedule not read', err?.message || String(err));
    } finally {
      this.sweeping.set(false);
    }
  }

  // ---------------------------------------------------------------- the tab strip

  /**
   * Which tab is on after a load: the remembered one if it still exists, else the first.
   *
   * The remembered value is compared against EVERY tab that exists, which now includes
   * `spreaker` — so a reload lands the operator back in the podcast lane rather than
   * bouncing to a channel he was not looking at. A remembered id for a channel that has
   * since been removed is still not honoured: the tab would show nothing and dim
   * everything, which reads as an empty board rather than as a stale preference.
   *
   * The list is never empty — the Spreaker tab is always in it — so there is always a tab
   * to be on, including on an install with no channels registered at all.
   */
  private settleActiveTab(): void {
    const tabs = this.tabIds();
    const remembered = localStorage.getItem(CHANNEL_TAB_KEY);
    const known = remembered !== null && tabs.includes(remembered);
    this.activeTabId.set(known ? remembered : tabs[0]);
  }

  setActiveTab(tabId: string): void {
    this.activeTabId.set(tabId);
    localStorage.setItem(CHANNEL_TAB_KEY, tabId);
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

  /**
   * How strongly this slot should offer itself to the drag in flight.
   *
   * `match` — the slot's lane is the item's lane. This is the obvious target.
   * `other` — a real target that will take the drop, drawn back so it is plainly the
   *           second answer. NOT refused: the app reports and does not enforce, and a
   *           podcast dropped at 2 PM or a video at 5 AM is the operator's decision to
   *           make. Refusing it would be this page inventing a rule the writer does not
   *           have.
   * `none`  — nothing is being dragged, or the slot is inside the writer's lead and is
   *           inert anyway.
   */
  dropAffinity(slot: SlotCell): 'match' | 'other' | 'none' {
    if (slot.isPast) return 'none';
    const dragging = this.draggingDestination();
    if (dragging === null) return 'none';
    return dragging === slot.destination ? 'match' : 'other';
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

  // ---------------------------------------------------------------- bulk upload

  /**
   * Open the confirm panel. Nothing is sent until the operator reads the list and agrees.
   */
  askUploadAll(): void {
    const chips = this.uploadable();
    if (chips.length === 0) return;
    this.uploadResults.set([]);
    this.uploadConfirm.set(chips);
  }

  closeUploadConfirm(): void {
    this.uploadConfirm.set(null);
  }

  dismissUploadResults(): void {
    this.uploadResults.set([]);
  }

  /**
   * Upload every ready item, ONE AT A TIME.
   *
   * Sequential is not caution for its own sake: these are multi-gigabyte files over one
   * connection, and running them together would make every upload slower while making the
   * failure of any one of them harder to attribute. The main process refuses a second
   * upload of the same item anyway.
   *
   * A FAILURE DOES NOT STOP THE RUN. Each item's refusal is captured verbatim against
   * that item and the next one starts — stopping would leave the remaining items in an
   * unexplained limbo, whereas a run that finishes with three failures listed is a run
   * the operator can act on. Nothing is retried automatically.
   */
  async confirmUploadAll(): Promise<void> {
    const chips = this.uploadConfirm();
    if (!chips || chips.length === 0) return;
    this.uploadConfirm.set(null);

    const results: UploadResult[] = [];
    this.uploadRun.set({
      queue: chips.map((c) => c.itemId),
      total: chips.length,
      index: 0,
      currentItemId: null,
      currentTitle: '',
      sentBytes: 0,
      totalBytes: 0,
      cancelling: false,
    });

    for (let i = 0; i < chips.length; i++) {
      const chip = chips[i];
      const run = this.uploadRun();
      if (!run || run.cancelling) break;

      this.uploadRun.set({
        ...run,
        index: i + 1,
        currentItemId: chip.itemId,
        currentTitle: chip.title,
        sentBytes: 0,
        totalBytes: 0,
      });

      try {
        const res = await this.electron.publishUploadYouTube(chip.itemId);
        if (!res.success || !res.data) {
          results.push({
            itemId: chip.itemId,
            title: chip.title,
            channelName: chip.channelName,
            ok: false,
            error: res.error ?? 'The upload failed and gave no reason.',
            remoteId: null,
          });
        } else {
          results.push({
            itemId: chip.itemId,
            title: chip.title,
            channelName: chip.channelName,
            ok: true,
            error: null,
            remoteId: res.data.receipt.videoId,
          });
        }
      } catch (err: any) {
        results.push({
          itemId: chip.itemId,
          title: chip.title,
          channelName: chip.channelName,
          ok: false,
          error: err?.message || String(err),
          remoteId: null,
        });
      }
      // Published as the run goes rather than at the end: a long run should show its
      // failures while it is still running, not only once everything has been attempted.
      this.uploadResults.set([...results]);
    }

    this.uploadRun.set(null);

    const failed = results.filter((r) => !r.ok).length;
    const sent = results.length - failed;
    if (failed === 0) {
      this.notify.success(
        'Uploads finished',
        `${sent} video${sent === 1 ? '' : 's'} created on YouTube, each private with its schedule.`
      );
    } else {
      // The per-item reasons stay in the results panel; this only says how it ended, so
      // an operator who walked away is told rather than left to find out.
      this.notify.error(
        'Uploads finished with failures',
        `${sent} uploaded, ${failed} failed. The reasons are listed on the calendar.`
      );
    }

    // The records now carry video ids, so the board must re-read them — and YouTube now
    // holds videos it did not a minute ago, so the mirror must too. AWAITED, unlike the
    // sweep on page load: the uploaded chips have just left the board, and until the
    // mirror answers their slots read as empty when they are in fact spoken for.
    await this.reload();
    await this.refreshSweep();
  }

  /**
   * Stop the run: abort what is in flight and skip the rest.
   *
   * The in-flight upload is aborted through the main process's own cancel, which is the
   * only thing that can stop a resumable transfer mid-file. Items already uploaded stay
   * uploaded — this stops the run, it does not undo it, and the results list says exactly
   * which ones got through.
   */
  async cancelUploadRun(): Promise<void> {
    const run = this.uploadRun();
    if (!run) return;
    this.uploadRun.set({ ...run, cancelling: true });
    if (run.currentItemId) {
      const res = await this.electron.publishUploadCancel(run.currentItemId);
      if (!res.success) this.report(res.error ?? 'The upload could not be cancelled.');
    }
  }

  /** `1.4 GB of 3.1 GB` for the item in flight. */
  runProgressLabel(run: UploadRun): string {
    if (run.totalBytes <= 0) return 'starting…';
    const gb = (n: number) => (n / 1_073_741_824).toFixed(2);
    return `${gb(run.sentBytes)} GB of ${gb(run.totalBytes)} GB`;
  }

  runProgressPercent(run: UploadRun): number {
    if (run.totalBytes <= 0) return 0;
    return Math.round((run.sentBytes / run.totalBytes) * 100);
  }

  // ------------------------------------------------------------- the Spreaker run

  /**
   * Open the Spreaker confirm panel.
   *
   * Nothing is sent until the list has been read, and this list is read for a different
   * reason from the YouTube one: there, the panel is guarding against creating a video on
   * the wrong channel; here it is guarding against a release happening NOW. That is why
   * every row prints its date and time — the date is the mechanism, not decoration.
   */
  askSpreakerRun(): void {
    const items = this.spreakerUploadable();
    if (items.length === 0) return;
    this.spreakerResults.set([]);
    this.spreakerConfirm.set(items);
  }

  closeSpreakerConfirm(): void {
    this.spreakerConfirm.set(null);
  }

  dismissSpreakerResults(): void {
    this.spreakerResults.set([]);
  }

  /**
   * Upload every dated, ready episode to Spreaker, ONE AT A TIME.
   *
   * The same sequential discipline as the YouTube run and for the same reasons: one
   * connection, one attributable failure, and a refusal recorded verbatim against its own
   * item while the rest of the run continues. There is no progress bar and no Stop, and
   * neither is an omission — the Spreaker push reports no bytes and the main process
   * offers no cancel for it, so drawing either would be drawing a control that does
   * nothing.
   *
   * The list is re-read from the panel rather than recomputed, so what is sent is exactly
   * what was agreed to, even if the board changed underneath while it was open.
   */
  async confirmSpreakerRun(): Promise<void> {
    const items = this.spreakerConfirm();
    if (!items || items.length === 0) return;
    this.spreakerConfirm.set(null);

    const results: UploadResult[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Re-checked HERE, not only when the list was built. Everything else in this run is
      // recoverable — a refusal is one line in the results — but a Spreaker push with no
      // date is a live release, and there is no unpublish. The panel can sit open while
      // the board changes underneath it, so the last thing before the call re-asks the
      // question the panel was opened to answer.
      if (item.publishAt === null) {
        results.push({
          itemId: item.itemId,
          title: item.title,
          channelName: SPREAKER_DESTINATION_LABEL,
          ok: false,
          error:
            'Not sent: this episode has no publish date any more, and Spreaker has no draft ' +
            'state — uploading it would have published it immediately.',
          remoteId: null,
        });
        this.spreakerResults.set([...results]);
        continue;
      }

      this.spreakerRun.set({ index: i + 1, total: items.length, title: item.title });
      try {
        const res = await this.electron.publishPushSpreaker(item.itemId);
        if (!res.success || !res.data) {
          results.push({
            itemId: item.itemId,
            title: item.title,
            channelName: SPREAKER_DESTINATION_LABEL,
            ok: false,
            error: res.error ?? 'The episode upload failed and gave no reason.',
            remoteId: null,
          });
        } else {
          results.push({
            itemId: item.itemId,
            title: item.title,
            channelName: SPREAKER_DESTINATION_LABEL,
            ok: true,
            error: null,
            remoteId: String(res.data.receipt.episodeId),
          });
        }
      } catch (err: any) {
        results.push({
          itemId: item.itemId,
          title: item.title,
          channelName: SPREAKER_DESTINATION_LABEL,
          ok: false,
          error: err?.message || String(err),
          remoteId: null,
        });
      }
      this.spreakerResults.set([...results]);
    }

    this.spreakerRun.set(null);

    const failed = results.filter((r) => !r.ok).length;
    const sent = results.length - failed;
    if (failed === 0) {
      this.notify.success(
        'Spreaker uploads finished',
        `${sent} episode${sent === 1 ? '' : 's'} uploaded, each carrying its scheduled date.`
      );
    } else {
      this.notify.error(
        'Spreaker uploads finished with failures',
        `${sent} uploaded, ${failed} failed. The reasons are listed on the calendar.`
      );
    }

    // The records now carry episode ids, and an episode id is what turns a chip's
    // readiness to done. Awaited for the same reason the YouTube run awaits its reload:
    // until it lands, the board is still offering to send what has just been sent. No
    // sweep follows — that reads YouTube, which knows nothing about any of this.
    await this.reload();
  }

  // ---------------------------------------------------------------- schedule push

  /**
   * Send every out-of-date schedule to YouTube, one at a time.
   *
   * status-only writes, so a title running a Test & Compare experiment is never touched
   * — the API cannot see those experiments, which is exactly why nothing here may write a
   * field it was not asked to write.
   *
   * Same failure discipline as the upload run: one refusal is recorded against its item,
   * verbatim, and the rest still go.
   */
  async pushSchedules(): Promise<void> {
    const chips = this.needsSchedulePush();
    if (chips.length === 0 || this.pushRun() !== null) return;

    this.pushResults.set([]);
    const results: UploadResult[] = [];

    for (let i = 0; i < chips.length; i++) {
      const chip = chips[i];
      this.pushRun.set({ index: i + 1, total: chips.length, title: chip.title });
      try {
        const res = await this.electron.publishPushSchedule(chip.itemId);
        results.push({
          itemId: chip.itemId,
          title: chip.title,
          channelName: chip.channelName,
          ok: res.success,
          error: res.success ? null : res.error ?? 'The schedule was refused with no reason given.',
          remoteId: chip.videoId,
        });
      } catch (err: any) {
        results.push({
          itemId: chip.itemId,
          title: chip.title,
          channelName: chip.channelName,
          ok: false,
          error: err?.message || String(err),
          remoteId: chip.videoId,
        });
      }
      this.pushResults.set([...results]);
    }

    this.pushRun.set(null);
    // Re-read YouTube: the whole point is that the board now agrees with it, and the only
    // way to show that honestly is to ask again rather than assume the writes landed.
    await this.refreshSweep();
  }

  dismissPushResults(): void {
    this.pushResults.set([]);
  }

  readonly pushFailures = computed(() => this.pushResults().filter((r) => !r.ok));

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
    activeTab: string | null,
    mirror: ReadonlyMap<string, ScheduledVideo>,
    mirrorBySlot: ReadonlyMap<string, MirrorChip>,
    linkedByVideoId: ReadonlyMap<string, LinkedVideo>
  ): CalendarChip {
    const publishAt = facts.publishAt as string;
    const at = new Date(publishAt);
    const channel = this.channelOf(facts.channelId);

    // YouTube's own answer OVERRIDES every local reading of the same record. The local
    // rules can only infer from a date and a status, and both of those describe what was
    // meant to happen; this describes what did.
    const remote = facts.videoId !== null ? linkedByVideoId.get(facts.videoId) ?? null : null;
    const live = remote !== null && remote.privacyStatus !== 'private' ? remote : null;
    const destination = destinationOf(facts);
    const state = live !== null ? 'published' : chipStateOf(facts, now);
    const published = state === 'published';

    // Still private, so YouTube can still take a date — and it does not have this one.
    // Null publishAt on a private video means it has never been given a schedule at all,
    // which is exactly what a drag leaves behind until something pushes it.
    const needsSchedulePush =
      remote !== null &&
      remote.privacyStatus === 'private' &&
      (remote.publishAt === null || new Date(remote.publishAt).getTime() !== at.getTime());

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
      dimmed: dimmedFor({ destination, channelId: facts.channelId }, channel.known, activeTab),
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
      mirrorDivergence:
        remote !== null && remote.privacyStatus === 'private' && remote.publishAt !== null
          ? new Date(remote.publishAt).getTime() === at.getTime()
            ? null
            : `YouTube has this at ${new Date(remote.publishAt).toLocaleString([], {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}`
          : null,
      destination,
      readiness: readinessOf(facts),
      missing: missingFor(facts),
      needsSchedulePush,
      liveNote:
        live !== null
          ? `live on YouTube since ${new Date(live.publishedAt).toLocaleDateString([], {
              month: 'short',
              day: 'numeric',
            })}` + (live.privacyStatus === 'public' ? '' : ` (${live.privacyStatus})`)
          : null,
      collision:
        mirrorBySlot.get(
          `${facts.channelId}|${dateKeyOf(at)}|${splitPublishAt(publishAt).time}`
        )?.title ?? null,
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
