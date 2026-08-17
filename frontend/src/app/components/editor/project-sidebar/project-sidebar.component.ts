import { Component, EventEmitter, HostListener, Inject, Input, OnDestroy, OnInit, Output, ChangeDetectorRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { EDITOR_HOST, EditorHost } from '../editor-host';
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
}

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
      this.groups = this.groupByWeek(list);
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

    // Probes the archive and silently mounts it if it can. Starts NO transfer — a project
    // opening must never begin a 300 GB upload on its own. The per-week checks are driven by
    // the projects list arriving (above); this promise is what they wait on, so they can
    // never run before it is known whether the archive is even reachable.
    this.archiveReady = this.archive.init();
  }

  dismissPrunedNotice(): void {
    this.projectsService.clearPrunedNotice();
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
   * Split the flat registry into weeks. A project at `<week>/files/<day>` belongs to `<week>`;
   * anything else falls into a single trailing group with no week path.
   *
   * The rule is the literal `files` parent directory, not a date-shaped name, because that is
   * what actually decides the archive destination. Guessing from a name would let a folder be
   * grouped under a week it would never be uploaded into.
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

  /** The `<week>` folder above a `<week>/files/<day>` project, or null for any other layout. */
  private weekOf(projectPath: string): string | null {
    const clean = projectPath.replace(/[\\/]+$/, '');
    const parts = clean.split(/[\\/]/);
    if (parts.length < 3) return null;
    if (parts[parts.length - 2] !== 'files') return null;
    return parts.slice(0, parts.length - 2).join('/');
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
   * and a day always sits at `<week>/files/<day>`, so the two can never collide.
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
      return 'This project is not inside a <week>/files/<day> folder, so there is no ' +
             'archive destination to derive. Move it into a week folder to sync it.';
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
        if (settled) this.autoCheckedWeeks.add(group.path);
        this.cdr.markForCheck();
      }
    } finally {
      this.refreshing = false;
      this.cdr.markForCheck();
    }
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
