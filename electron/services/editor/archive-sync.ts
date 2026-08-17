// electron/services/archive-sync.ts
//
// Pushing a project to the backup NAS.
//
// The transfer is rsync, not a copy, for one reason: the bulk of a project is media that
// never changes after ingest (a single day folder is ~140 GB of master/cam/screen capture).
// The first push moves everything; every push after it moves the handful of megabytes that
// actually changed — the .fcpbundle, the fcpxml, the sidecar json. A plain copy would move
// 140 GB every time.
//
// TWO DELIBERATE OMISSIONS, both requested:
//
//   1. NO --delete. The original spec said "our system is the single source of truth, the
//      server copy is erased and replaced". It is not implemented, because the user also
//      deletes their local copies once a project is archived — the local volume runs at 96%
//      full. A mirror with --delete would therefore erase the NAS copy the moment the local
//      one was pruned, destroying the only surviving copy. Files present on both sides are
//      overwritten from local; files only on the NAS are LEFT ALONE and cleaned up by hand.
//
//   2. NO checksum comparison. rsync's default size+mtime test is what makes a repeat push
//      cheap. --checksum would read all 140 GB on both sides over SMB to prove what the
//      timestamps already say.
//
// rsync's delta algorithm does nothing here — the NAS is an SMB mount, so rsync treats it as
// a local path and copies whole files. What earns its keep is the skip-unchanged test.

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';

export interface ArchiveStatus {
  /** The archive root is a reachable directory right now. */
  available: boolean;
  /** The configured archive root, echoed back so the UI can name it in a tooltip. */
  root: string;
  /** Why it is not available. Always set when `available` is false. */
  reason?: string;
}

export interface ArchiveProgress {
  id: string;
  /** The local folder being pushed — the renderer keys its per-row state on this. */
  localPath: string;
  destPath: string;
  /** 0-100, or null before rsync has built its file list. */
  percent: number | null;
  /** Bytes transferred so far, as rsync reports them. */
  transferred: number;
  /** e.g. "112.34MB/s" — rsync's own text, not recomputed. */
  rate: string;
  /** e.g. "0:04:12" — rsync's own estimate. */
  eta: string;
}

export interface ArchiveResult {
  id: string;
  localPath: string;
  destPath: string;
  ok: boolean;
  /** Set when ok is false: rsync's stderr, or the reason we never got that far. */
  error?: string;
  /**
   * Set when the transfer ran but skipped something (rsync exit 23/24). The sync counts as
   * successful — this is what it could not take, verbatim, and it is surfaced rather than
   * dropped.
   */
  warning?: string;
  /** rsync --stats summary, for the completed tooltip. Absent if stats did not parse. */
  filesTransferred?: number;
  bytesTransferred?: number;
  /**
   * Symlinks deliberately not archived (see the `-rt` note on the argument list). Reported
   * so the gap is visible: a restored Final Cut library will need its media relinked.
   */
  symlinksSkipped?: number;
  /** True when the user cancelled; the UI returns to idle rather than showing a failure. */
  canceled?: boolean;
}

/** What one push covers. 'week' is the whole week folder, 'day' is one folder under files/. */
export type ArchiveKind = 'week' | 'day';

/** One file a push would send, and how big it is. */
export interface PendingFile {
  /** Path relative to the folder being checked, e.g. `files/2026-08-05/master.mp4`. */
  path: string;
  bytes: number;
}

/** One folder waiting to be pushed. */
export interface QueueJob {
  id: string;
  localPath: string;
  kind: ArchiveKind;
  root: string;
  mountUrl: string;
}

/** Who is running and who is waiting, broadcast whenever either changes. */
export interface ArchiveQueueState {
  running: { id: string; localPath: string; kind: ArchiveKind } | null;
  pending: Array<{ id: string; localPath: string; kind: ArchiveKind }>;
}

/** What a dry run says a push would do right now. */
export interface ArchiveCheck {
  localPath: string;
  destPath: string;
  /** Nothing would be transferred — this folder is already in the archive, as it stands. */
  inSync: boolean;
  /**
   * Every file that WOULD be sent, with its size. Sizes are carried per file, not just as a
   * total, because one scan of a week has to answer for each day inside it as well — both
   * "is it behind" and "by how much".
   */
  pending: PendingFile[];
  /** Sum of `pending`. What a sync of this exact folder would move right now. */
  pendingBytes: number;
  /** The destination does not exist at all, so no scan was run. */
  neverArchived?: boolean;
}

const RSYNC_CANDIDATES = ['/opt/homebrew/bin/rsync', '/usr/local/bin/rsync', '/usr/bin/rsync'];

/**
 * Left over from the `--partial-dir` this used to pass. It is still EXCLUDED so that any
 * such directory an earlier build wrote to the server is never mistaken for project content
 * and copied back down or re-synced.
 */
const PARTIAL_DIR = '.rsync-partial';

/**
 * Defaults for the two settings this feature adds. Both are overridable in Settings; these
 * are only what a machine that has never been configured falls back to.
 *
 * The root is the WORKING tree on the NAS (`FCPX/<week>`), not `FCPX/Archive/<week>`, because
 * that is where the full copies live — Archive is the pruned tier the user moves things to by
 * hand once a week is finished with.
 */
export const DEFAULT_ARCHIVE_ROOT = '/Volumes/iO/FCPX';
export const DEFAULT_ARCHIVE_MOUNT_URL = 'smb://titan.local/iO';

/**
 * THE MATCHING RULES — every flag that decides WHICH files are considered, and whether two
 * sides count as equal.
 *
 * Shared verbatim between the real push and the dry-run status check, because a check that
 * used even slightly different rules would report a project as in sync when the push would
 * still move files, or vice versa. The check exists to predict the push; the only honest way
 * to do that is to run the push's own rules.
 *
 * Flags about PRESENTATION (progress, stats) are NOT here — they differ between the two and
 * change nothing about what matches.
 */
const MATCHING_RULES: string[] = [
  // -rt, not -a: the destination is SMB, which has no POSIX ownership or permission bits
  // to preserve. Asking for them (-p -o -g) makes rsync report an error per file on a
  // transfer that in fact succeeded. Times ARE preserved (-t) because the whole
  // skip-unchanged test depends on them.
  //
  // NO `-l` EITHER — symlinks are deliberately not archived. A Final Cut library is full
  // of them: the 2026-07-26 bundle has 104, pointing at `FCPX/assets/`, `~/Downloads`,
  // `~/Movies/Final Cut Optimized Media` and other weeks. Every one is an ABSOLUTE path
  // to this Mac, so on the server they would resolve to nothing a restore could use —
  // and 17 of the 104 are already dead locally. Copying them would archive 104 broken
  // pointers and call it a backup.
  //
  // They also cannot be written to this share: rsync failed all 99 of them with EPERM,
  // and `touch` at the same names fails identically while a fresh name in the same
  // directory succeeds — the names are refused server-side, symlink or not.
  //
  // What this costs is stated plainly rather than hidden: the archived library will need
  // its media relinked on a restore, and the shared `FCPX/assets/` folder those links
  // point into is OUTSIDE any week, so it is not covered by this backup at all.
  '-rt',
  // SMB timestamp resolution is coarser than APFS's. Without this every file looks
  // modified on every run and the entire project re-uploads.
  '--modify-window=2',
  // WRITE STRAIGHT INTO THE DESTINATION FILE. This is what makes a repeat sync cheap,
  // and without it the whole feature does not work.
  //
  // rsync normally writes a temp file, sets its mtime, then renames it into place. THIS
  // SHARE RESETS THE MTIME ON RENAME, so every destination file ends up stamped with the
  // time it was copied rather than the time of its source — and the next run sees 2,900
  // files whose times disagree and re-uploads all 23.8 GB. Measured: two consecutive
  // week syncs each transferred 3,143 files / 23,812,894,068 bytes, byte for byte.
  //
  // It is not the share refusing to store mtimes — `touch -t` sets one and it sticks. It
  // is specifically the rename. `--inplace` has no rename, and the same one-file test
  // goes from dest-mtime=today/resends=1 to dest-mtime=source/resends=0.
  //
  // `--size-only` would also have stopped the re-uploading, and is the wrong fix: it
  // would make a half-written file that happens to match on size permanently invisible
  // to every future sync. Comparing times keeps that self-healing — an interrupted file
  // has neither the right size nor the right time, so the next run replaces it.
  //
  // The cost is that `--partial-dir` is incompatible with `--inplace` (rsync refuses the
  // combination outright), so an interrupted 50 GB file restarts rather than resuming.
  // That is the right trade: interruptions are occasional, re-uploading everything every
  // single time was constant.
  '--inplace',
  '--exclude=.DS_Store',
  `--exclude=${PARTIAL_DIR}`,
  // AppleDouble sidecars. macOS GENERATES ITS OWN on an SMB share to hold the extended
  // attributes of the file beside them, so the server's copy is a different size from
  // the local one by construction and can never match it. Left in, they are the only
  // thing a settled sync still moves: measured after everything else had converged,
  // 2,124 files still wanted sending, every one of them a `._*`, all reporting BOTH size
  // and time differing — 1,875 × 4,096 bytes of pure churn on each run, and the slowest
  // kind of write there is over SMB.
  //
  // Excluding them cedes those files to the SMB client, which is already maintaining
  // them. Nothing of the projects themselves lives there.
  '--exclude=._*',
  // ── Final Cut library internals that cannot cross to the server ──────────
  //
  // A Final Cut library keeps two pointer entries, `.fcpcache` (a SELF-referential
  // symlink, `-> .`) and `.fcpdata` (`-> ./__.fcpdata.apple.com`), plus a `__Temp/`
  // folder of scratch bundles that each carry their own `.fcpcache`. On the server every
  // one of those is a real DIRECTORY, materialised by earlier Finder copies.
  //
  // rsync will not replace a non-empty directory with a symlink, so without these
  // excludes a week push exits 23 and reports failure on a transfer that in fact moved
  // 23 GB perfectly. Measured on 2026-07-26.
  //
  // They are EXCLUDED rather than forced through. `--force` would let rsync delete the
  // server-side directory to make way for the link — and `.fcpcache` is where Final Cut
  // keeps its render files. MEASURED on 2026-07-26: that directory is 51 GB on the
  // server (the whole library there is 52 GB against 1.3 GB locally). Forcing would
  // destroy 51 GB of renders to install a one-byte pointer. The real payload
  // (`__.fcpdata.apple.com`, 89 MB) copies normally; only the pointers are skipped, and
  // Final Cut recreates those.
  //
  // `__Temp/` is additionally worthless in a backup on its own merits: transient working
  // state, 72 KB, recreated on demand.
  '--exclude=__Temp/',
  '--exclude=.fcpcache',
  '--exclude=.fcpdata',
];

/**
 * The mount point a path lives on: `/Volumes/<name>` on macOS, the drive root on Windows.
 * Same lexical approach as the projects scanner, and for the same reason — it has to answer
 * for a path whose volume is absent, which by definition has no mount-table entry.
 */
export function volumeRootOf(p: string): string {
  const win = /^([a-zA-Z]:[\\/])/.exec(p);
  if (win) return win[1];
  const mac = /^(\/Volumes\/[^/]+)/.exec(p);
  if (mac) return mac[1];
  return path.parse(p).root || '/';
}

/** The rsync we will actually run, or null if there is none. */
function findRsync(): string | null {
  for (const c of RSYNC_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Where a local project folder lands under the archive root.
 *
 *   week  /…/FCPX/2026-07-26              ->  <root>/2026-07-26
 *   day   /…/FCPX/2026-07-26/files/07-30  ->  <root>/2026-07-26/files/07-30
 *
 * A day is recognised by its parent being literally `files`, which is the layout every
 * project on disk uses. A folder that is not in that shape THROWS rather than being pushed
 * to a guessed destination — writing 140 GB to the wrong place is not a recoverable mistake.
 */
export function destinationFor(localPath: string, kind: ArchiveKind, root: string): string {
  const clean = localPath.replace(/[/\\]+$/, '');
  if (kind === 'week') {
    return path.join(root, path.basename(clean));
  }
  const filesDir = path.dirname(clean);
  const weekDir = path.dirname(filesDir);
  if (path.basename(filesDir) !== 'files') {
    throw new Error(
      `${clean} is not a day project: its parent is "${path.basename(filesDir)}", expected "files". ` +
      `The archive destination is derived from the <week>/files/<day> layout and cannot be guessed.`
    );
  }
  if (!path.basename(weekDir)) {
    throw new Error(`${clean} has no week folder above its files/ directory.`);
  }
  return path.join(root, path.basename(weekDir), 'files', path.basename(clean));
}

/**
 * One sync at a time, process-wide. Two concurrent rsyncs to the same SMB share compete for
 * the same pipe and finish later than they would in sequence, and a week push overlapping a
 * push of one of its own days would have both writing the same files.
 */
export class ArchiveSync {
  /**
   * The reservation, claimed SYNCHRONOUSLY the moment a sync is accepted and held until it
   * ends. `child` stays null over the awaits between accepting a job and spawning rsync.
   *
   * That window is why this is a reservation rather than "the running process": start() has
   * to mount the share and create directories before it can spawn, and a busy-check that
   * only looked at a live process would let a second click through during those awaits. Both
   * rsyncs would then run at once — which the earlier version of this class did.
   */
  private current: { id: string; localPath: string; kind: ArchiveKind; child: ChildProcess | null } | null = null;
  private canceled = new Set<string>();
  private nextId = 1;
  /**
   * Jobs waiting their turn, oldest first. One rsync runs at a time — they would otherwise
   * fight over the same SMB pipe and all finish later than if they had queued — so pressing
   * Sync while something is running ADDS to this rather than being refused.
   */
  private queue: QueueJob[] = [];
  /** True while `drain()` is walking the queue; keeps a second drain loop from starting. */
  private draining = false;
  /**
   * The dry-run status check, kept in its OWN slot rather than `current`. A check must never
   * make the Sync button answer "a sync is already running", and a real transfer always wins:
   * `start()` kills whatever is here before claiming the transfer slot.
   */
  private checkChild: ChildProcess | null = null;

  constructor(
    private readonly emitProgress: (p: ArchiveProgress) => void,
    private readonly emitComplete: (r: ArchiveResult) => void,
    /** Optional: told whenever the running job or the waiting list changes. */
    private readonly emitQueueState: (q: ArchiveQueueState) => void = () => {}
  ) {}

  private emitQueue(): void {
    this.emitQueueState(this.queueState());
  }

  get busyPath(): string | null {
    return this.current ? this.current.localPath : null;
  }

  /** True while anything is running or waiting — status checks stand aside for transfers. */
  get busy(): boolean {
    return !!this.current || this.queue.length > 0;
  }

  /**
   * Is the archive root there? Nothing is mounted and nothing is written — this is the
   * cheap probe the sidebar runs when it loads, and on an unmounted volume it costs one
   * failed stat rather than a network round trip.
   */
  status(root: string): ArchiveStatus {
    if (!root || !root.trim()) {
      return { available: false, root, reason: 'No archive location is set in Settings.' };
    }
    const stat = fs.statSync(root, { throwIfNoEntry: false });
    if (stat && stat.isDirectory()) return { available: true, root };
    if (stat) {
      return { available: false, root, reason: `${root} exists but is not a directory.` };
    }
    const volume = volumeRootOf(root);
    if (!fs.existsSync(volume)) {
      return { available: false, root, reason: `${volume} is not mounted.` };
    }
    return { available: false, root, reason: `${root} does not exist on ${volume}.` };
  }

  /**
   * Try to bring the share up, then report status.
   *
   * `open -g <url>` hands the mount to macOS's own network-auth agent, which uses the
   * credential already in the Keychain and puts up no window. That is deliberate: the
   * requirement is that a failed connect is SILENT, and every other route to mounting an SMB
   * share either needs root (mount_smbfs must mkdir under /Volumes) or throws up a dialog
   * (AppleScript `mount volume`). The mount is asynchronous, so the appearance of the mount
   * point is polled for; the caller sees only the final status either way.
   */
  async connect(root: string, mountUrl: string, timeoutMs = 20000): Promise<ArchiveStatus> {
    const already = this.status(root);
    if (already.available) return already;

    if (process.platform !== 'darwin') {
      return { available: false, root, reason: `Cannot mount ${root} automatically on ${process.platform}.` };
    }
    if (!mountUrl || !mountUrl.trim()) {
      return { available: false, root, reason: 'No archive server URL is set in Settings.' };
    }

    const volume = volumeRootOf(root);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('open', ['-g', mountUrl], { stdio: 'ignore' });
        child.on('error', reject);
        child.on('close', () => resolve());   // `open` returns immediately; mounting continues
      });
    } catch (err: any) {
      log.warn('[archive] mount request failed:', err?.message || err);
      return { available: false, root, reason: `Could not ask macOS to mount ${mountUrl}: ${err?.message || err}` };
    }

    // Poll for the mount point rather than waiting on `open`, which returns the moment the
    // request is handed off. The loop exits as soon as the VOLUME appears: once it is up,
    // whether the archive folder exists under it is a settled answer, and waiting longer
    // would only delay reporting "the folder is not there".
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(volume)) return this.status(root);
      await new Promise(r => setTimeout(r, 500));
    }
    return { available: false, root, reason: `${volume} did not mount within ${Math.round(timeoutMs / 1000)}s.` };
  }

  /**
   * Add folders to the queue and start working through them. Returns the ids accepted.
   *
   * This REPLACES the old "one at a time, second click is an error" behaviour. Pressing Sync
   * while something is running used to reject with "a sync is already running", which put the
   * burden of scheduling on the user — they had to watch for the end of a one-hour transfer
   * to start the next. Now the second press queues.
   *
   * Still exactly one rsync at a time: concurrent transfers to the same SMB share compete for
   * one pipe and all finish later than they would in sequence.
   *
   * A folder already running or already queued is IGNORED rather than added twice; the ids
   * returned are only the ones actually taken on.
   */
  enqueue(
    items: Array<{ localPath: string; kind: ArchiveKind }>,
    root: string,
    mountUrl: string
  ): { ids: string[] } {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('archive enqueue needs at least one folder');
    }
    // Validate EVERY item before taking any of them on. A batch that is half-accepted and
    // half-rejected leaves the user with a queue that does not match what they clicked, and
    // an unmappable path is a programming error rather than something to work around.
    for (const it of items) {
      destinationFor(it.localPath, it.kind, root);
    }

    const taken = new Set<string>([
      ...(this.current ? [this.current.localPath] : []),
      ...this.queue.map(j => j.localPath)
    ]);

    const fresh: QueueJob[] = [];
    for (const it of items) {
      if (taken.has(it.localPath)) continue;
      taken.add(it.localPath);
      fresh.push({ id: `archive-${this.nextId++}`, localPath: it.localPath, kind: it.kind, root, mountUrl });
    }

    this.queue.push(...fresh);
    this.emitQueue();
    void this.drain();
    return { ids: fresh.map(j => j.id) };
  }

  /** Everything waiting, plus what is running. The renderer paints its rows from this. */
  queueState(): ArchiveQueueState {
    const brief = (j: QueueJob) => ({ id: j.id, localPath: j.localPath, kind: j.kind });
    return {
      running: this.current
        ? { id: this.current.id, localPath: this.current.localPath, kind: this.current.kind }
        : null,
      // The running job stays at the head of the queue until it finishes, so it is excluded
      // here rather than being absent — `pending` means "not started yet".
      pending: this.queue.filter(j => j.id !== this.current?.id).map(brief)
    };
  }

  /**
   * Work through the queue, one job at a time, until it is empty.
   *
   * Jobs are only removed once finished, so `queueState` can report the running one as part
   * of the queue rather than having to reconstruct it.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue[0];
        const outcome = await this.runJob(job);
        this.queue.shift();

        // The share going away fails every remaining job for the same reason. Draining ten of
        // them would produce ten identical errors and hide the one that matters, so the rest
        // are dropped with a single message that names what was skipped.
        if (outcome === 'archive-gone' && this.queue.length > 0) {
          const dropped = this.queue.splice(0, this.queue.length);
          log.warn(`[archive] archive unreachable — dropped ${dropped.length} queued job(s)`);
          for (const d of dropped) {
            this.emitComplete({
              id: d.id, localPath: d.localPath, destPath: destinationFor(d.localPath, d.kind, d.root),
              ok: false,
              error: `Skipped — the archive became unreachable while ${path.basename(job.localPath)} was syncing.`
            });
          }
        }
        this.emitQueue();
      }
    } finally {
      this.draining = false;
      this.emitQueue();
    }
  }

  /**
   * Run one job to completion. Never rejects: every ending — success, failure, cancellation —
   * is reported through `emitComplete`, because the queue has to keep moving either way and a
   * rejection here would strand every job behind it.
   */
  private runJob(job: QueueJob): Promise<'ok' | 'failed' | 'archive-gone'> {
    return new Promise(resolve => { void this.executeJob(job, resolve); });
  }

  private async executeJob(
    job: QueueJob,
    done: (outcome: 'ok' | 'failed' | 'archive-gone') => void
  ): Promise<void> {
    const { id, localPath, kind, root, mountUrl } = job;

    // A real transfer outranks a status check. Killing it here — before anything else — means
    // the user never waits behind a multi-minute dry run they did not ask for.
    this.killCheck();

    let destPath: string;
    try {
      destPath = destinationFor(localPath, kind, root);
    } catch (err: any) {
      this.emitComplete({ id, localPath, destPath: '', ok: false, error: err?.message || String(err) });
      done('failed');
      return;
    }

    // Cancelled before it ever started — a queued job the user changed their mind about.
    if (this.canceled.delete(id)) {
      this.emitComplete({ id, localPath, destPath, ok: false, canceled: true });
      done('ok');
      return;
    }

    const srcStat = fs.statSync(localPath, { throwIfNoEntry: false });
    if (!srcStat || !srcStat.isDirectory()) {
      this.emitComplete({ id, localPath, destPath, ok: false, error: `${localPath} is not a folder — nothing to sync.` });
      done('failed');
      return;
    }

    const rsync = findRsync();
    if (!rsync) {
      this.emitComplete({ id, localPath, destPath, ok: false, error: `rsync was not found (looked in ${RSYNC_CANDIDATES.join(', ')}).` });
      done('failed');
      return;
    }

    // Claim the slot. The next statement awaits, so a second caller reaches its busy check
    // only after this line has run.
    this.current = { id, localPath, kind, child: null };
    this.emitQueue();

    try {
      const available = await this.connect(root, mountUrl);
      if (!available.available) {
        throw new Error(available.reason || `${root} is not available.`);
      }

      // rsync creates the leaf, not a chain of missing parents. A day push into a week that
      // has never been archived needs <root>/<week>/files to exist first.
      const destParent = path.dirname(destPath);
      if (!fs.existsSync(destParent)) {
        fs.mkdirSync(destParent, { recursive: true });
        log.info(`[archive] created ${destParent}`);
      }
    } catch (err: any) {
      // Nothing was spawned, so nothing will emit a completion — the slot has to be released
      // here or every later job would find it occupied.
      this.current = null;
      this.canceled.delete(id);
      this.emitComplete({ id, localPath, destPath, ok: false, error: err?.message || String(err) });
      done('archive-gone');
      return;
    }

    // Cancelled during the mount. There is no process to kill, so it is honoured here.
    if (this.canceled.delete(id)) {
      this.current = null;
      this.emitComplete({ id, localPath, destPath, ok: false, canceled: true });
      done('ok');
      return;
    }

    const args = [
      ...MATCHING_RULES,
      // Whole-run percentage. `--no-inc-recursive` builds the complete file list up front,
      // which is what makes that percentage mean anything: without it rsync measures against
      // the part of the tree it has walked so far, so the number climbs and then falls back
      // as more is discovered, and a progress bar that moves backwards is worse than none.
      //
      // The price is real and was measured on the 2026-07-26 week (14,324 files over SMB):
      // rsync emits NOTHING for the four-to-five minutes it spends comparing both sides, so
      // the first byte transferred is the signal that the scan has ended. The renderer
      // renders that gap as an explicit "Comparing…" state with a running clock rather than
      // a still spinner — the wait is inherent, being unable to tell it from a hang was not.
      '--info=progress2',
      '--no-inc-recursive',
      // Names each symlink it skips, so the reported count is measured rather than assumed.
      '--info=nonreg1',
      '--stats',
      `${localPath.replace(/[/\\]+$/, '')}/`,
      `${destPath}/`
    ];


    log.info(`[archive] ${id}: ${rsync} ${args.join(' ')}`);
    const child = spawn(rsync, args);
    this.current = { id, localPath, kind, child };


    let stderr = '';
    let statsText = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      statsText += chunk;
      // progress2 rewrites one line with \r; --stats appends real lines at the end.
      for (const line of chunk.split(/[\r\n]+/)) {
        const p = parseProgress(line);
        if (p) {
          this.emitProgress({ id, localPath, destPath, ...p });
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    child.on('error', (err: any) => {
      this.current = null;
      this.canceled.delete(id);
      this.emitComplete({ id, localPath, destPath, ok: false, error: err?.message || String(err) });
      done('failed');
    });

    child.on('close', (code: number | null, signal: string | null) => {
      this.current = null;
      const wasCanceled = this.canceled.delete(id);

      if (wasCanceled) {
        this.emitComplete({ id, localPath, destPath, ok: false, canceled: true });
        // A cancelled job is not a broken archive: the rest of the queue carries on. Stopping
        // one day of a week should not silently abandon the days behind it.
        done('ok');
        return;
      }
      // 23 and 24 are rsync's "everything ran, some items did not make it" codes: a source
      // file that vanished mid-run, an entry it could not replace. They are NOT the same as a
      // failed transfer, and showing a red ✕ for them on a 300 GB push that worked would
      // train the user to ignore the indicator. They are also not nothing, so what was
      // skipped is carried through verbatim and shown — reported, not swallowed.
      if (code === 0 || code === 23 || code === 24) {
        const stats = parseStats(statsText);
        const warning = code === 0 ? undefined : (stderr.trim() || `rsync exited with code ${code}`);
        if (warning) {
          log.warn(`[archive] ${id} completed with skipped items (code ${code}): ${warning}`);
        } else {
          log.info(`[archive] ${id} completed: ${stats.filesTransferred ?? '?'} files, ` +
            `${stats.bytesTransferred ?? '?'} bytes` +
            (stats.symlinksSkipped ? `, ${stats.symlinksSkipped} symlinks not archived` : ''));
        }
        this.emitComplete({ id, localPath, destPath, ok: true, warning, ...stats });
        done('ok');
        return;
      }
      const detail = stderr.trim() || `rsync exited with code ${code}${signal ? ` (${signal})` : ''}`;
      log.error(`[archive] ${id} failed: ${detail}`);
      this.emitComplete({ id, localPath, destPath, ok: false, error: detail });
      // Losing the share mid-transfer dooms every job behind this one for the same reason, so
      // it ends the queue rather than repeating itself once per remaining job.
      done(/No such file or directory|Input\/output error|not mounted|Host is down/i.test(detail)
        ? 'archive-gone'
        : 'failed');
    });
  }

  /**
   * Ask what a push WOULD do, without doing it — the up-to-date check behind the green marks.
   *
   * This is `rsync -n` over `MATCHING_RULES`, the push's own matching flags, so its answer is
   * the push's answer by construction. It returns the relative path of every file that would
   * be sent, which lets one scan of a week settle that week AND each day inside it: a day is
   * up to date exactly when nothing pending lives under `files/<day>/`. One scan for the
   * whole group matters because the scan is the expensive part — a week is ~14,000 files over
   * SMB and takes minutes, while re-walking it once per row would take that many times longer.
   *
   * Runs in its own process slot, NOT the transfer's. A check must never make the Sync button
   * report "a sync is already running", and a real transfer always wins: `start()` kills any
   * check in flight, and a check refuses to begin while a transfer holds the slot.
   */
  async check(localPath: string, kind: ArchiveKind, root: string): Promise<ArchiveCheck> {
    // Queued work counts as busy, not just the running job: a check that started between two
    // queued transfers would be killed by the next one the moment it began.
    if (this.busy) {
      throw new Error('A sync is running — status checks wait until it finishes.');
    }
    const rsync = findRsync();
    if (!rsync) throw new Error('rsync was not found.');

    const srcStat = fs.statSync(localPath, { throwIfNoEntry: false });
    if (!srcStat || !srcStat.isDirectory()) {
      throw new Error(`${localPath} is not a folder.`);
    }
    const destPath = destinationFor(localPath, kind, root);
    if (!fs.existsSync(destPath)) {
      // Never archived. Saying so directly avoids a pointless full scan against nothing.
      return { localPath, destPath, inSync: false, pending: [], pendingBytes: 0, neverArchived: true };
    }

    this.killCheck();

    const args = [
      ...MATCHING_RULES,
      '--dry-run',
      // Names AND sizes, which is what makes the per-day breakdown possible and lets the
      // progress bar know its total before a byte has moved. `%i` is the itemize code, `%l`
      // the size, `%n` the path — path last, because these filenames contain spaces.
      '--out-format=%i %l %n',
      // Silence the "skipping non-regular file" lines; symlinks are not archived by design,
      // so they must not read as pending work and turn every row permanently out of date.
      '--info=nonreg0',
      `${localPath.replace(/[/\\]+$/, '')}/`,
      `${destPath}/`
    ];

    return new Promise<ArchiveCheck>((resolve, reject) => {
      const child = spawn(rsync, args);
      this.checkChild = child;
      let out = '', err = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c: string) => { out += c; });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c: string) => { err += c; });
      child.on('error', e => { this.checkChild = null; reject(e); });
      child.on('close', (code, signal) => {
        this.checkChild = null;
        if (signal) {
          // Superseded by a real transfer. Not an error, and not an answer either.
          reject(new Error('Status check was interrupted.'));
          return;
        }
        // 23/24 mean "would have run, some items unreachable" — still a usable answer.
        if (code !== 0 && code !== 23 && code !== 24) {
          reject(new Error(err.trim() || `rsync check exited with code ${code}`));
          return;
        }
        const pending = parsePendingFiles(out);
        const pendingBytes = pending.reduce((n, f) => n + f.bytes, 0);
        resolve({ localPath, destPath, inSync: pending.length === 0, pending, pendingBytes });
      });
    });
  }

  /** Drop a status check that a real transfer is about to supersede. */
  private killCheck(): void {
    if (this.checkChild) {
      this.checkChild.kill('SIGTERM');
      this.checkChild = null;
    }
  }

  /**
   * Drop work, named by the FOLDERS it applies to rather than by job id.
   *
   * Paths, because that is what the user clicked: a day row cancels its own job, and a week
   * divider passes its own path plus every day under it, which stops the whole group in one
   * call whether those days are running or still waiting.
   *
   * A queued job is simply removed. A running one is signalled, and a cancel that lands while
   * the share is still mounting is REMEMBERED — there is no process to signal yet, and
   * without this the click would be silently ignored and the transfer would start anyway.
   *
   * Whatever transferred stays on the server; the next run continues from there.
   */
  cancel(paths: string[]): { canceled: number } {
    const wanted = new Set(paths || []);
    if (wanted.size === 0) return { canceled: 0 };

    let n = 0;

    // Waiting jobs first, so one that is about to start cannot slip through as the running
    // job is being signalled.
    const keep: QueueJob[] = [];
    for (const job of this.queue) {
      const isRunning = this.current?.id === job.id;
      if (!isRunning && wanted.has(job.localPath)) {
        this.emitComplete({
          id: job.id, localPath: job.localPath,
          destPath: destinationFor(job.localPath, job.kind, job.root),
          ok: false, canceled: true
        });
        n++;
        continue;
      }
      keep.push(job);
    }
    this.queue = keep;

    if (this.current && wanted.has(this.current.localPath)) {
      this.canceled.add(this.current.id);
      if (this.current.child) this.current.child.kill('SIGTERM');
      n++;
    }

    this.emitQueue();
    return { canceled: n };
  }

  /** Stop everything, running and waiting. Used on quit. */
  cancelAll(): { canceled: number } {
    return this.cancel([
      ...(this.current ? [this.current.localPath] : []),
      ...this.queue.map(j => j.localPath)
    ]);
  }
}

/**
 * One `--info=progress2` line:
 *   "  4,405,821,952  12%  112.34MB/s    0:04:12"
 * The trailing "(xfr#…, to-chk=…)" is present only on some builds and is not parsed.
 * A line that is not progress (rsync's own chatter, the --stats block) returns null.
 */
export function parseProgress(line: string):
  { percent: number | null; transferred: number; rate: string; eta: string } | null {
  const m = /([\d,]+)\s+(\d+)%\s+(\S+)\s+(\d+:\d\d:\d\d)/.exec(line);
  if (!m) return null;
  const transferred = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(transferred)) return null;
  return { percent: Number(m[2]), transferred, rate: m[3], eta: m[4] };
}

/**
 * The files a dry run says would be SENT, from `--itemize-changes` output.
 *
 * Only real file transfers count. rsync itemises plenty of things that are not pending work:
 *
 *   >f…      a file being sent               <- counted
 *   cd+++…   a directory being created       <- IGNORED
 *   .d..t…   a directory whose mtime differs <- IGNORED
 *
 * Directory timestamps are excluded deliberately. They differ constantly on this share, are
 * worth nothing in a backup, and counting them would leave every week permanently marked out
 * of date — which makes the green check meaningless rather than informative.
 */
export function parsePendingFiles(text: string): PendingFile[] {
  const out: PendingFile[] = [];
  for (const line of text.split('\n')) {
    // `--out-format='%i %l %n'`: itemize code, size in bytes, then the path. The path comes
    // last precisely because these filenames are full of spaces ("2026-08-05 master.mp4").
    //
    // The code's first character is the update type and the second the file kind. Only a
    // regular file ('f') being sent ('>') or created ('c') is real pending work.
    const m = /^([>c])f\S*\s+(\d+)\s+(.+)$/.exec(line.trimEnd());
    if (m) out.push({ path: m[3], bytes: Number(m[2]) });
  }
  return out;
}

/**
 * The `--stats` lines worth showing, plus a count of the symlinks rsync skipped.
 *
 * The skip count is derived from `--info=nonreg1`'s per-file lines rather than from --stats,
 * which does not break them out. It exists so the omission is REPORTED: the archive silently
 * lacking 104 entries from a Final Cut library would be exactly the kind of quiet gap that
 * only shows up when someone tries to restore.
 */
export function parseStats(text: string):
  { filesTransferred?: number; bytesTransferred?: number; symlinksSkipped?: number } {
  const out: { filesTransferred?: number; bytesTransferred?: number; symlinksSkipped?: number } = {};
  const files = /Number of regular files transferred:\s*([\d,]+)/.exec(text);
  if (files) out.filesTransferred = Number(files[1].replace(/,/g, ''));
  const bytes = /Total transferred file size:\s*([\d,]+)\s*bytes/.exec(text);
  if (bytes) out.bytesTransferred = Number(bytes[1].replace(/,/g, ''));
  const skipped = text.match(/skipping non-regular file/g);
  if (skipped) out.symlinksSkipped = skipped.length;
  return out;
}
