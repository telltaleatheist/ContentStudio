import {
  Component,
  ElementRef,
  HostListener,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MatCardModule } from '@angular/material/card';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { AnalyticsChannel, ElectronService } from '../../services/electron';
import { NotificationService } from '../../services/notification';
import { PublishState } from '../../features/publish/publish-state';
import { YouTubePushDialog, YouTubePushDialogData } from '../../features/publish/youtube-push-dialog';
import {
  SpreakerUploadDialog,
  SpreakerUploadDialogData,
} from '../../features/publish/spreaker-upload-dialog';
import {
  MAX_AB_VARIANTS,
  type PublishFacts,
  type ReportIndexEntry,
} from '../../features/publish/publish.types';
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
  /** How many titles the run produced. 0 is the failed-run state the list can filter for. */
  titleCount?: number;
  /** This item's publish record as the index joined it, or null when it has none yet. */
  facts?: PublishFacts | null;
  /** Why this item's publish record could not be read. The row still exists. */
  publishFault?: string | null;
}

// ---------------------------------------------------------------- page shell
//
// The three-pane report page (PHASE-4-DESIGN §1.2): list | decide | dispatch. The left
// split is a real pane, so its width belongs to the operator and outlives the session. A
// missing key is the first run, not a failure; a stored value outside the draggable range
// is clamped rather than allowed to hide the pane; and a value that is not a number at
// all is SAID rather than silently corrected, because something else wrote it.
const LEFT_WIDTH_KEY = 'metadata-reports.left-width';
const LEFT_WIDTH_DEFAULT = 280;
const LEFT_WIDTH_MIN = 220;
const LEFT_WIDTH_MAX = 560;

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

/**
 * The five publish facts the readiness strip states and the list rows dot.
 *
 * One vocabulary for both surfaces on purpose: a row's dots and the open report's strip
 * are the same five answers, so learning one teaches the other.
 */
type ReadinessKey = 'channel' | 'schedule' | 'ab' | 'thumbnail' | 'podcast';

interface ReadinessChip {
  key: ReadinessKey;
  label: string;
  /** set = recorded; unset = nothing recorded, said as such; warn = recorded and suspect. */
  state: 'set' | 'unset' | 'warn';
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
interface ReportGroup {
  key: string;
  head: MetadataReport;
  runs: MetadataReport[];
}

interface ChannelFilterChip {
  value: string;
  label: string;
  count: number;
}

type StateFilter = 'all' | 'scheduled' | 'unscheduled' | 'ab' | 'no-titles';

/** One dot on a list row — a publish fact that is recorded. */
interface RowDot {
  key: string;
  label: string;
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
}

@Component({
  selector: 'app-metadata-reports',
  standalone: true,
  imports: [
    MatCardModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatChipsModule,
    MatCheckboxModule,
    MatDialogModule,
    RouterLink
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
  /** '' is every channel; 'unrouted' is the null-channel state, which is a real answer. */
  readonly channelFilter = signal('');
  readonly stateFilter = signal<StateFilter>('all');

  /** Which re-run groups the operator has opened. Keyed by sourceKey. */
  readonly expandedGroups = signal<ReadonlySet<string>>(new Set<string>());

  /**
   * The channel registry, for the filter chips' NAMES only.
   *
   * The same call the publish panel and the calendar make. When it fails the chips fall
   * back to nothing — they show the raw channel ids, which is what the index actually
   * holds, and the failure is said out loud rather than leaving an empty filter row that
   * looks like "no channels are in use".
   */
  readonly registryChannels = signal<AnalyticsChannel[]>([]);

  readonly channelFilterChips = computed<ChannelFilterChip[]>(() => {
    const counts = new Map<string, number>();
    let unrouted = 0;
    for (const entry of this.reportIndex()) {
      const id = entry.publish?.channelId ?? null;
      if (id === null) {
        unrouted++;
        continue;
      }
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const named = this.registryChannels();
    const chips: ChannelFilterChip[] = [...counts.entries()].map(([value, count]) => {
      const known = named.find((c) => c.channelId === value);
      return { value, label: known ? known.name : value, count };
    });
    chips.sort((a, b) => a.label.localeCompare(b.label));
    if (unrouted > 0) chips.push({ value: 'unrouted', label: 'unrouted', count: unrouted });
    return chips;
  });

  /** Does this row survive the search box and the two filter chip rows? */
  private matchesFilters(report: MetadataReport): boolean {
    const query = this.searchQuery().trim().toLowerCase();
    if (query) {
      const haystack = [report.displayTitle, report.name, report.sourceFilename]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    const channel = this.channelFilter();
    if (channel) {
      const id = report.facts?.channelId ?? null;
      if (channel === 'unrouted') {
        if (id !== null) return false;
      } else if (id !== channel) {
        return false;
      }
    }

    switch (this.stateFilter()) {
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
      case 'all':
        return true;
    }
  }

  /**
   * The list as it renders: newest run per source, older runs collapsed under it.
   *
   * Filtered BEFORE grouping, so a filter promotes the newest MATCHING run to the head
   * rather than hiding a whole source behind a head that does not match.
   */
  readonly visibleGroups = computed<ReportGroup[]>(() => {
    const groups: ReportGroup[] = [];
    const byKey = new Map<string, ReportGroup>();

    for (const report of this.reports()) {
      if (!this.matchesFilters(report)) continue;
      // A row with no source key is its own group: the index did not record what it was
      // generated from, and grouping it with anything would be a guess.
      const key = report.sourceKey ?? ` row:${report.itemId ?? report.path}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.runs.push(report);
      } else {
        const group: ReportGroup = { key, head: report, runs: [] };
        byKey.set(key, group);
        groups.push(group);
      }
    }

    return groups;
  });

  /** Every row on screen — heads, plus the runs of whichever groups are open. */
  readonly visibleReports = computed<MetadataReport[]>(() => {
    const open = this.expandedGroups();
    const rows: MetadataReport[] = [];
    for (const group of this.visibleGroups()) {
      rows.push(group.head);
      if (open.has(group.key)) rows.push(...group.runs);
    }
    return rows;
  });

  isGroupExpanded(key: string): boolean {
    return this.expandedGroups().has(key);
  }

  toggleGroup(key: string, event: Event): void {
    event.stopPropagation();
    const next = new Set(this.expandedGroups());
    if (!next.delete(key)) next.add(key);
    this.expandedGroups.set(next);
  }

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
   * The publish facts this row has recorded, one dot each.
   *
   * Only facts that ARE recorded get a dot — an unrouted, unscheduled item shows none,
   * which is the honest reading of a row nobody has touched.
   */
  rowDots(report: MetadataReport): RowDot[] {
    const facts = report.facts;
    if (!facts) return [];
    const dots: RowDot[] = [];
    if (facts.channelId) dots.push({ key: 'channel', label: 'Routed to a channel' });
    if (facts.publishAt) dots.push({ key: 'schedule', label: 'Scheduled' });
    if (facts.abCount > 0) {
      dots.push({
        key: 'ab',
        label: `${facts.abCount} of ${MAX_AB_VARIANTS} A/B variants picked`,
      });
    }
    if (facts.hasThumbnail) dots.push({ key: 'thumbnail', label: 'Thumbnail attached' });
    if (facts.isPodcast) dots.push({ key: 'podcast', label: 'Podcast episode' });
    return dots;
  }

  // ---------------------------------------------- readiness strip (§1.3, 4.4)

  /**
   * The one line that answers "is this ready", built ONLY from the record already on
   * screen. Nothing here is inferred: a field with nothing in it renders as a hollow chip
   * saying so, never as a plausible value.
   */
  readonly readinessChips = computed<ReadinessChip[]>(() => {
    const chips: ReadinessChip[] = [];

    const unknown = this.publish.unknownStoredChannel();
    const channelId = this.publish.selectedChannelId();
    if (unknown) {
      chips.push({
        key: 'channel',
        label: `channel ${unknown}`,
        state: 'warn',
        hint: `Routed to ${unknown}, which is not in the channel registry.`,
      });
    } else if (channelId) {
      const known = this.publish.channels().find((c) => c.channelId === channelId);
      const suggested = this.publish.channelIsSuggested();
      chips.push({
        key: 'channel',
        label: known ? known.name : channelId,
        state: suggested ? 'warn' : 'set',
        hint: suggested
          ? 'Suggested only — not stored until your next change here.'
          : 'The channel this item is routed to.',
      });
    } else {
      chips.push({
        key: 'channel',
        label: 'no channel',
        state: 'unset',
        hint: 'Not routed to a channel.',
      });
    }

    const when = this.scheduleDescription();
    if (when) {
      chips.push({
        key: 'schedule',
        label: when.local,
        state: when.isPast || !when.offsetsAgree ? 'warn' : 'set',
        hint: when.isPast
          ? 'This time has already passed.'
          : !when.offsetsAgree
            ? `Stored as ${when.raw} (${when.storedOffset}), read here in ${when.localOffset}.`
            : `${when.localOffset} · ${when.relative}`,
      });
    } else {
      chips.push({
        key: 'schedule',
        label: 'no schedule',
        state: 'unset',
        hint: 'No publish time recorded.',
      });
    }

    const chosen = this.publish.chosenCount();
    chips.push({
      key: 'ab',
      label: `A/B ${chosen}/${MAX_AB_VARIANTS}`,
      state: chosen === MAX_AB_VARIANTS ? 'set' : 'unset',
      hint:
        chosen === 0
          ? 'No titles picked yet.'
          : `${chosen} picked, in click order — #1 is the video's title.`,
    });

    const warnings = this.publish.thumbnailWarnings();
    if (this.publish.thumbnailPath()) {
      chips.push({
        key: 'thumbnail',
        label: warnings.length
          ? `thumbnail · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
          : 'thumbnail ✓',
        state: warnings.length ? 'warn' : 'set',
        hint: warnings.length ? warnings.join(' ') : 'A thumbnail is attached.',
      });
    } else {
      chips.push({
        key: 'thumbnail',
        label: 'no thumbnail',
        state: 'unset',
        hint: 'No thumbnail chosen.',
      });
    }

    const podcast = this.publish.isPodcast();
    chips.push({
      key: 'podcast',
      label: podcast ? 'podcast' : 'podcast —',
      state: podcast ? 'set' : 'unset',
      hint: podcast ? 'Marked as a Spreaker episode.' : 'Not a podcast episode.',
    });

    return chips;
  });

  /** A chip is a jump target: it focuses the control in the rail that sets that fact. */
  focusReadiness(key: ReadinessKey): void {
    if (key === 'ab') {
      this.titlesScroll?.nativeElement.focus();
      return;
    }
    const el =
      key === 'channel'
        ? this.channelSelect?.nativeElement
        : key === 'schedule'
          ? this.scheduleDateInput?.nativeElement
          : key === 'thumbnail'
            ? this.thumbnailRow?.nativeElement
            : this.podcastRow?.nativeElement;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) el.focus();
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

  async onPodcastChange(checked: boolean) {
    await this.publish.setPodcast(checked);
  }

  /**
   * The monetization picker's value, as a string the <select> can match.
   *
   * THREE options, not a checkbox: '' is "no decision recorded", which is a real answer
   * and the only one that leaves Studio's monetization control untouched. A checkbox
   * could only say on/off and would turn every never-answered item into "off".
   */
  monetizeSelectValue(): string {
    const value = this.publish.monetize();
    if (value === null) return '';
    return value ? 'on' : 'off';
  }

  /** Record the intent. Nothing here monetizes anything — the extension fills Studio. */
  async onMonetizeChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    if (value !== '' && value !== 'on' && value !== 'off') {
      // The template owns these three options; anything else means the two have drifted
      // apart, and writing a guess would put a decision on the record nobody made.
      this.publish.showError(
        `The monetization picker offered an option this handler does not know: ` +
        `${JSON.stringify(value)}. Nothing was saved.`
      );
      return;
    }
    await this.publish.setMonetize(value === '' ? null : value === 'on');
  }

  /**
   * Pick a thumbnail file.
   *
   * The dialog is unfiltered, and everything about whether the file is usable is decided
   * in the main process against the bytes — so a wrong pick comes back naming the file
   * and the rule instead of being screened out by an extension list that magic bytes
   * disagree with.
   */
  async changeThumbnail() {
    const picked = await this.electron.selectFiles();
    // Cancelling is not a failure and has nothing to report.
    if (!picked.success || picked.files.length === 0) return;
    if (picked.files.length > 1) {
      this.publish.showError(
        `A video has one thumbnail; you picked ${picked.files.length} files. Choose one.`
      );
      return;
    }
    await this.publish.setThumbnail(picked.files[0]);
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

    await this.publish.saveTitleEdit(this.getTitleText(original), this.titleDraft());
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

  startEditDescription() {
    this.descriptionDraft.set(this.descriptionValue());
    this.editingDescription.set(true);
  }

  cancelEditDescription() {
    this.editingDescription.set(false);
    this.descriptionDraft.set('');
  }

  async saveDescription() {
    await this.publish.setFields({ descriptionOverride: this.descriptionDraft() });
    if (this.publish.error()) return;
    this.editingDescription.set(false);
  }

  /** Drop the override so the generated description flows through again. */
  async revertDescription() {
    await this.publish.setFields({ descriptionOverride: null });
    if (this.publish.error()) return;
    this.cancelEditDescription();
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

    // Names for the channel filter chips. Deliberately after the list: the chips are
    // derived from the ids the index actually holds, and this call only labels them.
    await this.loadChannelRegistry();

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
          'channel filter shows raw channel ids.',
      );
      return;
    }
    this.registryChannels.set(res.channels);
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
          titleCount: entry.titleCount,
          facts: entry.publish,
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

  copyChaptersToClipboard() {
    const meta = this.metadata();
    if (!meta || !meta.chapters) return;

    const chaptersText = meta.chapters
      .map((chapter: any) => `${this.getChapterTimestamp(chapter)} - ${this.getChapterTitle(chapter)}`)
      .join('\n');

    navigator.clipboard.writeText(chaptersText).then(() => {
      this.setCopiedItem('chapters-all');
      this.notificationService.success('Copied', 'All chapters copied to clipboard', false);
    }).catch(err => {
      this.notificationService.error('Copy Failed', 'Failed to copy chapters: ' + err.message);
    });
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

  getTitleText(title: any): string {
    // Handle both string format and object format {text: "...", style: "..."}
    if (typeof title === 'string') {
      return title;
    }
    if (title && typeof title === 'object' && title.text) {
      return title.text;
    }
    return String(title);
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

  getChapterTimestamp(chapter: any): string {
    // Handle various formats AI models might return
    if (typeof chapter === 'string') {
      // String format like "0:00 - Introduction"
      const match = chapter.match(/^(\d+:\d+)/);
      return match ? match[1] : '0:00';
    }
    if (chapter && typeof chapter === 'object') {
      // Try common property names
      if (chapter.timestamp) return String(chapter.timestamp);
      if (chapter.time) return String(chapter.time);
    }
    return '0:00';
  }

  getChapterTitle(chapter: any): string {
    // Handle various formats AI models might return
    if (typeof chapter === 'string') {
      // String format like "0:00 - Introduction"
      const match = chapter.match(/^\d+:\d+\s*-\s*(.+)$/);
      return match ? match[1] : chapter;
    }
    if (chapter && typeof chapter === 'object') {
      // Try common property names
      if (chapter.title) return String(chapter.title);
      if (chapter.text) return String(chapter.text);
      if (chapter.name) return String(chapter.name);
    }
    return String(chapter || 'Untitled');
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
