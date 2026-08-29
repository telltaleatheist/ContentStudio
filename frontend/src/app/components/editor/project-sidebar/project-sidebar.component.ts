import { Component, EventEmitter, HostListener, Inject, Input, OnDestroy, OnInit, Output, ChangeDetectorRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { EDITOR_HOST, EditorHost, RemoteWeek } from '../editor-host';
import { ProjectEntry, ProjectsService } from '../services/projects.service';
import { ArchiveRow, ArchiveService } from '../services/archive.service';

/**
 * One week of work: the `<week>` folder, and the day projects under its `files/` directory.
 *
 * `path` is null for the catch-all group holding projects that are not in that layout. Those
 * rows still open and process normally — the only thing a group without a week path cannot
 * do is derive an archive destination, so their sync buttons are disabled and say why.
 */
export interface WeekGroup {
  path: string | null;
  label: string;
  entries: ProjectEntry[];
  /**
   * A GHOST: this week exists on the archive server and nowhere on this machine.
   *
   * `path` is then its path ON THE ARCHIVE, and `entries` is always empty — there is nothing
   * here to open, process or sync, and every control that acts on a local folder is left out
   * rather than shown disabled. The one thing it offers is deleting the archived copy, which
   * for a week in this state is the only copy in existence.
   */
  ghost?: boolean;
}

/**
 * A week folder is named EXACTLY as a date (2026-08-16) — that is the FCPX library layout the
 * whole pipeline is built on. Used to recognise the second, `files`-less project layout
 * (see `weekOf`).
 */
const WEEK_FOLDER_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The editor's far-left FCPX-libraries column, rendered INSIDE the editor's existing
 * `.project-pane` (the pane container, its splitter and the width binding stay in the editor).
 *
 * Deliberately dumb: it lists what ProjectsService publishes and emits what the user meant.
 * The editor decides what opening or processing a project actually does — this component never
 * calls bootstrap, and never starts a job. The one thing it owns is adding/removing entries,
 * because those are list operations, not session operations.
 *
 * The exception is archive sync, which it does drive: pushing a folder to the NAS is a
 * property of the LIST (a week, a day) rather than of the loaded session, so there is no
 * editor state for it to belong to.
 *
 * Failures are shown in the pane, never in an alert() and never swallowed: a corrupt registry
 * banners across the top and disables the + button, and a rejected add prints inline under the
 * header until the next successful action clears it.
 */
@Component({
  selector: 'app-project-sidebar',
  templateUrl: './project-sidebar.component.html',
  styleUrls: ['./project-sidebar.component.scss'],
  standalone: false
})
export class ProjectSidebarComponent implements OnInit, OnDestroy {
  /**
   * The project a job is currently running on, by `entry.path`. Renders a spinner (and the
   * percent, when given) on that row. Nothing here drives it yet — a later agent feeds it from
   * the processing job.
   */
  @Input() busyPath: string | null = null;
  /** Optional 0-100 progress for `busyPath`; null shows an indeterminate spinner. */
  @Input() busyPercent: number | null = null;
  /**
   * The session loaded in this window (a compounds zip path). The entry whose scan points at
   * that zip gets the active highlight — same behaviour the old recents list had.
   */
  @Input() activeZipPath: string | null = null;

  /** A processed/edited project the user wants loaded. The editor bootstraps `scan.zipPath`. */
  @Output() openRequested = new EventEmitter<ProjectEntry>();
  /** A raw project the user wants processed. The editor owns the processing UI. */
  @Output() processRequested = new EventEmitter<ProjectEntry>();

  projects: ProjectEntry[] = [];
  /** The list as the template renders it: week dividers, each with its day projects. */
  groups: WeekGroup[] = [];
  /** Registry could not be read: banner text, and adds are refused while it is set. */
  registryError: string | null = null;
  /** Last failed add/remove, shown under the header. Cleared by the next successful action. */
  inlineError: string | null = null;
  /** Last refused/failed sync, shown on the same line. */
  archiveError: string | null = null;
  /** "Removed N projects whose folders are gone" — the list never changes itself in silence. */
  prunedNotice: string | null = null;
  /**
   * "Finishing 2 weeks that had fallen behind" — the same rule applied to transfers.
   *
   * Uploads that nobody just clicked are the one thing in this pane that can consume the
   * network for hours on its own, and they are only ever started on folders the operator has
   * already put in the archive. That is a promise being kept rather than a surprise, but it
   * is still said out loud, with the names, and dismissed with the ✕.
   */
  resumeNotice: string | null = null;
  dragOver = false;

  /**
   * The right-click menu, positioned in viewport coordinates. Null when closed.
   *
   * `entry` is the day project the menu was opened on, and is null on a week divider — the
   * per-project actions (re-process) are only offered where there is a project to act on.
   */
  contextMenu: {
    x: number; y: number; path: string; kind: 'week' | 'day'; label: string;
    entry: ProjectEntry | null;
  } | null = null;
  /** A pass over the archive marks is in progress; the refresh button spins and is disabled. */
  refreshing = false;

  /**
   * The delete confirmation currently open, or null.
   *
   * Inline, on the row it was opened from. The editor has no `alert()` and no `confirm()`,
   * and a destructive action is the worst possible place to introduce one: a native dialog
   * says "Are you sure?" over a sentence the user can no longer read. This row stays beside
   * the week it names, spells out both paths, and prints the host's refusal in place if the
   * re-verification says no.
   */
  pendingDelete: {
    /** 'local' removes the folder on this Mac; 'remote' removes the one on the archive. */
    scope: 'local' | 'remote';
    /** The folder that will actually be removed. Also the key the template renders it under. */
    target: string;
    label: string;
    /** Where the surviving copy lives. For 'remote' there is none, and this is the target. */
    destPath: string;
    /** How many rows leave the projects list with it. 'local' only. */
    projectCount: number;
    /** The delete is running: both buttons are disabled and the action button says so. */
    busy: boolean;
    /** The host's verbatim refusal, printed inside this row rather than on the shared line. */
    error: string | null;
    /**
     * What it is doing right now, in the operator's words. Null until the host says.
     *
     * A delete takes its turn behind any transfer already running, then re-verifies the whole
     * week against the archive — thousands of files over SMB, minutes of it — before a single
     * byte is removed. A static "Deleting…" through all of that is indistinguishable from a
     * hang, and this is the row that has to say otherwise.
     */
    progress: string | null;
    /** The outcome, once there is one. The row stays open long enough to be read. */
    done: string | null;
  } | null = null;

  /** Resolves once the archive has been probed. Every check waits on it. */
  private archiveReady: Promise<void> | null = null;
  /**
   * Weeks the automatic pass has already settled. The projects list publishes several times
   * as it loads, and each week costs a full rsync dry run — tens of seconds — so a week is
   * scanned once per session unless the refresh button asks for it again.
   *
   * Only weeks that actually produced a verdict are recorded. One skipped because the NAS was
   * asleep stays eligible, so plugging it back in and pressing refresh still checks it.
   */
  private autoCheckedWeeks = new Set<string>();
  private autoCheckTimer: ReturnType<typeof setTimeout> | null = null;

  private archiveRows: Record<string, ArchiveRow> = {};
  /**
   * Every week the archive server holds, from the last listing. The ones whose name matches
   * no local week become ghost rows; the rest are simply the remote halves of weeks already
   * on the list, and are not rendered twice.
   *
   * Empty when the archive is unreachable, which is why the ghost rows disappear then rather
   * than going stale — nothing is claimed about a server nobody can currently see.
   */
  private remoteWeeks: RemoteWeek[] = [];
  private subs: Subscription[] = [];

  constructor(
    private projectsService: ProjectsService,
    private archive: ArchiveService,
    @Inject(EDITOR_HOST) private host: EditorHost,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.subs.push(this.projectsService.projects$.subscribe(list => {
      this.projects = list;
      this.composeGroups();
      this.cdr.markForCheck();
      // THE LIST ARRIVING is what starts the startup check, not this component mounting.
      // The registry is loaded by the editor, asynchronously, and it publishes several times
      // (initial read, legacy migration, prune). Kicking the check off in ngOnInit instead
      // ran it against an empty list and checked nothing at all.
      this.scheduleAutoCheck();
    }));
    this.subs.push(this.projectsService.error$.subscribe(err => {
      this.registryError = err;
      this.cdr.markForCheck();
    }));
    this.subs.push(this.projectsService.pruned$.subscribe(note => {
      this.prunedNotice = note;
      this.cdr.markForCheck();
    }));
    this.subs.push(this.archive.rows$.subscribe(rows => {
      this.archiveRows = rows;
      this.cdr.markForCheck();
    }));
    this.subs.push(this.archive.error$.subscribe(err => {
      this.archiveError = err;
      this.cdr.markForCheck();
    }));
    this.subs.push(this.archive.deleteProgress$.subscribe(p => {
      // Only for the row that asked. A broadcast from another window's delete must not
      // relabel a confirm row sitting here over a different week.
      if (!p || !this.pendingDelete || p.path !== this.pendingDelete.target) return;
      this.pendingDelete.progress = this.describeDeletePhase(p);
      this.cdr.markForCheck();
    }));

    // Probes the archive and silently mounts it if it can. Starts NO transfer — a project
    // opening must never begin a 300 GB upload on its own. The per-week checks are driven by
    // the projects list arriving (above); this promise is what they wait on, so they can
    // never run before it is known whether the archive is even reachable.
    this.archiveReady = this.archive.init();

    // Which weeks the server holds. Waits on the probe above (inside), and yields nothing at
    // all when the archive is unreachable — no ghost rows is the honest answer there.
    void this.refreshGhostWeeks();
  }

  dismissPrunedNotice(): void {
    this.projectsService.clearPrunedNotice();
  }

  dismissResumeNotice(): void {
    this.resumeNotice = null;
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
    this.subs = [];
    if (this.autoCheckTimer !== null) {
      clearTimeout(this.autoCheckTimer);
      this.autoCheckTimer = null;
    }
  }

  trackByPath = (_: number, e: ProjectEntry) => e.path;
  // '\0ungrouped' as an ESCAPE, not a literal NUL byte. It was written as a raw NUL, which
  // made git treat this whole file as binary — every diff on it read "Bin 22599 -> 22813
  // bytes" and showed nothing at all. Same value, same sentinel, readable history.
  trackByGroup = (_: number, g: WeekGroup) => g.path || '\0ungrouped';

  /** Let the host put a message on the pane's inline error line (it owns no other surface). */
  showError(message: string): void {
    this.inlineError = message;
    this.cdr.markForCheck();
  }

  // ── Week grouping ───────────────────────────────────────────────────────────

  /**
   * The list the template renders: local weeks and ghost weeks in ONE name ordering, with the
   * catch-all group last.
   *
   * Ghosts are woven in rather than gathered under a heading of their own, because they are
   * the same weeks: one deleted locally yesterday belongs exactly where it has always been in
   * the list, faded, not exiled to the bottom.
   *
   * Matching is by NAME, not by path — the two copies live on different volumes, and the name
   * is precisely what maps one onto the other (`<archiveRoot>/<week>`, which is what
   * `destinationFor` does for a week). A week present on both sides is not a ghost and is
   * never drawn twice.
   */
  private composeGroups(): void {
    const grouped = this.groupByWeek(this.projects);
    const weeks = grouped.filter(g => !!g.path);
    const ungrouped = grouped.filter(g => !g.path);

    const localNames = new Set(weeks.map(g => g.label));
    for (const remote of this.remoteWeeks) {
      if (localNames.has(remote.name)) continue;
      weeks.push({ path: remote.path, label: remote.name, entries: [], ghost: true });
    }

    weeks.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
    this.groups = [...weeks, ...ungrouped];

    // A confirmation whose week has left the list has nothing left to confirm. Never while it
    // is running: that one is mid-flight and owns its own ending.
    if (this.pendingDelete && !this.pendingDelete.busy &&
        !this.groups.some(g => g.path === this.pendingDelete!.target)) {
      this.pendingDelete = null;
    }
  }

  /**
   * Re-read which weeks the archive server holds, and rebuild the list around the answer.
   *
   * An unreachable archive produces NO ghost rows, and that is a documented state rather than
   * a swallowed failure — it is the same answer the sidebar already gives by hiding every
   * sync control on a host with no archive at all. A row claiming "this week survives on the
   * server" has to be backed by having just looked.
   */
  async refreshGhostWeeks(): Promise<void> {
    if (!this.ghostWeeksSupported) return;
    // The probe decides whether a listing can say anything, exactly as it does for the checks.
    if (this.archiveReady) await this.archiveReady;
    this.remoteWeeks = await this.archive.listRemoteWeeks();
    this.composeGroups();
    this.cdr.markForCheck();
  }

  /**
   * Split the flat registry into weeks (see `weekOf` for the two accepted layouts); anything
   * else falls into a single trailing group with no week path.
   *
   * Grouping tracks the ARCHIVE DESTINATION exactly — `weekOf` accepts precisely the two
   * layouts `destinationFor` (electron/services/editor/archive-sync.ts) can map, so a folder
   * is never grouped under a week it would not be uploaded into. Any looser name-guessing
   * would break that correspondence.
   */
  private groupByWeek(list: ProjectEntry[]): WeekGroup[] {
    const byWeek = new Map<string, WeekGroup>();
    const ungrouped: ProjectEntry[] = [];

    for (const entry of list) {
      const week = this.weekOf(entry.path);
      if (!week) {
        ungrouped.push(entry);
        continue;
      }
      let group = byWeek.get(week);
      if (!group) {
        group = { path: week, label: this.basename(week), entries: [] };
        byWeek.set(week, group);
      }
      group.entries.push(entry);
    }

    const groups = Array.from(byWeek.values()).sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));

    // Entries arrive already name-sorted from the service, so each group is in order too.
    if (ungrouped.length) {
      groups.push({ path: null, label: 'Other projects', entries: ungrouped });
    }
    return groups;
  }

  /**
   * The `<week>` folder a project groups under, or null when its layout names no week.
   *
   * Two accepted shapes, checked in this order:
   *   1. `<week>/files/<day>` — the layout every recorded session uses.
   *   2. `<week>/<day>` where `<week>` is a bare date (2026-08-16) — a MASTER-ONLY recovery
   *      project. Those folders hold nothing but a downloaded broadcast master and are
   *      dropped straight onto the week root, with no `files/` layer to sit under. The week
   *      folder returned is the same string shape as (1) produces, so a recovery project and
   *      the real sessions of that week land in ONE group.
   *
   * Shape 2 requires the parent to be exactly date-named on purpose: without that, EVERY
   * two-deep path on disk would claim its parent as a week and the grouping would be noise.
   */
  private weekOf(projectPath: string): string | null {
    const clean = projectPath.replace(/[\\/]+$/, '');
    const parts = clean.split(/[\\/]/);
    if (parts.length < 3) return null;
    if (parts[parts.length - 2] === 'files') {
      return parts.slice(0, parts.length - 2).join('/');
    }
    if (WEEK_FOLDER_RE.test(parts[parts.length - 2])) {
      return parts.slice(0, parts.length - 1).join('/');
    }
    return null;
  }

  // ── Row state ───────────────────────────────────────────────────────────────

  /** 'missing' when a folder has never been scanned — nothing about it is known yet. */
  state(e: ProjectEntry): string {
    return e.scan?.state || 'missing';
  }

  /** Only a project we can act on is clickable; missing/unrecognized rows are dead. */
  isActionable(e: ProjectEntry): boolean {
    const s = this.state(e);
    return s === 'raw' || s === 'processed' || s === 'edited';
  }

  isActive(e: ProjectEntry): boolean {
    return !!this.activeZipPath && e.scan?.zipPath === this.activeZipPath;
  }

  isBusy(e: ProjectEntry): boolean {
    return !!this.busyPath && e.path === this.busyPath;
  }

  /** Hover text: the verbatim reason for a dead row, otherwise the folder it points at. */
  rowTitle(e: ProjectEntry): string {
    const s = this.state(e);
    // 'missing' rows are removed by the service, so a row only reads "gone" in the instant
    // between a scan and the prune — but it must still say something true if seen.
    if (s === 'missing') return `${e.path}\nThe folder is no longer there.`;
    if (s === 'unreachable') {
      return `${e.path}\n${e.scan?.error || 'Its volume is not mounted.'}\n` +
             `Kept in the list — it comes back when the volume does.`;
    }
    if (s === 'unrecognized') return `${e.path}\n${e.scan?.error || 'No master video found in this folder.'}`;
    if (s === 'raw') return `${e.path}\nNot processed yet — click to process.`;
    return e.scan?.zipPath || e.path;
  }

  /** The badge text; 'unreachable' is too long and says nothing a user cares about. */
  badge(e: ProjectEntry): string {
    return this.state(e) === 'unreachable' ? 'offline' : this.state(e);
  }

  // ── Archive sync ────────────────────────────────────────────────────────────

  /** False when the host has no archive at all: every sync control is left out of the DOM. */
  get archiveSupported(): boolean {
    return this.archive.supported;
  }

  syncState(path: string | null): ArchiveRow['state'] {
    if (!path) return 'unavailable';
    return (this.archiveRows[path] || this.archive.rowOf(path)).state;
  }

  /** Time remaining while transferring, null otherwise. */
  syncLabel(path: string | null): string | null {
    if (!path) return null;
    return (this.archiveRows[path] || this.archive.rowOf(path)).label;
  }

  /** 0-100 for the week divider's progress bar; null when there is nothing to draw. */
  syncPercent(path: string | null): number | null {
    if (!path) return null;
    return (this.archiveRows[path] || this.archive.rowOf(path)).percent;
  }

  /** "45.2 GB / 380 GB left". */
  syncCounter(path: string | null): string | null {
    if (!path) return null;
    return (this.archiveRows[path] || this.archive.rowOf(path)).counter;
  }

  /** "101 MB/s". */
  syncSpeed(path: string | null): string | null {
    if (!path) return null;
    return (this.archiveRows[path] || this.archive.rowOf(path)).speed;
  }

  /**
   * Whether the week divider should show its transfer readout. Bound to the COUNTER rather
   * than to the state, so the second line appears the moment there are real figures and never
   * as an empty strip during the comparison phase.
   */
  showSyncBar(path: string | null): boolean {
    return !!path && !!this.syncCounter(path);
  }

  /**
   * Is this path a WEEK divider's folder? Weeks are keyed by group path, days by entry path,
   * and a day always sits strictly BELOW its week (`<week>/files/<day>` or `<week>/<day>`),
   * so the two can never collide.
   */
  private isWeekPath(path: string): boolean {
    return this.groups.some(g => g.path === path);
  }

  /** Every actionable day under this week is verified in the archive. */
  private daysArchived(week: string): boolean {
    const group = this.groups.find(g => g.path === week);
    if (!group) return false;
    const days = group.entries.filter(e => this.isActionable(e));
    return days.length > 0 && days.every(e => this.syncState(e.path) === 'done');
  }

  /**
   * A week whose DAYS are all in the archive while the week folder itself still owes it
   * something — the Final Cut library, `complete/`, `thumbnails/`, a day folder never added
   * as a project. On a real week that remainder is 13 GB against 232 GB of day media, so it
   * is neither noise nor something to paint over.
   *
   * The divider goes GREEN for it, because the days really are safe, but the check is drawn
   * HOLLOW: a filled check is this button's claim that the whole folder is archived, and 12 GB
   * of un-backed-up renders must never inherit that claim.
   *
   * Requires a MEASURED remainder. A week nobody has checked reports no extras, and an
   * unmeasured week is left on its own state — nothing measured, nothing claimed.
   */
  weekPartlyArchived(path: string | null): boolean {
    if (!path || !this.isWeekPath(path)) return false;
    if (this.syncState(path) !== 'idle') return false;   // busy/failed/done states own the row
    const extras = this.archive.weekExtrasOf(path);
    if (!extras || extras.bytes <= 0) return false;
    return this.daysArchived(path);
  }

  /**
   * The state the BUTTON is drawn in, which is not always the state the row IS in: a partly
   * archived week is idle (it has bytes to send) but reads green, because its days are done.
   * Everything that acts — syncing, cancelling, the queue — keeps using `syncState`.
   */
  displaySyncState(path: string | null): ArchiveRow['state'] {
    return this.weekPartlyArchived(path) ? 'done' : this.syncState(path);
  }

  /**
   * The glyph on the button. Every state is a CIRCLE — filled for idle and done, a ring for
   * the failure marks — so the control reads as a button at rest and matches the spinner it
   * turns into. A bare arrow looked like decoration rather than something to click.
   *
   * Deliberately one character per state so the column never reflows mid-sync.
   */
  syncGlyph(path: string | null): string {
    switch (this.displaySyncState(path)) {
      case 'done': return '✓';
      case 'unavailable': return '✕';
      case 'failed': return '✕';
      default: return '↑';
    }
  }

  /** True for the states drawn as a filled disc rather than an outlined ring. */
  syncFilled(path: string | null): boolean {
    // The one case where a green check is deliberately NOT filled — see weekPartlyArchived.
    if (this.weekPartlyArchived(path)) return false;
    const s = this.syncState(path);
    return s === 'idle' || s === 'done' || s === 'checking' || s === 'queued';
  }

  /** Every phase where work is genuinely in flight spins, including the silent scan. */
  syncSpinning(path: string | null): boolean {
    const s = this.syncState(path);
    return s === 'connecting' || s === 'scanning' || s === 'uploading';
  }

  syncTitle(path: string | null, kind: 'week' | 'day'): string {
    if (!path) {
      return 'This project is not inside a <week>/files/<day> or <week>/<day> folder, so ' +
             'there is no archive destination to derive. Move it into a week folder to sync it.';
    }
    const row = this.archiveRows[path] || this.archive.rowOf(path);
    const what = kind === 'week' ? 'this whole week' : 'this day';

    // The hollow green check. It has to say BOTH halves — what is safe and what is not —
    // because the mark itself only carries the good half.
    if (this.weekPartlyArchived(path)) {
      const group = this.groups.find(g => g.path === path);
      const n = group ? group.entries.filter(e => this.isActionable(e)).length : 0;
      return `All ${n} day${n === 1 ? '' : 's'} are in the archive.\n` +
             `The week folder itself still has ${this.archive.extrasSummary(path)} to upload — ` +
             `the Final Cut library, complete/, thumbnails/, and any day folder not on this list.\n` +
             `Click to sync ${this.basename(path)} and finish it.`;
    }

    switch (row.state) {
      case 'idle': return `Sync ${what} to the archive.\n${row.detail}`;
      case 'checking': return row.detail;
      case 'queued': return row.detail;
      case 'done': return `${row.detail}\nClick to sync ${what} again.`;
      case 'unavailable': return `Archive unavailable: ${row.detail}\nClick to try connecting again.`;
      case 'failed': return `Last sync failed: ${row.detail}\nClick to try again.`;
      default: return row.detail;
    }
  }

  async onSyncClick(ev: Event, path: string | null, kind: 'week' | 'day'): Promise<void> {
    ev.stopPropagation();
    ev.preventDefault();
    this.closeContextMenu();
    if (!path) return;
    await this.archive.sync(path, kind, this.daysOf(path, kind));
    this.cdr.markForCheck();
  }

  /**
   * Work out which weeks (and the days inside them) are already in the archive.
   *
   * ONE WEEK AT A TIME, in sequence. Each check is a full rsync dry run — minutes of network
   * round-trips for a week's ~14,000 files — and firing them all at once would have them
   * competing for the same share and finishing later than doing them in order. Ungrouped
   * projects are skipped: without a week folder there is no destination to compare against.
   *
   * Fire-and-forget by design. Nothing waits on this, and a failure leaves the rows on their
   * neutral mark rather than claiming anything.
   */
  /**
   * Debounced trigger for the automatic pass. The registry publishes several times while it
   * loads (initial read, legacy migration, prune), and each publication would otherwise start
   * its own sweep of multi-minute rsync scans.
   */
  private scheduleAutoCheck(): void {
    if (!this.archiveSupported) return;
    if (this.autoCheckTimer !== null) clearTimeout(this.autoCheckTimer);
    this.autoCheckTimer = setTimeout(() => {
      this.autoCheckTimer = null;
      void this.refreshArchiveMarks();
    }, 500);
  }

  async refreshArchiveMarks(force = false): Promise<void> {
    if (!this.archiveSupported || this.refreshing) return;
    // Never check before the archive has been probed — its availability decides whether a
    // check can say anything at all.
    if (this.archiveReady) await this.archiveReady;
    if (force) this.autoCheckedWeeks.clear();

    this.refreshing = true;
    this.cdr.markForCheck();
    // Folders the operator had already put in the archive that this pass finds behind. They
    // are COLLECTED here and started after every check has run, never as they are found: the
    // archive queue serializes checks against transfers, so kicking off a four-hour week the
    // moment it is spotted would park every remaining week's verification behind it, and the
    // marks the operator is watching would arrive one upload at a time.
    const behind: Array<{ path: string; kind: 'week' | 'day'; days: string[] }> = [];
    try {
      for (const group of this.groups) {
        if (!group.path) continue;
        if (this.autoCheckedWeeks.has(group.path)) continue;
        // Only projects whose folder is actually THERE. A day on an unmounted drive would
        // otherwise come back "in sync" for the emptiest of reasons — rsync finds nothing
        // pending under a source directory that does not exist — and a green check on a
        // project that is not on this machine is the worst possible lie for a backup tool.
        const present = group.entries
          .filter(e => this.isActionable(e))
          .map(e => e.path);
        if (present.length === 0) continue;
        const settled = await this.archive.refresh(group.path, present, force);
        // Only a week that actually got an answer is struck off. One skipped because the
        // archive was unreachable must remain eligible for the next attempt.
        if (settled) {
          this.autoCheckedWeeks.add(group.path);
          this.collectBehind(group.path, present, behind);
        }
        this.cdr.markForCheck();
      }
      // Same pass, same question asked of the other side: what the server holds that this
      // machine does not. A week deleted locally in another window shows up here.
      await this.refreshGhostWeeks();
    } finally {
      this.refreshing = false;
      this.cdr.markForCheck();
    }

    // Outside the `finally`, so the refresh spinner stops when the CHECKING stops. What
    // follows is transfers, and each one is drawn on its own row.
    await this.resumeBehind(behind);
  }

  /**
   * Which of this week's rows the operator had already put in the archive and which the check
   * just found behind.
   *
   * `syncState`, not `displaySyncState`: a week whose days are all archived reads green while
   * the week folder itself still owes the archive its Final Cut library and `complete/`, and
   * that hollow green check is exactly the case this is here to finish. The underlying state
   * is `idle`, and after a check that settled, `idle` means one thing — it has something to
   * send.
   *
   * A synced WEEK swallows its days: `sync(week)` already queues a job per day plus the week
   * folder, so listing them separately would queue each day twice.
   */
  private collectBehind(
    week: string,
    days: string[],
    out: Array<{ path: string; kind: 'week' | 'day'; days: string[] }>
  ): void {
    if (this.archive.wasIntentionallySynced(week) && this.syncState(week) === 'idle') {
      out.push({ path: week, kind: 'week', days });
      return;
    }
    for (const day of days) {
      if (!this.archive.wasIntentionallySynced(day)) continue;
      if (this.syncState(day) !== 'idle') continue;
      out.push({ path: day, kind: 'day', days: [] });
    }
  }

  /**
   * Finish the folders the operator had already put in the archive.
   *
   * Nothing here can start an upload of a folder that has never been synced — `autoSync`
   * refuses one — so the worst this can do is send what the operator asked to be sent, later
   * than they asked for it. It also refuses anything already running or queued, which is what
   * keeps a second pass from cancelling the transfers the first one started.
   */
  private async resumeBehind(
    behind: Array<{ path: string; kind: 'week' | 'day'; days: string[] }>
  ): Promise<void> {
    if (behind.length === 0) return;

    const started: string[] = [];
    for (const job of behind) {
      if (await this.archive.autoSync(job.path, job.kind, job.days)) {
        started.push(this.basename(job.path));
      }
    }
    if (started.length === 0) return;

    this.resumeNotice =
      `${started.length === 1 ? 'Finishing' : `Finishing ${started.length}`} ` +
      `${started.length === 1 ? 'a folder' : 'folders'} already in the archive that had ` +
      `fallen behind: ${started.join(', ')}.`;
    this.cdr.markForCheck();
  }

  /**
   * The day projects inside a week, in the order the sidebar lists them — which is the order
   * they will be uploaded. Empty for a day click: a day is one job on its own.
   *
   * Only days whose folder is actually present are included; queueing a job for a folder on
   * an unmounted drive would just fail its way through the queue.
   */
  private daysOf(path: string, kind: 'week' | 'day'): string[] {
    if (kind !== 'week') return [];
    const group = this.groups.find(g => g.path === path);
    return group ? group.entries.filter(e => this.isActionable(e)).map(e => e.path) : [];
  }

  dismissArchiveError(): void {
    this.archive.clearError();
  }

  // ── Deleting copies ─────────────────────────────────────────────────────────
  //
  // Two irreversible actions, kept deliberately far apart in what they say and what they
  // look like. Removing a LOCAL week is routine housekeeping on a volume that runs at 96%
  // full, and it is only offered where a verified archived copy exists. Removing a REMOTE
  // week destroys the only copy there is, because a ghost row exists precisely because there
  // is nothing here any more.
  //
  // Neither one trusts the mark next to it. The green check was earned minutes or hours ago;
  // the host re-runs the whole verification against the actual share before it deletes, and
  // its refusal — verbatim — is what the confirmation row prints.

  /** False when the host cannot delete week folders: no red ✕ appears anywhere. */
  get deleteLocalSupported(): boolean {
    return this.projectsService.canDeleteLocalWeek;
  }

  /** False when the host cannot list or prune the archive: no ghost rows at all. */
  get ghostWeeksSupported(): boolean {
    return this.archive.remoteWeeksSupported;
  }

  /**
   * May this week's local copy be deleted?
   *
   * `syncState`, NOT `displaySyncState`. A week whose DAYS are all archived reads green while
   * the week folder itself still owes the archive its Final Cut library, `complete/` and
   * `thumbnails/` — 13 GB on a real week — and that hollow green check must never double as
   * permission to erase them. Only the week's OWN verdict counts here.
   *
   * A destination the host reported is also required: the confirmation has to name where the
   * surviving copy lives, and a week nobody has checked this session has no such answer.
   */
  /** Is the local-delete ✕ drawn at all? Separate from whether it can be PRESSED. */
  showsDeleteLocal(g: WeekGroup): boolean {
    return !g.ghost && !!g.path && this.archiveSupported && this.deleteLocalSupported;
  }

  canDeleteLocal(g: WeekGroup): boolean {
    if (g.ghost || !g.path) return false;
    if (!this.archiveSupported || !this.deleteLocalSupported) return false;
    if (this.syncState(g.path) !== 'done') return false;
    return !!this.archive.destinationOf(g.path);
  }

  /** May this ghost week be deleted from the archive? Only a ghost has an archive-side path. */
  canDeleteRemote(g: WeekGroup): boolean {
    return !!g.ghost && !!g.path && this.ghostWeeksSupported;
  }

  /** Hover text for a week divider. A ghost says what it is and why it does not open. */
  weekTitle(g: WeekGroup): string {
    if (g.ghost) {
      return `${g.path}\nOn the archive server only — there is no copy of this week on this Mac.\n` +
             `Nothing to open or process. The ✕ deletes it from the archive.`;
    }
    return g.path || 'Projects that are not inside a week folder';
  }

  /** Tooltip for the red ✕ on a green week. */
  /**
   * Why the local-delete ✕ on this week cannot be pressed, or null when it can.
   *
   * The button is now DRAWN either way. Omitting it was defensible while the row that
   * lacked it also looked unfinished — but a week whose days are all archived reads green,
   * and a green row with no ✕ next to it looks like a missing button rather than a refused
   * one. The reason a thing is unavailable is worth more than the tidiness of hiding it,
   * and here the reason is the interesting part: there are bytes on this Mac that are not
   * in the archive, and they are the Final Cut library and the exports, not the days.
   */
  deleteLocalBlockedReason(g: WeekGroup): string | null {
    if (g.ghost || !g.path) return null;
    if (!this.archiveSupported || !this.deleteLocalSupported) return null;

    const busy = this.deleteBlockedBySync(g);
    if (busy) return busy;

    if (this.weekPartlyArchived(g.path)) {
      return `${g.label} cannot be deleted locally yet.\n` +
             `Every day in it is archived, which is why it reads green — but the week folder ` +
             `itself still holds ${this.archive.extrasSummary(g.path)} that is NOT in the ` +
             `archive: the Final Cut library, complete/, thumbnails/, and any day folder not ` +
             `on this list.\n` +
             `Sync the week to finish it, and the ✕ becomes usable.`;
    }
    if (this.syncState(g.path) !== 'done') {
      return `${g.label} has not been verified against the archive this session.\n` +
             `Press the refresh button at the top to re-check it, then sync anything still ` +
             `outstanding.`;
    }
    if (!this.archive.destinationOf(g.path)) {
      return `${g.label} has no archived location on record this session, so there is nothing ` +
             `to check the local copy against.\n` +
             `Press the refresh button at the top first.`;
    }
    return null;
  }

  deleteLocalTitle(g: WeekGroup): string {
    return this.deleteBlockedBySync(g) ??
           (`Delete the local copy of ${g.label}.\n` +
            `The archived copy at ${this.archive.destinationOf(g.path!)} stays.\n` +
            `It is re-checked against the archive before anything is deleted.`);
  }

  /**
   * Why this week's ✕ cannot act right now, or null when it can.
   *
   * The one refusal left that the operator cannot see coming. A delete no longer fails just
   * because SOMETHING is syncing — it takes its turn — but a transfer of this very week, or of
   * a day inside it, is a different matter: running the delete and then that sync would put
   * the week straight back. The host refuses it, correctly, and this says so before the click
   * instead of after.
   *
   * Deliberately a DISABLED button rather than a hidden one, unlike `canDeleteLocal`'s "not
   * archived yet" case. That one is a fact about the week; this one is a fact about the next
   * few minutes, and a control that vanishes and returns on its own teaches nobody why.
   */
  deleteBlockedBySync(g: WeekGroup): string | null {
    if (!g.path) return null;
    const busyStates: Array<ArchiveRow['state']> = ['queued', 'connecting', 'scanning', 'uploading'];
    const group = this.groups.find(x => x.path === g.path && !x.ghost);
    const paths = group ? [g.path, ...group.entries.map(e => e.path)] : [g.path];
    const busy = paths.filter(pp => busyStates.includes(this.syncState(pp)));
    if (busy.length === 0) return null;
    return `${g.label} cannot be deleted while it is being uploaded — ` +
           `${busy.length} folder${busy.length === 1 ? '' : 's'} in this week ` +
           `${busy.length === 1 ? 'is' : 'are'} syncing or queued.\n` +
           `Cancel the sync, or let it finish, and the ✕ comes back.`;
  }

  /** Tooltip for the ✕ on a ghost week. */
  deleteRemoteTitle(g: WeekGroup): string {
    return `Delete ${g.label} from the archive server (${g.path}).\n` +
           `There is no local copy — this is the only one.`;
  }

  openDeleteLocal(ev: Event, g: WeekGroup): void {
    ev.stopPropagation();
    ev.preventDefault();
    this.closeContextMenu();
    if (!this.canDeleteLocal(g)) return;
    const destPath = this.archive.destinationOf(g.path!);
    if (!destPath) {
      // Unreachable via canDeleteLocal, and said out loud rather than assumed away: an
      // unnamed destination is exactly the state this must never delete in.
      this.inlineError = `${g.label} has not been checked against the archive this session, so ` +
        `there is no archived location to name. Press the refresh button first.`;
      this.cdr.markForCheck();
      return;
    }
    this.pendingDelete = {
      scope: 'local', target: g.path!, label: g.label, destPath,
      projectCount: g.entries.length, busy: false, error: null, progress: null, done: null
    };
    this.cdr.markForCheck();
  }

  openDeleteRemote(ev: Event, g: WeekGroup): void {
    ev.stopPropagation();
    ev.preventDefault();
    this.closeContextMenu();
    if (!this.canDeleteRemote(g)) return;
    this.pendingDelete = {
      scope: 'remote', target: g.path!, label: g.label, destPath: g.path!,
      projectCount: 0, busy: false, error: null, progress: null, done: null
    };
    this.cdr.markForCheck();
  }

  cancelDelete(): void {
    if (this.pendingDelete?.busy) return;   // it is already running; there is nothing to undo
    this.pendingDelete = null;
    this.archive.clearDeleteProgress();
    this.cdr.markForCheck();
  }

  /** The first line of the confirmation: what is about to happen, in one sentence. */
  confirmHeadline(): string {
    const p = this.pendingDelete;
    if (!p) return '';
    return p.scope === 'local'
      ? `Delete the local copy of “${p.label}”?`
      : `Delete “${p.label}” from the archive server?`;
  }

  /** The paths, spelled out. Both of them, always — this is the whole point of the row. */
  confirmDetail(): string {
    const p = this.pendingDelete;
    if (!p) return '';
    if (p.scope === 'local') {
      const n = p.projectCount;
      return `${p.target}\nis removed from this Mac.\n\n` +
             `The archived copy stays at\n${p.destPath}\n\n` +
             `${n} project${n === 1 ? '' : 's'} leave${n === 1 ? 's' : ''} the list. The week is checked ` +
             `against the archive again before anything is deleted, and this cannot be undone.`;
    }
    return `${p.target}\nis removed from the archive server.\n\n` +
           `There is no copy of this week on this Mac — the archived one is the only one. ` +
           `Nothing else has it, and this cannot be undone.`;
  }

  confirmButtonLabel(): string {
    return this.pendingDelete?.scope === 'local' ? 'Delete local copy' : 'Delete from archive';
  }

  /**
   * Do it. A refusal from the host leaves the row open with its verbatim message, because the
   * reason ("2 files, 4.1 GB would still be uploaded") is what the user needs in order to
   * decide what to do next — dismissing the row and printing it elsewhere would separate the
   * two.
   */
  async confirmDelete(): Promise<void> {
    const pending = this.pendingDelete;
    if (!pending || pending.busy) return;
    pending.busy = true;
    pending.error = null;
    pending.done = null;
    // The host has not spoken yet, and "waiting" is the honest first state: the delete may sit
    // behind a transfer that is already running before it does anything at all.
    pending.progress = 'Waiting for the archive…';
    this.archive.clearDeleteProgress();
    this.cdr.markForCheck();

    try {
      if (pending.scope === 'local') {
        const result = await this.deleteLocalWeek(pending.target);
        const n = result.removedProjects.length;
        pending.done =
          `Deleted ${this.leafOf(result.deleted)}. ` +
          `${n} project${n === 1 ? '' : 's'} left the list. The archived copy is still at ${result.destPath}.`;
      } else {
        const result = await this.archive.deleteRemoteWeek(pending.target);
        await this.refreshGhostWeeks();
        pending.done = result.finishedOnNas
          ? `Deleted ${result.name} from the archive. The share could not remove everything, ` +
            `so the server finished the job itself.`
          : `Deleted ${result.name} from the archive.`;
      }
      // The row stays, showing what happened. It used to vanish on success, which meant the
      // only difference between "it worked" and "the click did nothing" was a row that was no
      // longer there to say either.
      pending.busy = false;
      pending.progress = null;
      this.inlineError = null;
    } catch (err: any) {
      pending.busy = false;
      pending.progress = null;
      pending.error = err?.message || String(err);
    }
    this.archive.clearDeleteProgress();
    this.cdr.markForCheck();
  }

  /** Plain words for a delete phase. The host's vocabulary is not the operator's. */
  private describeDeletePhase(p: { phase: string; filesRemoved?: number }): string {
    switch (p.phase) {
      case 'verifying':
        return 'Checking the archive copy is complete…';
      case 'deleting':
        return typeof p.filesRemoved === 'number' && p.filesRemoved > 0
          ? `Deleting — ${p.filesRemoved.toLocaleString()} files removed…`
          : 'Deleting…';
      case 'finishing-on-nas':
        return 'The share left some entries behind — finishing on the server…';
      case 'updating-registry':
        return 'Updating the projects list…';
      default:
        // A phase this build does not know about still means work is happening; saying so
        // beats falling back to a label that claims to know which.
        return 'Working…';
    }
  }

  /** Last path segment, for a message that names a folder without repeating its whole path. */
  private leafOf(p: string): string {
    return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  }

  /**
   * Delete one local week and put the sidebar back in step, in place — no reload.
   *
   * The projects list republishes on its own (the service drops the rows the host removed),
   * which rebuilds the groups and schedules the next automatic archive pass. What that does
   * not cover is this component's own memory: the archive marks for the folder that is now
   * gone, and the record of having already checked that week.
   */
  private async deleteLocalWeek(week: string): Promise<{ deleted: string; destPath: string; removedProjects: string[] }> {
    const group = this.groups.find(g => g.path === week && !g.ghost);
    const covered = group ? [week, ...group.entries.map(e => e.path)] : [week];

    const result = await this.projectsService.deleteLocalWeek(week);

    // A checkmark outliving its folder would be a claim about something that is not there.
    this.archive.forget(covered);
    this.autoCheckedWeeks.delete(week);
    // It is on the server and not here any more, which is exactly what a ghost row is.
    await this.refreshGhostWeeks();
    return result;
  }

  // ── Right-click menu ────────────────────────────────────────────────────────

  /**
   * Open the menu, if there is anything on it. A right-click that would produce an EMPTY menu
   * is left to the browser rather than swallowed — the archive item needs an archive and a
   * derivable path, the re-process item needs a project, and a week divider on a host with no
   * archive has neither.
   */
  onContextMenu(ev: MouseEvent, path: string | null, kind: 'week' | 'day', label: string,
                entry: ProjectEntry | null = null): void {
    const canSync = this.archiveSupported && !!path;
    const canReprocess = !!entry && this.isActionable(entry);
    if (!canSync && !canReprocess) return;
    ev.preventDefault();
    ev.stopPropagation();
    // `path` is only read by the archive item, which is hidden unless canSync — so the empty
    // string it falls back to for a re-process-only menu is never used as a path.
    this.contextMenu = { x: ev.clientX, y: ev.clientY, path: path || '', kind, label, entry };
    this.cdr.markForCheck();
  }

  /** Whether the open menu offers its archive item at all. */
  get menuCanSync(): boolean {
    return !!this.contextMenu && this.archiveSupported && !!this.contextMenu.path;
  }

  /** The archive item's label — it changes with what that folder is currently doing. */
  contextMenuLabel(): string {
    if (!this.contextMenu) return '';
    const state = this.syncState(this.contextMenu.path);
    if (state === 'queued') return `Remove “${this.contextMenu.label}” from the queue`;
    if (state === 'uploading' || state === 'connecting' || state === 'scanning') {
      return `Stop syncing “${this.contextMenu.label}”`;
    }
    return `Upload “${this.contextMenu.label}” to archive`;
  }

  async onContextMenuSync(): Promise<void> {
    const menu = this.contextMenu;
    this.closeContextMenu();
    if (!menu) return;
    await this.archive.sync(menu.path, menu.kind, this.daysOf(menu.path, menu.kind));
    this.cdr.markForCheck();
  }

  /** Whether the open menu offers "Process"/"Re-process". */
  get menuCanProcess(): boolean {
    return !!this.contextMenu?.entry && this.isActionable(this.contextMenu.entry);
  }

  /**
   * "Process" for a project that has never been run, "Re-process" for one that has. The word
   * has to differ: re-processing REPLACES a session that already exists, and a menu item that
   * read the same either way would hide that.
   */
  processMenuLabel(): string {
    const entry = this.contextMenu?.entry;
    if (!entry) return '';
    return this.state(entry) === 'raw'
      ? `Process “${entry.name}”`
      : `Re-process “${entry.name}”…`;
  }

  /**
   * Hand the project to the editor's normal processing path — the same event a click on a raw
   * row emits. The editor opens the setup modal on it; nothing is started here, and nothing on
   * disk is touched until the user presses Process in that modal.
   */
  onContextMenuProcess(): void {
    const entry = this.contextMenu?.entry;
    this.closeContextMenu();
    if (!entry || !this.isActionable(entry)) return;
    this.inlineError = null;
    this.processRequested.emit(entry);
  }

  @HostListener('document:click')
  @HostListener('document:contextmenu', ['$event'])
  closeContextMenu(ev?: MouseEvent): void {
    // A right-click that opened this menu also bubbles to the document listener; the handler
    // that opened it stops propagation, so anything reaching here is a click somewhere else.
    if (!this.contextMenu) return;
    this.contextMenu = null;
    this.cdr.markForCheck();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeContextMenu();
    // Escape also backs out of a delete confirmation — but not one already running, which
    // has no undo to offer.
    this.cancelDelete();
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  onRowClick(e: ProjectEntry): void {
    if (!this.isActionable(e)) return;
    this.inlineError = null;
    if (this.state(e) === 'raw') {
      this.processRequested.emit(e);
      return;
    }
    this.openRequested.emit(e);
  }

  async onAdd(): Promise<void> {
    if (this.registryError) return;
    try {
      const added = await this.projectsService.addFromDialog();
      if (added) this.inlineError = null;
    } catch (err: any) {
      this.inlineError = err?.message || String(err);
    }
    this.cdr.markForCheck();
  }

  async onRemove(ev: Event, e: ProjectEntry): Promise<void> {
    ev.stopPropagation();
    try {
      await this.projectsService.removeProject(e.path);
      this.inlineError = null;
    } catch (err: any) {
      this.inlineError = err?.message || String(err);
    }
    this.cdr.markForCheck();
  }

  // ── Drag & drop a folder onto the pane ──────────────────────────────────────

  onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.dragOver = true;
  }

  onDragLeave(ev: DragEvent): void {
    ev.preventDefault();
    this.dragOver = false;
  }

  /**
   * Electron 32 removed File.path, so the absolute path has to come from the preload's
   * webUtils (getPathForFile). An empty string means the drop was not a filesystem item at all
   * (a browser drag, a text selection) — said plainly rather than reported as a bad project.
   * Whether the path is a directory is settled by the scan, not guessed here.
   */
  async onDrop(ev: DragEvent): Promise<void> {
    ev.preventDefault();
    ev.stopPropagation();
    this.dragOver = false;
    if (this.registryError) return;

    const files = Array.from(ev.dataTransfer?.files || []);
    if (files.length === 0) {
      this.inlineError = 'Nothing droppable there — drop a project folder.';
      this.cdr.markForCheck();
      return;
    }
    for (const file of files) {
      const path = this.host.getPathForFile(file);
      if (!path) {
        this.inlineError = `“${file.name}” is not a filesystem folder.`;
        continue;
      }
      try {
        await this.projectsService.addProject(path);
        this.inlineError = null;
      } catch (err: any) {
        this.inlineError = err?.message || String(err);
      }
    }
    this.cdr.markForCheck();
  }

  private basename(p: string): string {
    return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  }
}
