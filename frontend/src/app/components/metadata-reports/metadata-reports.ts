import {
  Component,
  ElementRef,
  HostListener,
  OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { AnalyticsChannel, ElectronService, MetadataRoutingOption } from '../../services/electron';
import { NotificationService } from '../../services/notification';
import { PublishState } from '../../features/publish/publish-state';
import { YouTubePushDialog, YouTubePushDialogData } from '../../features/publish/youtube-push-dialog';
import {
  SpreakerUploadDialog,
  SpreakerUploadDialogData,
} from '../../features/publish/spreaker-upload-dialog';
import {
  MAX_AB_VARIANTS,
  SPREAKER_DESTINATION,
  SPREAKER_DESTINATION_LABEL,
  type PublishFacts,
  type ReportIndexEntry,
  type ThumbStripEntry,
} from '../../features/publish/publish.types';
import {
  CADENCE_NOTES,
  cadenceKeyFor,
  collidesWith,
  isCadenceSlot,
  nextOpenSlot,
  slotKeyOf,
  splitSlot,
  type CadenceKey,
} from '../../features/publish/publish-slots';
// The calendar's pure day arithmetic, reused rather than written a second time.
import { dateKeyOf, startOfMonth } from '../publish-calendar/calendar-states';
import {
  basename,
  describePublishAt,
  formatBytes,
  formatDuration,
  offsetLabel,
  offsetStringFor,
  splitPublishAt,
} from '../../features/publish/publish-schedule';
import type { AudioMeta } from '../../features/publish/publish.types';
import {
  describeProvenance,
  type ItemProvenance,
} from '../../features/transcript-link/transcript-link.types';

interface MetadataReport {
  name: string;
  path: string;
  date: Date;
  size: number;
  promptSet?: string; // The prompt set used for generation
  displayTitle?: string; // The actual title from the metadata
  txtFolder?: string; // Path to the folder containing txt files
  jobId?: string; // The job ID this item belongs to
  /**
   * The item's permanent id — what a delete names, and the only field here that keeps
   * meaning after a sibling is removed.
   *
   * Optional ONLY because the pre-`.contentstudio/metadata` legacy layout below has no
   * items to have ids: those rows are folders. Every row built from a job file has one,
   * and a job item without one is reported as corrupt rather than listed.
   */
  itemId?: string;
  itemIndex?: number; // Position within the job — for reading items[], never for identity
  txtFilePath?: string; // The TXT file this item recorded, when it recorded one
  selected?: boolean; // Selection state for batch operations
  /**
   * The source this run was generated from, as the index reports it. Re-runs of one
   * source share it, which is what collapses them under the newest.
   *
   * Absent for the pre-`.contentstudio/metadata` layout below, which has no such record —
   * those rows are each their own group rather than being lumped together by a guess.
   */
  sourceKey?: string | null;
  sourceFilename?: string | null;
  /**
   * Is this the DEFINITIVE set for its source — the one the calendar draws, the push sends
   * and the extension fills?
   *
   * The list shows one row per source, and that row is this one. Every OTHER set over the
   * same source is still in `reports()`, because the version picker on the item's page is
   * built from them; it is only the list that collapses to primaries.
   *
   * Absent for the pre-`.contentstudio/metadata` legacy layout below, whose rows are
   * folders with no items and therefore no siblings. See `isPrimaryRow`.
   */
  isPrimary?: boolean;
  /**
   * The item this set was SOFTENED FROM, or null when it is a generation run.
   *
   * What lets the version picker tell two sets of one video apart: they share a source,
   * chapters and timestamps, and differ only in their words.
   */
  softenedFromItemId?: string | null;
  /** How many titles the run produced. 0 is the failed-run state the list can filter for. */
  titleCount?: number;
  /** This item's publish record as the index joined it, or null when it has none yet. */
  facts?: PublishFacts | null;
  /**
   * The channel the prompt set routes to — the routing decision made at generation,
   * carried so the row is answered before any record exists. Stored channelId wins.
   */
  promptSetChannelId?: string | null;
  promptSetChannelName?: string | null;
  /** Why this item's publish record could not be read. The row still exists. */
  publishFault?: string | null;
}

// ---------------------------------------------------------------- page shell
//
// The two-pane report page: list | work. The work pane carries BOTH the metadata blocks
// and the publish record, on a two-tab bar — the record used to be a third column, and
// the 404px it held was width the description and the chapter list wanted more.
//
// The left split is a real pane, so its width belongs to the operator and outlives the
// session. A missing key is the first run, not a failure; a stored value outside the
// draggable range is clamped rather than allowed to hide the pane; and a value that is
// not a number at all is SAID rather than silently corrected, because something else
// wrote it.
//
// The MINIMUM is also the migration. Rows now carry a 72px thumbnail, so a stored width
// from before they existed would open the list too narrow to show one. Raising the floor
// widens those stored widths on read, without anyone having to remember to.
const LEFT_WIDTH_KEY = 'metadata-reports.left-width';
const LEFT_WIDTH_DEFAULT = 370;
const LEFT_WIDTH_MIN = 310;
const LEFT_WIDTH_MAX = 640;

/**
 * Which channel tab the list is filtered to, remembered across sessions like the split.
 *
 * The value is a channel id, or `UNROUTED_TAB` for the rows nothing routes. It is NOT
 * validated on read: the registry is not loaded yet at that moment, and a tab that no
 * longer exists is resolved against the tabs that DO exist every time they are computed.
 */
const CHANNEL_TAB_KEY = 'metadata-reports.channel-tab';

/** The trailing tab's value. Not a channel id, and no channel id can look like it. */
const UNROUTED_TAB = 'unrouted';

/**
 * How wide a list thumbnail is asked for, in px.
 *
 * Twice the 72px the row draws, so the image is still sharp on this Mac's 2x display.
 * The main process's ceiling is 512.
 */
const STRIP_MAX_PX = 144;

/** The main process takes at most this many ids in one strip call. */
const STRIP_BATCH = 300;

/** YouTube's description limit — what the character count is read against. */
const MAX_DESCRIPTION_CHARS = 5000;

/** Beyond this many tags the chip strip is clamped to two rows with a Show all. */
const TAGS_CLAMP_THRESHOLD = 8;

function clampLeftWidth(px: number): number {
  return Math.min(LEFT_WIDTH_MAX, Math.max(LEFT_WIDTH_MIN, Math.round(px)));
}

function readStoredLeftWidth(): number {
  const raw = localStorage.getItem(LEFT_WIDTH_KEY);
  if (raw === null) return LEFT_WIDTH_DEFAULT;
  const px = Number(raw);
  if (!Number.isFinite(px)) {
    console.warn(
      `[MetadataReports] ${LEFT_WIDTH_KEY} holds ${JSON.stringify(raw)}, which is not a ` +
        'width. The split opens at its default; dragging it writes a real one.',
    );
    return LEFT_WIDTH_DEFAULT;
  }
  return clampLeftWidth(px);
}

/** '' — no tab chosen yet — is the first run, and resolves to the first tab on screen. */
function readStoredChannelTab(): string {
  return localStorage.getItem(CHANNEL_TAB_KEY) ?? '';
}

/**
 * The six publish facts the readiness meter names and the list rows dot.
 *
 * ONE vocabulary for both surfaces, in one order, so learning either teaches the other:
 * TITLES · CHANNEL · MONEY · WHEN · THUMB · LINK. A row's six dots and the open item's
 * six ticks answer the same six questions about the same record.
 *
 * The old five (channel, schedule, ab, thumbnail, podcast) are all still here — "podcast"
 * stopped being a fact of its own when it became half of CHANNEL, which is now the one
 * routing decision: three YouTube channels or Spreaker.
 */
type TickKey = 'titles' | 'channel' | 'money' | 'when' | 'thumb' | 'link';

/**
 * Three values, never a fourth — plus `na` for a fact this destination does not have.
 *
 * set  — recorded.
 * unset— nothing recorded. A FACT, not a fault, and never counted as held.
 * warn  — recorded and suspect, or missing and blocking. This is the only one that asks
 *         anything of the operator, and the only one that is ever amber.
 * na    — the question does not apply to where this item is going (monetization on a
 *         Spreaker episode). Said, rather than shown as an unanswered question.
 */
type TickState = 'set' | 'unset' | 'warn' | 'na';

interface ReadinessTick {
  key: TickKey;
  /** The tick's short name, as the meter prints it. */
  label: string;
  state: TickState;
  /** What the record actually says, for the item header. Never a plausible stand-in. */
  value: string;
  hint: string;
}

/** One A/B slot: a VIEW of publish.chosenTitles(), never a second store. */
interface SlateSlot {
  /** 0-based slot. Slot 0 is variant 1 — the video's title and YouTube's fallback. */
  index: number;
  title: string | null;
  chars: number;
  /**
   * Which row of the generated list holds this exact text, or null when none does —
   * which is what an inline-edited variant looks like, since the generated report is
   * never rewritten. A slot with no row has nothing to scroll to and says so.
   */
  rowIndex: number | null;
}

/** A source's newest run, with its older runs collapsed underneath. */
/**
 * One SOURCE in the list: its primary set, and how many sets exist for it.
 *
 * This used to be `{ key, head, runs }` — the newest run at the head with the older ones
 * collapsed beneath it, expandable in place. The sets no longer belong in the list at all:
 * exactly one of them is the one the app publishes, and the choice between them is made on
 * the item's own page, where the words are on screen to choose by. `versionCount` is what
 * is left of the old disclosure control — a number saying "there are others", pointing at
 * where they now live.
 */
interface ReportGroup {
  key: string;
  head: MetadataReport;
  /** How many sets exist for this source, the head included. 1 for most rows. */
  versionCount: number;
}

/**
 * The list key for a row the index recorded no `source_key` for.
 *
 * UPPERCASE on purpose, and that is the whole guarantee: a real source_key is produced by
 * `normalizeForMatch`, which lowercases, so no source file can ever normalize to something
 * starting with this. It used to be a literal NUL byte typed into the template string here
 * — which made `grep` treat the whole file as binary and report zero matches for every
 * symbol in it — and, worse, it was written with a NUL in one place and a leading SPACE in
 * three others, so the key that opened a group and the key that counted one were not the
 * same string for these rows.
 */
const NO_SOURCE_KEY = 'SOURCELESS:';

/** One selectable metadata set for the open item's source, as the version picker shows it. */
interface ItemVersion {
  itemId: string;
  /** Generation time, what produced it, and whether it is the primary. */
  label: string;
  isPrimary: boolean;
}

/**
 * One tab of the list's channel strip: a channel, or the trailing "Unrouted".
 *
 * `count` is counted AFTER the search box and the segment filter, so the number on a tab
 * is exactly how many rows pressing it leaves on screen — the same discipline the segment
 * counts already keep.
 */
interface ChannelTab {
  value: string;
  label: string;
  count: number;
  /**
   * True when this channel is in the index but NOT in the registry. It gets a tab anyway,
   * labelled by its raw id: a tab strip is the only way to a row now, and a row nothing
   * offers a tab for would be a row that cannot be reached at all.
   */
  unknown: boolean;
}

/**
 * The work pane's two tabs.
 *
 * The pane head — crumb, title, readiness meter, error banner — is outside both: it
 * describes the ITEM, not either half of it, and a refusal that scrolled out of view with
 * the tab it was reported on would be a refusal nobody read.
 */
type WorkTab = 'metadata' | 'record';

/**
 * One value, two entry points: the four headline states are the segmented control, the
 * three narrower ones live in the "also" picker under it. Exactly one is ever active,
 * which is why they are one signal and not two. The channel is NOT one of them — it is
 * the tab strip above the search box, and it filters alongside this rather than instead.
 */
type StateFilter =
  | 'all'
  | 'needs-you'
  | 'scheduled'
  | 'ready'
  | 'unscheduled'
  | 'ab'
  | 'no-titles';

/** The four states the segmented control offers, in its 2x2 order. */
const SEGMENT_FILTERS: ReadonlyArray<{ value: StateFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'needs-you', label: 'Needs you' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'ready', label: 'Ready' },
];

/** The narrower states, kept because they are the ones that answer a specific question. */
const REFINE_FILTERS: ReadonlyArray<{ value: StateFilter; label: string }> = [
  { value: 'unscheduled', label: 'Unscheduled' },
  { value: 'ab', label: 'A/B picked' },
  { value: 'no-titles', label: 'No titles' },
];

/** One dot on a list row: the same six facts the meter names, at list resolution. */
interface RowDot {
  key: TickKey;
  state: TickState;
  label: string;
}

/** Which rail fact a tick opens. `titles` is in the work column and opens nothing here. */
type FactKey = 'destination' | 'money' | 'when' | 'thumb' | 'audio';

/**
 * Which rail row answers which tick, and back again.
 *
 * Declared as one pair of tables rather than as two switch statements, because the ONE
 * thing that must never drift is that a tick and the row it opens describe the same fact.
 * `titles` maps to null: it is the editorial act, and it lives in the work column.
 */
const FACT_FOR_TICK: Readonly<Record<TickKey, FactKey | null>> = {
  titles: null,
  channel: 'destination',
  money: 'money',
  when: 'when',
  thumb: 'thumb',
  // The Spreaker link IS the episode audio; for a YouTube item there is no rail row that
  // sets it, because nothing in this app uploads video or links a draft.
  link: 'audio',
};

const TICK_FOR_FACT: Readonly<Record<FactKey, TickKey | null>> = {
  destination: 'channel',
  money: 'money',
  when: 'when',
  thumb: 'thumb',
  audio: 'link',
};

/** One line of the dispatch manifest: exactly what this button would send. */
interface ManifestRow {
  label: string;
  value: string;
  /** True when this part will NOT be sent — rendered quiet, never as a value. */
  missing: boolean;
}

/** A day cell in the schedule row's calendar. */
interface CalendarDay {
  dateKey: string;
  date: Date;
  dayOfMonth: number;
  inMonth: boolean;
  isToday: boolean;
  isPast: boolean;
  /** How many OTHER items are already scheduled on this day, on any channel. */
  count: number;
  /** True when at least one of those is on this item's own channel. */
  onThisChannel: boolean;
  /** True when this day carries one of this channel's cadence slots. */
  isReleaseDay: boolean;
  selected: boolean;
}

interface ParsedMetadata {
  titles: string[];
  thumbnail_text: string[];
  description: string;
  tags: string | string[]; // Can be comma-separated string OR array
  hashtags: string;
  pinned_comment?: string[]; // Pinned comment suggestions
  clip_suggestions?: string[]; // Shorts-able moment suggestions
  chapters?: Array<{ timestamp: string; title: string; sequence: number }>; // YouTube chapter markers
  // Why this item has no chapters, as the run recorded it on the job JSON. Shown where
  // the chapter list would have been — a report read later has no other account of it.
  chaptersSkipped?: { outcome: 'failed' | 'skipped'; reason: string };
  /**
   * Which transcript wrote this item's words, as the run recorded it. Absent only for
   * items generated before the two-source split existed — the pane then says nothing
   * rather than claiming a mode nobody recorded.
   */
  content_provenance?: ItemProvenance;
  _title?: string; // The display title from the source
  _prompt_set?: string; // The prompt set used for generation
  /**
   * The prompts the run sent for this item, as the generator recorded them.
   *
   * Declared and carried because `promptTrace()` below reads it and the assets pane renders
   * it — it was being dropped by `normalizeMetadataKeys`, so the panel never appeared. It is
   * also what the titles model picker reads its default from: the model that wrote this
   * item's titles is the one the operator is most likely to want more of them from.
   */
  _prompt_trace?: Array<{ what: string; model: string; chars: number; at: string; prompt: string }>;
}

@Component({
  selector: 'app-metadata-reports',
  standalone: true,
  // Four Material pieces earn their keep here and the rest were dropped with the chrome
  // they used to carry: icons, the spinner, the tag chips (restyled flat, not fought) and
  // the dialog service the two confirmations open. Cards, lists, buttons and checkboxes
  // are plain elements now — they were being overridden into plain elements anyway.
  imports: [
    MatIconModule,
    MatProgressSpinnerModule,
    MatChipsModule,
    MatDialogModule,
    MatMenuModule,
    RouterLink,
  ],
  templateUrl: './metadata-reports.html',
  styleUrl: './metadata-reports.scss'
})
export class MetadataReports implements OnInit {
  reports = signal<MetadataReport[]>([]);
  /**
   * The main process's joined index, as it arrived — one entry per item, each carrying
   * its publish record's facts (channel, schedule, status).
   *
   * The list renders `reports()`; this is the same data before it was flattened into the
   * shape that list has always used, kept because it is what the publish calendar reads
   * and because it costs one call rather than two.
   */
  reportIndex = signal<ReportIndexEntry[]>([]);
  selectedReport = signal<MetadataReport | null>(null);
  metadata = signal<ParsedMetadata | null>(null);
  isLoading = signal(false);
  reportsDirectory = signal('');

  // Track copied state for visual feedback
  copiedItem = signal<string | null>(null);
  private copiedTimeout: any = null;

  // Publish feature: the operator's chosen A/B titles for the open item. Held in a
  // shared service rather than local state so features/publish/ owns the selection —
  // this component only renders it. That's the single seam between the generator UI
  // and the publish feature.
  readonly publish = inject(PublishState);
  readonly MAX_AB_VARIANTS = MAX_AB_VARIANTS;

  // ---------------------------------------------------------------- ten more titles
  //
  // The models the TITLES task offers, read from the same `metadata-routing:get` payload the
  // routing dialog is built from — so this picker and that dialog can never disagree about
  // what titles can run on. Read once per mount; the table is a property of the build.
  readonly moreTitlesOptions = signal<MetadataRoutingOption[]>([]);
  /** The option id the routing store currently has on titles — the picker's fallback seat. */
  private readonly routedTitlesOptionId = signal<string>('');
  /** What the operator has the picker set to. */
  readonly moreTitlesOptionId = signal<string>('');
  /** One request at a time, and the button says so while it is out. */
  readonly moreTitlesBusy = signal(false);

  // ------------------------------------------------------- soften for monetization
  //
  // The models the pass can run on, read from the same `metadata-routing:get` payload the
  // routing dialog and the titles picker are built from.
  //
  // THE DESCRIPTION TASK sources this list, and the authority for that is
  // services/metadata/soften.ts (SOFTEN_ROUTING_TASK), not this line: description is the one
  // task offering every rung the build ships, so it is the superset, and softening is a prose
  // rewrite any of them can perform. Drift is not silent — the main process validates the
  // chosen id against its OWN task and refuses by name, listing what that task offers.
  readonly softenOptions = signal<MetadataRoutingOption[]>([]);
  /** What the operator has the picker set to. */
  readonly softenOptionId = signal<string>('');
  /** The field currently in flight, or '' when nothing is out. Named on the button. */
  readonly softenBusyField = signal<string>('');
  /** One pass at a time. */
  readonly softenBusy = signal(false);

  // ----------------------------------------------------------- versions of one source
  //
  // A video can have more than one metadata set: re-running metadata mints a new item over
  // the same `source_key`, and so does a softening pass. Exactly ONE of them is the set this
  // app publishes — the calendar draws it, the push sends it, the extension fills it — and
  // this is where the operator switches between them and says which.
  //
  // The list no longer shows the others at all. It shows one row per source: the primary.

  /** True while a promotion is out. One at a time, and the button says so. */
  readonly settingPrimary = signal(false);

  /**
   * Every set over the open item's source, newest first, labelled so they can be told apart.
   *
   * Built from `reports()` — the WHOLE index, not the collapsed list — because that is the
   * only place the siblings still are. An item whose source_key is null has no siblings by
   * definition (null never joins to null; item-identity.ts), and this answers with the one
   * set that exists rather than with an empty picker.
   */
  readonly itemVersions = computed<ItemVersion[]>(() => {
    const open = this.selectedReport();
    if (!open?.itemId) return [];

    const siblings = open.sourceKey
      ? this.reports().filter((r) => r.sourceKey === open.sourceKey && r.itemId)
      : this.reports().filter((r) => r.itemId === open.itemId);

    return [...siblings]
      .sort(
        (a, b) =>
          b.date.getTime() - a.date.getTime() || (b.itemId ?? '').localeCompare(a.itemId ?? ''),
      )
      .map((report) => {
        // WHAT PRODUCED IT, which is the only thing that distinguishes two sets of one
        // video: they share a source, chapters and timestamps and differ only in wording.
        const origin = report.softenedFromItemId ? 'softened' : 'original run';
        const primary = this.isPrimaryRow(report) ? ' · primary' : '';
        return {
          itemId: report.itemId!,
          label: `${this.formatDate(report.date)} · ${origin}${primary}`,
          isPrimary: this.isPrimaryRow(report),
        };
      });
  });

  /** Is the set on screen the one this app publishes? */
  readonly selectedIsPrimary = computed<boolean>(() => {
    const open = this.selectedReport();
    if (!open?.itemId) return false;
    // Read off the INDEX rather than off the open row's own copy: a promotion re-reads the
    // list, and the object held in `selectedReport` is the one from before that read.
    const row = this.reports().find((r) => r.itemId === open.itemId);
    return this.isPrimaryRow(row ?? open);
  });

  constructor(
    private electron: ElectronService,
    private notificationService: NotificationService,
    private dialog: MatDialog,
    private route: ActivatedRoute
  ) {}

  // ================================================================ page shell (4.2)
  //
  // Three panes, each with its own scroll, and a page that never scrolls: a 30-chapter
  // report and a 5-chapter one are the same height. Nothing in this block reads or writes
  // anything new — it arranges what the page already had and states what the already
  // loaded record already says.

  readonly MAX_DESCRIPTION_CHARS = MAX_DESCRIPTION_CHARS;
  readonly TAGS_CLAMP_THRESHOLD = TAGS_CLAMP_THRESHOLD;

  /** One slot per A/B variant, always rendered — an empty slot is a state, not a gap. */
  readonly SLATE_SLOTS = Array.from({ length: MAX_AB_VARIANTS }, (_, i) => i);

  /** The draggable list/work split, in px, persisted across sessions. */
  readonly leftWidth = signal(readStoredLeftWidth());
  readonly draggingSplit = signal(false);

  /**
   * Which half of the work pane is showing. Deliberately NOT persisted: the tab is about
   * the item open right now, and an operator who left the record tab up last night is
   * opening this morning's item to write titles.
   */
  readonly workTab = signal<WorkTab>('metadata');

  showWorkTab(tab: WorkTab): void {
    this.workTab.set(tab);
  }

  @ViewChild('searchBox') private searchBox?: ElementRef<HTMLInputElement>;
  @ViewChild('titlesScroll') private titlesScroll?: ElementRef<HTMLElement>;
  @ViewChild('channelSelect') private channelSelect?: ElementRef<HTMLSelectElement>;
  @ViewChild('scheduleDateInput') private scheduleDateInput?: ElementRef<HTMLInputElement>;
  @ViewChild('thumbnailRow') private thumbnailRow?: ElementRef<HTMLElement>;
  @ViewChild('podcastRow') private podcastRow?: ElementRef<HTMLElement>;

  /**
   * Where the drag started, so the pane tracks the pointer exactly rather than snapping
   * by whatever padding sits between the grid's edge and the pane's.
   */
  private splitDragFrom: { x: number; width: number } | null = null;

  /**
   * Drag the split. Pointer capture rather than window listeners so a pointer that
   * leaves the window still ends the drag on release.
   */
  onSplitPointerDown(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    this.splitDragFrom = { x: event.clientX, width: this.leftWidth() };
    this.draggingSplit.set(true);
    event.preventDefault();
  }

  onSplitPointerMove(event: PointerEvent): void {
    const from = this.splitDragFrom;
    if (!from) return;
    this.leftWidth.set(clampLeftWidth(from.width + (event.clientX - from.x)));
  }

  onSplitPointerUp(event: PointerEvent): void {
    if (!this.splitDragFrom) return;
    const handle = event.currentTarget as HTMLElement;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    this.splitDragFrom = null;
    this.draggingSplit.set(false);
    localStorage.setItem(LEFT_WIDTH_KEY, String(this.leftWidth()));
  }

  // ------------------------------------------------------- left column (§1.7)

  readonly searchQuery = signal('');
  /**
   * The channel tab the operator last pressed, as stored. A channel id, `UNROUTED_TAB`,
   * or '' for "never pressed one". Read through `activeChannelTab()`, never directly —
   * a stored id whose channel has since been disconnected must not filter the list down
   * to nothing.
   */
  readonly storedChannelTab = signal(readStoredChannelTab());
  readonly stateFilter = signal<StateFilter>('all');


  /**
   * The channel registry: the list's tab strip, in the order the registry keeps them.
   *
   * The same call the publish panel and the calendar make. When it fails this stays empty
   * and the tabs are built from `publish.channels()` instead — the open item's own copy of
   * the same registry — and the failure is said out loud rather than leaving an empty tab
   * row that looks like "no channels are in use".
   */
  readonly registryChannels = signal<AnalyticsChannel[]>([]);

  /**
   * Where this row goes: the stored channel, or — for a row with no record yet — the
   * channel its prompt set routes to. `UNROUTED_TAB` when neither answers.
   *
   * The SAME answer the row's channel dot gives, which is what makes a tab's contents and
   * a row's own claim about itself impossible to disagree.
   */
  private channelOf(report: MetadataReport): string {
    return report.facts?.channelId ?? report.promptSetChannelId ?? UNROUTED_TAB;
  }

  /**
   * The channel tab strip: one tab per registered channel, in registry order, then any
   * channel the index uses that the registry does not know, then "Unrouted".
   *
   * Counted with the search box and the segment filter applied but NOT the channel — a
   * tab has to be able to say how many rows it would leave without becoming the current
   * tab first. Sources are counted rather than rows, for the reason the segment counts
   * are: six re-runs of one source are one line in the list.
   *
   * A channel present in the index but absent from the registry still gets a tab, wearing
   * its raw id. There is no "all" tab, so a channel with no tab would be rows nobody can
   * reach; showing the id is the honest version of that.
   *
   * "Unrouted" is last, and only when something is actually unrouted.
   */
  readonly channelTabs = computed<ChannelTab[]>(() => {
    const state = this.stateFilter();
    const sources = new Map<string, Set<string>>();
    for (const report of this.reports()) {
      // '' as the channel means "do not filter by channel" — this is the count BEFORE
      // the tab, which is the only count a tab can honestly print on itself.
      if (!this.matchesFilters(report, state, '')) continue;
      const id = this.channelOf(report);
      const key = report.sourceKey ?? `${NO_SOURCE_KEY}${report.itemId ?? report.path}`;
      const bucket = sources.get(id);
      if (bucket) bucket.add(key);
      else sources.set(id, new Set<string>([key]));
    }

    const registry = this.registryChannels().length
      ? this.registryChannels()
      : this.publish.channels();

    const tabs: ChannelTab[] = registry.map((channel) => ({
      value: channel.channelId,
      label: channel.name,
      count: sources.get(channel.channelId)?.size ?? 0,
      unknown: false,
    }));

    const known = new Set(tabs.map((t) => t.value));
    for (const [id, keys] of sources) {
      if (id === UNROUTED_TAB || known.has(id)) continue;
      tabs.push({ value: id, label: id, count: keys.size, unknown: true });
    }

    const unrouted = sources.get(UNROUTED_TAB)?.size ?? 0;
    if (unrouted > 0) {
      tabs.push({ value: UNROUTED_TAB, label: 'Unrouted', count: unrouted, unknown: false });
    }
    return tabs;
  });

  /**
   * The tab actually in force: the stored one when it is still on screen, otherwise the
   * first tab there is.
   *
   * '' — which is what this answers while the registry is still loading and no tab has
   * been drawn — means no channel filter at all. The list then shows every row rather
   * than none, which is the truthful state of a list nobody has narrowed yet.
   */
  readonly activeChannelTab = computed<string>(() => {
    const tabs = this.channelTabs();
    if (tabs.length === 0) return '';
    const stored = this.storedChannelTab();
    return tabs.some((t) => t.value === stored) ? stored : tabs[0].value;
  });

  chooseChannelTab(value: string): void {
    this.storedChannelTab.set(value);
    localStorage.setItem(CHANNEL_TAB_KEY, value);
  }

  // ------------------------------------------------------- row thumbnails (§D)
  //
  // Every visible row draws the item's thumbnail at 72x40. The images are decoded and
  // downscaled in the main process and arrive as data URLs, so the renderer still never
  // touches the operator's external volume and webSecurity stays on.
  //
  // They are fetched in BATCHES keyed off what is on screen — one call per index load and
  // per filter change, not one per row. 111 rows would otherwise be 111 IPC round trips
  // and 111 image decodes every time the search box was typed in.

  /**
   * itemId -> what the strip call said about it.
   *
   * An entry exists for every id that has been ASKED about, including the ones that came
   * back with nothing and the ones that failed: a missing entry means "not asked yet", and
   * that is the only thing that triggers a fetch. An id that failed and was left out would
   * be asked about again on every re-render, forever.
   */
  private readonly thumbStrip = signal<ReadonlyMap<string, ThumbStripEntry>>(new Map());

  /** Ids in a call that has not answered yet — so two renders do not both ask. */
  private readonly stripInFlight = new Set<string>();

  /** This row's thumbnail, or null when nothing has been asked or answered for it yet. */
  thumbFor(report: MetadataReport): ThumbStripEntry | null {
    const id = report.itemId;
    if (!id) return null;
    return this.thumbStrip().get(id) ?? null;
  }

  /**
   * Ask for every visible row whose thumbnail has not been asked for.
   *
   * Reads both `visibleReports()` and the cache, so it re-runs when the list changes AND
   * when an entry is invalidated — which is how a rescan or a drop gets a fresh image
   * without a full index reload.
   */
  private readonly stripFetcher = effect(() => {
    const cached = this.thumbStrip();
    const wanted: string[] = [];
    for (const report of this.visibleReports()) {
      const id = report.itemId;
      if (!id || cached.has(id) || this.stripInFlight.has(id)) continue;
      if (!wanted.includes(id)) wanted.push(id);
    }
    if (wanted.length === 0) return;
    void this.fetchThumbStrip(wanted);
  });

  /**
   * The open item's row image follows its record, live.
   *
   * Every door a thumbnail can arrive or leave through — drop, change, clear, proposal
   * confirm, carry-forward, rescan — lands on the selection's thumbnailPath/Source
   * signals, so watching those is one invalidation instead of one per call site (call
   * sites were tried first and clearThumbnail/confirmProposal were missed; operator,
   * 2026-08-25: "when I link a thumbnail it should automatically load on the side").
   * The tuple is re-baselined when the selection ITSELF changes, so switching rows does
   * not read as that row's thumbnail changing.
   */
  private lastThumbTuple: { id: string | null; path: string | null; source: string | null } | null = null;
  private readonly selectionThumbWatcher = effect(() => {
    const id = this.selectedReport()?.itemId ?? null;
    const path = this.publish.thumbnailPath();
    const source = this.publish.thumbnailSource();
    const prev = this.lastThumbTuple;
    this.lastThumbTuple = { id, path, source };
    if (!id || !prev || prev.id !== id) return;
    if (prev.path === path && prev.source === source) return;
    this.invalidateThumbStrip([id]);
  });

  /**
   * One strip call per batch of ids, merged into the cache as each answers.
   *
   * A failed call is SAID and every id in it is cached carrying the failure as its fault,
   * which is what the broken placeholder's tooltip then shows. Leaving them uncached would
   * put the fetcher above into a loop against a main process that is already unhappy.
   */
  private async fetchThumbStrip(ids: string[]): Promise<void> {
    for (const id of ids) this.stripInFlight.add(id);
    try {
      for (let i = 0; i < ids.length; i += STRIP_BATCH) {
        const batch = ids.slice(i, i + STRIP_BATCH);
        const res = await this.electron.publishThumbStrip(batch, STRIP_MAX_PX);
        const next = new Map(this.thumbStrip());
        if (!res.success || !res.data) {
          const fault =
            `The thumbnail strip could not be read (${res.error ?? 'no reason given'}).`;
          this.notificationService.warning('Row thumbnails unavailable', fault);
          for (const id of batch) next.set(id, { itemId: id, dataUrl: null, fault });
        } else {
          for (const entry of res.data) next.set(entry.itemId, entry);
          // An id the main process did not answer for at all is not the same as one it
          // answered "nothing" for, and it must still be cached or it is asked forever.
          const answered = new Set(res.data.map((e) => e.itemId));
          for (const id of batch) {
            if (answered.has(id)) continue;
            next.set(id, {
              itemId: id,
              dataUrl: null,
              fault: 'The thumbnail strip call returned no entry for this item.',
            });
          }
        }
        this.thumbStrip.set(next);
      }
    } finally {
      for (const id of ids) this.stripInFlight.delete(id);
    }
  }

  /** Forget what we know about these items' thumbnails; the fetcher re-asks on sight. */
  private invalidateThumbStrip(itemIds: Iterable<string>): void {
    const next = new Map(this.thumbStrip());
    let changed = false;
    for (const id of itemIds) {
      if (next.delete(id)) changed = true;
    }
    if (changed) this.thumbStrip.set(next);
  }

  // ------------------------------------------------------- move to another channel (§C)

  /**
   * Send this item to a different channel.
   *
   * The operator generates under one prompt set and then decides the video belongs on
   * another channel; the prompt set's routing is a default, not a verdict. Written
   * straight to the record — an explicit channelId is what stops the automatic routing
   * from putting it back — and then the index is re-read so the row hops tabs.
   *
   * When the moved item is the one open, its publish facts are re-read the same way
   * selecting it would, so the record tab and the readiness meter cannot go on naming the
   * old channel.
   */
  async moveToChannel(report: MetadataReport, channelId: string, event: Event): Promise<void> {
    event.stopPropagation();
    const itemId = report.itemId;
    if (!itemId) {
      this.notificationService.error(
        'That row cannot be moved',
        `"${report.displayTitle || report.name}" has no item id — it is from the older ` +
          'on-disk layout, which has no publish record to write a channel to.',
      );
      return;
    }

    const res = await this.electron.publishSetFields(itemId, { channelId });
    if (!res.success) {
      this.notificationService.error(
        'Could not move that item',
        res.error ?? 'The main process refused the write and gave no reason.',
      );
      return;
    }

    if (this.selectedReport()?.itemId === itemId) {
      await this.publish.load(itemId, report.promptSet);
    }
    await this.loadReports();
    this.notificationService.success(
      'Moved',
      `"${report.displayTitle || report.name}" is now routed to ${this.channelNameFor(channelId)}.`,
    );
  }

  /**
   * A hand-applied "this one is done": the operator uploaded the video himself, outside
   * both the API and the extension, and the record catches up here. Only offered on rows
   * without a videoId — a linked row is already done as a matter of fact, and a mark on
   * top of a fact would be a second answer to a question with one.
   */
  canMarkPublished(report: MetadataReport): boolean {
    return !!report.itemId && !report.facts?.videoId && report.facts?.status !== 'published';
  }

  /** The mark is showing and can be taken back — again only where it IS a mark. */
  canUnmarkPublished(report: MetadataReport): boolean {
    return !!report.itemId && !report.facts?.videoId && report.facts?.status === 'published';
  }

  async setPublishedMark(report: MetadataReport, published: boolean, event: Event): Promise<void> {
    event.stopPropagation();
    const itemId = report.itemId;
    if (!itemId) return;

    const res = await this.electron.publishMarkPublished(itemId, published);
    if (!res.success) {
      this.notificationService.error(
        published ? 'Could not mark that item published' : 'Could not take the mark back',
        res.error ?? 'The main process refused the write and gave no reason.',
      );
      return;
    }

    if (this.selectedReport()?.itemId === itemId) {
      await this.publish.load(itemId, report.promptSet);
    }
    await this.loadReports();
    this.notificationService.success(
      published ? 'Marked published' : 'Mark taken back',
      published
        ? `"${report.displayTitle || report.name}" now counts as done and sinks in the list.`
        : `"${report.displayTitle || report.name}" is back among the pending items.`,
    );
  }

  /** The channels this row is NOT on — everything the overflow menu can offer it. */
  otherChannels(report: MetadataReport): AnalyticsChannel[] {
    const registry = this.registryChannels().length
      ? this.registryChannels()
      : this.publish.channels();
    const current = this.channelOf(report);
    return registry.filter((c) => c.channelId !== current);
  }

  /**
   * Does this row survive the search box, the channel picker and one state filter?
   *
   * The state is a PARAMETER rather than a read of the signal, because the segmented
   * control has to be able to count what each of its four segments would leave on screen
   * without becoming that segment first. Writing the signal to ask the question — which is
   * what the first draft of this did — is a write inside a computed, and Angular is right
   * to refuse it.
   */
  private matchesFilters(
    report: MetadataReport,
    state: StateFilter = this.stateFilter(),
    channel: string = this.activeChannelTab(),
  ): boolean {
    const query = this.searchQuery().trim().toLowerCase();
    if (query) {
      const haystack = [report.displayTitle, report.name, report.sourceFilename]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    // '' is the no-tab-yet state (see activeChannelTab) and filters nothing.
    if (channel && this.channelOf(report) !== channel) return false;

    switch (state) {
      case 'scheduled':
        return !!report.facts?.publishAt;
      case 'unscheduled':
        return !report.facts?.publishAt;
      case 'ab':
        return (report.facts?.abCount ?? 0) > 0;
      case 'no-titles':
        // Only rows whose run RECORDED a title count answer this. A legacy row has no
        // count, which is not the same claim as "it produced none".
        return report.titleCount === 0;
      // The triage view: at least one of this row's six facts is amber — on a row that
      // is not already done. A published or uploaded item may well be missing facts,
      // but nothing about it needs the operator any more, and a triage view that keeps
      // re-surfacing the finished backlog is a triage view nobody trusts. Read from the
      // SAME rowDots() the row draws, so what the filter selects is exactly what the eye
      // would have picked out of the list by hand.
      case 'needs-you':
        return !this.isUploaded(report) && this.rowDots(report).some((dot) => dot.state === 'warn');
      // Nothing amber and every fact that can be recorded is. Deliberately stricter than
      // "not held": a row here needs no further decision at list resolution.
      case 'ready':
        return this.rowDots(report).every((dot) => dot.state === 'set' || dot.state === 'na');
      case 'all':
        return true;
    }
  }

  /**
   * The four segments, each with how many rows it would leave on screen.
   *
   * Counted with the SAME predicate the list runs, so the number on a segment and the
   * number of rows you get when you press it can never be two different rules. Sources are
   * counted, not rows, so a source with six re-runs counts once — which is what the list
   * shows when its group is collapsed.
   */
  readonly segmentFilters = computed(() => {
    const counts = new Map<StateFilter, Set<string>>(
      SEGMENT_FILTERS.map((f) => [f.value, new Set<string>()]),
    );
    for (const report of this.reports()) {
      const key = report.sourceKey ?? `${NO_SOURCE_KEY}${report.itemId ?? report.path}`;
      for (const f of SEGMENT_FILTERS) {
        if (this.matchesFilters(report, f.value)) counts.get(f.value)!.add(key);
      }
    }
    return SEGMENT_FILTERS.map((f) => ({ ...f, count: counts.get(f.value)!.size }));
  });

  readonly REFINE_FILTERS = REFINE_FILTERS;

  /** '' when the segmented control owns the current value — the picker then reads "also". */
  refineValue(): string {
    const current = this.stateFilter();
    return REFINE_FILTERS.some((f) => f.value === current) ? current : '';
  }

  onRefineChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value === '') {
      this.stateFilter.set('all');
      return;
    }
    const known = REFINE_FILTERS.find((f) => f.value === value);
    if (!known) {
      // The template owns these options; anything else means the two have drifted, and
      // filtering by a state nobody defined would quietly show the wrong rows.
      this.notificationService.error(
        'Unknown filter',
        `The filter picker offered "${value}", which this handler does not know. The list ` +
          'was left as it was.',
      );
      return;
    }
    this.stateFilter.set(known.value);
  }

  /**
   * Is this row the definitive set for its source?
   *
   * The index answers it for every row it produced, including `true` for an item whose
   * `source_key` is null — no source file, no siblings, its own primary by definition.
   * `undefined` is reachable only from the pre-`.contentstudio/metadata` legacy layout
   * below, whose rows are FOLDERS with no items: the same situation, arrived at from a
   * different place, and the same answer.
   */
  isPrimaryRow(report: MetadataReport): boolean {
    return report.isPrimary ?? true;
  }

  /**
   * The list as it renders: ONE ROW PER SOURCE — its primary set.
   *
   * It used to be the newest run per source with the older ones collapsed under it. Now
   * exactly one set of each video is the one this app publishes, so exactly one of them is
   * the row: a list that offered six near-identical rows and left the operator to work out
   * which one the calendar would honour is the problem this feature exists to end.
   *
   * FILTERED ON THE PRIMARY, not on whichever sibling happens to match. A source whose
   * primary does not match the search or the segment drops out — which is the honest
   * answer now that the primary IS the source as far as this list is concerned.
   */
  readonly visibleGroups = computed<ReportGroup[]>(() => {
    // Counted over EVERY row, before the filter: how many sets a source has is a fact
    // about the source, not about what the search box is showing.
    const versionCounts = new Map<string, number>();
    for (const report of this.reports()) {
      if (!report.sourceKey) continue;
      versionCounts.set(report.sourceKey, (versionCounts.get(report.sourceKey) ?? 0) + 1);
    }

    const groups: ReportGroup[] = [];
    for (const report of this.reports()) {
      if (!this.isPrimaryRow(report)) continue;
      if (!this.matchesFilters(report)) continue;
      // A row with no source key is its own group: the index did not record what it was
      // generated from, and grouping it with anything would be a guess.
      const key = report.sourceKey ?? `${NO_SOURCE_KEY}${report.itemId ?? report.path}`;
      groups.push({
        key,
        head: report,
        versionCount: report.sourceKey ? (versionCounts.get(report.sourceKey) ?? 1) : 1,
      });
    }

    // Done sources sink. A group whose newest run is finished with this page — its video
    // is on YouTube, or its record was marked published — stays clickable and stays in
    // its tab, but it stops competing for the top of the list with the ones that still
    // need a decision. Both buckets keep the order they were built in, which is the
    // index's own order.
    const pending = groups.filter((g) => !this.isUploaded(g.head));
    const uploaded = groups.filter((g) => this.isUploaded(g.head));
    return [...pending, ...uploaded];
  });

  /**
   * Is this row done with this page?
   *
   * Two facts answer yes: `videoId` — a linked draft is a video that exists, whatever
   * its status — and `status === 'published'`, which is how the pre-API backlog was
   * marked complete in bulk (operator, 2026-08-25: everything generated before that day
   * went out through the old workflow). Rows that answer yes sink and go quiet.
   */
  isUploaded(report: MetadataReport): boolean {
    return !!report.facts?.videoId || report.facts?.status === 'published';
  }

  /** Every row on screen — one per source. */
  readonly visibleReports = computed<MetadataReport[]>(() =>
    this.visibleGroups().map((group) => group.head),
  );

  focusSearch(): void {
    const input = this.searchBox?.nativeElement;
    if (!input) return;
    input.focus();
    input.select();
  }

  /** ⌘F / Ctrl-F puts the caret in the report search box (§1.5). */
  @HostListener('window:keydown', ['$event'])
  onWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== 'f' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    this.focusSearch();
  }

  /**
   * This row's six facts, in the meter's order and the meter's vocabulary.
   *
   * Read from the INDEX's projection of the record, which is a smaller thing than the
   * record: it knows whether there is a thumbnail, not whether that thumbnail is small,
   * and it knows nothing at all about monetization. Every fact the index cannot answer is
   * `unset` here rather than guessed at, and the open item's meter — which reads the whole
   * record — is where the finer answer lives. A row never claims more than the index said.
   *
   * A row with NO record at all still gets six dots, all hollow. "Nobody has touched this"
   * is an answer, and six hollow rings say it in the same shape as every other row.
   */
  rowDots(report: MetadataReport): RowDot[] {
    const facts = report.facts;
    const ab = facts?.abCount ?? 0;
    const titleCount = report.titleCount;

    // A run that produced NOTHING to pick from is the one row-level warning that is about
    // the generator rather than about a decision the operator has not made yet.
    const titles: RowDot =
      titleCount === 0
        ? { key: 'titles', state: 'warn', label: 'This run produced no titles.' }
        : ab >= MAX_AB_VARIANTS
          ? { key: 'titles', state: 'set', label: `All ${MAX_AB_VARIANTS} A/B variants picked` }
          : ab === 0
            ? { key: 'titles', state: 'warn', label: 'No title picked — variant 1 is the video title.' }
            : { key: 'titles', state: 'unset', label: `${ab} of ${MAX_AB_VARIANTS} A/B variants picked` };

    // The prompt set answers the channel BEFORE any record exists — the routing decision
    // was made at generation when the operator picked the prompt set (2026-08-24). A
    // stored channelId still wins; the amber survives only for an item nothing routes.
    const channel: RowDot = facts?.isPodcast
      ? { key: 'channel', state: 'set', label: `Routed to ${SPREAKER_DESTINATION_LABEL}` }
      : facts?.channelId
        ? { key: 'channel', state: 'set', label: `Routed to ${this.channelNameFor(facts.channelId)}` }
        : report.promptSetChannelName
          ? {
              key: 'channel',
              state: 'set',
              label:
                `Routed to ${report.promptSetChannelName} — from prompt set ` +
                `"${report.promptSet}"; recorded with the first save.`,
            }
          : { key: 'channel', state: 'warn', label: 'Not routed to a destination yet.' };

    // One state on YouTube, because there is one answer: monetization is on for every
    // video. The dot is kept rather than dropped from the row — a fact row that stops
    // mentioning money reads as a fact row that forgot to check.
    const money: RowDot = facts?.isPodcast
      ? { key: 'money', state: 'na', label: 'Monetization is a YouTube setting; this goes to Spreaker.' }
      : { key: 'money', state: 'set', label: 'Monetized — every video is.' };

    const when: RowDot = facts?.publishAt
      ? new Date(facts.publishAt).getTime() < Date.now()
        ? { key: 'when', state: 'warn', label: 'The scheduled time has already passed.' }
        : { key: 'when', state: 'set', label: 'Scheduled' }
      : { key: 'when', state: 'unset', label: 'No publish time recorded.' };

    const thumb: RowDot = facts?.hasThumbnail
      ? { key: 'thumb', state: 'set', label: 'Thumbnail attached' }
      : { key: 'thumb', state: 'unset', label: 'No thumbnail chosen.' };

    const link: RowDot = facts?.isPodcast
      ? facts.spreakerEpisodeId !== null
        ? { key: 'link', state: 'set', label: `Uploaded as episode ${facts.spreakerEpisodeId}` }
        : { key: 'link', state: 'warn', label: 'No Spreaker episode yet.' }
      : facts?.videoId
        ? { key: 'link', state: 'set', label: `Linked to video ${facts.videoId}` }
        : // Hollow, not amber (2026-08-24): an unlinked draft is a FACT about where the
          // browser-side upload stands, not a fault this page can act on. The open item's
          // meter still ambers it when it is the one thing holding a dispatch.
          {
            key: 'link',
            state: 'unset',
            label: 'Not linked to a YouTube video yet — upload the draft in the browser, then link it here.',
          };

    return [titles, channel, money, when, thumb, link];
  }

  /** A channel's registry name, or its raw id when the registry has no name for it. */
  private channelNameFor(channelId: string): string {
    const known = this.registryChannels().find((c) => c.channelId === channelId);
    return known ? known.name : channelId;
  }

  // -------------------------------------------- the readiness meter (§1.3, 4.4)

  /**
   * The six ticks that answer "is this ready", built ONLY from the record already on
   * screen. Nothing here is inferred: a field with nothing in it reads as an unanswered
   * question, never as a plausible value.
   *
   * Every reason the dispatch button can be held maps to exactly ONE amber tick, which is
   * what keeps `HELD - n` and the button's own refusal from ever disagreeing.
   */
  readonly readinessTicks = computed<ReadinessTick[]>(() => {
    const toSpreaker = this.publish.isPodcast();
    const ticks: ReadinessTick[] = [];

    // -- TITLES -- variant 1 is the video's title, so zero picked is what blocks a push.
    const chosen = this.publish.chosenCount();
    ticks.push({
      key: 'titles',
      label: 'Titles',
      state: chosen === MAX_AB_VARIANTS ? 'set' : chosen === 0 ? 'warn' : 'unset',
      value: `${chosen}/${MAX_AB_VARIANTS}`,
      hint:
        chosen === 0
          ? 'No titles picked. Variant 1 is what goes on the video, so nothing can be sent yet.'
          : `${chosen} picked, in click order — #1 is the video's title and YouTube's fallback.`,
    });

    // -- CHANNEL -- one routing decision: a YouTube channel, or Spreaker.
    const unknown = this.publish.unknownStoredChannel();
    const storedChannel = this.publish.channelId();
    if (toSpreaker) {
      ticks.push({
        key: 'channel',
        label: 'Channel',
        state: 'set',
        value: SPREAKER_DESTINATION_LABEL,
        hint: 'This item is routed to the podcast feed. Its dispatch is a Spreaker upload.',
      });
    } else if (unknown) {
      ticks.push({
        key: 'channel',
        label: 'Channel',
        state: 'warn',
        value: unknown,
        hint:
          `Routed to ${unknown}, which is not in the channel registry — the picker cannot ` +
          'show it. Re-connect that channel or choose another.',
      });
    } else if (storedChannel) {
      ticks.push({
        key: 'channel',
        label: 'Channel',
        state: 'set',
        value: this.channelNameFor(storedChannel),
        hint: 'The channel this item is routed to.',
      });
    } else if (this.publish.channelIsSuggested()) {
      // The routing decision was made at generation, when the prompt set was picked
      // (2026-08-24) — the suggestion IS the answer, and the auto-route writes it into
      // the record on the first save of anything. Not 'warn': there is no decision left
      // to make here.
      const suggestedId = this.publish.selectedChannelId();
      ticks.push({
        key: 'channel',
        label: 'Channel',
        state: 'set',
        value: suggestedId ? this.channelNameFor(suggestedId) : 'routed',
        hint:
          `${this.publish.channelNote() ?? ''} Routed from the prompt set picked at ` +
          'generation; recorded with the first save.',
      });
    } else {
      ticks.push({
        key: 'channel',
        label: 'Channel',
        state: 'warn',
        value: 'not routed',
        hint: 'No destination is recorded. Pick a channel, or Spreaker.',
      });
    }

    // -- MONEY -- one answer, stated rather than asked. See PublishState.monetize.
    ticks.push(
      toSpreaker
        ? {
            key: 'money',
            label: 'Money',
            state: 'na',
            value: '—',
            hint: 'Monetization is a YouTube Studio setting. This item goes to Spreaker.',
          }
        : {
            key: 'money',
            label: 'Money',
            state: 'set',
            value: 'on',
            hint:
              'Every video is monetized. The extension switches it on in Studio\'s ' +
              'Monetization tab when you click it there.',
          },
    );

    // -- WHEN -- a lapsed schedule is the one that needs saying out loud.
    const when = this.scheduleDescription();
    ticks.push(
      when
        ? {
            key: 'when',
            label: 'When',
            state: when.isPast || !when.offsetsAgree ? 'warn' : 'set',
            value: when.local,
            hint: when.isPast
              ? `This time passed ${when.relative}. Pushing now would publish immediately.`
              : !when.offsetsAgree
                ? `Stored as ${when.raw} (${when.storedOffset}), read here in ${when.localOffset}.`
                : `${when.localOffset} · ${when.relative}`,
          }
        : {
            key: 'when',
            label: 'When',
            state: 'unset',
            value: 'no schedule',
            hint: 'No publish time recorded. Open this for the next open slot on the channel.',
          },
    );

    // -- THUMB -- destination-independent: the record holds one either way.
    const warnings = this.publish.thumbnailWarnings();
    const proposal = this.publish.proposal();
    const thumbnailPath = this.publish.thumbnailPath();
    if (thumbnailPath) {
      // WHO attached it is in the hint, not the state: an image found beside the export is
      // as usable as one picked by hand, so it is not a warning — but "you have not looked
      // at this one" is worth being able to read off the row.
      const source = this.publish.thumbnailSource();
      ticks.push({
        key: 'thumb',
        label: 'Thumb',
        state: warnings.length ? 'warn' : 'set',
        value: this.fileName(thumbnailPath),
        hint: warnings.length
          ? warnings.join(' ')
          : source === 'auto'
            ? 'Found automatically beside the export. Choose or drop another to replace it.'
            : 'A thumbnail is attached.',
      });
    } else if (proposal) {
      ticks.push({
        key: 'thumb',
        label: 'Thumb',
        state: 'warn',
        value: 'proposed — not applied',
        hint: 'An image was exported beside this video. Check the slot number, then confirm it.',
      });
    } else {
      ticks.push({
        key: 'thumb',
        label: 'Thumb',
        state: 'unset',
        value: 'none',
        hint: 'No thumbnail chosen.',
      });
    }

    // -- LINK -- what "the thing this dispatches to" is, per destination.
    if (toSpreaker) {
      const episodeId = this.publish.spreakerEpisodeId();
      const audio = this.publish.spreakerAudioPath();
      ticks.push({
        key: 'link',
        label: 'Link',
        state: episodeId !== null || audio ? 'set' : 'warn',
        value:
          episodeId !== null ? `episode ${episodeId}` : audio ? this.fileName(audio) : 'no audio',
        hint:
          episodeId !== null
            ? `Already uploaded as episode ${episodeId}. A second upload is a second episode.`
            : audio
              ? 'The episode audio this upload would send.'
              : 'No episode audio is chosen, and an episode is the audio.',
      });
    } else {
      const videoId = this.publish.videoId();
      // Unlinked is hollow, not amber (2026-08-24): the upload happens in the browser,
      // so there is nothing on this page to do about it until dispatch time — and the
      // disagreement check below still ambers this tick the moment it is the one thing
      // refusing the button.
      ticks.push({
        key: 'link',
        label: 'Link',
        state: videoId ? 'set' : 'unset',
        value: videoId ?? 'no video',
        hint: videoId
          ? `Writes to video ${videoId}. Nothing here uploads video.`
          : 'Not linked to a YouTube video yet. Upload the draft in the browser and link it.',
      });
    }

    // The meter and the dispatch button must never disagree. Every refusal the button can
    // give is meant to land on exactly one amber tick above — but the two rules live in
    // two places (this method, and PublishState's blocked-reason computeds), and a rule
    // added to one and not the other would show READY over a button that will not go.
    //
    // So the disagreement is checked rather than assumed: if something is refusing the
    // dispatch and nothing here is amber, the refusal is put on the LINK tick verbatim.
    // A meter that says READY over a dead button is the one failure this cannot have.
    // Which refusal applies follows the dispatch itself: an unlinked YouTube item's
    // dispatch is an UPLOAD, and holding it against the push's "not linked" refusal
    // would show HELD over a button that is ready to go.
    const blocked = toSpreaker
      ? this.publish.spreakerBlockedReason()
      : this.publish.videoId()
        ? this.publish.pushBlockedReason()
        : this.publish.uploadBlockedReason();
    if (blocked && !this.dispatchDone() && !ticks.some((t) => t.state === 'warn')) {
      const link = ticks[ticks.length - 1];
      link.state = 'warn';
      link.hint = blocked;
    }

    return ticks;
  });

  /** How many of the six ticks are actually asking for something. */
  readonly heldCount = computed(
    () => this.readinessTicks().filter((t) => t.state === 'warn').length,
  );

  /**
   * True when this item's dispatch has already happened and cannot honestly be repeated.
   *
   * Only Spreaker: a YouTube push REWRITES the linked video, so pushing again is a
   * legitimate thing to do and "sent" would be the wrong word for it. A Spreaker upload
   * CREATES, and a second one is a second episode in a public feed.
   */
  readonly dispatchDone = computed(
    () => this.publish.isPodcast() && this.publish.spreakerEpisodeId() !== null,
  );

  /** One word: Sent, Ready, or Held - n. */
  readonly readinessWord = computed(() => {
    if (this.dispatchDone()) return 'Sent';
    const held = this.heldCount();
    return held === 0 ? 'Ready' : `Held · ${held}`;
  });

  /**
   * The single next thing to do, or null when there is nothing left.
   *
   * This is what carries the whole colour scheme: THE ONLY FILLED ORANGE ON SCREEN IS THE
   * NEXT THING TO DO. When this is null the dispatch button is that orange; when it is
   * not, the dispatch button is grey and this one fact row wears it instead. There is
   * never a second one, because there is never a second answer here.
   */
  readonly nextAction = computed<{ tick: ReadinessTick; fact: FactKey | null } | null>(() => {
    if (this.dispatchDone()) return null;
    const tick = this.readinessTicks().find((t) => t.state === 'warn');
    if (!tick) return null;
    return { tick, fact: FACT_FOR_TICK[tick.key] };
  });

  /**
   * A tick is a jump target: it opens the rail row that sets that fact, or focuses the
   * titles pane for the one fact the rail does not own.
   */
  focusTick(key: TickKey): void {
    if (key === 'titles') {
      // The titles list lives in the metadata half. A tick is a jump, so it takes the
      // pane with it rather than scrolling something the operator cannot see.
      this.workTab.set('metadata');
      setTimeout(() => this.titlesScroll?.nativeElement.focus());
      return;
    }
    const fact = FACT_FOR_TICK[key];
    if (fact === null) return;
    // LINK on a YouTube item has no rail row, because nothing in this app uploads a video
    // or links a draft — that happens in the browser. Collapsing whatever the operator had
    // open in order to show them nothing would be worse than doing nothing.
    if (fact === 'audio' && !this.publish.isPodcast()) return;
    // Every remaining tick names a publish-record fact, and the record is the other tab.
    this.workTab.set('record');
    this.openFact.set(fact);
    // After the row expands. The control inside it is what the operator came for.
    setTimeout(() => {
      const el =
        fact === 'destination'
          ? this.channelSelect?.nativeElement
          : fact === 'when'
            ? this.scheduleDateInput?.nativeElement
            : fact === 'thumb'
              ? this.thumbnailRow?.nativeElement
              : this.podcastRow?.nativeElement;
      if (!el) return;
      el.scrollIntoView({ block: 'nearest' });
      if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) el.focus();
    });
  }

  // ------------------------------------------------- the publish record accordion
  //
  // One card, five label/value rows, one open at a time. The control that SETS a fact
  // lives inside the row that STATES it, so nothing has to be explained in advance —
  // which is what replaced the 41 resident paragraphs this panel used to carry.

  readonly openFact = signal<FactKey | null>(null);

  isFactOpen(key: FactKey): boolean {
    return this.openFact() === key;
  }

  toggleFact(key: FactKey): void {
    this.openFact.set(this.openFact() === key ? null : key);
  }

  /** The tick that describes a rail row, so the row's dot and the meter never disagree. */
  tickFor(fact: FactKey): ReadinessTick | null {
    const key = TICK_FOR_FACT[fact];
    if (key === null) return null;
    return this.readinessTicks().find((t) => t.key === key) ?? null;
  }

  /** True when this row is the one thing left to do — the single filled orange. */
  isNextAction(fact: FactKey): boolean {
    return this.nextAction()?.fact === fact;
  }

  // ------------------------------------------------------ the A/B slate (§1.4)

  /**
   * The three slots, read straight off publish.chosenTitles().
   *
   * A VIEW, not a second state: order here is the store's order, which is click order,
   * which is variant order. Nothing on the slate writes — removing a variant is still
   * done by clicking its row in the list below, exactly as before.
   */
  readonly slate = computed<SlateSlot[]>(() => {
    const chosen = this.publish.chosenTitles();
    const rows = this.metadata()?.titles ?? [];
    return this.SLATE_SLOTS.map((index) => {
      const title = chosen[index] ?? null;
      if (title === null) return { index, title: null, chars: 0, rowIndex: null };
      const rowIndex = rows.findIndex((row) => this.getTitleText(row) === title);
      return { index, title, chars: title.length, rowIndex: rowIndex === -1 ? null : rowIndex };
    });
  });

  /** Scroll a slot's row into view and mark it. A slot with no row does nothing. */
  revealSlateSlot(slot: SlateSlot): void {
    if (slot.rowIndex === null) return;
    this.focusedTitleIndex.set(slot.rowIndex);
    this.scrollTitleIntoView(slot.rowIndex);
  }

  // -------------------------------------------------- titles keyboard (§1.5)
  //
  // Additive, and scoped to the titles pane: the handler is on the scroll container, so
  // none of it fires unless that pane has focus, and every pointer interaction on the
  // page behaves identically with the keyboard layer never touched.

  readonly focusedTitleIndex = signal<number | null>(null);

  private scrollTitleIntoView(index: number): void {
    const host = this.titlesScroll?.nativeElement;
    if (!host) return;
    const row = host.querySelector(`[data-title-row="${index}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  onTitlesKeydown(event: KeyboardEvent): void {
    // The inline editor owns its own keys (Enter saves, Escape cancels) and it lives
    // inside this container.
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const titles = this.metadata()?.titles ?? [];
    if (titles.length === 0) return;

    const current = this.focusedTitleIndex();
    const moveTo = (next: number) => {
      const clamped = Math.min(titles.length - 1, Math.max(0, next));
      this.focusedTitleIndex.set(clamped);
      this.scrollTitleIntoView(clamped);
      event.preventDefault();
    };

    switch (event.key) {
      case 'ArrowDown':
        moveTo(current === null ? 0 : current + 1);
        return;
      case 'ArrowUp':
        moveTo(current === null ? titles.length - 1 : current - 1);
        return;
      case ' ':
      case 'Enter':
        if (current === null) return;
        event.preventDefault();
        void this.publish.toggleTitle(this.getTitleText(titles[current]));
        return;
      case 'e':
        if (current === null) return;
        event.preventDefault();
        this.startEditTitle(titles[current], current);
        return;
      case 'c':
        if (current === null) return;
        event.preventDefault();
        this.copyToClipboard(this.getTitleText(titles[current]), 'title-' + current);
        return;
    }

    // 1…9 then 0 for the tenth. A digit past the end of the list is not a row, so it
    // toggles nothing rather than wrapping onto some other title.
    if (/^[0-9]$/.test(event.key)) {
      const nth = event.key === '0' ? 10 : Number(event.key);
      if (nth > titles.length) return;
      event.preventDefault();
      this.focusedTitleIndex.set(nth - 1);
      void this.publish.toggleTitle(this.getTitleText(titles[nth - 1]));
    }
  }

  // ------------------------------------------- description, tags, assets (4.4)

  /** `2,143 / 5,000` against YouTube's real limit. */
  descriptionCountLabel(): string {
    return `${this.descriptionValue().length.toLocaleString()} / ${MAX_DESCRIPTION_CHARS.toLocaleString()}`;
  }

  descriptionOverLimit(): boolean {
    return this.descriptionValue().length > MAX_DESCRIPTION_CHARS;
  }

  readonly tagsExpanded = signal(false);

  /** The extract sections, collapsed to their counts until the text is wanted. */
  readonly openAssets = signal<ReadonlySet<string>>(new Set<string>(['chapters']));

  /**
   * Whether this item has any extract at all.
   *
   * An "Assets" card with nothing under it would claim the item has clipboard sources it
   * does not have, which is a smaller version of the same lie the counts exist to avoid.
   */
  hasAssets(): boolean {
    const meta = this.metadata();
    if (!meta) return false;
    return (
      (meta.thumbnail_text?.length ?? 0) > 0 ||
      (meta.chapters?.length ?? 0) > 0 ||
      this.chaptersMissing() !== null ||
      (meta.pinned_comment?.length ?? 0) > 0 ||
      (meta.clip_suggestions?.length ?? 0) > 0
    );
  }

  isAssetOpen(key: string): boolean {
    return this.openAssets().has(key);
  }

  toggleAsset(key: string): void {
    const next = new Set(this.openAssets());
    if (!next.delete(key)) next.add(key);
    this.openAssets.set(next);
  }

  /**
   * The prompts the run sent for this item, recorded by the generator as `_prompt_trace`.
   * Empty (and the section unrendered) for items generated before the trace existed.
   */
  promptTrace(): Array<{ what: string; model: string; chars: number; at: string; prompt: string }> {
    const trace = (this.metadata() as any)?._prompt_trace;
    return Array.isArray(trace) ? trace : [];
  }

  formatPromptSize(chars: number): string {
    return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k chars` : `${chars} chars`;
  }

  /**
   * Toggle a title into/out of the A/B set. Click order becomes variant order —
   * variant 1 is YouTube's fallback when a test is inconclusive, so it's a real choice.
   */
  async toggleChosenTitle(title: any, event: MouseEvent) {
    // The row's own click handler copies to clipboard; picking shouldn't also copy.
    event.stopPropagation();
    await this.publish.toggleTitle(this.getTitleText(title));
  }

  isTitleChosen(title: any): boolean {
    return this.publish.isChosen(this.getTitleText(title));
  }

  /** 1-based variant number, or null when the title isn't picked. */
  titleVariantNumber(title: any): number | null {
    return this.publish.variantNumber(this.getTitleText(title));
  }

  /** True when the 3-variant cap blocks picking this one. */
  isTitleBlocked(title: any): boolean {
    return this.publish.isBlocked(this.getTitleText(title));
  }

  // -------------------------------------------------------------- publish panel
  //
  // The panel above Titles. Everything it edits lives in PublishState — what is here is
  // the two schedule boxes and the handlers that turn one click into one call.
  //
  // The boxes hold LOCAL WALL-CLOCK text with no zone in it, which is not yet a moment;
  // PublishState composes it with the offset in effect on that date before anything is
  // saved. That is why the offset is printed next to them rather than assumed.

  /** The operator's draft, or null for "show what is stored". */
  readonly scheduleDateDraft = signal<string | null>(null);
  readonly scheduleTimeDraft = signal<string | null>(null);

  /** What the date box shows: the draft if there is one, else the stored schedule. */
  readonly scheduleDate = computed(() => {
    const draft = this.scheduleDateDraft();
    if (draft !== null) return draft;
    const at = this.publish.publishAt();
    return at ? splitPublishAt(at).date : '';
  });

  readonly scheduleTime = computed(() => {
    const draft = this.scheduleTimeDraft();
    if (draft !== null) return draft;
    const at = this.publish.publishAt();
    return at ? splitPublishAt(at).time : '';
  });

  /** A moment needs both halves. Until then there is nothing to compose. */
  readonly scheduleComplete = computed(() => !!this.scheduleDate() && !!this.scheduleTime());

  /**
   * The offset the boxes will be composed with.
   *
   * The one in effect ON THAT DATE, which is not always the one in effect today — that
   * is the whole reason it is on screen. Before both boxes are filled there is no moment
   * to ask about, so it shows today's.
   */
  readonly scheduleOffset = computed(() => {
    if (!this.scheduleComplete()) return offsetLabel(offsetStringFor(new Date()));
    const at = new Date(`${this.scheduleDate()}T${this.scheduleTime()}:00`);
    if (Number.isNaN(at.getTime())) return offsetLabel(offsetStringFor(new Date()));
    return offsetLabel(offsetStringFor(at));
  });

  /**
   * How the stored schedule reads: local wall time, the offset it is read in, the offset
   * it was stored with, and how far off it is.
   *
   * Computed when the item loads and whenever the schedule changes, so "in 15 days" is
   * as of the last change rather than as of this second. That is the resolution the line
   * is for.
   */
  readonly scheduleDescription = computed(() => {
    const at = this.publish.publishAt();
    return at ? describePublishAt(at) : null;
  });

  /** `1920x1080 · 412 KB · image/png` for whichever image the row is describing. */
  thumbnailFacts(meta: { width: number; height: number; bytes: number; mime: string }): string {
    return `${meta.width}x${meta.height} · ${formatBytes(meta.bytes)} · ${meta.mime}`;
  }

  /** The file's own name — the path itself is on the row's tooltip. */
  fileName(absPath: string): string {
    return basename(absPath);
  }

  /**
   * The offer's field list, read as a sentence: "channel, thumbnail and podcast flag".
   *
   * Built from what the earlier record ACTUALLY holds, not from the four field names —
   * offering a thumbnail that the earlier run never had would be a promise the apply
   * cannot keep, and the receipt would then have to explain a field nobody was owed.
   */
  carryFieldList(): string {
    const fields = this.publish.carryOfferFields();
    if (fields.length === 0) return 'nothing';
    if (fields.length === 1) return fields[0];
    return `${fields.slice(0, -1).join(', ')} and ${fields[fields.length - 1]}`;
  }

  /** The picker's value, as a string the <select> can match. '' is "not routed". */
  channelSelectValue(): string {
    return this.publish.selectedChannelId() ?? '';
  }

  // ------------------------------------------------------------ one destination
  //
  // The routing decision is asked ONCE and has four answers: the three YouTube channels
  // the registry holds, and Spreaker. There is no second "publish as podcast" checkbox and
  // no second dispatch section, because an item goes to one place.
  //
  // Nothing new is stored for this. `channelId` names the YouTube channel and `isPodcast`
  // is what makes the destination Spreaker — the two fields the record has always had. The
  // mapping is written down once, in PublishState.chooseDestination.

  readonly SPREAKER_DESTINATION = SPREAKER_DESTINATION;
  readonly SPREAKER_DESTINATION_LABEL = SPREAKER_DESTINATION_LABEL;

  /** An explicit choice, including the empty option — see PublishState.chooseDestination. */
  async onDestinationChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    if (value === '') {
      // Unreachable through the picker — "— not routed —" is disabled there, because the
      // channel comes from the prompt set and clearing it is undone by the same write.
      // Named rather than silently ignored: if it ever IS reachable, that is a template
      // and handler that have drifted apart.
      this.publish.showError(
        'An item cannot be un-routed: its channel comes from the prompt set it was ' +
        'generated with. Pick a different destination instead. Nothing was saved.'
      );
      return;
    }
    await this.publish.chooseDestination(value);
  }

  /** How the chosen destination reads on one line. */
  destinationLabel(): string {
    if (this.publish.isPodcast()) return SPREAKER_DESTINATION_LABEL;
    const id = this.publish.selectedChannelId();
    if (!id) return 'not routed';
    return this.channelNameFor(id);
  }

  /** The registry name of the channel this item is routed to, or null when it has none. */
  private currentChannelName(): string | null {
    const id = this.publish.selectedChannelId();
    if (!id) return null;
    const known = this.publish.channels().find((c) => c.channelId === id);
    return known ? known.name : null;
  }

  /**
   * The release cadence this item's channel publishes on, or null when this app has none
   * recorded for it.
   *
   * NULL IS SAID OUT LOUD in the schedule row rather than filled in with somebody else's
   * schedule. A channel nobody has told this app about gets a calendar with no suggestion,
   * which is the truth; a guessed release day would be an upload at the wrong hour that
   * looked exactly like an intentional one.
   */
  readonly cadence = computed<CadenceKey | null>(() => {
    if (this.publish.isPodcast()) return null;
    return cadenceKeyFor(this.currentChannelName());
  });

  /** The one line that explains what "next open slot" means for this channel. */
  cadenceNote(): string | null {
    const key = this.cadence();
    return key === null ? null : CADENCE_NOTES[key];
  }

  // ---------------------------------------------------------------- the calendar
  //
  // The schedule row opens a month, not a bare date box, and the month is populated from
  // the SAME publish-list-index this page already read for its list — the call that also
  // powers /publish-calendar. There is no second index and no second IPC read.

  /** Which month the calendar is showing. Local midnight on the first. */
  readonly calendarMonth = signal<Date>(startOfMonth(new Date()));

  /** Recomputed when the panel opens a different item, so "today" is not last week's. */
  private readonly calendarNow = signal<Date>(new Date());

  stepCalendar(months: number): void {
    const at = this.calendarMonth();
    this.calendarMonth.set(new Date(at.getFullYear(), at.getMonth() + months, 1));
  }

  calendarMonthLabel(): string {
    return this.calendarMonth().toLocaleDateString([], { month: 'long', year: 'numeric' });
  }

  readonly WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  /**
   * Every OTHER item's schedule, by local day.
   *
   * "Other" is doing real work: an item's own schedule is not a clash with itself, and
   * showing it as one would make every already-scheduled item look like a conflict.
   */
  private readonly schedulesByDay = computed<Map<string, ReportIndexEntry[]>>(() => {
    const openItemId = this.selectedReport()?.itemId ?? null;
    const byDay = new Map<string, ReportIndexEntry[]>();
    for (const entry of this.reportIndex()) {
      const at = entry.publish?.publishAt;
      if (!at || entry.itemId === openItemId) continue;
      const when = new Date(at);
      if (Number.isNaN(when.getTime())) continue; // said by the calendar page, not here
      const key = dateKeyOf(when);
      const list = byDay.get(key);
      if (list) list.push(entry);
      else byDay.set(key, [entry]);
    }
    return byDay;
  });

  /**
   * The slots already taken ON THIS ITEM'S CHANNEL, as `slotKeyOf` strings.
   *
   * Per channel, not global: Unfiltered at 4pm and Fireside at 1pm on the same Tuesday are
   * two releases on two channels, which is the schedule working, not a collision.
   */
  private readonly occupiedSlots = computed<ReadonlySet<string>>(() => {
    const channelId = this.publish.selectedChannelId();
    const openItemId = this.selectedReport()?.itemId ?? null;
    const taken = new Set<string>();
    if (!channelId) return taken;
    for (const entry of this.reportIndex()) {
      const at = entry.publish?.publishAt;
      if (!at || entry.itemId === openItemId) continue;
      if (entry.publish?.channelId !== channelId) continue;
      const when = new Date(at);
      if (Number.isNaN(when.getTime())) continue;
      taken.add(slotKeyOf(when));
    }
    return taken;
  });

  /**
   * The earliest future slot for this channel that nothing else on it holds.
   *
   * A SUGGESTION. Any day and any time is allowed, including an occupied one — the
   * calendar flags a clash and never blocks it.
   */
  readonly suggestedSlot = computed<Date | null>(() => {
    const key = this.cadence();
    if (key === null) return null;
    return nextOpenSlot(key, this.calendarNow(), this.occupiedSlots());
  });

  suggestedSlotLabel(): string | null {
    const at = this.suggestedSlot();
    if (at === null) return null;
    return at.toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  /** Put the suggestion in the two boxes. It is not saved until Set is pressed. */
  useSuggestedSlot(): void {
    const at = this.suggestedSlot();
    if (at === null) return;
    const { date, time } = splitSlot(at);
    this.scheduleDateDraft.set(date);
    this.scheduleTimeDraft.set(time);
    this.calendarMonth.set(startOfMonth(at));
  }

  /** Six weeks of day cells, Sunday-first — the same shape the calendar page renders. */
  readonly calendarWeeks = computed<CalendarDay[][]>(() => {
    const first = this.calendarMonth();
    const now = this.calendarNow();
    const todayKey = dateKeyOf(now);
    const selectedKey = this.scheduleDate();
    const channelId = this.publish.selectedChannelId();
    const cadence = this.cadence();
    const byDay = this.schedulesByDay();

    const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
    const weeks: CalendarDay[][] = [];
    for (let w = 0; w < 6; w++) {
      const row: CalendarDay[] = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(
          gridStart.getFullYear(),
          gridStart.getMonth(),
          gridStart.getDate() + w * 7 + d,
        );
        const key = dateKeyOf(date);
        const onDay = byDay.get(key) ?? [];
        row.push({
          dateKey: key,
          date,
          dayOfMonth: date.getDate(),
          inMonth: date.getMonth() === first.getMonth(),
          isToday: key === todayKey,
          isPast: key < todayKey,
          count: onDay.length,
          onThisChannel:
            channelId !== null && onDay.some((e) => e.publish?.channelId === channelId),
          // "Is this a release day for this channel" — the cadence's own answer, so the
          // dot and the suggestion can never disagree about which days are release days.
          isReleaseDay:
            cadence !== null &&
            this.cadenceSlotsOn(cadence, date).length > 0,
          selected: key === selectedKey,
        });
      }
      weeks.push(row);
    }
    return weeks;
  });

  /** The cadence slots that fall on one day. Empty for a day this channel does not use. */
  private cadenceSlotsOn(cadence: CadenceKey, day: Date): Date[] {
    const out: Date[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0, 0, 0);
      if (isCadenceSlot(cadence, at)) out.push(at);
    }
    return out;
  }

  /**
   * Pick a day. The time comes from the channel's cadence when that day has one, and is
   * otherwise left exactly as it was for the operator to type.
   *
   * Nothing is saved here — this fills the two boxes, and Set is what writes. A past day
   * is pickable: the boxes are the operator's, and the refusal that matters (a schedule
   * less than 15 minutes out) belongs to the main process and arrives verbatim.
   */
  pickCalendarDay(day: CalendarDay): void {
    this.scheduleDateDraft.set(day.dateKey);
    const cadence = this.cadence();
    if (cadence === null) return;
    const slots = this.cadenceSlotsOn(cadence, day.date);
    if (slots.length === 0) return;
    // The first slot of the day that is still free, else the first slot at all — an
    // occupied one is offered rather than withheld, and flagged below.
    const taken = this.occupiedSlots();
    const open = slots.find((at) => !taken.has(slotKeyOf(at)));
    this.scheduleTimeDraft.set(splitSlot(open ?? slots[0]).time);
  }

  /**
   * Whether the two boxes name a moment something else on this channel already holds.
   *
   * Reported, never enforced. A deliberate double release is the operator's call, and the
   * only thing this app is entitled to do about it is say so.
   */
  scheduleCollision(): string | null {
    if (!this.scheduleComplete()) return null;
    const at = new Date(`${this.scheduleDate()}T${this.scheduleTime()}:00`);
    if (Number.isNaN(at.getTime())) return null;
    if (!collidesWith(at, this.occupiedSlots())) return null;
    const name = this.currentChannelName() ?? 'this channel';
    return `Another item on ${name} is already scheduled for that exact time. That is ` +
      'allowed — this is only saying so.';
  }

  /** What is already on the day the boxes name, for the line under the calendar. */
  daySummary(): string | null {
    const date = this.scheduleDate();
    if (!date) return null;
    const onDay = this.schedulesByDay().get(date) ?? [];
    if (onDay.length === 0) return null;
    return onDay
      .map((e) => {
        const at = new Date(e.publish!.publishAt!);
        const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const channel = e.publish?.channelId ? this.channelNameFor(e.publish.channelId) : 'unrouted';
        return `${time} · ${e.publish?.mainTitle ?? e.displayTitle} (${channel})`;
      })
      .join('\n');
  }

  dayCount(): number {
    const date = this.scheduleDate();
    if (!date) return 0;
    return (this.schedulesByDay().get(date) ?? []).length;
  }

  // ------------------------------------------------------------- dispatch manifest
  //
  // The exact payload, stated above the button that sends it. This replaced four resident
  // paragraphs with a table nobody has to read unless they want to — and every value in it
  // is the value that will actually go, read from the same resolved record the confirm
  // dialog assembles its own copy from. Nothing here is recomposed for display.

  readonly dispatchManifest = computed<ManifestRow[]>(() => {
    if (!this.publish.hasResolved()) return [];
    const rows: ManifestRow[] = [];

    const title = this.publish.pushTitle();
    rows.push({
      label: 'Title',
      value: title ? `variant 1 of ${this.publish.chosenCount()}` : 'none picked',
      missing: !title,
    });

    const description = this.publish.resolvedDescription();
    const chapters =
      this.publish.chaptersInDescription() && this.hasChapters() ? 'with chapters' : 'no chapters';
    rows.push({
      label: 'Description',
      value: `${description.length.toLocaleString()} chars · ${chapters}`,
      missing: description.length === 0,
    });

    const tagCount = this.editedTagsArray().length;
    rows.push({ label: 'Tags', value: String(tagCount), missing: tagCount === 0 });

    if (this.publish.isPodcast()) {
      const audio = this.publish.audio();
      rows.push({
        label: 'Audio',
        value: audio ? `${this.fileName(audio.path)} · ${this.audioFacts(audio.meta)}` : 'none',
        missing: !audio,
      });
      rows.push({ label: 'Show', value: this.spreakerShowLabel(), missing: false });
      rows.push({
        label: 'Publication',
        value: this.publish.publishAt() ? 'held until the schedule' : 'immediate',
        missing: !this.publish.publishAt(),
      });
      return rows;
    }

    const when = this.scheduleDescription();
    rows.push({
      label: 'Schedule',
      value: when ? (when.isPast ? `${when.local} — in the past` : when.local) : 'none — publishes on push',
      missing: !when || when.isPast,
    });

    const thumbnailPath = this.publish.thumbnailPath();
    rows.push({
      label: 'Thumbnail',
      value: thumbnailPath ? this.fileName(thumbnailPath) : 'none — the video keeps its own',
      missing: !thumbnailPath,
    });

    rows.push({ label: 'Channel', value: this.destinationLabel(), missing: !this.publish.channelId() });
    return rows;
  });

  /**
   * Why the one dispatch button is unavailable, for whichever destination is chosen.
   *
   * The YouTube destination has two dispatches: a linked item PUSHES metadata onto its
   * video, an unlinked one UPLOADS the source file as a new (locked-private) video. The
   * button and the meter's cross-check both read the same three-way choice, so they
   * cannot disagree about which rule applies.
   */
  dispatchBlockedReason(): string | null {
    if (this.publish.isPodcast()) return this.publish.spreakerBlockedReason();
    return this.publish.videoId()
      ? this.publish.pushBlockedReason()
      : this.publish.uploadBlockedReason();
  }

  /** An explicit choice, including the empty option — see PublishState.chooseChannel. */
  async onChannelChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    await this.publish.chooseChannel(value === '' ? null : value);
  }

  async saveSchedule() {
    await this.publish.setPublishAtLocal(this.scheduleDate(), this.scheduleTime());
    // A rejected schedule keeps what was typed so it can be corrected; an accepted one
    // drops the drafts so the boxes go back to reflecting the record.
    if (this.publish.error()) return;
    this.clearScheduleDrafts();
  }

  async clearSchedule() {
    await this.publish.clearPublishAt();
    if (this.publish.error()) return;
    this.clearScheduleDrafts();
  }

  private clearScheduleDrafts() {
    this.scheduleDateDraft.set(null);
    this.scheduleTimeDraft.set(null);
  }

  /**
   * Pick a thumbnail file.
   *
   * The dedicated picker (`publish-choose-thumbnail`), not the generic multi-select
   * `selectFiles` this used to open: a video has ONE thumbnail, and a dialog that let the
   * operator select four of them and then told them off is a worse dialog than one that
   * only ever hands back one. It is filtered to the three extensions the validator takes,
   * which cannot screen out anything the validator would have accepted — everything about
   * whether the file is usable is still decided in the main process, against the bytes.
   */
  async changeThumbnail() {
    await this.publish.chooseThumbnail();
    this.invalidateSelectedThumb();
  }

  /** The open item's row is now drawing a picture of a file that is no longer the one. */
  private invalidateSelectedThumb(): void {
    const itemId = this.selectedReport()?.itemId;
    if (itemId) this.invalidateThumbStrip([itemId]);
  }

  /**
   * Look for the exported thumbnail again (§E).
   *
   * The record's thumbnail is attached automatically when generation finishes, which is
   * routinely BEFORE the operator has made the image. This is the button for "I have made
   * it now" — it re-runs the same export-layout lookup, and it is the only way to get a
   * second attempt without clearing the record by hand.
   *
   * Every one of the three buckets the call answers with is shown. "Nothing found" is a
   * result, not silence: it is the answer the operator is checking for when the file they
   * just exported is not where the layout expects it.
   */
  async rescanThumbnail(): Promise<void> {
    const itemId = this.selectedReport()?.itemId;
    if (!itemId) {
      this.notificationService.error(
        'Nothing to look for',
        'No item is open, so there is no export layout to look in.',
      );
      return;
    }

    const res = await this.electron.publishRescanThumbnail(itemId);
    if (!res.success || !res.data) {
      this.notificationService.error(
        'The thumbnail could not be looked for',
        res.error ?? 'The main process refused the rescan and gave no reason.',
      );
      return;
    }

    const outcome = res.data;
    // Re-read the record the same way every other save on this page does, then drop the
    // list's cached image for this row — in that order, so the row's picture and the
    // record's path cannot be two different files for a frame.
    await this.publish.load(itemId, this.selectedReport()?.promptSet);
    this.invalidateThumbStrip([itemId]);
    await this.loadReports();

    // The rescan re-runs the WHOLE automatic pass, so it reports on the channel as well as
    // the thumbnail. This button asked one question, so it is answered on the thumbnail's
    // own outcome — every sentence the call returned is still shown, in whichever bucket
    // it arrived in.
    const attached = outcome.applied.some((o) => o.field === 'thumbnail');
    const say = (outcomes: readonly { field: string; detail: string }[]) =>
      outcomes.map((o) => `${o.field}: ${o.detail}`).join(' ');

    if (attached) {
      this.notificationService.success('Thumbnail attached', say(outcome.applied));
      return;
    }

    // Nothing was attached, and the two ways that happens are different answers. Both are
    // shown — a rescan that reports nothing is indistinguishable from one that did not run.
    const said = say([...outcome.refused, ...outcome.skipped, ...outcome.applied]);
    this.notificationService.warning(
      'No thumbnail was attached',
      said.length > 0
        ? said
        : 'The rescan returned no outcome at all — nothing was applied, refused or skipped.',
    );
  }

  /**
   * Drag-and-drop onto the thumbnail row.
   *
   * The second way in, and the one the operator reaches for with Finder already open on
   * the week's thumbnails folder. Everything after the path is the same code the picker
   * runs, so a dropped file and a picked file cannot be validated differently.
   *
   * `dragOverThumbnail` is a signal rather than a CSS :hover because a drop target has to
   * light up for a drag that is CARRYING something, which hover cannot express.
   */
  readonly dragOverThumbnail = signal(false);

  onThumbnailDragOver(event: DragEvent) {
    // Both calls are required: without preventDefault the browser navigates to the file
    // instead of firing drop, and without dropEffect the cursor shows the wrong verb.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.dragOverThumbnail.set(true);
  }

  onThumbnailDragLeave() {
    this.dragOverThumbnail.set(false);
  }

  async onThumbnailDrop(event: DragEvent) {
    event.preventDefault();
    this.dragOverThumbnail.set(false);

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      this.publish.showError(
        'That drop carried no file — a dragged image from a web page is not a file on ' +
        'this computer. Save it first, or use Choose….'
      );
      return;
    }
    if (files.length > 1) {
      // Refused rather than taking the first: a video has one thumbnail, and picking one
      // of four dropped files on the operator's behalf is a choice they did not make.
      this.publish.showError(
        `A video has one thumbnail; you dropped ${files.length} files. Drop one.`
      );
      return;
    }
    await this.publish.dropThumbnail(files[0]);
    this.invalidateSelectedThumb();
  }

  // ------------------------------------------------------------- push to YouTube
  //
  // The only control on this page that changes something the audience can see. Two steps,
  // always: a dialog listing exactly what will be sent, then the call. There is no
  // "push without asking" path and there is no batch push — one video at a time, looked at.

  /** An ISO instant as this Mac reads it. Used for push timestamps in the panel. */
  localTime(iso: string): string {
    return describePublishAt(iso).local;
  }

  /** The channel's display name, or its raw id when the registry has no name for it. */
  pushChannelLabel(): string {
    const id = this.publish.channelId();
    if (!id) return 'no channel';
    const known = this.publish.channels().find((c) => c.channelId === id);
    return known ? `${known.name} (${id})` : id;
  }

  /**
   * Confirm, then push.
   *
   * Everything shown in the dialog is the value that will actually be sent: the title is
   * chosen variant 1, the description and tags are the RESOLVED ones (overrides applied,
   * composed in the main process) — the same values the extension would have typed into
   * Studio. Nothing is recomposed here for display.
   */
  async pushToYouTube() {
    const blocked = this.publish.pushBlockedReason();
    if (blocked) {
      this.publish.showError(`Cannot push: ${blocked}`);
      return;
    }

    const description = this.publish.resolvedDescription();
    const tags = this.publish.resolvedTags()
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const schedule = this.publish.publishAt();
    const thumbnailPath = this.publish.thumbnailPath();
    const preview = this.publish.thumbnailPreview();

    const data: YouTubePushDialogData = {
      videoId: this.publish.videoId()!,
      channelLabel: this.pushChannelLabel(),
      title: this.publish.pushTitle()!,
      descriptionFirstLine: description.split('\n')[0].trim(),
      descriptionChars: description.length,
      tagCount: tags.length,
      tagsPreview: tags.slice(0, 8).join(', ') + (tags.length > 8 ? `, +${tags.length - 8} more` : ''),
      scheduleLabel: schedule ? this.describeScheduleForPush(schedule) : null,
      thumbnailName: thumbnailPath ? this.fileName(thumbnailPath) : null,
      // Only the image already on screen. Reading one here would be a second read of a
      // file the panel has already read, and a slow dialog for no new information.
      thumbnailDataUrl: preview && preview.path === thumbnailPath ? preview.dataUrl : null,
    };

    const confirmed = await firstValueFrom(
      this.dialog.open(YouTubePushDialog, { data, width: '640px' }).afterClosed()
    );
    if (!confirmed) return;

    const receipt = await this.publish.pushToYouTube();
    if (!receipt) return; // the failure is in the banner, verbatim
    this.notificationService.success(
      'Pushed to YouTube',
      `"${receipt.updated.title}" — video ${receipt.videoId} on ${this.pushChannelLabel()}.`
    );
  }

  /** The schedule as the dialog states it: local wall clock, its offset, and the raw instant. */
  private describeScheduleForPush(iso: string): string {
    const when = describePublishAt(iso);
    return `${when.local} (${when.localOffset}) — stored as ${when.raw}`;
  }

  // ------------------------------------------------------------- upload to YouTube
  //
  // The dispatch an UNLINKED item gets: videos.insert creates the video from the source
  // file with the manifest above already on it. No confirmation dialog, unlike push and
  // Spreaker, because nothing an audience can see changes: the video is born PRIVATE,
  // and until Google approves the app's YouTube API audit it is LOCKED private — it
  // cannot go public even at its scheduled time. Release uploads still go through the
  // browser, and the dispatch foot says so next to the button.

  async uploadToYouTube() {
    const blocked = this.publish.uploadBlockedReason();
    if (blocked) {
      this.publish.showError(`Cannot upload: ${blocked}`);
      return;
    }
    const receipt = await this.publish.uploadToYouTube();
    if (!receipt) return; // the failure is in the banner, verbatim
    this.notificationService.success(
      'Uploaded to YouTube',
      `"${receipt.title}" — video ${receipt.videoId} on ${this.pushChannelLabel()}. ` +
        'Locked private until the Google API audit clears.'
    );
  }

  async cancelUpload() {
    await this.publish.cancelUpload();
  }

  /** 0–100 for the bar. Before the first ~4 Hz progress event the bar sits at 0. */
  uploadPercent(): number {
    const p = this.publish.uploadProgress();
    if (!p) return 0;
    return Math.min(100, Math.floor((p.sentBytes / p.totalBytes) * 100));
  }

  /** `42% — 123.4 MB of 291.0 MB`, or the pre-first-event word. */
  uploadProgressLabel(): string {
    const p = this.publish.uploadProgress();
    if (!p) return 'starting…';
    return `${this.uploadPercent()}% — ${formatBytes(p.sentBytes)} of ${formatBytes(p.totalBytes)}`;
  }

  /** A byte count as the receipt states it — formatBytes, reachable from the template. */
  bytesLabel(bytes: number): string {
    return formatBytes(bytes);
  }

  // ------------------------------------------------------------ upload to Spreaker
  //
  // The other control that changes something an audience can see, and the one that
  // CREATES: after it there is an episode in a public podcast feed. Two steps, always —
  // a dialog listing exactly what will be sent and saying that Spreaker has no draft
  // state, then the call. No batch upload, and nothing here retries.

  /** `1:04:12 · 126.6 MB · mp3` for whichever audio file the row is describing. */
  audioFacts(meta: AudioMeta): string {
    return `${formatDuration(meta.durationSec)} · ${formatBytes(meta.bytes)} · ${meta.extension.replace(/^\./, '')}`;
  }

  /** The show as the dialog names it: the operator's label, else the bare show id. */
  spreakerShowLabel(): string {
    const status = this.publish.spreakerStatus();
    if (!status || !status.showId) return 'the configured show';
    return status.showName ? `${status.showName} (show ${status.showId})` : `show ${status.showId}`;
  }

  /** Pick an episode audio file. Unfiltered dialog; the main process decides usability. */
  async chooseAudio() {
    const picked = await this.electron.selectFiles();
    // Cancelling is not a failure and has nothing to report.
    if (!picked.success || picked.files.length === 0) return;
    if (picked.files.length > 1) {
      this.publish.showError(
        `An episode is one audio file; you picked ${picked.files.length}. Choose one.`
      );
      return;
    }
    await this.publish.setAudio(picked.files[0]);
  }

  /**
   * Confirm, then upload.
   *
   * Everything shown is the value that will actually be sent: the title is chosen variant
   * 1, the description and tags are the RESOLVED ones — the same values the YouTube push
   * would send and the extension would type into Studio. Nothing is recomposed here.
   */
  async uploadToSpreaker() {
    const blocked = this.publish.spreakerBlockedReason();
    if (blocked) {
      this.publish.showError(`Cannot upload: ${blocked}`);
      return;
    }

    const audio = this.publish.audio();
    if (!audio) {
      // spreakerBlockedReason already covers this; the guard is here because the dialog
      // below cannot describe a file it does not have, and a dialog with blanks in it is
      // worse than no dialog.
      this.publish.showError('The episode audio has not been measured, so there is nothing to confirm.');
      return;
    }

    const description = this.publish.resolvedDescription();
    const tags = this.publish.resolvedTags()
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const data: SpreakerUploadDialogData = {
      showLabel: this.spreakerShowLabel(),
      title: this.publish.pushTitle()!,
      descriptionFirstLine: description.split('\n')[0].trim(),
      descriptionChars: description.length,
      tagCount: tags.length,
      tagsPreview: tags.slice(0, 8).join(', ') + (tags.length > 8 ? `, +${tags.length - 8} more` : ''),
      audioName: this.fileName(audio.path),
      audioPath: audio.path,
      audioFacts: this.audioFacts(audio.meta),
      publicationNote: this.publish.spreakerPublicationNote(),
      warnings: audio.warnings,
    };

    const confirmed = await firstValueFrom(
      this.dialog.open(SpreakerUploadDialog, { data, width: '640px' }).afterClosed()
    );
    if (!confirmed) return;

    const receipt = await this.publish.uploadToSpreaker();
    if (!receipt) return; // the failure is in the banner, verbatim
    this.notificationService.success(
      'Uploaded to Spreaker',
      `"${receipt.uploaded.title}" — episode ${receipt.episodeId}, ` +
      `${(receipt.encodingStatus ?? 'queued').toLowerCase()}.`
    );
  }

  /**
   * Forget the recorded episode so the item can be uploaded again.
   *
   * Confirmed in plain words, because the thing people will assume it does — delete the
   * episode — is the one thing it cannot do.
   */
  async forgetSpreakerEpisode() {
    const episodeId = this.publish.spreakerEpisodeId();
    if (episodeId === null) return;
    const ok = window.confirm(
      `Forget Spreaker episode ${episodeId}?\n\n` +
      `This does NOT delete the episode — it still exists on your show. It only lets this ` +
      `item be uploaded again, which will create a SECOND episode unless you have already ` +
      `deleted the first one on Spreaker.`
    );
    if (!ok) return;
    await this.publish.forgetSpreakerEpisode();
  }

  // ------------------------------------------------------------------- editing
  //
  // Titles, description and tags are all editable, but they are NOT written back into the
  // job's report — that file stays the pristine generator output so an item can be
  // regenerated. Edits live in the selection store as overrides, and the extension reads
  // the resolved value. A cleared override means "use the generated value again", which is
  // why revert is a first-class action rather than retyping.

  /**
   * Which ROW is being edited, indexed into the generated title list; null when none.
   *
   * Keyed by row rather than by variant number so any title can be edited, not just the
   * ones already picked — an over-long generated title is otherwise unusable, since it
   * can't be selected until it's shortened.
   */
  readonly editingTitleIndex = signal<number | null>(null);
  readonly titleDraft = signal('');

  /**
   * The inline editor's input, focused explicitly after the row switches to edit mode.
   *
   * The `autofocus` attribute is unreliable on an element the framework creates after
   * first paint, and an editor you have to click twice to use reads as broken.
   */
  @ViewChild('titleInput') private titleInput?: ElementRef<HTMLInputElement>;

  readonly editingDescription = signal(false);
  readonly descriptionDraft = signal('');

  // — the three-section description (2026-08-25): body and links get their own editors;
  //   chapters get per-row rename/delete. All persist on the selection record, report
  //   files stay pristine, regeneration reverts (stale keys). —
  readonly editingLinks = signal(false);
  readonly linksDraft = signal('');
  readonly editingChapterKey = signal<string | null>(null);
  readonly chapterDraft = signal('');

  readonly editingTags = signal(false);
  readonly tagsDraft = signal('');

  /**
   * `event` is optional because the keyboard opens the same editor and has no click to
   * stop propagating. The pointer path is unchanged: it still passes its event and the
   * row's own toggle still does not fire.
   */
  startEditTitle(title: any, rowIndex: number, event?: MouseEvent) {
    event?.stopPropagation();
    this.editingTitleIndex.set(rowIndex);
    this.titleDraft.set(this.getTitleText(title));

    // After the row re-renders as an editor. Cursor at the end rather than select-all:
    // these are long titles being tweaked, not replaced wholesale.
    setTimeout(() => {
      const input = this.titleInput?.nativeElement;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  isEditingTitle(rowIndex: number): boolean {
    return this.editingTitleIndex() === rowIndex;
  }

  cancelEditTitle(event?: MouseEvent) {
    event?.stopPropagation();
    this.editingTitleIndex.set(null);
    this.titleDraft.set('');
  }

  async saveEditTitle(original: any, event?: Event) {
    event?.stopPropagation();
    if (this.editingTitleIndex() === null) return;

    // The generated text is the edit's permanent key; the displayed text is what a
    // chosen variant was picked as. They differ exactly when re-editing an edited title.
    await this.publish.saveTitleEdit(
      this.rawTitleText(original),
      this.getTitleText(original),
      this.titleDraft()
    );
    // A rejected edit leaves the error banner up and the editor open, so the operator can
    // fix it rather than losing what they typed.
    if (this.publish.error()) return;
    this.cancelEditTitle();
  }

  /**
   * What the extension will actually put in the description field.
   *
   * Comes from the main process, which is the ONLY place a description is composed
   * (chapters at the top, hashtags before the link block) and the only place overrides are
   * applied. Composing a second copy here is what made the app show one description while
   * YouTube received another.
   */
  descriptionValue(): string {
    return this.publish.resolvedDescription();
  }

  tagsValue(): string {
    return this.publish.resolvedTags();
  }

  /** The description SECTION (prose only) with the operator's override applied. */
  bodyValue(): string {
    return this.publish.descriptionOverride() ?? this.publish.sections()?.body ?? '';
  }

  /** The link block with the operator's override applied. '' is a real value: no links. */
  linksValue(): string {
    return this.publish.linksOverride() ?? this.publish.sections()?.links ?? '';
  }

  /** The chapter list as the editors see it: renames applied, deletions marked. */
  chapterRows(): Array<{
    key: string;
    timestamp: string;
    generatedTitle: string;
    title: string;
    edited: boolean;
    dropped: boolean;
  }> {
    const sections = this.publish.sections();
    if (!sections) return [];
    const edits = this.publish.chapterEdits();
    const drops = new Set(this.publish.chapterDrops());
    return sections.chapters.map((c) => ({
      key: c.key,
      timestamp: c.timestamp,
      generatedTitle: c.title,
      title: edits[c.key] ?? c.title,
      edited: c.key in edits,
      dropped: drops.has(c.key),
    }));
  }

  startEditDescription() {
    this.descriptionDraft.set(this.bodyValue());
    this.editingDescription.set(true);
  }

  cancelEditDescription() {
    this.editingDescription.set(false);
    this.descriptionDraft.set('');
  }

  /** Editing back to the generated text clears the override — that is the revert. */
  async saveDescription() {
    const draft = this.descriptionDraft();
    const generated = this.publish.sections()?.body ?? '';
    await this.publish.setFields({
      descriptionOverride: draft.trim() === generated.trim() ? null : draft,
    });
    if (this.publish.error()) return;
    this.editingDescription.set(false);
  }

  /** Drop the override so the generated description section flows through again. */
  async revertDescription() {
    await this.publish.setFields({ descriptionOverride: null });
    if (this.publish.error()) return;
    this.cancelEditDescription();
  }

  startEditLinks() {
    this.linksDraft.set(this.linksValue());
    this.editingLinks.set(true);
  }

  cancelEditLinks() {
    this.editingLinks.set(false);
    this.linksDraft.set('');
  }

  /** An emptied box saves as '' — publish with no links — not as a cleared override. */
  async saveLinks() {
    const draft = this.linksDraft();
    const generated = this.publish.sections()?.links ?? '';
    await this.publish.setFields({
      linksOverride: draft.trim() === generated.trim() ? null : draft,
    });
    if (this.publish.error()) return;
    this.editingLinks.set(false);
  }

  async revertLinks() {
    await this.publish.setFields({ linksOverride: null });
    if (this.publish.error()) return;
    this.cancelEditLinks();
  }

  startEditChapter(key: string, title: string, event?: MouseEvent) {
    event?.stopPropagation();
    this.editingChapterKey.set(key);
    this.chapterDraft.set(title);
  }

  cancelEditChapter(event?: MouseEvent) {
    event?.stopPropagation();
    this.editingChapterKey.set(null);
    this.chapterDraft.set('');
  }

  async saveEditChapter(key: string, generatedTitle: string, event?: Event) {
    event?.stopPropagation();
    await this.publish.saveChapterEdit(key, generatedTitle, this.chapterDraft());
    if (this.publish.error()) return;
    this.cancelEditChapter();
  }

  /** Delete or restore one chapter from the published list. */
  async toggleChapterDropped(key: string, dropped: boolean, event?: MouseEvent) {
    event?.stopPropagation();
    await this.publish.setChapterDropped(key, dropped);
  }

  startEditTags() {
    this.tagsDraft.set(this.tagsValue());
    this.editingTags.set(true);
  }

  cancelEditTags() {
    this.editingTags.set(false);
    this.tagsDraft.set('');
  }

  async saveTags() {
    await this.publish.setFields({ tagsOverride: this.tagsDraft() });
    if (this.publish.error()) return;
    this.editingTags.set(false);
  }

  async revertTags() {
    await this.publish.setFields({ tagsOverride: null });
    if (this.publish.error()) return;
    this.cancelEditTags();
  }

  /** Tags as the extension will type them, split for chip display. */
  editedTagsArray(): string[] {
    return this.tagsValue()
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  async ngOnInit() {
    await this.loadReports();

    // The channels the list's tab strip is built from. Deliberately after the list: the
    // rows exist first and the tabs are drawn over them, so a slow registry costs the
    // operator a moment of an unfiltered list rather than a blank page.
    await this.loadChannelRegistry();

    // The models "10 more titles" can run on. After the list for the same reason the chips
    // are: it labels a control on an already-rendered page and the list does not wait on it.
    await this.loadTitlesModelOptions();

    // The models the softening pass can run on. Same payload, same reason it comes last.
    await this.loadSoftenModelOptions();

    // Deep link: /metadata-reports?item=<itemId>, which is what every chip on the publish
    // calendar navigates to. Read once, AFTER the list exists — the parameter names a row,
    // and there is no row to select before the index has been read.
    //
    // A snapshot rather than a subscription: this route is entered fresh from the calendar
    // (the component is constructed each time), so there is no in-place parameter change
    // to react to, and a subscription would re-select the same report on every unrelated
    // navigation.
    const requestedItemId = this.route.snapshot.queryParamMap.get('item');
    if (requestedItemId) await this.selectByItemId(requestedItemId);
  }

  /**
   * Read the channel registry, for the filter chips' names.
   *
   * A failure is said and the chips then show the raw channel ids the index holds —
   * which is the truth about the data, not a stand-in for it. The reports list does not
   * depend on this call and is not blanked by its failure.
   */
  private async loadChannelRegistry(): Promise<void> {
    const res = await this.electron.analyticsListChannels();
    if (!res.success || !res.channels) {
      this.notificationService.warning(
        'Channel names unavailable',
        `The channel registry could not be read (${res.error ?? 'no reason given'}), so the ` +
          'channel tabs are built from whatever the open item last read.',
      );
      return;
    }
    this.registryChannels.set(res.channels);
  }

  /**
   * The models the TITLES task offers, for the "10 more titles" picker.
   *
   * Straight off `metadata-routing:get` — the routing dialog's own payload — so the picker
   * offers exactly what the build offers and nothing it has to keep in step by hand. A
   * failure is said and the picker stays empty, which disables the button: sending a titles
   * call to a model this page guessed at is the one thing worse than not sending one.
   */
  private async loadTitlesModelOptions(): Promise<void> {
    try {
      const routing = await this.electron.getMetadataRouting();
      const titles = routing.tasks.find((task) => task.id === 'titles');
      if (!titles) {
        throw new Error('the routing table this build ships has no "titles" task');
      }
      this.moreTitlesOptions.set(titles.options);
      this.routedTitlesOptionId.set(titles.selectedOptionId);
      if (!this.moreTitlesOptionId()) this.moreTitlesOptionId.set(titles.selectedOptionId);
    } catch (error) {
      this.notificationService.warning(
        'Title models unavailable',
        `The model list could not be read (${(error as Error).message}), so "10 more titles" ` +
          'has nothing to send a call on.',
      );
    }
  }

  /**
   * Seat the picker on the model that wrote THIS item's titles.
   *
   * The trace says which model the run used, and more of the same is the likeliest thing the
   * operator wants — so the picker opens there rather than on whatever the routing store
   * happens to say today. An item whose recorded model is no longer an option (an upgrade
   * removed it) opens on the routed one instead, visibly, in a control the operator sets.
   */
  private seatTitlesModelPicker(): void {
    const options = this.moreTitlesOptions();
    if (options.length === 0) return;
    const recorded = this.titlesTraceModel();
    const match = recorded ? options.find((option) => option.model === recorded) : undefined;
    this.moreTitlesOptionId.set(match ? match.id : this.routedTitlesOptionId());
  }

  /** The model the open item's titles were written by, as its own trace recorded it. */
  private titlesTraceModel(): string | null {
    const entries = this.promptTrace().filter((entry) => entry.what.startsWith('the titles call for '));
    const last = entries[entries.length - 1];
    return last ? last.model : null;
  }

  /**
   * TEN MORE TITLES, appended to the list.
   *
   * One call, on the model in the picker beside the button. The main process replays this
   * item's OWN stored titles prompt — nothing is re-assembled here, and no prompt crosses
   * into the renderer. What comes back is appended to the list as ordinary generated titles:
   * the selection record keys on the exact title text, so starring and editing reach them
   * with no special case, and a reload shows them because they are on the record now.
   *
   * Every refusal is the main process's sentence, shown as it was written — an item with no
   * stored prompt, an unusable answer, a model that would not run.
   */
  async generateMoreTitles(): Promise<void> {
    const report = this.selectedReport();
    const current = this.metadata();
    if (!report || !current) return;
    if (!report.jobId || !report.itemId) {
      this.notificationService.error(
        'This report has no identity',
        'It carries no job id or item id, so there is no record to write more titles onto.',
      );
      return;
    }
    const optionId = this.moreTitlesOptionId();
    if (!optionId) {
      this.notificationService.error(
        'No model chosen',
        'Pick a model beside the button — the call has to go somewhere.',
      );
      return;
    }

    // A half-finished edit is about a row that is about to be joined by ten more; save or
    // cancel it first rather than leaving an index-keyed editor open over a changed list.
    this.cancelEditTitle();
    this.moreTitlesBusy.set(true);
    try {
      const result = await this.electron.generateMoreTitles(report.jobId, report.itemId, optionId);
      if (!result.success || !result.titles) {
        this.notificationService.error('No new titles', result.error ?? 'The request gave no reason.');
        return;
      }

      // The item on screen may have changed while the call was out — appending to a list the
      // operator is no longer looking at would put another item's titles on this one.
      if (this.selectedReport()?.itemId !== report.itemId) return;

      const open = this.metadata();
      if (open) this.metadata.set({ ...open, titles: [...open.titles, ...result.titles] });
      // The row's count comes from the cached index, and the record it counts just grew.
      if (typeof result.totalTitles === 'number') {
        report.titleCount = result.totalTitles;
        this.reports.set([...this.reports()]);
      }

      if (result.warning) {
        this.notificationService.warning('Written, with a note', result.warning);
      } else {
        this.notificationService.success(
          `${result.titles.length} more titles`,
          `Written by ${result.model} and appended to the list.`,
        );
      }
    } catch (error) {
      this.notificationService.error('No new titles', (error as Error).message);
    } finally {
      this.moreTitlesBusy.set(false);
    }
  }

  /**
   * The models the softening pass can run on.
   *
   * Straight off `metadata-routing:get`, the routing dialog's own payload, so the picker
   * offers exactly what the build offers. A failure is said and the picker stays empty, which
   * disables the button — sending a rewrite of every field on an item to a model this page
   * guessed at is worse than not sending one.
   */
  private async loadSoftenModelOptions(): Promise<void> {
    try {
      const routing = await this.electron.getMetadataRouting();
      // See the note on `softenOptions` for why this is the description task.
      const task = routing.tasks.find((t) => t.id === 'description');
      if (!task) {
        throw new Error('the routing table this build ships has no "description" task');
      }
      this.softenOptions.set(task.options);
      if (!this.softenOptionId()) this.softenOptionId.set(task.selectedOptionId);
    } catch (error) {
      this.notificationService.warning(
        'Softening models unavailable',
        `The model list could not be read (${(error as Error).message}), so "Soften for ` +
          'monetization" has nothing to send a call on.',
      );
    }
  }

  /**
   * SOFTEN FOR MONETIZATION — every text field on this item, rewritten milder, as a NEW SET.
   *
   * One call per field on the model in the picker beside the button. What comes back is
   * written by the main process as a NEW ITEM in a NEW JOB over the SAME `source_key`, which
   * is the same sibling relation a regeneration produces — so this list already groups the two
   * (newest run at the head, older runs collapsed beneath it) and there is no set-switcher to
   * build. THE ORIGINAL IS NOT TOUCHED: not its report, not its .txt, not its publish record.
   *
   * On success the list is re-read, the source's group is opened so BOTH sets are on screen,
   * and the softened one is selected — which is the state the operator asked for: two sets,
   * side by side, his pick.
   *
   * Every refusal is the main process's own sentence, shown as it was written.
   */
  async softenItem(): Promise<void> {
    const report = this.selectedReport();
    if (!report) return;
    if (!report.jobId || !report.itemId) {
      this.notificationService.error(
        'This report has no identity',
        'It carries no job id or item id, so there is no item to soften.',
      );
      return;
    }
    const optionId = this.softenOptionId();
    if (!optionId) {
      this.notificationService.error(
        'No model chosen',
        'Pick a model beside the button — the calls have to go somewhere.',
      );
      return;
    }

    // A half-finished title edit is about a row on the set being READ, and the pass is about
    // to put a different set on screen.
    this.cancelEditTitle();
    this.softenBusy.set(true);
    // The main process runs the fields in order and does not report per-field progress, so
    // this names the pass rather than claiming to know which call is out right now.
    this.softenBusyField.set('every text field');
    try {
      const result = await this.electron.softenItem(report.jobId, report.itemId, optionId);
      if (!result.success || !result.itemId) {
        this.notificationService.error('Nothing softened', result.error ?? 'The request gave no reason.');
        return;
      }

      // The new set is a new row, so the list has to be re-read before anything can select it.
      await this.loadReports();

      // Open the softened set. It is now one of the versions in the picker at the top of
      // this pane, alongside the set it came from — which is where the operator chooses
      // between them.
      await this.selectByItemId(result.itemId);

      const applied = result.applied ?? [];
      const skipped = result.skipped ?? [];
      const notes = applied.map((f) => f.warning).filter((w): w is string => !!w);
      const lines = [
        `${applied.length} field(s) rewritten by ${result.model}: ${applied.map((f) => f.field).join(', ')}.`,
      ];
      if (skipped.length > 0) {
        lines.push(`Skipped: ${skipped.map((s) => `${s.field} — ${s.reason}`).join(' ')}`);
      }
      lines.push(
        'The original set is untouched and is still the primary — this new set is NOT ' +
          'published anywhere until you press "Set as primary" on the version picker above.',
      );
      if (result.warning) notes.push(result.warning);
      for (const note of notes) lines.push(note);

      if (notes.length > 0) {
        this.notificationService.warning('Softened, with notes', lines.join(' '));
      } else {
        this.notificationService.success('Softened set written', lines.join(' '));
      }
    } catch (error) {
      this.notificationService.error('Nothing softened', (error as Error).message);
    } finally {
      this.softenBusy.set(false);
      this.softenBusyField.set('');
    }
  }

  /**
   * Switch which metadata set of this source is on screen.
   *
   * Viewing only. Promotion is the separate button beside this picker, because looking at a
   * version and declaring it definitive are two different decisions and the operator's own
   * account of the feature puts them in that order: pull one up, configure it, then say it
   * is the one.
   */
  async onVersionChange(event: Event): Promise<void> {
    const itemId = (event.target as HTMLSelectElement).value;
    if (!itemId || itemId === this.selectedReport()?.itemId) return;
    // A half-finished title edit belongs to the set being left, not the one arriving.
    this.cancelEditTitle();
    await this.selectByItemId(itemId);
  }

  /**
   * Make the set on screen the definitive one for its source.
   *
   * From here on the calendar draws THIS set, a push sends THIS set's words, and the
   * extension's shelf offers THIS set — and whichever sibling held that role stops being
   * used, however completely it is filled in.
   *
   * NOTHING IS COPIED. Titles, descriptions, thumbnails, schedules and video links all stay
   * on the items they were made against; this changes which item the app reads, not what
   * any of them holds. Moving state between two sets is carry-forward, which is still its
   * own explicit click on the publish record.
   *
   * Every refusal is the main process's own sentence — an item with no source_key has no
   * siblings and is already the only set for what it came from, and that is an answer
   * rather than a failure.
   */
  async setAsPrimary(): Promise<void> {
    const report = this.selectedReport();
    if (!report?.itemId) {
      this.notificationService.error(
        'This report has no identity',
        'It carries no item id, so there is nothing to promote.',
      );
      return;
    }

    this.settingPrimary.set(true);
    try {
      const result = await this.electron.publishSetPrimary(report.itemId);
      if (!result.success || !result.data) {
        this.notificationService.error(
          'Not promoted',
          result.error ?? 'The request gave no reason.',
        );
        return;
      }

      // Re-read: `isPrimary` rides on every row of the index, so the list, the picker's
      // labels and this pane's own answer all come from the same next read.
      await this.loadReports();
      await this.selectByItemId(report.itemId);

      const previous = result.data.previousItemId;
      this.notificationService.success(
        'This is now the primary set',
        `"${result.data.sourceKey}" publishes from this set from now on` +
          (previous && previous !== result.data.itemId
            ? `, in place of ${previous}, which stays on disk and stops being used.`
            : '.'),
      );
    } catch (error) {
      this.notificationService.error('Not promoted', (error as Error).message);
    } finally {
      this.settingPrimary.set(false);
    }
  }

  /**
   * Open the report for one item id, or say why it could not be opened.
   *
   * The id comes from a link, so it can name an item that has since been deleted. That is
   * reported: a deep link that silently landed on an unselected page would look exactly
   * like the operator having clicked "Metadata Reports" in the sidebar.
   */
  private async selectByItemId(itemId: string): Promise<void> {
    const row = this.reports().find((r) => r.itemId === itemId);
    if (!row) {
      this.notificationService.warning(
        'That report is not in the list',
        `Nothing in the current report list has the item id ${itemId}. It may have been deleted.`,
      );
      return;
    }
    await this.selectReport(row);
  }

  /**
   * The report list, from the main process's index.
   *
   * This used to read and `JSON.parse` EVERY job file under `.contentstudio/metadata`
   * here in the renderer — 111 files on this install — on every mount and every refresh,
   * over an IPC round trip per file. The rows it produces are the same rows; what changed
   * is that the directory is now walked once, in the process that already caches those
   * files by mtime (services/metadata/report-index.ts), and each item arrives joined to
   * its publish record so the calendar can read the same call.
   *
   * The three ways this can go wrong are still three different outcomes, exactly as
   * before: the call itself failing, the reports directory not existing (which is what
   * the older on-disk layout looks like), and individual report files that could not be
   * indexed. None of them shortens the list quietly.
   */
  async loadReports() {
    try {
      this.isLoading.set(true);

      // Get settings to determine output directory. The backend get-settings
      // handler always returns a populated outputDirectory; if it's somehow
      // empty, show an explicit empty state instead of scanning a guessed path.
      const settings = await this.electron.getSettings();
      const baseDir = settings.outputDirectory;

      if (!baseDir) {
        this.reports.set([]);
        this.reportsDirectory.set('');
        this.notificationService.warning('No Output Directory', 'No output directory configured — set one in Settings.');
        return;
      }

      // Bring the files up to schema_version 2 BEFORE listing them, so every row below
      // can require an item id. This is the lazy trigger the migration is designed for:
      // the operator has opened the reports page, which means the output volume is
      // present. Whatever it did is said out loud — a silent migration is indistinguishable
      // from a migration that did not run.
      await this.reportMigrationOutcome();

      const indexed = await this.electron.publishListIndex();

      // A call that FAILED is not a call that found nothing. The legacy layout is still
      // tried, because old installs really do have it, but a failure of BOTH says so and
      // carries the main process's reason verbatim.
      if (!indexed.success || !indexed.data) {
        const legacyFound = await this.loadReportsLegacy(baseDir);
        if (!legacyFound) {
          this.notificationService.error(
            'Could not read reports',
            `The report index could not be built (${indexed.error ?? 'no reason given'}), ` +
              'and no reports were found in the older layout either.',
          );
        }
        return;
      }

      const index = indexed.data;

      // The directory is not there at all — which is exactly what an install predating
      // `.contentstudio/metadata` looks like. Same documented migration step as before,
      // not a catch-all.
      if (index.directoryMissing) {
        const legacyFound = await this.loadReportsLegacy(baseDir);
        if (!legacyFound) {
          this.notificationService.error(
            'Could not read reports',
            `No reports directory at ${index.directory}, and none in the older layout either. ` +
              'Check the output directory in Settings.',
          );
        }
        return;
      }

      this.reportsDirectory.set(index.directory);

      // A row whose thumbnail changed since the last index — attached, cleared, or taken
      // over from an automatic find — is holding a picture of the wrong file. Forget it
      // here, where the two versions of the truth are both in hand; the fetcher re-asks
      // for it the moment the row is on screen again.
      const before = new Map(
        this.reportIndex().map((e) => [
          e.itemId,
          `${e.publish?.hasThumbnail ?? false}|${e.publish?.thumbnailSource ?? ''}`,
        ]),
      );
      const stale = index.entries
        .filter((e) => {
          const was = before.get(e.itemId);
          if (was === undefined) return false;
          return (
            was !== `${e.publish?.hasThumbnail ?? false}|${e.publish?.thumbnailSource ?? ''}`
          );
        })
        .map((e) => e.itemId);
      if (stale.length > 0) this.invalidateThumbStrip(stale);

      // Kept for the publish facts the index carries (channel, schedule, status). The
      // list below renders none of them yet — the calendar does — but they arrive in the
      // same call, so holding them costs nothing and re-fetching them would.
      this.reportIndex.set(index.entries);

      this.reports.set(
        index.entries.map((entry) => ({
          name: `${entry.jobId}-item-${entry.itemIndex}`,
          path: entry.jobPath,      // Path to JSON file
          date: new Date(entry.dateIso),
          size: entry.jobSizeBytes,
          promptSet: entry.promptSet ?? undefined,
          displayTitle: entry.displayTitle,
          txtFolder: entry.txtFolder ?? '',
          jobId: entry.jobId,
          itemId: entry.itemId,
          itemIndex: entry.itemIndex,
          txtFilePath: entry.txtFilePath ?? '',
          // Carried onto the row so the list can search, filter, dot and collapse without
          // a second pass over the index. Every one of them is the index's own value.
          sourceKey: entry.sourceKey,
          sourceFilename: entry.sourceFilename,
          isPrimary: entry.isPrimary,
          softenedFromItemId: entry.softenedFromItemId,
          titleCount: entry.titleCount,
          facts: entry.publish,
          promptSetChannelId: entry.promptSetChannelId,
          promptSetChannelName: entry.promptSetChannelName,
          publishFault: entry.publishFault,
        })),
      );

      // Files that could not be listed are SAID, not just counted into the console. A
      // reports page silently missing three of forty rows looks exactly like a reports page
      // that has thirty-seven rows, and the operator has no way to tell.
      if (index.problems.length > 0) {
        const named = index.problems.map((p) => p.file);
        this.notificationService.warning(
          'Some reports could not be listed',
          `${named.length} file${named.length === 1 ? '' : 's'} skipped: ${named.slice(0, 5).join(', ')}` +
            (named.length > 5 ? `, and ${named.length - 5} more` : '') +
            '. They are unreadable, or missing the job_id / item_id every action is keyed by;' +
            ' see the console for detail.',
        );
      }

      // A publish record whose report has been deleted. It has no title and no date, so
      // there is no row to render — but a schedule the operator set is now attached to
      // nothing, and that is worth one sentence rather than silence.
      if (index.orphanedSelections.length > 0) {
        const n = index.orphanedSelections.length;
        this.notificationService.warning(
          'Publish records without a report',
          `${n} publish selection${n === 1 ? '' : 's'} name an item that is no longer in any ` +
            `report: ${index.orphanedSelections.slice(0, 5).join(', ')}` +
            (n > 5 ? `, and ${n - 5} more` : '') + '.',
        );
      }
    } catch (error) {
      this.notificationService.error('Load Error', 'Failed to load metadata reports: ' + (error as Error).message);
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Run the one-off report migration and tell the operator what it did.
   *
   * Nothing is thrown from here: a migration that could not run leaves the files exactly
   * as they were, and the listing below will report every item it then cannot identify.
   * Saying both — "the migration failed" and "these rows are unusable" — is the point.
   */
  private async reportMigrationOutcome(): Promise<void> {
    try {
      const outcome = await this.electron.ensureReportsMigrated();

      if (outcome.error) {
        this.notificationService.error(
          'Reports could not be updated',
          `The one-off update of the report files did not run: ${outcome.error}`,
        );
        return;
      }

      if (outcome.ran && outcome.message) {
        // Both halves of the pass are reported, and a failure in EITHER is a failure:
        // reports that could not be migrated and publish selections that could not be
        // moved are the same kind of fact, and burying the second under the first's
        // success is how the operator would learn about it by missing something.
        const failed =
          (outcome.receipt?.failures.length ?? 0) > 0 ||
          (outcome.selectionReceipt?.failures.length ?? 0) > 0;
        const orphaned = (outcome.selectionReceipt?.filesOrphaned ?? 0) > 0;

        if (failed) {
          this.notificationService.error('Reports updated, with failures', outcome.message);
        } else if (orphaned) {
          // Nothing broke, but chosen A/B titles were set aside rather than carried over,
          // and the operator has to know where they went to get them back.
          this.notificationService.warning('Reports updated, some selections set aside', outcome.message);
        } else {
          this.notificationService.success('Reports updated', outcome.message);
        }
      }
    } catch (e) {
      this.notificationService.error(
        'Reports could not be updated',
        `The one-off update of the report files could not be started: ${(e as Error).message}`,
      );
    }
  }

  /**
   * The pre-`.contentstudio/metadata` layout, for installs that predate it.
   *
   * Returns whether it FOUND anything, which the caller needs: this used to be a silent
   * catch-all for any failure of the current path, so "no reports here either" and "we could
   * not look" both ended as an empty list with nothing said.
   */
  private async loadReportsLegacy(baseDir: string): Promise<boolean> {
    // Legacy structure: try the old metadata folder under the output directory
    const possiblePaths = [
      `${baseDir}/metadata`
    ];

    let metadataDir = '';
    let result: any = null;

    for (const path of possiblePaths) {
      try {
        const testResult = await this.electron.readDirectory(path);
        if (testResult.success) {
          metadataDir = path;
          result = testResult;
          console.log('Found legacy metadata directory:', path);
          break;
        }
      } catch (e) {
        // Continue to next path
      }
    }

    if (!metadataDir || !result) {
      console.warn('No metadata directory found in any location');
      this.reportsDirectory.set(possiblePaths[0]);
      return false;
    }

    this.reportsDirectory.set(metadataDir);

    if (result.success && result.directories) {
      const reports: MetadataReport[] = [];

      for (const dir of result.directories) {
        let displayTitle = dir.name;
        let promptSet: string | undefined;

        try {
          const dirContents = await this.electron.readDirectory(dir.path);
          if (dirContents.success && dirContents.files) {
            const jsonFile = dirContents.files.find((f: any) => f.name.endsWith('.json'));
            if (jsonFile) {
              const jsonPath = `${dir.path}/${jsonFile.name}`;
              const content = await this.electron.readFile(jsonPath);
              if (content) {
                const parsed = JSON.parse(content);
                if (parsed._title) {
                  displayTitle = parsed._title;
                }
                if (parsed._prompt_set) {
                  promptSet = parsed._prompt_set;
                }
              }
            }
          }
        } catch (e) {
          console.warn('Could not read metadata for', dir.name);
        }

        reports.push({
          name: dir.name,
          path: dir.path,
          date: new Date(dir.mtime),
          size: dir.size || 0,
          promptSet,
          displayTitle
        });
      }

      reports.sort((a, b) => b.date.getTime() - a.date.getTime());
      this.reports.set(reports);
      return reports.length > 0;
    }
    // The directory was readable but held no files worth listing. Found the LOCATION, found
    // no reports — reported as "nothing here" rather than as a failure to look.
    return true;
  }

  async selectReport(report: MetadataReport) {
    try {
      this.isLoading.set(true);
      this.selectedReport.set(report);

      // Read the JSON file (report.path is now the path to the JSON file)
      let content = await this.electron.readFile(report.path);

      if (!content) {
        throw new Error('Empty file content');
      }

      const jobData = JSON.parse(content);
      console.log('[MetadataReports] Loaded job data:', jobData);
      console.log('[MetadataReports] Report itemIndex:', report.itemIndex);

      // Strict checking - no fallbacks
      if (report.itemIndex === undefined) {
        throw new Error('Report missing itemIndex - cannot determine which item to load');
      }

      if (!jobData.items || !Array.isArray(jobData.items)) {
        throw new Error('Job data missing items array - invalid structure');
      }

      if (jobData.items.length <= report.itemIndex) {
        throw new Error(`Item index ${report.itemIndex} out of bounds (only ${jobData.items.length} items in job)`);
      }

      const selectedItem = this.normalizeMetadataKeys(jobData.items[report.itemIndex]);
      console.log('[MetadataReports] Selected item from array:', selectedItem);
      console.log('[MetadataReports] Titles array:', selectedItem.titles);
      console.log('[MetadataReports] Thumbnail text array:', selectedItem.thumbnail_text);

      this.metadata.set(selectedItem);
      console.log('[MetadataReports] Final metadata signal value:', this.metadata());

      // Any half-finished edit belongs to the PREVIOUS item — drop it before the new
      // selection loads, or a save would write it onto the wrong report.
      this.cancelEditTitle();
      this.cancelEditDescription();
      this.cancelEditTags();
      this.clearScheduleDrafts();

      // View state that named a row or a section of the PREVIOUS item. Keyboard focus on
      // "row 7" means nothing here, and an expanded tag strip is about the item it was
      // expanded for.
      this.focusedTitleIndex.set(null);
      this.tagsExpanded.set(false);
      this.openAssets.set(new Set<string>(['chapters']));
      // The rail's accordion and its calendar are both about the item that was open. A
      // month scrolled to December and a Schedule row left expanded belong to that item,
      // and "now" is re-read here so a session left open overnight does not go on
      // suggesting yesterday's next slot.
      this.openFact.set(null);
      // A new item opens on its metadata, always. The record tab is where the operator
      // goes after they have decided something, not where they land.
      this.workTab.set('metadata');
      this.calendarNow.set(new Date());
      this.calendarMonth.set(startOfMonth(new Date()));

      // The titles picker belongs to the item now open, and its default is that item's own
      // recorded model. AFTER metadata() is set — it is read off this item's trace.
      this.seatTitlesModelPicker();

      // Load any previously chosen A/B titles for this item, BY ITS ID. The row's
      // itemIndex is only ever a position into the array read above; it has never been
      // an identity, and passing it here is what re-pointed selections at the wrong item
      // when a sibling was deleted.
      //
      // Deliberately not awaited with the metadata read — a failure here must not blank
      // the report.
      //
      // The prompt set travels with it: it is the only input to channel seeding, and an
      // item opened without one gets a panel that says so rather than an empty picker.
      void this.publish.load(report.itemId, report.promptSet);
    } catch (error) {
      console.error('[MetadataReports] Error loading report:', error);
      this.notificationService.error('Read Error', 'Failed to read report: ' + (error as Error).message);
      this.metadata.set(null);
    } finally {
      this.isLoading.set(false);
    }
  }

  getDisplayTitle(report: MetadataReport): string {
    // If we have loaded metadata with a title, use it
    if (this.selectedReport()?.path === report.path && this.metadata()?._title) {
      return this.metadata()!._title!;
    }
    // Otherwise use the folder name
    return report.name;
  }

  async showInFolder(report: MetadataReport) {
    try {
      // Show the specific txt file if available, otherwise the txt folder, otherwise the JSON file location
      const pathToShow = report.txtFilePath || report.txtFolder || report.path;
      await this.electron.showInFolder(pathToShow);
    } catch (error) {
      this.notificationService.error('Show Error', 'Failed to show in folder: ' + (error as Error).message);
    }
  }

  /**
   * Ask the main process to delete one item, then re-read the directory.
   *
   * What used to be here: an unbounded `delete-directory` aimed at the txt file, a
   * renderer-side read-modify-write of the job JSON that bypassed the output handler's
   * write queue, and an in-memory renumber of the sibling rows that ran whether or not
   * the write had succeeded — so a failed write left the UI showing the wrong item's
   * metadata under the right title (P3). All three are gone. The renderer names an item
   * and re-reads what is actually on disk; it no longer keeps its own opinion about it.
   */
  async deleteReport(report: MetadataReport, event: Event) {
    event.stopPropagation();

    if (!report.jobId || !report.itemId) {
      // Not reachable from a listed row (rows without both ids are never built), which is
      // exactly why it is worth saying rather than silently returning.
      this.notificationService.error(
        'Cannot delete this report',
        `${report.name} has no job id or item id, so there is nothing the app can safely delete.`,
      );
      return;
    }

    try {
      const receipt = await this.electron.deleteReportItem(report.jobId, report.itemId);

      // The list is rebuilt from disk rather than patched: the delete may also have
      // removed the whole job file, and the positions of every sibling item have moved.
      await this.loadReports();

      if (this.selectedReport()?.name === report.name) {
        this.selectedReport.set(null);
        this.metadata.set(null);
      }

      // The one outcome the operator cannot see from the list: a text file left behind
      // because the item never recorded where it was. Said, not logged.
      if (!receipt.txtDeleted) {
        this.notificationService.warning(
          'Deleted, text file left behind',
          `The report entry is gone, but its text file was not removed (${receipt.txtReason}).` +
            (report.txtFolder ? ` Look in ${report.txtFolder}.` : ''),
        );
      } else {
        this.notificationService.success('Deleted', 'Report and its text file deleted');
      }
    } catch (error) {
      // A rejected delete did nothing at all — the main process is a single transaction
      // that throws rather than half-finishing — so the row stays exactly where it is.
      this.notificationService.error('Delete Error', 'Failed to delete report: ' + (error as Error).message);
    }
  }

  formatDate(date: Date): string {
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  copyToClipboard(text: string, itemKey?: string) {
    navigator.clipboard.writeText(text).then(() => {
      // Set copied state for visual feedback
      if (itemKey) {
        this.setCopiedItem(itemKey);
      }
      this.notificationService.success('Copied', 'Text copied to clipboard', false);
    }).catch(err => {
      this.notificationService.error('Copy Failed', 'Failed to copy to clipboard: ' + err.message);
    });
  }

  // Set copied item and auto-clear after delay
  private setCopiedItem(key: string) {
    // Clear any existing timeout
    if (this.copiedTimeout) {
      clearTimeout(this.copiedTimeout);
    }

    this.copiedItem.set(key);

    // Clear after 1.5 seconds
    this.copiedTimeout = setTimeout(() => {
      this.copiedItem.set(null);
    }, 1500);
  }

  // Check if a specific item was just copied
  isCopied(key: string): boolean {
    return this.copiedItem() === key;
  }

  getTagsArray(): string[] {
    const meta = this.metadata();
    if (!meta || !meta.tags) return [];

    // Handle both string (comma-separated) and array formats
    if (Array.isArray(meta.tags)) {
      return meta.tags;
    }

    // If it's a string, split by comma
    if (typeof meta.tags === 'string') {
      return meta.tags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
    }

    return [];
  }

  getTagsString(): string {
    const tags = this.getTagsArray();
    return tags.join(', ');
  }

  /** The GENERATED text of a title row, exactly as the report recorded it. */
  rawTitleText(title: any): string {
    // Handle both string format and object format {text: "...", style: "..."}
    if (typeof title === 'string') {
      return title;
    }
    if (title && typeof title === 'object' && title.text) {
      return title.text;
    }
    return String(title);
  }

  /**
   * What a title row SHOWS and OFFERS: the operator's stored edit when one exists
   * (record.titleEdits, keyed by the generated text), else the generated text. Every
   * consumer — the list row, the slate's row lookup, pick/copy/keyboard — reads this,
   * so an edited title is one title everywhere.
   */
  getTitleText(title: any): string {
    const raw = this.rawTitleText(title);
    return this.publish.titleEdits()[raw] ?? raw;
  }

  /** True when this row's text is an operator edit rather than the generated text. */
  isTitleEdited(title: any): boolean {
    return this.rawTitleText(title) in this.publish.titleEdits();
  }

  getDescriptionText(description: any): string {
    // Handle both string format and object format
    if (typeof description === 'string') {
      return description;
    }
    if (description && typeof description === 'object') {
      // Try common object formats
      if (description.text) return description.text;
      if (description.content) return description.content;
      if (description.description) return description.description;
    }
    return String(description || '');
  }

  getThumbnailText(thumbnail: any): string {
    // Handle both string format and object format
    if (typeof thumbnail === 'string') {
      return thumbnail;
    }
    if (thumbnail && typeof thumbnail === 'object' && thumbnail.text) {
      return thumbnail.text;
    }
    return String(thumbnail);
  }

  /**
   * The recorded reason this item has no chapters — null when it has some, or when the
   * run recorded nothing (chapters were never requested, so there is nothing to explain).
   */
  /**
   * The one-line account of which transcript wrote this item's content fields, and which
   * one wrote its chapters — null for an item generated before the split was recorded.
   *
   * Shown above Titles because that is where the consequence bites: these are the words
   * the titles were written from, and they either include a sponsor read or describe a
   * story the final cut may have trimmed (spec §3.4/§3.5).
   */
  provenanceLine(): string | null {
    return describeProvenance(this.metadata()?.content_provenance);
  }

  /** True when the content fields came from a linked editor story, for the pane's styling. */
  provenanceIsLinked(): boolean {
    return this.metadata()?.content_provenance?.content_fields === 'editor-story-transcript';
  }

  /** Does this item have a chapter list at all? The chapters switch is meaningless without one. */
  hasChapters(): boolean {
    const chapters = this.metadata()?.chapters;
    return Array.isArray(chapters) && chapters.length > 0;
  }

  chaptersToggleHint(): string {
    return 'Include the chapter list between the description and the links in what gets copied and pushed.';
  }

  /**
   * Persist the switch on the item's selection record.
   *
   * Straight through to publish-set-fields — the same channel the description and tag
   * overrides use — so it survives a reload and the YouTube push reads it from the same
   * resolver the panel does. Nothing is recomposed here; refreshing the resolved values is
   * what re-reads the description with or without its chapters.
   */
  async setChaptersInDescription(include: boolean): Promise<void> {
    await this.publish.setFields({ chaptersInDescription: include });
  }

  chaptersMissing(): { outcome: 'failed' | 'skipped'; reason: string } | null {
    const meta = this.metadata();
    if (!meta || (meta.chapters && meta.chapters.length > 0)) return null;
    return meta.chaptersSkipped ?? null;
  }

  /**
   * Normalize variant key names from different AI models to the expected ParsedMetadata fields.
   * Also flattens objects to strings (some models return {text: "...", style: "..."} instead of plain strings).
   */
  private normalizeMetadataKeys(raw: any): ParsedMetadata {
    // Extract string from any value (handles objects AI models might return)
    const toStr = (val: any): string => {
      if (typeof val === 'string') return val;
      if (val && typeof val === 'object') {
        return val.text || val.title || val.value || val.content || val.label || JSON.stringify(val);
      }
      return String(val ?? '');
    };

    // Normalize an array of items to string[]
    const toStrArray = (arr: any): string[] => {
      if (!arr) return [];
      if (!Array.isArray(arr)) return [toStr(arr)];
      return arr.map(toStr);
    };

    // Tags: strip # prefix, handle string or array
    let tags: string | string[] = raw.tags || '';
    if (Array.isArray(tags)) {
      tags = tags.map((t: any) => toStr(t).replace(/^#\s*/, ''));
    } else if (typeof tags === 'string') {
      tags = tags.split(',').map((t: string) => t.trim().replace(/^#\s*/, '')).join(',');
    }

    return {
      titles: toStrArray(raw.titles || raw.titleOptions || raw.title_options || raw.titleSuggestions),
      thumbnail_text: toStrArray(raw.thumbnail_text || raw.thumbnailText || raw.thumbnailTextOptions
        || raw.thumbnail_text_options || raw.thumbnailOptions),
      description: raw.description || '',
      tags,
      hashtags: raw.hashtags || '',
      pinned_comment: toStrArray(raw.pinned_comment || raw.pinnedComment || raw.pinned_comments) || undefined,
      clip_suggestions: toStrArray(raw.clip_suggestions || raw.clipSuggestions || raw.clips) || undefined,
      chapters: raw.chapters,
      chaptersSkipped: raw.chaptersSkipped,
      // Passed through verbatim — it is a record of a past run, not a value to normalize.
      content_provenance: raw.content_provenance,
      _title: raw._title,
      _prompt_set: raw._prompt_set,
      // Passed through verbatim, for the same reason content_provenance is: a record of what
      // the run sent, not a value with variants to normalize.
      _prompt_trace: raw._prompt_trace,
    };
  }

  toggleSelection(report: MetadataReport, event: Event) {
    event.stopPropagation();
    report.selected = !report.selected;
    this.reports.set([...this.reports()]);
  }

  /**
   * Select-all acts on WHAT IS VISIBLE — the rows the search box, the filter chips and
   * the collapsed re-run groups have left on screen. Ticking a box you cannot see is the
   * thing this list must never do.
   */
  toggleSelectAll() {
    const visible = this.visibleReports();
    const allSelected = visible.every(r => r.selected);
    visible.forEach(r => r.selected = !allSelected);
    this.reports.set([...this.reports()]);
  }

  /**
   * Everything selected, visible or not.
   *
   * Deliberately NOT filtered to the visible rows: a row selected before a filter was
   * typed is still selected, and dropping it from the export silently is exactly the
   * failure this list is trying to stop. The count in the header says how many there are,
   * so a number larger than what is on screen is the operator's cue.
   */
  getSelectedReports(): MetadataReport[] {
    return this.reports().filter(r => r.selected);
  }

  hasSelectedReports(): boolean {
    return this.reports().some(r => r.selected);
  }

  allReportsSelected(): boolean {
    const visible = this.visibleReports();
    return visible.length > 0 && visible.every(r => r.selected);
  }

  async exportSelectedAsTxt() {
    const selected = this.getSelectedReports();

    if (selected.length === 0) {
      this.notificationService.warning('No Selection', 'Please select at least one report to export');
      return;
    }

    try {
      // Ask user to select export directory
      const result = await this.electron.selectOutputDirectory();

      if (!result.success || !result.directory) {
        return; // User cancelled
      }

      const exportDir = result.directory;
      let successCount = 0;
      let errorCount = 0;

      for (const report of selected) {
        try {
          // Read the metadata
          const content = await this.electron.readFile(report.path);
          if (!content) {
            console.error('Empty content for report:', report.name);
            errorCount++;
            continue;
          }

          const jobData = JSON.parse(content);

          // Strict checking - no fallbacks
          if (report.itemIndex === undefined) {
            console.error('Report missing itemIndex:', report.name);
            errorCount++;
            continue;
          }

          if (!jobData.items || !Array.isArray(jobData.items)) {
            console.error('Job data missing items array:', report.name);
            errorCount++;
            continue;
          }

          if (jobData.items.length <= report.itemIndex) {
            console.error('Item index out of bounds:', report.name);
            errorCount++;
            continue;
          }

          const metadata: ParsedMetadata = this.normalizeMetadataKeys(jobData.items[report.itemIndex]);

          // Format the metadata as text
          const txtContent = this.formatMetadataAsTxt(metadata, report);

          // Create safe filename
          const safeName = (report.displayTitle || report.name)
            .replace(/[^a-zA-Z0-9-_]/g, '_')
            .substring(0, 100);
          const fileName = `${safeName}_metadata.txt`;

          // Export the file
          await this.electron.writeTextFile(`${exportDir}/${fileName}`, txtContent);
          successCount++;
        } catch (error) {
          console.error('Error exporting report:', report.name, error);
          errorCount++;
        }
      }

      if (successCount > 0) {
        this.notificationService.success(
          'Export Complete',
          `Exported ${successCount} file(s) to ${exportDir}`
        );
      }

      if (errorCount > 0) {
        this.notificationService.warning(
          'Export Partial',
          `${errorCount} file(s) failed to export`
        );
      }

      // Deselect all after export
      this.reports().forEach(r => r.selected = false);
      this.reports.set([...this.reports()]);

    } catch (error) {
      this.notificationService.error('Export Failed', 'Failed to export files: ' + (error as Error).message);
    }
  }

  private formatMetadataAsTxt(metadata: ParsedMetadata, report: MetadataReport): string {
    let output = '';

    // Header
    output += '='.repeat(80) + '\n';
    output += `METADATA EXPORT\n`;
    output += `Title: ${metadata._title || report.displayTitle || report.name}\n`;
    output += `Prompt Set: ${metadata._prompt_set || report.promptSet || 'N/A'}\n`;
    output += `Generated: ${report.date.toLocaleString()}\n`;
    output += '='.repeat(80) + '\n\n';

    // Titles
    if (metadata.titles && metadata.titles.length > 0) {
      output += '--- TITLES ---\n\n';
      metadata.titles.forEach((title, i) => {
        output += `${i + 1}. ${title}\n`;
      });
      output += '\n';
    }

    // Thumbnail Text
    if (metadata.thumbnail_text && metadata.thumbnail_text.length > 0) {
      output += '--- THUMBNAIL TEXT ---\n\n';
      metadata.thumbnail_text.forEach((text, i) => {
        output += `${i + 1}. ${text}\n`;
      });
      output += '\n';
    }

    // Pinned Comment
    if (metadata.pinned_comment && metadata.pinned_comment.length > 0) {
      output += '--- PINNED COMMENT ---\n\n';
      metadata.pinned_comment.forEach((comment, i) => {
        output += `${i + 1}. ${comment}\n`;
      });
      output += '\n';
    }

    // Clip Suggestions
    if (metadata.clip_suggestions && metadata.clip_suggestions.length > 0) {
      output += '--- CLIP SUGGESTIONS ---\n\n';
      metadata.clip_suggestions.forEach((clip, i) => {
        output += `${i + 1}. ${clip}\n`;
      });
      output += '\n';
    }

    // Description
    if (metadata.description) {
      output += '--- DESCRIPTION ---\n\n';
      const descText = this.getDescriptionText(metadata.description);
      output += descText + '\n\n';

      if (metadata.hashtags && !descText.includes(metadata.hashtags)) {
        output += metadata.hashtags + '\n\n';
      }
    }

    // Tags - handle both string and array formats
    if (metadata.tags) {
      output += '--- TAGS ---\n\n';
      if (Array.isArray(metadata.tags)) {
        output += metadata.tags.join(', ') + '\n\n';
      } else {
        output += metadata.tags + '\n\n';
      }
    }

    // Hashtags (if not already included)
    const descText = metadata.description ? this.getDescriptionText(metadata.description) : '';
    if (metadata.hashtags && !descText.includes(metadata.hashtags)) {
      output += '--- HASHTAGS ---\n\n';
      output += metadata.hashtags + '\n\n';
    }

    output += '='.repeat(80) + '\n';
    output += 'End of metadata export\n';

    return output;
  }
}
