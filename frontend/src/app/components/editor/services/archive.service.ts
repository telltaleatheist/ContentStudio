// src/app/components/editor/services/archive.service.ts
import { Inject, Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import {
  ArchiveDeleteProgress, ArchiveProgress, ArchiveResult, DeleteRemoteWeekResult,
  EDITOR_HOST, EditorHost, RemoteWeek
} from '../editor-host';

/**
 * What one sync button is showing.
 *
 *   idle         ↑   has changes to push (or nothing is known about it yet)
 *   checking     ↑   dimmed, while a dry run works out whether it is already up to date
 *   queued       ↑   waiting its turn behind another transfer; click to drop it
 *   connecting   ◍   bringing the share up (orange, spinning)
 *   scanning     ◍   rsync is comparing both sides; shows elapsed time, no percent yet
 *   uploading    ◍   bytes are moving; shows rsync's percentage
 *   done         ✓   verified in the archive — either just uploaded, or a check found nothing
 *                    pending. The tooltip says which, and when.
 *   unavailable  ✕   the archive is not reachable; click to try connecting again
 *   failed       ✕   the transfer itself failed; click to retry, reason is in the tooltip
 *
 * `scanning` exists because rsync is silent for the four-to-five minutes it spends comparing
 * a week's 14,000 files across SMB before it sends a byte. Rendering that as the same
 * motionless spinner as a live transfer made a working sync indistinguishable from a hang.
 * The clock ticking is the whole point: it is proof of life, and it is honest about the fact
 * that no percentage is knowable yet.
 *
 * `unavailable` and `failed` are separate on purpose. "The NAS is asleep" is a normal state
 * with a grey mark and no fuss, exactly as asked. "rsync died halfway through 140 GB" is not
 * normal, and hiding it behind the same grey ✕ would be the kind of silent failure this
 * codebase treats as a bug.
 */
export type ArchiveState =
  'idle' | 'checking' | 'queued' | 'connecting' | 'scanning' | 'uploading' | 'done'
  | 'unavailable' | 'failed';

export interface ArchiveRow {
  state: ArchiveState;
  /**
   * The short text beside the spinner: TIME REMAINING once bytes are moving ("42m"), null
   * otherwise.
   *
   * An estimate of what is left, never a count of what has elapsed. A stopwatch answers a
   * question nobody asked — you can see it is working from the spinner; what you want to know
   * is whether to wait for it. During the comparison phase there is no honest estimate to
   * give (rsync has not sized the job yet), so the spinner stands alone rather than showing
   * a number that means nothing.
   */
  label: string | null;
  /** Hover text. Always says something true about the state it is on. */
  detail: string;
  /**
   * 0-100 for the progress bar, or null when there is nothing honest to draw — during the
   * comparison phase, or before the size of the job is known.
   */
  percent: number | null;
  /** "45.2 GB / 380 GB left", or null when no transfer is running on this row. */
  counter: string | null;
  /** "101 MB/s", or null. rsync's own measured rate, tidied. */
  speed: string | null;
}

/**
 * The archive sync's renderer half: one state per syncable folder, driven by the host's
 * archive events.
 *
 * NOTHING here starts a transfer on its own. The user asked for that explicitly — opening a
 * project must never begin a 300 GB upload — and it is also the only safe default when the
 * destination is a shared NAS. The one thing that does happen unprompted is a single silent
 * connect attempt on load, which mounts the share if it can and says nothing if it cannot.
 *
 * State is per window and per session. It is not persisted, because a checkmark restored from
 * disk would be a claim about the NAS that this process has not verified.
 */
@Injectable()
export class ArchiveService implements OnDestroy {
  private readonly rowsSubject = new BehaviorSubject<Record<string, ArchiveRow>>({});
  private readonly errorSubject = new BehaviorSubject<string | null>(null);
  private readonly deleteProgressSubject = new BehaviorSubject<ArchiveDeleteProgress | null>(null);

  /** Per-folder button state, keyed by local folder path. */
  readonly rows$: Observable<Record<string, ArchiveRow>> = this.rowsSubject.asObservable();
  /** The last refused/failed action, for the pane's inline error line. */
  readonly error$: Observable<string | null> = this.errorSubject.asObservable();
  /**
   * The running delete's latest phase, or null when none is running.
   *
   * Kept apart from the per-folder row state on purpose: a delete's subject can be a week that
   * has NO row at all (a ghost week exists only on the archive), and its lifetime is the
   * confirm row's rather than the folder's. The consumer is the row that started it, and that
   * row clears this as it closes.
   */
  readonly deleteProgress$: Observable<ArchiveDeleteProgress | null> =
    this.deleteProgressSubject.asObservable();

  /** False when the host has no archive at all — the UI hides every sync control. */
  readonly supported: boolean;
  /**
   * False when the host cannot list or delete week folders on the archive server. Tested
   * separately from `supported` because it is a strictly later addition to the same optional
   * group: a host may push to an archive without offering to prune it, and the ghost rows are
   * left out entirely there rather than shown as buttons that cannot act.
   */
  readonly remoteWeeksSupported: boolean;

  private available = false;
  private root = '';
  private unavailableReason = 'The archive has not been checked yet.';
  /** The folder rsync is on right now, so a second click can cancel it. */
  private runningPath: string | null = null;
  private runningId: string | null = null;
  private listenersAttached = false;
  /** Drives the "Comparing…" clock. Non-null only while rsync is in its silent scan phase. */
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Set when a completion event arrives for a sync `sync()` has not finished starting — i.e.
   * the job ended before its own caller was handed the id back. `sync()` consumes it the
   * instant it resumes.
   *
   * A single field rather than a set, because the host permits exactly one sync at a time, so
   * at most one can ever be in this state. A set would additionally leak: in the normal
   * ordering nothing would consume the entries.
   */
  private earlyFinishId: string | null = null;
  /**
   * Bytes the last check said each folder still owes the archive.
   *
   * Kept so the progress bar and the counter have a total from the FIRST byte of a transfer
   * instead of waiting for rsync's percentage to reach 1 — on a 400 GB week that is about a
   * minute of a blank bar. Superseded by rsync's own figure as soon as it has one.
   */
  private totalBytes = new Map<string, number>();
  /**
   * What the last check said a WEEK still owes the archive from OUTSIDE its day projects —
   * the Final Cut library bundle, `complete/`, `thumbnails/`, and any day folder that was
   * never added as a project.
   *
   * Kept separately because "every day is archived" and "the week folder is archived" are
   * different claims, and on a real week the gap between them is not small: on 2026-08-09 it
   * is 13 GB (a 1 GB library and 12 GB of finished renders) against 232 GB of day media. The
   * sidebar needs the difference to mark a week that is only PARTLY up without either lying
   * about the rest or hiding that the days are done.
   *
   * Absent for a week that has not been checked this session: nothing measured means nothing
   * claimed.
   */
  private weekExtras = new Map<string, { bytes: number; files: number; stamp: string }>();
  /**
   * Where each folder's archived copy lives, as the HOST reported it — from a check's
   * `destPath` or a completed transfer's, never derived here.
   *
   * It exists so the delete-the-local-copy confirmation can name the exact folder that will
   * still hold this week afterwards. Deriving it in the renderer would be a second
   * implementation of `destinationFor`, and the one place it must not be guessed is the
   * sentence a user reads before erasing 200 GB. A folder with no entry here has not been
   * checked this session, and the sidebar refuses to offer the delete rather than inventing
   * a destination.
   */
  private destPaths = new Map<string, string>();

  constructor(@Inject(EDITOR_HOST) private host: EditorHost) {
    this.supported = typeof this.host.archiveStatus === 'function'
      && typeof this.host.archiveSync === 'function';
    this.remoteWeeksSupported = typeof this.host.archiveListRemoteWeeks === 'function'
      && typeof this.host.archiveDeleteRemoteWeek === 'function';
  }

  ngOnDestroy(): void {
    // The clock outlives the component unless it is cleared — an interval holding a closure
    // over a destroyed service is a leak that keeps repainting rows nobody is rendering.
    this.stopScanClock();
    if (this.listenersAttached) this.host.removeArchiveListeners?.();
  }

  get isAvailable(): boolean { return this.available; }
  get archiveRoot(): string { return this.root; }

  /**
   * Probe the archive and, if it is down, make ONE silent attempt to mount it. Never throws:
   * an unreachable archive is a state the buttons render, not an error the pane reports.
   */
  async init(): Promise<void> {
    if (!this.supported) return;
    this.attachListeners();

    try {
      let status = await this.host.archiveStatus!();
      if (!status.available && this.host.archiveConnect) {
        // Silent, as specified. A NAS that is asleep is not something to interrupt the user
        // about — the grey ✕ on the buttons is the whole report.
        status = await this.host.archiveConnect();
      }
      this.adoptStatus(status.available, status.root, status.reason);
    } catch (err: any) {
      this.adoptStatus(false, this.root, err?.message || String(err));
    }
  }

  /**
   * The grey ✕ was clicked. Every unavailable button spins orange, one connect is attempted,
   * and they all settle together — the share is one thing, so it cannot be up for one row
   * and down for another.
   */
  async retryConnect(): Promise<void> {
    if (!this.supported || !this.host.archiveConnect) return;

    const rows = { ...this.rowsSubject.value };
    for (const [p, r] of Object.entries(rows)) {
      if (r.state === 'unavailable') {
        rows[p] = { state: 'connecting', label: null, percent: null, counter: null, speed: null, detail: `Connecting to ${this.root || 'the archive'}…` };
      }
    }
    this.rowsSubject.next(rows);

    try {
      const status = await this.host.archiveConnect();
      this.adoptStatus(status.available, status.root, status.reason);
    } catch (err: any) {
      this.adoptStatus(false, this.root, err?.message || String(err));
    }
  }

  /**
   * Queue a folder for upload.
   *
   * A WEEK IS SPLIT INTO ONE JOB PER DAY, in name order, plus a final job for the week folder
   * itself. That last job is not optional and is easy to leave out: a week holds far more than
   * its days — the .fcpbundle, `complete/`, `thumbnails/`, and any day folder that was never
   * added as a project (`files/shorts` on this machine). Queue only the days and all of that
   * silently stops being backed up. It runs LAST so the bulk media moves first and the small,
   * frequently-edited library is captured as late as possible.
   *
   * Clicking something already running or queued DROPS it instead, which is the only way to
   * stop a transfer measured in hours. On a week that means the whole group, days included.
   */
  async sync(localPath: string, kind: 'week' | 'day', days: string[] = []): Promise<void> {
    if (!this.supported) return;

    const group = kind === 'week' ? [...days, localPath] : [localPath];

    // Anything in this group already in flight or waiting → the click means "stop".
    if (group.some(p => this.isActive(p))) {
      await this.cancel(group);
      return;
    }

    const current = this.rowOf(localPath);
    if (current.state === 'unavailable') {
      await this.retryConnect();
      if (!this.available) return;
    }

    this.errorSubject.next(null);
    const items = kind === 'week'
      ? [...days.map(d => ({ localPath: d, kind: 'day' as const })), { localPath, kind: 'week' as const }]
      : [{ localPath, kind: 'day' as const }];

    // Painted immediately rather than waiting for the queue broadcast, so the click has an
    // effect on the same frame instead of after an IPC round trip.
    for (const it of items) {
      this.paint(it.localPath, {
        state: 'queued', label: null, percent: null, counter: null, speed: null,
        detail: `Waiting to sync ${this.leaf(it.localPath)}. Click to drop it from the queue.`
      });
    }

    try {
      await this.host.archiveSync!({ items });
    } catch (err: any) {
      const message = err?.message || String(err);
      if (/not mounted|not available|does not exist|No archive/i.test(message)) {
        this.adoptStatus(false, this.root, message);
        return;
      }
      for (const it of items) {
        this.paint(it.localPath, {
          state: 'failed', label: null, percent: null, counter: null, speed: null, detail: message
        });
      }
      this.errorSubject.next(message);
    }
  }

  /** Is this folder mid-transfer or waiting for its turn? */
  isActive(localPath: string): boolean {
    const s = this.rowOf(localPath).state;
    return s === 'queued' || s === 'connecting' || s === 'scanning' || s === 'uploading';
  }

  /**
   * Adopt the queue the main process reports.
   *
   * The main process is the authority on what is running and what is waiting — it survives
   * this component being torn down and rebuilt, and it is shared by every window. Rows the
   * queue does not mention are left exactly as they are: a checkmark, a failure and an idle
   * arrow are all things the queue knows nothing about.
   */
  private adoptQueue(q: { running: { localPath: string } | null; pending: Array<{ localPath: string }> }): void {
    const rows = { ...this.rowsSubject.value };
    const waiting = new Set(q.pending.map(j => j.localPath));

    for (const [p, r] of Object.entries(rows)) {
      const stillWaiting = waiting.has(p);
      if (stillWaiting && r.state !== 'queued') {
        rows[p] = {
          state: 'queued', label: null, percent: null, counter: null, speed: null,
          detail: `Waiting to sync ${this.leaf(p)}. Click to drop it from the queue.`
        };
      } else if (!stillWaiting && r.state === 'queued' && q.running?.localPath !== p) {
        // Left the queue without a completion of its own — it is now the running job, whose
        // own events take over from here.
        rows[p] = {
          state: 'connecting', label: null, percent: null, counter: null, speed: null,
          detail: `Starting sync of ${this.leaf(p)}…`
        };
      }
    }
    this.rowsSubject.next(rows);
  }

  /**
   * Write one row.
   *
   * Every folder is now its own queued job with its own state, so there is no longer a set of
   * "covered" rows to keep in step with a week — the week's days each report for themselves.
   */
  private paint(primary: string, row: ArchiveRow): void {
    this.rowsSubject.next({ ...this.rowsSubject.value, [primary]: row });
  }

  /**
   * Ask the host what a push of `week` would still move, and settle that week AND every day
   * inside it from the one answer.
   *
   * One scan per week, not per row: the scan is the whole cost (a week is ~14,000 files over
   * SMB and takes minutes), and rsync's itemised output names the files, so which days are
   * behind falls straight out of it.
   *
   * Anything already carrying a verdict from THIS session is left alone — a checkmark earned
   * by an actual completed transfer outranks a check, and a row mid-transfer must not be
   * repainted underneath the user.
   */
  async refresh(week: string, days: string[], force = false): Promise<boolean> {
    if (!this.supported || !this.host.archiveCheck) return false;

    // A manual refresh re-probes the archive first: the usual reason for pressing it is that
    // the NAS was asleep when the window opened, and re-checking every row against a share
    // still marked unreachable would answer nothing.
    if (force && !this.available) await this.retryConnect();
    // FALSE, not true: the caller records which weeks it has settled, and a week that was
    // never actually checked must stay eligible for the next attempt.
    if (!this.available) return false;

    // A live transfer owns its rows; its own completion is the authority on how it ended.
    // A checkmark is left alone on the automatic pass — it was earned by a real transfer or a
    // real check — but a manual refresh is a request to re-verify exactly that, so it goes.
    const busy: ArchiveState[] = ['scanning', 'uploading', 'connecting'];
    const skip: ArchiveState[] = force ? busy : [...busy, 'done', 'failed'];
    const rows = this.rowsSubject.value;
    const wanted = [week, ...days].filter(p => !skip.includes((rows[p] || { state: 'idle' }).state));
    // Nothing left to ask about — every row already carries a verdict, which counts as done.
    if (wanted.length === 0) return true;

    for (const p of wanted) {
      this.setOne(p, { state: 'checking', label: null, percent: null, counter: null, speed: null, detail: `Checking ${this.leaf(p)} against the archive…` });
    }

    let result;
    try {
      result = await this.host.archiveCheck({ localPath: week, kind: 'week' });
    } catch (err: any) {
      // A check that could not run says NOTHING about the project. Fall back to the neutral
      // "ready to sync" mark rather than inventing either a checkmark or a failure.
      const why = err?.message || String(err);
      for (const p of wanted) {
        this.setOne(p, { state: 'idle', label: null, percent: null, counter: null, speed: null, detail: `${this.idleDetail(p)}\nCould not check it first: ${why}` });
      }
      return false;
    }

    const stamp = this.timeOfDay();

    // The week's archived location, exactly as the host computed it. Recorded whether or not
    // this week's own row was due for a repaint — the delete-the-local-copy confirmation has
    // to name it, and it must never be a renderer-side guess.
    this.destPaths.set(week, result.destPath);

    // Recorded from the SAME dry run, and outside the `wanted` loop: the scan answers for the
    // whole week whether or not the week's own row was due for a repaint, and the sidebar
    // needs this to tell "the days are up, the library is not" from "nothing is known".
    const dayPrefixes = days.map(d => `files/${this.leaf(d)}/`);
    const extras = result.pending.filter(f => !dayPrefixes.some(pre => f.path.startsWith(pre)));
    this.weekExtras.set(week, {
      bytes: extras.reduce((n, f) => n + f.bytes, 0),
      files: extras.length,
      stamp
    });

    for (const p of wanted) {
      const pending = p === week
        ? result.pending
        // A day is up to date when nothing pending lives under its own folder.
        : result.pending.filter(f => f.path.startsWith(`files/${this.leaf(p)}/`));
      const bytes = pending.reduce((n, f) => n + f.bytes, 0);
      const inSync = !result.neverArchived && pending.length === 0;

      // Remembered even when this row is in sync (0), so a stale total from an earlier check
      // can never be applied to a later transfer of the same folder.
      this.totalBytes.set(p, bytes);

      this.setOne(p, inSync
        ? { state: 'done', label: null, percent: null, counter: null, speed: null, detail: `Already in the archive — checked at ${stamp}.` }
        : {
            state: 'idle', label: null, percent: null, counter: null, speed: null,
            detail: result.neverArchived
              ? `Not in the archive yet. Click to upload ${this.leaf(p)}.`
              // Size first: "12 files" says nothing about whether this is a coffee break or
              // an hour, and the size is exactly what the progress bar will count down.
              : `${this.humanBytes(bytes)} to upload in ${pending.length} ` +
                `file${pending.length === 1 ? '' : 's'} (checked at ${stamp}). ` +
                `Click to sync ${this.leaf(p)}.`
          });
    }
    return true;
  }

  private setOne(localPath: string, row: ArchiveRow): void {
    this.rowsSubject.next({ ...this.rowsSubject.value, [localPath]: row });
  }

  private timeOfDay(): string {
    const d = new Date();
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** Stop the running sync. Whatever transferred stays; the next run picks up where it left off. */
  /**
   * Drop work by the folders it covers — running or merely waiting.
   *
   * Paths rather than job ids, because the renderer does not track ids for queued jobs and
   * because it is what the click means: a week divider passes its own path plus every day
   * under it, stopping the group in one call.
   */
  async cancel(paths: string[]): Promise<void> {
    if (!this.supported || !this.host.archiveCancel || paths.length === 0) return;
    try {
      await this.host.archiveCancel({ paths });
    } catch (err: any) {
      this.errorSubject.next(err?.message || String(err));
    }
  }

  clearError(): void {
    this.errorSubject.next(null);
  }

  /**
   * What this week still owes the archive from outside its day projects, as of the last check.
   * Null when it has not been checked this session — the caller must claim nothing then.
   */
  weekExtrasOf(week: string): { bytes: number; files: number; stamp: string } | null {
    return this.weekExtras.get(week) || null;
  }

  /** That remainder as readable text ("13 GB in 412 files"), or null if never measured. */
  extrasSummary(week: string): string | null {
    const e = this.weekExtras.get(week);
    if (!e || e.bytes <= 0) return null;
    return `${this.humanBytes(e.bytes)} in ${e.files} file${e.files === 1 ? '' : 's'}`;
  }

  /** A successful week sync clears the remainder it just sent. */
  private forgetExtras(localPath: string): void {
    this.weekExtras.delete(localPath);
  }

  /**
   * Where the archive holds this folder, as the HOST reported it on the last check or the
   * last completed transfer. Null when neither has happened this session.
   *
   * Null is a refusal, not a blank: the caller must not delete a local copy it cannot name
   * the surviving one for.
   */
  destinationOf(localPath: string): string | null {
    return this.destPaths.get(localPath) || null;
  }

  // ── Weeks that live only on the archive ─────────────────────────────────────

  /**
   * The week folders on the archive server.
   *
   * Returns an EMPTY LIST when the archive is unreachable, and that is a documented state
   * rather than a swallowed failure: the sidebar hides every archive control on a host with
   * no archive and shows an unreachable one as a grey mark, so "we cannot see the server, so
   * we claim nothing about what is on it" is the same answer in a different place. A listing
   * that FAILS while the archive is reachable is unexpected and goes to the error line.
   */
  async listRemoteWeeks(): Promise<RemoteWeek[]> {
    if (!this.remoteWeeksSupported) return [];
    if (!this.available) return [];
    try {
      const listing = await this.host.archiveListRemoteWeeks!();
      return listing.weeks;
    } catch (err: any) {
      const message = err?.message || String(err);
      // The share disappearing between the probe and the listing is the archive going away,
      // not a broken listing — it settles every row the same way a failed sync does.
      if (/not mounted|not available|does not exist|No archive/i.test(message)) {
        this.adoptStatus(false, this.root, message);
        return [];
      }
      this.errorSubject.next(`Could not list the weeks on ${this.root || 'the archive'}: ${message}`);
      return [];
    }
  }

  /**
   * Delete one week from the archive server. THROWS with the host's verbatim reason — the
   * caller is a confirmation the user is looking at, and it prints the refusal in place
   * rather than dropping it on the pane's shared error line.
   */
  async deleteRemoteWeek(remotePath: string): Promise<DeleteRemoteWeekResult> {
    if (!this.remoteWeeksSupported) {
      throw new Error('This host cannot delete folders on the archive.');
    }
    // RETURNED rather than discarded. The host reports what it actually removed and whether it
    // had to finish the job on the NAS itself; dropping that left the caller with nothing to
    // tell the operator beyond "the promise resolved".
    return await this.host.archiveDeleteRemoteWeek!({ path: remotePath });
  }

  /**
   * Forget the last delete's progress. Called by the row that displayed it, as it closes.
   *
   * Not cleared here on completion: a delete's terminal state is its RESULT, which goes to the
   * awaiting caller, and a progress subject racing that promise to null would blank the row's
   * last line before anyone had read it.
   */
  clearDeleteProgress(): void {
    if (this.deleteProgressSubject.value !== null) this.deleteProgressSubject.next(null);
  }

  /**
   * Drop everything this service remembers about some folders — their button state, their
   * measured sizes, their archived location.
   *
   * Called when a local folder is deleted. A checkmark left behind would be a claim about a
   * folder that no longer exists, and the remembered destination would outlive the only thing
   * that gave it meaning.
   */
  forget(localPaths: string[]): void {
    if (localPaths.length === 0) return;
    const rows = { ...this.rowsSubject.value };
    for (const p of localPaths) {
      delete rows[p];
      this.totalBytes.delete(p);
      this.weekExtras.delete(p);
      this.destPaths.delete(p);
    }
    this.rowsSubject.next(rows);
  }

  /** The state for one folder; a folder never seen before reads as whatever the archive is. */
  rowOf(localPath: string): ArchiveRow {
    const row = this.rowsSubject.value[localPath];
    if (row) return row;
    return this.available
      ? { state: 'idle', label: null, percent: null, counter: null, speed: null, detail: this.idleDetail(localPath) }
      : { state: 'unavailable', label: null, percent: null, counter: null, speed: null, detail: this.unavailableReason };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private attachListeners(): void {
    if (this.listenersAttached) return;
    this.host.onArchiveProgress?.(p => this.onProgress(p));
    this.host.onArchiveQueue?.(q => this.adoptQueue(q));
    this.host.onArchiveComplete?.(r => this.onComplete(r));
    // Optional independently of the three above: a host that can delete but cannot narrate it
    // leaves this unimplemented, and the confirm row falls back to a plain working state.
    this.host.onArchiveDeleteProgress?.(p => this.deleteProgressSubject.next(p));
    this.listenersAttached = true;
  }

  /**
   * Show a running clock while rsync compares the two sides.
   *
   * rsync prints nothing at all during that phase, so there is no event to drive the display
   * — the clock is generated here. It is not a progress bar and does not pretend to be one:
   * it says how long the comparison has been going, which is the only thing actually known.
   * The FIRST progress line ends it, because with `--no-inc-recursive` rsync cannot emit one
   * until the file list is complete.
   */
  private startScanClock(localPath: string): void {
    this.stopScanClock();
    const started = Date.now();
    const tick = () => {
      const secs = Math.floor((Date.now() - started) / 1000);
      this.paint(localPath, {
        state: 'scanning',
        // No number on the button. rsync has not sized the job yet, so there is no estimate
        // to give, and a count-up would be a stopwatch rather than an answer. The spinner
        // already says it is alive; the elapsed time lives in the tooltip for anyone who
        // actually wants it.
        label: null, percent: null, counter: null, speed: null,
        detail: `Comparing ${this.leaf(localPath)} against ${this.root} — ${this.clock(secs)} so far.\n` +
                `Every file is checked on both sides before anything is sent, which takes ` +
                `a few minutes for a whole week over the network. Click to stop.`
      });
    };
    tick();
    this.scanTimer = setInterval(tick, 1000);
  }

  private stopScanClock(): void {
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /**
   * A tick from rsync.
   *
   * BYTES MOVED — not the arrival of a line — is what says the comparison is over. rsync
   * emits a `0 bytes / 0%` progress line almost immediately and then goes quiet for the whole
   * multi-minute scan. Treating that first line as "transfer started" replaced the running
   * clock with a frozen "0%", which is exactly the motionless display the clock exists to
   * prevent: a 489 GB week sat on "0%" for ten minutes and looked hung.
   */
  private onProgress(p: ArchiveProgress): void {
    this.runningPath = p.localPath;
    this.runningId = p.id;

    // Still comparing. Leave the clock running rather than freezing on a zero.
    if (p.transferred <= 0) return;

    this.stopScanClock();

    const moved = this.humanBytes(p.transferred);
    const rate = p.rate ? ` at ${p.rate}` : '';
    const remaining = this.remaining(p.eta);
    const pct = p.percent ? `${p.percent}%, ` : '';

    // How big the whole job is. rsync's own percentage recovers it exactly once there is one
    // to divide by, which is preferred because it tracks what rsync ACTUALLY decided to send.
    // Before that, fall back to the size the last check measured for this folder — which is
    // what makes the bar and the counter real from the first byte rather than blank for the
    // first minute of a 400 GB push.
    const derived = p.percent ? p.transferred / (p.percent / 100) : 0;
    const total = derived > 0 ? derived : (this.totalBytes.get(p.localPath) || 0);
    const left = total > p.transferred ? total - p.transferred : 0;

    this.paint(p.localPath, {
      percent: total > 0 ? Math.min(100, Math.round((p.transferred / total) * 100)) : null,
      counter: total > 0 ? `${moved} / ${this.humanBytes(left)} left` : moved,
      speed: this.tidyRate(p.rate),
      state: 'uploading',
      // TIME LEFT, from rsync's own estimate. It knows the full job size (--no-inc-recursive
      // builds the whole file list first), so this is a real projection rather than one
      // extrapolated here. Null until it says something usable, which keeps a nonsense
      // figure off the button during the first seconds when the rate has not settled.
      label: remaining,
      detail: `Syncing to ${p.destPath} — ${pct}${moved} transferred${rate}` +
              `${remaining ? `, about ${remaining} left` : ''}. Click to stop.`
    });
  }

  /**
   * rsync's `h:mm:ss` estimate as something readable at a glance — "42m", "1h 20m".
   *
   * Returns null for a missing or zero estimate rather than showing "0s": at the very start
   * rsync reports 0:00:00 before it has a rate to extrapolate from, and a job that claims to
   * be finishing instantly and then does not is worse than no claim.
   */
  /**
   * rsync's rate as something readable — "101.23MB/s" becomes "101 MB/s".
   *
   * Decimals are dropped because the third significant figure of a transfer rate changes
   * several times a second and communicates nothing; a jittering number just draws the eye.
   */
  private tidyRate(rate: string): string | null {
    const m = /^([\d.]+)\s*([kMGT]?B\/s)$/i.exec((rate || '').trim());
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${m[2]}`;
  }

  private remaining(eta: string): string | null {
    const m = /^(\d+):(\d\d):(\d\d)$/.exec(eta || '');
    if (!m) return null;
    const total = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (total <= 0) return null;
    if (total < 60) return `${total}s`;
    const mins = Math.round(total / 60);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
  }

  /** m:ss up to an hour, then h:mm:ss. */
  private clock(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  private onComplete(r: ArchiveResult): void {
    // A sync with nothing to send finishes without ever emitting a progress line, so this is
    // the other place the scan clock can end.
    this.stopScanClock();

    // Only one sync exists at a time (the host refuses a second), so this result always ends
    // whatever was running. When the id does NOT match, this event has overtaken the promise
    // that started the job — flag it so `sync()` knows not to paint a scan state over the
    // result that is about to be rendered below.
    if (this.runningId !== r.id) this.earlyFinishId = r.id;
    this.runningPath = null;
    this.runningId = null;

    if (r.canceled) {
      this.paint(r.localPath, {
        state: 'idle', label: null, percent: null, counter: null, speed: null,
        detail: `Sync stopped. Whatever transferred stays; the next run picks up the rest.`
      });
      return;
    }

    if (r.ok) {
      const files = r.filesTransferred;
      const moved = files === undefined
        ? 'Up to date.'
        : files === 0
          ? 'Already up to date — nothing needed transferring.'
          : `${files} file${files === 1 ? '' : 's'} transferred${
              r.bytesTransferred ? ` (${this.humanBytes(r.bytesTransferred)})` : ''}.`;
      // Stated on every successful sync, not just the first. It is true every time, and a
      // library missing its media links is something you want to learn about now rather than
      // during a restore.
      const links = r.symlinksSkipped
        ? `\n${r.symlinksSkipped} symlink${r.symlinksSkipped === 1 ? '' : 's'} were not archived ` +
          `(they point at paths on this Mac, so they mean nothing on the server). ` +
          `A restored Final Cut library will need its media relinked.`
        : '';
      const skipped = (r.warning ? `\nSome items were skipped:\n${r.warning}` : '') + links;
      // The days inside a synced week get the checkmark too. A week push sends every
      // `files/<day>/` under it, so leaving those rows on their old state would show a day as
      // un-synced at the exact moment it had just been uploaded.
      // A week folder that just went up owes nothing outside its days any more. Cleared rather
      // than left to go stale, or the divider would keep showing a remainder it has since sent.
      this.forgetExtras(r.localPath);
      // Where it actually landed, from the transfer itself. Same purpose as the one a check
      // records: the delete confirmation names this folder, and never one it worked out.
      this.destPaths.set(r.localPath, r.destPath);
      this.paint(r.localPath, {
        state: 'done', label: null, percent: null, counter: null, speed: null,
        detail: `${moved} → ${r.destPath}${skipped}`
      });
      // The transfer succeeded, so the button gets its checkmark — but what it could not
      // take is put on the error line too, rather than living only in a tooltip nobody opens.
      if (r.warning) {
        this.errorSubject.next(`${this.leaf(r.localPath)} synced, but some items were skipped: ${r.warning}`);
      }
      return;
    }

    const message = r.error || 'The sync failed and gave no reason.';
    // rsync losing the share mid-transfer is the archive going away, not a bad transfer.
    if (/No such file or directory|Input\/output error|not mounted|Host is down/i.test(message)) {
      this.adoptStatus(false, this.root, message);
      return;
    }
    this.paint(r.localPath, { state: 'failed', label: null, percent: null, counter: null, speed: null, detail: message });
    this.errorSubject.next(`Sync of ${this.leaf(r.localPath)} failed: ${message}`);
  }

  /**
   * Take a status and re-settle every row that is not mid-transfer. A running rsync is left
   * alone — its own completion event is the authority on how it ended.
   */
  private adoptStatus(available: boolean, root: string, reason?: string): void {
    this.available = available;
    this.root = root || this.root;
    this.unavailableReason = reason || (available ? '' : 'The archive is not reachable.');

    const rows = { ...this.rowsSubject.value };
    for (const [p, r] of Object.entries(rows)) {
      // A live sync is left alone in BOTH of its phases, and on EVERY row it covers — its
      // own completion event is the authority on how it ended. Missing 'scanning' would wipe
      // the clock off a run in its first few minutes; missing the covered rows would drop the
      // days of a week back to idle while that week is still uploading them.
      const live = r.state === 'uploading' || r.state === 'scanning' || r.state === 'connecting';
      if (live && p === this.runningPath) continue;
      if (available) {
        // A checkmark earned this session survives the archive being re-probed.
        if (r.state === 'done') continue;
        rows[p] = { state: 'idle', label: null, percent: null, counter: null, speed: null, detail: this.idleDetail(p) };
      } else {
        rows[p] = { state: 'unavailable', label: null, percent: null, counter: null, speed: null, detail: this.unavailableReason };
      }
    }
    this.rowsSubject.next(rows);
  }

  private idleDetail(localPath: string): string {
    return `Sync ${this.leaf(localPath)} to ${this.root || 'the archive'}`;
  }

  private leaf(p: string): string {
    return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  }

  private humanBytes(n: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }
}
