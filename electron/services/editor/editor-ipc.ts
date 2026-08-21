// electron/services/editor/editor-ipc.ts
import { ipcMain, dialog, shell, BrowserWindow } from 'electron';
import Store from 'electron-store';
import * as log from 'electron-log';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { execFile } from 'child_process';

import { EditorPaths } from './app-config';
import { PythonService } from './python-service';
import { BinaryResolver } from './binary-resolver';
import { AlignmentAudioService } from './alignment-audio-service';
import * as assetManager from './asset-manager';
import * as ollamaService from './ollama-service';
import { analyzeChapters, suggestTitle, Segment } from './chapter-splitter';
import {
  ArchiveSync, destinationFor, DEFAULT_ARCHIVE_ROOT, DEFAULT_ARCHIVE_MOUNT_URL
} from './archive-sync';
import { createEditorWindow, getEditorWindow } from './editor-window';
import { getMainWindow } from '../../main';

/**
 * Every IPC channel the ported timeline editor needs, in one place.
 *
 * Ported from AutoCutStudio's electron/ipc/ipc-handlers.ts — handler bodies, validation and
 * error messages are that file's, verbatim, because the editor renderer is that app's code
 * too and it reads those messages. The adaptations are only what the new host forces:
 *
 *   - Channels that would collide with a ContentStudio channel are NAMESPACED under
 *     `editor:` (see EDITOR_CHANNEL_RENAMES below). Nothing is reused with a different
 *     shape — a shared name with a different payload is worse than two names.
 *   - Dialogs parent to `BrowserWindow.fromWebContents(event.sender)`, since the editor is
 *     a second window and ACS's "always the main window" would put the sheet on the wrong one.
 *   - `search-files-recursive` is ASYNC here. ACS's version walks the tree with the
 *     synchronous fs API on the main thread, which freezes every window while it runs.
 *   - The services are constructed LAZILY. Constructing BinaryResolver/PythonService
 *     resolves `editor-backend/`, which THROWS when it is absent; doing that at
 *     registration time would take the whole app down over a feature the user may not be
 *     using. Built on first use, the same failure surfaces on the call that needed it.
 */

/**
 * Channel names that differ from AutoCutStudio's, and why. This list is the contract with
 * the frontend agent; anything not named here kept ACS's channel verbatim.
 *
 *   ACS 'select-file'            → 'editor:select-file'            (CS owns 'select-files')
 *   ACS 'select-directory'       → 'editor:select-directory'       (CS registers it)
 *   ACS 'read-directory'         → 'editor:read-directory'         (CS registers it)
 *   ACS 'show-in-folder'         → 'editor:show-in-folder'         (CS registers it)
 *   ACS 'check-file-exists'      → 'editor:check-file-exists'      (kept with the group)
 *   ACS 'search-files-recursive' → 'editor:search-files-recursive' (kept with the group)
 *   ACS 'get-asset-config'       → 'editor:get-asset-config'       (relink modal)
 *   ACS 'save-asset-config'      → 'editor:save-asset-config'      (relink modal)
 *   ACS 'cancel-job'             → 'editor:cancel-job'             (CS owns 'cancel-job'
 *                                                                   for metadata jobs)
 */
const EDITOR_CHANNEL_RENAMES = Object.freeze({
  'select-file': 'editor:select-file',
  'select-directory': 'editor:select-directory',
  'read-directory': 'editor:read-directory',
  'show-in-folder': 'editor:show-in-folder',
  'check-file-exists': 'editor:check-file-exists',
  'search-files-recursive': 'editor:search-files-recursive',
  'get-asset-config': 'editor:get-asset-config',
  'save-asset-config': 'editor:save-asset-config',
  'cancel-job': 'editor:cancel-job',
});

// ── Lazily-built backend services ────────────────────────────────────────────

let pythonServiceInstance: PythonService | null = null;
function pythonService(): PythonService {
  if (!pythonServiceInstance) pythonServiceInstance = new PythonService();
  return pythonServiceInstance;
}

let binaryResolverInstance: BinaryResolver | null = null;
function binaryResolver(): BinaryResolver {
  if (!binaryResolverInstance) binaryResolverInstance = new BinaryResolver();
  return binaryResolverInstance;
}

let audioServiceInstance: AlignmentAudioService | null = null;
function audioService(): AlignmentAudioService {
  if (!audioServiceInstance) audioServiceInstance = new AlignmentAudioService();
  return audioServiceInstance;
}

/**
 * The archive syncer, held at module scope purely so quitting can stop it — see
 * `stopArchiveSyncOnQuit` below.
 */
let archiveSyncInstance: ArchiveSync | null = null;

/**
 * Kill a running archive sync on the way out. Called from the app's shutdown cleanup.
 *
 * This is NOT tidiness. An rsync spawned without `detached` is not killed when its parent
 * exits on POSIX — verified: the child survives and is reparented to PID 1. So quitting
 * mid-sync would leave rsync writing to the NAS with nothing holding a handle on it, and the
 * next launch would offer a Sync button that starts a SECOND rsync into the same files.
 *
 * That is a data-integrity problem specifically because of `--inplace`: without a temp file
 * to isolate them, two rsyncs writing the same destination interleave their output into it.
 * Stopping the sync here is what keeps "one at a time" true across a restart, not just
 * within one run. Whatever had transferred stays and the next run continues from there.
 */
export function stopArchiveSyncOnQuit(): void {
  if (!archiveSyncInstance) return;
  if (!archiveSyncInstance.busy) return;
  const busy = archiveSyncInstance.busyPath || 'the queue';
  log.info(`[archive] quitting — stopping the sync of ${busy}`);
  archiveSyncInstance.cancelAll();
}

/**
 * One destructive deletion at a time, process-wide — the same single-job rule ArchiveSync
 * applies to rsync, for the same reason and then some.
 *
 * Held as the PATH being deleted rather than a boolean so the refusal can name what is
 * already running. It covers both deletions (a local week folder and a week on the archive
 * server) with ONE slot: they are the only two operations in this app that remove a user's
 * media, and two of them at once — in either combination — is a state nothing here is
 * written to reason about. Claimed synchronously the moment a request is accepted and
 * released in a `finally`, so the awaits inside a handler cannot let a second click through.
 */
let deletionInFlight: string | null = null;

/**
 * What the in-flight deletions are aimed at, and which side of the transfer they remove.
 *
 * Needed because a deletion now WAITS: it takes its turn in the ArchiveSync queue instead of
 * refusing outright, so `deletionInFlight` can be set for as long as an in-flight transfer
 * lasts. Refusing every sync for that whole span — which a blanket check on
 * `deletionInFlight` does — would rebuild the same over-broad refusal on the other side of
 * the fence, just pointed the other way.
 *
 * So the refusal is path-scoped instead. `scope` says which path to compare against: a
 * 'local' delete conflicts with a sync whose SOURCE is inside it, a 'remote' delete with a
 * sync whose DESTINATION is. Comparing the wrong one is a guard that never fires.
 */
const deleteTargets = new Map<string, { target: string; scope: 'local' | 'remote' }>();

/**
 * Entries under the archive root that are bookkeeping rather than content. `.rsync-partial`
 * is this app's own leftover (see archive-sync.ts); `#recycle` and `@eaDir` are Synology's
 * trash and thumbnail sidecars, which appear beside real folders on this NAS. Matched
 * case-insensitively, and everything beginning with a dot is skipped separately.
 *
 * `2026 fcpxtemplate` is excluded by name at the user's request: it is week-SHAPED (it has
 * a files/ directory, so the structural filter passes it) but it is a template, not a week —
 * it must never appear in the sidebar with a delete button beside it.
 */
const NON_WEEK_ENTRIES: ReadonlySet<string> = new Set([
  '.rsync-partial', '#recycle', '@eadir', 'lost+found',
  '2026 fcpxtemplate'
]);

/**
 * SSH alias for the archive server, used only to finish deletions the share cannot
 * complete (see finishRemoteDeleteOnNas). An alias, not a hostname: ~/.ssh/config decides
 * the address and key, same as every other machine-to-machine hop on this network.
 * Store key `archiveSshHost` overrides, resolved at read site per this app's convention.
 */
const DEFAULT_ARCHIVE_SSH_HOST = 'titan';

/**
 * Delete a directory tree on the SMB-mounted archive, expecting the share to fight back.
 *
 * `fs.rmSync` is the wrong tool there, learned the hard way (2026-08-17, "whaa audiobook -
 * draft 5"): the server resolves symlinks before the client ever sees them, so a loop like
 * Final Cut's `.fcpcache -> .` presents as a bottomless directory that rmSync burrows into
 * until EBUSY — aborting mid-tree and leaving the week half-deleted — while a DANGLING
 * symlink is hidden from listings entirely and makes the final rmdir fail ENOTEMPTY on a
 * directory that looks empty from this side. Neither can be removed over SMB at all:
 * unlink refuses (it's "a directory" / invisible), rmdir refuses (it's "not empty").
 *
 * So: best effort, with a complete account. Every regular file and honest directory is
 * removed; a directory whose (dev,ino) already appears on the ancestor chain (or that sits
 * past a depth no real week reaches) is recognized as a loop and NOT entered; whatever
 * cannot go is returned in `leftovers` with the reason, and the CALLER decides to throw.
 * Weeks this app pushed never trip any of this — rsync skips symlinks by design
 * (MATCHING_RULES in archive-sync.ts) — it is foreign, hand-copied folders that do.
 *
 * ASYNC throughout, and unlinks run a few at a time: a week is tens of thousands of SMB
 * round-trips, and the synchronous version of this walk froze every window for the whole
 * ride (2026-08-17). fs.promises keeps the main process serving events between calls.
 */
async function deleteArchiveTree(
  root: string,
  /**
   * Called as files come off, at most every `PROGRESS_EVERY` removals.
   *
   * Throttled rather than per-file because a week is tens of thousands of unlinks and one IPC
   * broadcast each would cost more than the deleting does. The count is the honest unit here:
   * there is no total to divide by, since the walk discovers the tree as it goes, and a
   * percentage invented from a guess would be worse than a number that only goes up.
   */
  onProgress?: (filesRemoved: number) => void
): Promise<{
  filesRemoved: number;
  leftovers: Array<{ path: string; reason: string }>;
}> {
  const leftovers: Array<{ path: string; reason: string }> = [];
  let filesRemoved = 0;
  const PROGRESS_EVERY = 200;
  let nextProgressAt = PROGRESS_EVERY;

  /** How many unlinks are in flight at once. SMB pipelines this happily; rsync does more. */
  const UNLINK_BATCH = 16;

  const walk = async (dir: string, ancestors: string[]): Promise<boolean> => {
    // true = this directory was fully removed
    //
    // Loop recognition, in order of cheapness. All three exist because macOS smbfs
    // synthesizes a DIFFERENT inode for every nesting level of the same server-side loop
    // (verified 2026-08-17 on 2026-07-12: .fcpcache, .fcpcache/.fcpcache and one deeper
    // returned three unrelated inode numbers), so identity matching alone can never fire
    // on this share — and a loop the walk enters anyway ends in the share throwing EBUSY
    // from readdir at whatever depth its path limit sits, which is why every syscall
    // below is caught and recorded rather than allowed to abort the handler. A false
    // positive costs nothing: whatever is skipped comes back as a leftover, and the
    // caller finishes leftovers on the NAS itself.
    let key: string;
    try {
      const st = await fs.promises.lstat(dir);
      key = `${st.dev}:${st.ino}`;
    } catch (err: any) {
      leftovers.push({ path: dir, reason: `the share refused to stat it (${err?.code || err?.message}) — symlink loop suspected` });
      return false;
    }
    if (ancestors.includes(key)) {
      leftovers.push({ path: dir, reason: 'symlink loop — the share presents it as a bottomless folder' });
      return false;
    }
    const base = path.basename(dir);
    if (base === path.basename(path.dirname(dir))) {
      // dir/dir with the same name is how a self-referencing link (.fcpcache -> .)
      // presents one level in. Real weeks never nest a folder inside its namesake.
      leftovers.push({ path: dir, reason: 'nested inside a folder of the same name — symlink loop' });
      return false;
    }
    if (ancestors.length >= 32) {
      leftovers.push({ path: dir, reason: 'directory nesting past any real week — treated as a loop' });
      return false;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      leftovers.push({ path: dir, reason: `the share refused to list it (${err?.code || err?.message}) — symlink loop suspected` });
      return false;
    }

    let clean = true;

    // Files first, a batch at a time; directories after, one at a time (recursion).
    const files = entries.filter(e => !e.isDirectory());
    for (let i = 0; i < files.length; i += UNLINK_BATCH) {
      const results = await Promise.all(files.slice(i, i + UNLINK_BATCH).map(async e => {
        const full = path.join(dir, e.name);
        try {
          await fs.promises.unlink(full);
          return null;
        } catch (err: any) {
          return { path: full, reason: err?.code || err?.message || String(err) };
        }
      }));
      for (const r of results) {
        if (r) { leftovers.push(r); clean = false; } else { filesRemoved++; }
      }
      if (onProgress && filesRemoved >= nextProgressAt) {
        nextProgressAt = filesRemoved + PROGRESS_EVERY;
        onProgress(filesRemoved);
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!(await walk(path.join(dir, entry.name), [...ancestors, key]))) clean = false;
    }

    if (!clean) return false;
    try {
      await fs.promises.rmdir(dir);
      return true;
    } catch (err: any) {
      leftovers.push({
        path: dir,
        reason: err?.code === 'ENOTEMPTY' || err?.code === 'EBUSY'
          ? 'the share reports it non-empty — it holds entries SMB hides (dangling symlinks)'
          : (err?.code || err?.message || String(err)),
      });
      return false;
    }
  };

  await walk(root, []);
  return { filesRemoved, leftovers };
}

/**
 * Finish a remote-week deletion ON the NAS itself, over SSH.
 *
 * The entries `deleteArchiveTree` cannot remove — symlink loops the share presents as
 * bottomless folders, dangling links it hides entirely — are ordinary symlinks on the
 * server, so a root helper there (`fcpx-rm-week`, source in editor-backend/nas/, installed
 * once from the NAS console) removes the surviving skeleton in one call. The helper does
 * its own validation (bare non-dot week name only, `assets` refused by name), so the worst
 * this invocation can ever ask for is exactly one direct child of the FCPX share.
 *
 * BatchMode and `sudo -n` mean this either works or fails immediately — it can never hang
 * waiting for a password. Async (the sync version blocked every window for up to its
 * 120 s timeout). Resolves null on success, or the reason it could not run.
 */
function finishRemoteDeleteOnNas(sshHost: string, weekName: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshHost,
      'sudo', '-n', '/usr/local/bin/fcpx-rm-week', weekName,
    ], { encoding: 'utf8', timeout: 120_000 }, (error, stdout, stderr) => {
      if (!error) return resolve(null);
      const detail = (stderr || stdout || '').trim();
      resolve(detail || `ssh could not run: ${error.message}`);
    });
  });
}

/** Where the projects registry lives — beside drift_corrections.json and the other user config. */
function projectsRegistryPath(): string {
  return path.join(EditorPaths.configDir, 'projects.json');
}

/**
 * Read the projects registry, or THROW naming exactly what is wrong with the file.
 *
 * Extracted so the delete-a-week handler validates the registry with the same rules
 * 'projects:read-registry' does, verbatim. A second, laxer reader would be a second opinion
 * about the only record of where the user's projects live.
 *
 * A registry that has never been written is legitimately empty. One that EXISTS but cannot
 * be read is an error that propagates — it is never reset or overwritten.
 */
function readProjectsRegistryFile(): ProjectRegistry {
  const p = projectsRegistryPath();
  if (!fs.existsSync(p)) return { version: 1, projects: [] };

  const raw = fs.readFileSync(p, 'utf8');
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`projects registry ${p} is not valid JSON: ${e.message} ` +
      `— fix or delete the file to continue; it will not be overwritten`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`projects registry ${p} is not an object (got ${Array.isArray(parsed) ? 'an array' : typeof parsed}) ` +
      `— fix or delete the file to continue; it will not be overwritten`);
  }
  if (parsed.version !== 1) {
    throw new Error(`projects registry ${p} has version ${JSON.stringify(parsed.version)}, expected 1 ` +
      `— fix or delete the file to continue; it will not be overwritten`);
  }
  if (!Array.isArray(parsed.projects)) {
    throw new Error(`projects registry ${p} has no projects array (projects is ${typeof parsed.projects}) ` +
      `— fix or delete the file to continue; it will not be overwritten`);
  }

  return parsed;
}

/** Atomic write: tmp + rename, so a crash mid-write can never corrupt the registry. */
function writeProjectsRegistryFile(registry: ProjectRegistry): void {
  const dir = EditorPaths.configDir;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log.info('Created config directory for projects registry:', dir);
  }
  const p = projectsRegistryPath();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/**
 * The `<week>` folder above a `<week>/files/<day>` project, or null for any other layout.
 *
 * The rule is the literal `files` parent directory, not a date-shaped name — the same rule
 * `destinationFor` uses to decide where a project is archived to, and the same one the
 * sidebar groups by. A week derived from a name instead would let a folder be deleted as a
 * week it was never archived as.
 */
function weekFolderOfProject(projectPath: string): string | null {
  const clean = projectPath.replace(/[\\/]+$/, '');
  const filesDir = path.dirname(clean);
  if (path.basename(filesDir) !== 'files') return null;
  const week = path.dirname(filesDir);
  return path.basename(week) ? week : null;
}

/**
 * Is `child` the same path as `parent`, or inside it? Purely lexical on resolved paths —
 * callers that need symlinks resolved pass realpaths in.
 */
function isAtOrUnder(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Where a folder would be archived to, or null if it does not map to one.
 *
 * `destinationFor` throws on an unmappable path, which is right when the caller is about to
 * transfer something — but a GUARD asking "would this sync write into the folder I am
 * deleting?" must not fail the whole request over an item it cannot place. An unmappable
 * item is not writing anywhere, so it cannot be the conflict, and null says so.
 */
function safeDestination(localPath: string, kind: 'week' | 'day', root: string): string | null {
  try {
    return destinationFor(localPath, kind, root);
  } catch {
    return null;
  }
}

/** The window that invoked a call, so a dialog opens on it rather than on the main window. */
function windowOf(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

// ── Types carried across the wire ────────────────────────────────────────────

/** One story's subject list on its way to the Metadata/Inputs queue.
 *
 *  `chapters` (optional) is that story's chapter list with times relative to the story's OWN
 *  exported video. It is carried for the SAVED REPORT only: the titling model sees
 *  `subjects` and nothing else, and no timestamp is ever folded into them. Nothing on this
 *  path may join the two. */
type TitleHandoff = {
  subjects: string[];
  format: 'normal' | 'livestream';
  source?: string;
  chapters?: { timestamp: string; title: string }[];
};

interface ProjectRegistryEntry {
  path: string;
  name: string;
  lastOpened: string;
}

interface ProjectRegistry {
  version: number;
  projects: ProjectRegistryEntry[];
}

interface ProjectScanResult {
  folder: string;
  realPath: string | null;
  exists: boolean;
  state: 'missing' | 'unreachable' | 'unrecognized' | 'raw' | 'processed' | 'edited';
  masterVideo?: string;
  session?: string;
  cleanName?: string;
  zipPath?: string;
  hasTranscript?: boolean;
  error?: string;
}

/**
 * Register every editor channel. Called from setupIpcHandlers, following the
 * setupPublishIpc precedent.
 */
export function setupEditorIpc(store: Store<any>): void {
  setupEditorSessionHandlers();
  setupStoryAnalysisHandlers();
  setupTitleHandoffHandlers();
  setupMediaHandlers();
  setupEditorFileHandlers();
  setupProcessingHandlers();
  setupProjectHandlers();
  setupEditorConfigHandlers();
  setupArchiveHandlers(store);
  log.info(`[editor] IPC handlers registered (renamed channels: ${Object.values(EDITOR_CHANNEL_RENAMES).join(', ')})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor session: window, seed payload, manifest, edit state, export, transcription
// ─────────────────────────────────────────────────────────────────────────────

/**
 * View-only timeline editor handlers.
 *
 * Cross-window seed-payload pattern: the main window invokes 'editor:open' with a
 * { zipPath } payload; the main process opens/focuses the single editor window and holds
 * the payload until the editor pulls it via 'editor:get-payload' (race-free) — it is ALSO
 * pushed on did-finish-load. A call with NO zipPath (the side-nav Editor button) opens/
 * focuses the window with no session: the editor mounts on its empty state and the user
 * picks a project in-window. There is NO completion relay and NO settle guard: the editor
 * is view-only, so closing its window is not a decision the main window is waiting on.
 *
 * 'editor:manifest' runs PythonService.editorManifest and returns the flattened
 * timeline manifest; a Python failure rejects with the Python message VERBATIM —
 * a manifest is never fabricated.
 */
function setupEditorSessionHandlers(): void {
  // Editor-scoped seed payload.
  let pendingEditorPayload: { zipPath: string } | null = null;

  ipcMain.handle('editor:open', async (_event, payload?: { zipPath?: string | null }) => {
    try {
      const zipPath = payload?.zipPath ?? null;
      if (zipPath !== null && (typeof zipPath !== 'string' || zipPath.trim() === '')) {
        throw new Error('editor:open zipPath must be a non-empty string when provided');
      }
      if (zipPath !== null && !fs.existsSync(zipPath)) {
        throw new Error(`editor:open zip file does not exist: ${zipPath}`);
      }

      // An editor window that is already up is simply focused; whatever session it holds
      // stays loaded. ACS also had to guard against the alignment wizard sharing this
      // window — the wizard did not travel, so there is nothing to refuse here.
      const alreadyOpen = getEditorWindow() !== null;

      // Blank open (no zipPath): the side-nav Editor button. A fresh window must NOT
      // inherit a previous session's payload, so the pending slot is cleared and the
      // editor mounts on its no-session state (projects sidebar, empty workspace). An
      // already-open editor keeps its session and the stale pending payload is left alone
      // (an open window never re-pulls it).
      if (zipPath === null) {
        if (!alreadyOpen) {
          pendingEditorPayload = null;
        }
        createEditorWindow();
        return { success: true };
      }

      pendingEditorPayload = { zipPath };

      const win = createEditorWindow();

      if (alreadyOpen) {
        // Already mounted — no navigation, so no did-finish-load will fire. Push the new
        // payload now; the mounted component re-initializes.
        win.webContents.send('editor-payload', pendingEditorPayload);
      } else {
        // Fresh window: push once loaded (belt-and-suspenders; the editor also
        // pulls via 'editor:get-payload' so there is no delivery race).
        win.webContents.once('did-finish-load', () => {
          if (!win.isDestroyed()) {
            win.webContents.send('editor-payload', pendingEditorPayload);
          }
        });
      }

      return { success: true };
    } catch (error: any) {
      log.error('editor:open failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  // Race-free pull of the seed payload by the editor renderer on mount.
  ipcMain.handle('editor:get-payload', async () => {
    return pendingEditorPayload;
  });

  // Build the view-only timeline manifest from the session zip. Rejections
  // propagate the Python error message verbatim; the manifest is never faked.
  ipcMain.handle('editor:manifest', async (_event, payload: { zipPath: string }) => {
    const zipPath = payload?.zipPath;
    if (typeof zipPath !== 'string' || zipPath.trim() === '') {
      throw new Error('editor:manifest requires a non-empty zipPath string');
    }
    return await pythonService().editorManifest(zipPath);
  });

  // Apply a list of frame-range cuts and write a revised .fcpxml next to the zip.
  // Validate loudly per the cut contract before spawning Python: a bad payload is
  // a caller bug, never a silent no-op. Rejections propagate the Python error
  // message verbatim; the export result is never fabricated.
  ipcMain.handle('editor:export', async (_event, payload: {
    zipPath: string;
    cuts: Array<{ startFrame: number; endFrame: number }>;
    stories?: Array<{ number: number; title: string; regions: Array<{ start: number; end: number }> }>;
    output?: 'fcpxml' | 'transcripts';
    // Split every mic lane where the screen track speaks and the mic does not, and disable
    // the middle pieces. Must be forwarded explicitly below — this handler passes named
    // arguments on to pythonService, so any field it does not name is dropped.
    muteMicDuringScreen?: boolean;
  }) => {
    const zipPath = payload?.zipPath;
    if (typeof zipPath !== 'string' || zipPath.trim() === '') {
      throw new Error('editor:export requires a non-empty zipPath string');
    }
    if (!fs.existsSync(zipPath)) {
      throw new Error(`editor:export zip file does not exist: ${zipPath}`);
    }

    // Per-story export carries a 'stories' array; on that path cuts MAY be empty (the user
    // can mark stories without cutting). Validate stories loudly when present. Python
    // re-validates and owns the coordinate math — this is a fast caller-bug guard.
    const stories = payload?.stories;
    const output = payload?.output;
    const isStoryExport = Array.isArray(stories) && stories.length > 0;
    if (isStoryExport) {
      if (output !== 'fcpxml' && output !== 'transcripts') {
        throw new Error(`editor:export with stories requires output 'fcpxml' or 'transcripts', got: ${output}`);
      }
      for (let i = 0; i < stories.length; i++) {
        const s = stories[i];
        if (!s || typeof s !== 'object') {
          throw new Error(`editor:export story at index ${i} is not an object`);
        }
        if (!Number.isInteger(s.number)) {
          throw new Error(`editor:export story at index ${i} has non-integer number: ${s.number}`);
        }
        if (typeof s.title !== 'string' || s.title.trim() === '') {
          throw new Error(`editor:export story at index ${i} (number ${s.number}) has an empty title`);
        }
        if (!Array.isArray(s.regions)) {
          throw new Error(`editor:export story ${s.title} regions must be an array`);
        }
        for (let j = 0; j < s.regions.length; j++) {
          const r = s.regions[j];
          if (!r || typeof r.start !== 'number' || typeof r.end !== 'number' || !(r.start < r.end)) {
            throw new Error(`editor:export story ${s.title} region ${j} is invalid: ${JSON.stringify(r)}`);
          }
        }
      }
    }

    // An EMPTY cuts array is valid: an export with no cuts still runs the mic-mute
    // pass and writes the derived master FCPXML. Only a missing/non-array value is
    // a caller bug.
    const cuts = payload?.cuts;
    if (!Array.isArray(cuts)) {
      throw new Error('editor:export requires a cuts array (empty is allowed)');
    }
    for (let i = 0; i < cuts.length; i++) {
      const cut = cuts[i];
      if (!cut || typeof cut !== 'object') {
        throw new Error(`editor:export cut at index ${i} is not an object`);
      }
      const { startFrame, endFrame } = cut;
      if (!Number.isInteger(startFrame)) {
        throw new Error(`editor:export cut at index ${i} has non-integer startFrame: ${startFrame}`);
      }
      if (!Number.isInteger(endFrame)) {
        throw new Error(`editor:export cut at index ${i} has non-integer endFrame: ${endFrame}`);
      }
      if (startFrame < 0) {
        throw new Error(`editor:export cut at index ${i} has negative startFrame: ${startFrame}`);
      }
      if (startFrame >= endFrame) {
        throw new Error(`editor:export cut at index ${i} has startFrame >= endFrame: ${startFrame} >= ${endFrame}`);
      }
    }

    const muteMic = payload?.muteMicDuringScreen;
    if (muteMic !== undefined && typeof muteMic !== 'boolean') {
      throw new Error(`editor:export muteMicDuringScreen must be a boolean, got: ${typeof muteMic}`);
    }

    return await pythonService().editorExport(
      zipPath, cuts, isStoryExport ? stories : undefined, isStoryExport ? output : undefined,
      muteMic);
  });

  // ── Editor edit-state sidecar (<session>_edits.json next to the zip) ──────────
  // The zip is the IMMUTABLE generated artifact; mutable session state (cuts, blades,
  // stories, undo/redo) lives in a sidecar beside it — the same pattern as the
  // _transcript.json sidecar. Missing file -> null (defined "never edited" state); a
  // file that exists but cannot be parsed is a REAL error and propagates verbatim, never
  // silently treated as fresh.
  const editsSidecarPath = (zipPath: string): string => {
    const dir = path.dirname(zipPath);
    const stem = path.basename(zipPath, '.zip');
    const session = stem.endsWith('_compounds') ? stem.slice(0, -'_compounds'.length) : stem;
    return path.join(dir, `${session}_edits.json`);
  };

  ipcMain.handle('editor:load-edits', async (_event, payload: { zipPath: string }) => {
    const zipPath = payload?.zipPath;
    if (typeof zipPath !== 'string' || zipPath.trim() === '') {
      throw new Error('editor:load-edits requires a non-empty zipPath string');
    }
    const p = editsSidecarPath(zipPath);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (e: any) {
      throw new Error(`edit-state sidecar ${path.basename(p)} is not valid JSON: ${e.message} ` +
        `— fix or delete the file to continue`);
    }
  });

  ipcMain.handle('editor:save-edits', async (_event, payload: { zipPath: string; edits: any }) => {
    const zipPath = payload?.zipPath;
    if (typeof zipPath !== 'string' || zipPath.trim() === '') {
      throw new Error('editor:save-edits requires a non-empty zipPath string');
    }
    if (!payload?.edits || typeof payload.edits !== 'object') {
      throw new Error('editor:save-edits requires an edits object');
    }
    const p = editsSidecarPath(zipPath);
    // Atomic write: tmp + rename, so a crash mid-write can never corrupt the sidecar.
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload.edits), 'utf8');
    fs.renameSync(tmp, p);
    return { path: p };
  });

  /**
   * Throw away the derived session state beside a zip, so a RE-PROCESS genuinely starts over.
   *
   * Only the two sidecars whose contents are expressed in TIMELINE coordinates are removed:
   *   - <session>_edits.json    — cuts, blades, stories, undo/redo
   *   - <session>_transcript.json — words carry timelineStart/timelineEnd (cli/transcribe.py
   *     maps file time to timeline time through the manifest before writing)
   * A re-run rebuilds the timeline, so both would survive pointing at cut boundaries that no
   * longer exist. Keeping them is the silent-wrongness this whole call exists to prevent.
   *
   * Deliberately NOT touched: the source recordings, the `_processed` audio (that is the work
   * a re-process may want to REUSE), and anything already exported — those are either inputs
   * or deliverables the user has taken away, not state.
   *
   * Returns the files it removed, so the caller can say what it did rather than claim it.
   */
  ipcMain.handle('editor:clear-session-state', async (_event, payload: { zipPath: string }) => {
    const zipPath = payload?.zipPath;
    if (typeof zipPath !== 'string' || zipPath.trim() === '') {
      throw new Error('editor:clear-session-state requires a non-empty zipPath string');
    }
    const dir = path.dirname(zipPath);
    const stem = path.basename(zipPath, '.zip');
    const session = stem.endsWith('_compounds') ? stem.slice(0, -'_compounds'.length) : stem;

    const removed: string[] = [];
    for (const name of [`${session}_edits.json`, `${session}_transcript.json`]) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) continue;
      // Never swallowed: a sidecar that cannot be removed would be silently reused by the
      // next open, which is exactly the stale state this is clearing.
      fs.unlinkSync(p);
      removed.push(name);
      log.info(`[clear-session-state] removed ${p}`);
    }
    return { removed };
  });

  // Whisper-transcribe the session's source audio tracks. Returns { jobId }
  // IMMEDIATELY; progress and completion are pushed to the WINDOW THAT INVOKED
  // this (event.sender), matching execute-workflow. On completion the renderer
  // receives 'transcribe-complete' with result on success, or result:null +
  // errorMessage carrying the loud message on any failure (including a pre-spawn
  // resolver failure — missing whisper-cli/model — surfaced via .catch).
  ipcMain.handle('editor:transcribe', async (event, payload: { zipPath: string }) => {
    const zipPath = payload?.zipPath;
    if (typeof zipPath !== 'string' || zipPath.trim() === '') {
      throw new Error('editor:transcribe requires a non-empty zipPath string');
    }
    if (!fs.existsSync(zipPath)) {
      throw new Error(`editor:transcribe zip file does not exist: ${zipPath}`);
    }

    const jobId = `transcribe_${Date.now()}`;
    const sender = event.sender;

    pythonService().transcribe(jobId, zipPath, {
      onProgress: (progress, message, etaSeconds) => {
        if (sender.isDestroyed()) return;
        sender.send('transcribe-progress', { jobId, progress, message, etaSeconds });
      },
      onComplete: (code, result, errorMessage) => {
        if (sender.isDestroyed()) return;
        sender.send('transcribe-complete', {
          jobId,
          exitCode: code,
          result: code === 0 ? (result ?? null) : null,
          errorMessage: code === 0 ? null : (errorMessage ?? null),
        });
      },
    }).catch((err: any) => {
      // Pre-spawn resolution failure (whisper-cli/model not found). Fail loud to
      // the renderer via the same completion channel so the UI never spins.
      const message = err?.message || String(err);
      log.error(`[${jobId}] transcribe failed before spawn: ${message}`);
      if (!sender.isDestroyed()) {
        sender.send('transcribe-complete', {
          jobId,
          exitCode: -1,
          result: null,
          errorMessage: message,
        });
      }
    });

    return { jobId };
  });

  // Cancel a running transcription. killProcess sends SIGTERM (its default
  // signal), which transcribe.py handles as a clean cancel.
  ipcMain.handle('editor:transcribe-cancel', async (_event, payload: { jobId: string }) => {
    const jobId = payload?.jobId;
    if (typeof jobId !== 'string' || jobId.trim() === '') {
      throw new Error('editor:transcribe-cancel requires a non-empty jobId string');
    }
    const killed = pythonService().killProcess(jobId);
    return { success: killed };
  });

  // Load the `<session>_transcript.json` sidecar next to the zip, deriving the
  // session name with the SAME rule the CLIs use (zip stem minus trailing
  // '_compounds'). Absence returns null (a normal state — no transcript yet); a
  // JSON parse failure is a loud throw, never a silent empty result.
  ipcMain.handle('editor:transcript-load', async (_event, payload: { zipPath: string }) => {
    const zipPath = payload?.zipPath;
    if (typeof zipPath !== 'string' || zipPath.trim() === '') {
      throw new Error('editor:transcript-load requires a non-empty zipPath string');
    }

    let stem = path.basename(zipPath, path.extname(zipPath)); // <name>_compounds
    if (stem.endsWith('_compounds')) {
      stem = stem.slice(0, -'_compounds'.length);
    }
    const transcriptPath = path.join(path.dirname(zipPath), `${stem}_transcript.json`);

    if (!fs.existsSync(transcriptPath)) {
      return null;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(transcriptPath, 'utf8');
    } catch (err: any) {
      throw new Error(`Failed to read transcript sidecar ${transcriptPath}: ${err.message}`);
    }
    try {
      return JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`Failed to parse transcript sidecar ${transcriptPath}: ${err.message}`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Story analysis (local Ollama LLM)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Story-analysis handlers: local-LLM (Ollama) chapter splitting + title
 * suggestions for Story Mode. All synchronous request/response — the renderer
 * holds the transcript and passes the relevant segments in; the main process
 * only runs the LLM call + phrase→timestamp mapping. Failures reject with the
 * real error (Ollama down, empty response, unparseable) — never a fabricated
 * result.
 */
function setupStoryAnalysisHandlers(): void {
  // The single in-flight analysis (chapter split OR title suggestion). Only one runs at a time —
  // the renderer gates on `analyzing`/`splitRunning` — so one controller is enough. 'story:cancel'
  // aborts it, which kills the HTTP request and unwinds the pipeline loop on the next check.
  let activeRun: AbortController | null = null;

  // List locally-installed Ollama models (for the model picker).
  ipcMain.handle('ollama:list-models', async (_event, payload?: { host?: string }) => {
    return ollamaService.listModels(payload?.host);
  });

  // Stop whatever analysis is running. Safe to call when nothing is — returns `stopped: false`
  // rather than throwing, so a stale click from a closed dialog is harmless.
  ipcMain.handle('story:cancel', async () => {
    if (!activeRun) return { stopped: false };
    log.info('[Story] cancel requested — aborting the in-flight analysis');
    activeRun.abort();
    return { stopped: true };
  });

  // Split a span of transcript into consecutive subject chapters. The pipeline is many small
  // single-question calls (~40 for a 12-minute video, ~390 for a 2-hour livestream), so step
  // progress is streamed back to the calling renderer on 'story:analyze-progress'. The model is
  // unloaded afterwards — a 14B left resident after a 25-minute run is memory nobody asked for.
  ipcMain.handle(
    'story:analyze-chapters',
    async (event, payload: { segments: Segment[]; model: string; host?: string; consolidate?: boolean }) => {
      const { segments, model, host, consolidate } = payload || ({} as any);
      if (!Array.isArray(segments) || segments.length === 0) {
        throw new Error('No transcript segments provided for chapter analysis.');
      }
      const controller = new AbortController();
      activeRun = controller;
      const generate = (prompt: string, opts?: ollamaService.GenerateOptions) =>
        ollamaService.generate(model, prompt, { host, signal: controller.signal, ...opts });
      const onProgress = (p: { phase: string; done: number; total: number }) => {
        if (!event.sender.isDestroyed()) event.sender.send('story:analyze-progress', p);
      };
      try {
        // `consolidate` is forwarded, NOT defaulted here — chapter-splitter owns the default (true).
        // The renderer sends false when the span is a story it has already defined, where stage 5
        // can only produce false merges. Defaulting in two places is how the two drift apart.
        const chapters = await analyzeChapters(
          segments, model, generate, onProgress, controller.signal, { consolidate }
        );
        return { chapters };
      } finally {
        if (activeRun === controller) activeRun = null;
        // Unloaded on a stop too — a stopped run has no more claim on the memory than a finished
        // one, and stopping is usually how a user reacts to the machine being busy.
        await ollamaService.unload(model, host);
      }
    }
  );

  // Suggest a single title for a story's transcript text. NOT unloaded afterwards — titling runs
  // once per story in a tight loop, and evicting between them would reload the model every time.
  // The renderer unloads once when its loop ends (or is stopped) via 'story:unload-model'.
  ipcMain.handle(
    'story:suggest-title',
    // `text` is either transcript text or a story's chapter labels. A subject list is the better
    // input — no truncation, and it is the shape the eventual titling adapter conditions on — so
    // the type must admit it rather than let an array cross a `string` boundary unremarked.
    async (_event, payload: { text: string | string[]; model: string; host?: string }) => {
      const { text, model, host } = payload || ({} as any);
      const controller = new AbortController();
      activeRun = controller;
      const generate = (prompt: string, opts?: ollamaService.GenerateOptions) =>
        ollamaService.generate(model, prompt, { host, signal: controller.signal, ...opts });
      try {
        const title = await suggestTitle(text, generate);
        return { title };
      } finally {
        if (activeRun === controller) activeRun = null;
      }
    }
  );

  // Evict a model the renderer is done with (end of a titling loop, or a stop). Never throws.
  ipcMain.handle('story:unload-model', async (_event, payload: { model: string; host?: string }) => {
    const { model, host } = payload || ({} as any);
    await ollamaService.unload(model, host);
    return { ok: true };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor → Titles/Inputs handoff
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The editor runs in its OWN window, so a story's subject list cannot be handed to the
 * main window's queue in-process. The editor pushes it here; the main window is focused
 * and given it on 'titles:subjects', and the payload is ALSO parked for a race-free pull —
 * the same belt-and-suspenders shape as the editor's own seed payload.
 *
 * The park is a QUEUE, not a slot: the editor can send several stories at once (each one
 * its own handoff, because each becomes its own upload), and a second send that lands
 * before the receiver drains the first must not overwrite it.
 */
function setupTitleHandoffHandlers(): void {
  let pendingHandoffs: TitleHandoff[] = [];

  ipcMain.handle(
    'titles:send-subjects',
    async (
      _event,
      payload: {
        handoffs: {
          subjects: string[];
          format?: 'normal' | 'livestream';
          source?: string;
          chapters?: { timestamp: string; title: string }[];
        }[];
      }
    ) => {
      const incoming = payload?.handoffs;
      if (!Array.isArray(incoming) || incoming.length === 0) {
        throw new Error('titles:send-subjects requires a non-empty handoffs array');
      }
      // Validated in full BEFORE anything is parked or pushed, so a bad batch cannot leave half
      // of itself queued for a tab that will then show stories the sender was told never went.
      const batch: TitleHandoff[] = incoming.map((h, i) => {
        const from = h?.source ? ` (“${h.source}”)` : '';
        const subjects = h?.subjects;
        if (!Array.isArray(subjects) || subjects.length === 0) {
          throw new Error(`titles:send-subjects handoff at index ${i}${from} has a missing or empty subjects array`);
        }
        const bad = subjects.findIndex((s) => typeof s !== 'string');
        if (bad !== -1) {
          throw new Error(`titles:send-subjects handoff at index ${i}${from}: subject at index ${bad} is not a string`);
        }
        // Chapters are OPTIONAL (the editor's title-only fallback sends none), but a malformed
        // list rejects the WHOLE batch like everything else here: half a chapter list saved into
        // a title report is a record that lies about the video it names.
        const chapters = h?.chapters;
        if (chapters !== undefined) {
          if (!Array.isArray(chapters)) {
            throw new Error(`titles:send-subjects handoff at index ${i}${from}: chapters is not an array`);
          }
          chapters.forEach((c, j) => {
            const ok = (v: any) => typeof v === 'string' && v.trim().length > 0;
            if (!c || typeof c !== 'object' || !ok(c.timestamp) || !ok(c.title)) {
              throw new Error(
                `titles:send-subjects handoff at index ${i}${from}: chapter at index ${j} needs a ` +
                `non-empty timestamp and title`
              );
            }
          });
        }
        return {
          subjects,
          format: h?.format === 'livestream' ? 'livestream' : 'normal',
          source: h?.source,
          // Passed through untouched — this never reaches the model, only the saved report.
          ...(chapters !== undefined ? { chapters } : {}),
        } as TitleHandoff;
      });

      const main = getMainWindow();
      if (!main || main.isDestroyed()) {
        // The only window that hosts the queue is gone. Say so — the user pressed a button
        // and is owed an answer, not a payload parked for a window that will not return.
        // Checked before the append for the same reason: parking then throwing leaves a ghost
        // batch that the next visit would deliver as if the send had succeeded.
        throw new Error('The main ContentStudio window is closed — reopen it to receive these subjects.');
      }
      pendingHandoffs = [...pendingHandoffs, ...batch];
      // The push carries the WHOLE queue, not just this batch: it is exactly what a receiver
      // pulling instead would get, so push and pull are the same delivery.
      main.webContents.send('titles:subjects', pendingHandoffs);
      if (main.isMinimized()) main.restore();
      main.focus();
      return { success: true };
    }
  );

  // Race-free pull for a receiver that mounts after the push (or was never listening).
  // Draining empties the queue: a handoff is delivered once, not replayed on every visit.
  // Always an array — an empty one means nothing was waiting, which is not an error.
  ipcMain.handle('titles:take-pending', async () => {
    const taken = pendingHandoffs;
    pendingHandoffs = [];
    return taken;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Media (waveform peaks)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Waveform peaks stream through AlignmentAudioService (ffmpeg) and FAIL LOUD — a rejected
 * extraction surfaces as { success:false, error } to the UI, which shows an empty lane
 * rather than fabricating a waveform.
 */
function setupMediaHandlers(): void {
  ipcMain.handle('alignment:extract-peaks', async (_event, opts: {
    filePath: string; startSec: number; durationSec: number; buckets: number;
  }) => {
    try {
      const peaks = await audioService().extractPeaks(opts.filePath, opts.startSec, opts.durationSec, opts.buckets);
      return { success: true, ...peaks };
    } catch (error: any) {
      log.error('alignment:extract-peaks failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Files & dialogs (namespaced — see EDITOR_CHANNEL_RENAMES)
// ─────────────────────────────────────────────────────────────────────────────

function setupEditorFileHandlers(): void {
  // Select file dialog
  ipcMain.handle('editor:select-file', async (event, options: { title?: string; filters?: any[]; properties?: any[] }) => {
    const window = windowOf(event);
    if (!window) return { canceled: true, filePaths: [] };

    const defaultFilters = [
      { name: 'Video Files', extensions: ['mp4', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'mpg', 'mpeg', 'm4v', 'webm'] },
      { name: 'Audio Files', extensions: ['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a'] },
      { name: 'All Files', extensions: ['*'] }
    ];

    const result = await dialog.showOpenDialog(window, {
      title: options?.title || 'Select File',
      filters: (options?.filters && options.filters.length > 0) ? options.filters : defaultFilters,
      properties: options?.properties || ['openFile']
    });

    log.info('Select file dialog result:', result);
    return result;
  });

  // Select directory dialog
  ipcMain.handle('editor:select-directory', async (event, options?: { title?: string }) => {
    const window = windowOf(event);
    if (!window) return { canceled: true, filePaths: [] };

    const result = await dialog.showOpenDialog(window, {
      title: options?.title || 'Select Directory',
      properties: ['openDirectory']
    });

    return result;
  });

  // Show file in Finder/Explorer
  ipcMain.handle('editor:show-in-folder', async (_event, filePath: string) => {
    try {
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (error: any) {
      log.error('Error showing file in folder:', error);
      return { success: false, error: error.message };
    }
  });

  // Check if file exists
  ipcMain.handle('editor:check-file-exists', async (_event, filePath: string) => {
    try {
      return { exists: fs.existsSync(filePath) };
    } catch (error: any) {
      return { exists: false, error: error.message };
    }
  });

  ipcMain.handle('editor:read-directory', async (_event, dirPath: string) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      const directories: Array<{ name: string; path: string; mtime: Date; size: number }> = [];
      const files: Array<{ name: string; path: string; mtime: Date; size: number }> = [];

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const stats = await fs.promises.stat(fullPath);

        if (entry.isDirectory()) {
          directories.push({ name: entry.name, path: fullPath, mtime: stats.mtime, size: stats.size });
        } else if (entry.isFile()) {
          files.push({ name: entry.name, path: fullPath, mtime: stats.mtime, size: stats.size });
        }
      }

      return { success: true, directories, files };
    } catch (error) {
      log.error('Error reading directory:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Recursively search for files by name — the relink modal's "find these 16 overlays"
   * button.
   *
   * ACS's version used readdirSync and recursed depth-first with no yielding, which blocks
   * the main process (every window frozen) for as long as the walk takes — and it is
   * pointed at whole asset volumes. This is the same walk, same first-match-wins rule and
   * same result shape, on fs.promises with a yield between directories so the event loop
   * keeps turning.
   */
  ipcMain.handle('editor:search-files-recursive', async (_event, options: {
    rootPath: string;
    filenames: string[];
    maxDepth?: number;
  }) => {
    try {
      const { rootPath, filenames, maxDepth = 5 } = options;

      if (!fs.existsSync(rootPath)) {
        return { success: false, error: 'Root path does not exist' };
      }

      log.info(`Searching recursively for ${filenames.length} files in: ${rootPath}`);

      const foundFiles: { [filename: string]: string } = {};
      const normalizedFilenames = filenames.map(f => f.toLowerCase());

      // Breadth-first with an explicit queue: the recursion depth is bounded by maxDepth
      // either way, and a queue makes the "yield between directories" point obvious.
      const queue: Array<{ dirPath: string; depth: number }> = [{ dirPath: rootPath, depth: 0 }];

      while (queue.length > 0) {
        const { dirPath, depth } = queue.shift()!;
        if (depth > maxDepth) continue;

        let items: import('fs').Dirent[];
        try {
          items = await fs.promises.readdir(dirPath, { withFileTypes: true });
        } catch (error: any) {
          // Skip directories we can't read (permissions, etc.)
          log.debug(`Skipping directory ${dirPath}: ${error.message}`);
          continue;
        }

        for (const item of items) {
          // Skip hidden files and system folders
          if (item.name.startsWith('.') || item.name === 'node_modules') continue;

          const itemPath = path.join(dirPath, item.name);

          if (item.isDirectory()) {
            queue.push({ dirPath: itemPath, depth: depth + 1 });
          } else if (item.isFile()) {
            // Check if this file matches any of our target filenames
            const itemNameLower = item.name.toLowerCase();
            const matchIndex = normalizedFilenames.indexOf(itemNameLower);

            if (matchIndex !== -1) {
              const originalFilename = filenames[matchIndex];
              // Only store if we haven't found this file yet (first match wins)
              if (!foundFiles[originalFilename]) {
                foundFiles[originalFilename] = itemPath;
                log.info(`Found: ${originalFilename} at ${itemPath}`);
              }
            }
          }
        }

        // Hand the event loop back between directories so the walk never freezes the UI.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      log.info(`Search complete. Found ${Object.keys(foundFiles).length} of ${filenames.length} files`);
      return { success: true, foundFiles };
    } catch (error: any) {
      log.error('Error searching files recursively:', error);
      return { success: false, error: error.message };
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Processing: source auto-detection, assets, workflow execution
// ─────────────────────────────────────────────────────────────────────────────

function setupProcessingHandlers(): void {
  /**
   * The downloadable environment: ffmpeg/ffprobe, the Python runtime, the Whisper model
   * (all three REQUIRED) and voice isolation (optional, the Denoise toggle's gate). These four
   * channels are AutoCutStudio's, verbatim in name and in handler body — `assets:list`,
   * `assets:install`, `assets:cancel`, `assets:ensure-required` — because ContentStudio's own
   * component system is registered under `components:*` with the event `component-progress`, so
   * there is nothing here to collide with and nothing to rename.
   *
   * ONE deviation from ACS, and it is forced: ACS emitted progress to `windowService
   * .getMainWindow()`, because ACS had one window and the installer lived in it. Here the
   * installer lives in the EDITOR window, so progress goes to `event.sender` — the window that
   * asked. The event name (`asset-progress`) and payload (InstallProgress) are unchanged.
   */

  /** Progress ticks for one install, sent to the window that requested it. */
  const emitProgressTo = (event: Electron.IpcMainInvokeEvent) => (p: any) => {
    if (!event.sender.isDestroyed()) event.sender.send('asset-progress', p);
  };

  /**
   * Asset listing — the install state of the shared OwenMorgan components. The editor reads
   * exactly one of these (`voice-separator-env`) to decide whether the Denoise toggle can be
   * offered, but the whole list is returned because that is ACS's shape.
   */
  ipcMain.handle('assets:list', async () => {
    try {
      return { success: true, components: assetManager.listStatus() };
    } catch (error: any) {
      log.error('assets:list failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  /** Install ONE component by id. Resolves with the InstallResult — `ok:false` carries the
   *  verbatim reason, which the environment modal prints as its own error line. */
  ipcMain.handle('assets:install', async (event, id: string) => {
    try {
      const result = await assetManager.install(id, emitProgressTo(event));
      return result;
    } catch (error: any) {
      log.error(`assets:install(${id}) failed:`, error);
      return { id, ok: false, error: error?.message || String(error) };
    }
  });

  /** Abort an in-flight install. A no-op when nothing is running for that id. */
  ipcMain.handle('assets:cancel', async (_event, id: string) => {
    assetManager.cancel(id);
    return { success: true };
  });

  /** Install every REQUIRED component that is missing. `failed` names the ones that did not
   *  land — an empty array is the only success. */
  ipcMain.handle('assets:ensure-required', async (event) => {
    try {
      return { success: true, ...(await assetManager.ensureRequired(emitProgressTo(event))) };
    } catch (error: any) {
      log.error('assets:ensure-required failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  // Auto-detect audio files from master video directory
  ipcMain.handle('auto-detect-audio', async (_event, masterVideoPath: string) => {
    try {
      if (!masterVideoPath || !fs.existsSync(masterVideoPath)) {
        return { success: false, error: 'Master video path is invalid' };
      }

      const dirPath = path.dirname(masterVideoPath);
      const masterFilename = path.basename(masterVideoPath, path.extname(masterVideoPath));

      // Extract session/prefix from master video filename
      // Extract everything before " master" (e.g., "2025-11-23 4 master" -> "2025-11-23 4")
      let session = '';
      const masterWordMatch = masterFilename.match(/^(.+?)\s+master$/i);
      if (masterWordMatch) {
        session = masterWordMatch[1].trim();
        log.info(`Extracted session: "${session}" from master video: ${masterFilename}`);
      } else {
        // No " master" suffix - use the full filename
        session = masterFilename;
        log.info(`Using full filename as session: "${session}" from master video: ${masterFilename}`);
      }

      // Escape special regex characters in session for safe pattern matching
      const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedSession = escapeRegex(session);

      // Audio file patterns to match (keys use camelCase to match frontend types)
      // Note: mic1 also matches "mic audio.wav" (without number) for new VMix naming convention
      const audioPatterns: { [key: string]: RegExp } = {
        'mic1': new RegExp(`^${escapedSession}.*(?:mic\\s*1|mic_1|mic1|mic\\s+audio(?![\\s_-]*\\d)).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'mic2': new RegExp(`^${escapedSession}.*(?:mic\\s*2|mic_2|mic2).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'mic3': new RegExp(`^${escapedSession}.*(?:mic\\s*3|mic_3|mic3).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'mic4': new RegExp(`^${escapedSession}.*(?:mic\\s*4|mic_4|mic4).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'screen': new RegExp(`^${escapedSession}.*(?:screen|desktop).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'game': new RegExp(`^${escapedSession}.*(?:game|gameplay).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'soundEffects': new RegExp(`^${escapedSession}.*(?:sound[\\s_-]?effects?|sfx).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i'),
        'bluetooth': new RegExp(`^${escapedSession}.*(?:bluetooth|bt).*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i')
      };

      // Video file patterns to match (keys use camelCase to match frontend types)
      const videoPatterns: { [key: string]: RegExp } = {
        'cam1': new RegExp(`^${escapedSession}\\s+cam\\.(mp4|mov|avi|mkv)$`, 'i'),
        'cam2': new RegExp(`^${escapedSession}\\s+cam\\s*2\\.(mp4|mov|avi|mkv)$`, 'i'),
        // A capture recorded in one go has no number; one that was stopped and
        // restarted is written as "... screen capture 1.mp4", "... 2.mp4", so the
        // unnumbered and the "1" form both mean the FIRST part. Parts 2 and 3 are
        // matched separately and become continuation sources, which the workflow
        // splices onto part 1 before anything else looks at them.
        'screenVideo': new RegExp(`^${escapedSession}\\s+screen\\s*capture(\\s*1)?\\.(mp4|mov|avi|mkv)$`, 'i'),
        'gameVideo': new RegExp(`^${escapedSession}\\s+game\\s*capture(\\s*1)?\\.(mp4|mov|avi|mkv)$`, 'i'),
        'screenVideo2': new RegExp(`^${escapedSession}\\s+screen\\s*capture\\s*2\\.(mp4|mov|avi|mkv)$`, 'i'),
        'screenVideo3': new RegExp(`^${escapedSession}\\s+screen\\s*capture\\s*3\\.(mp4|mov|avi|mkv)$`, 'i'),
        'gameVideo2': new RegExp(`^${escapedSession}\\s+game\\s*capture\\s*2\\.(mp4|mov|avi|mkv)$`, 'i'),
        'gameVideo3': new RegExp(`^${escapedSession}\\s+game\\s*capture\\s*3\\.(mp4|mov|avi|mkv)$`, 'i')
      };

      // Scan directory for matching audio and video files
      const items = fs.readdirSync(dirPath);
      const detectedAudio: { [key: string]: string } = {};
      const detectedVideo: { [key: string]: string } = {};

      // First pass: collect all matching files for each type
      const audioCandidatesByType: { [key: string]: string[] } = {};
      const videoCandidatesByType: { [key: string]: string[] } = {};

      for (const [audioType] of Object.entries(audioPatterns)) {
        audioCandidatesByType[audioType] = [];
      }

      for (const [videoType] of Object.entries(videoPatterns)) {
        videoCandidatesByType[videoType] = [];
      }

      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        // A dangling symlink or a file removed mid-scan must skip that entry,
        // not abort the whole directory scan.
        let stats: fs.Stats;
        try {
          stats = fs.statSync(itemPath);
        } catch (statErr: any) {
          log.warn(`Skipping unreadable entry ${itemPath}: ${statErr.message}`);
          continue;
        }

        if (stats.isFile()) {
          // Check audio patterns
          for (const [audioType, pattern] of Object.entries(audioPatterns)) {
            if (pattern.test(item)) {
              audioCandidatesByType[audioType].push(itemPath);
            }
          }

          // Check video patterns
          for (const [videoType, pattern] of Object.entries(videoPatterns)) {
            if (pattern.test(item)) {
              videoCandidatesByType[videoType].push(itemPath);
            }
          }
        }
      }

      // A screen/game CAPTURE writes a companion wav next to its mp4
      // ("2026-08-05 screen capture 1.wav"), and the screen/game AUDIO patterns
      // above match those too, since they only look for "screen"/"game" anywhere
      // in the name. Which one won was down to readdir order. That is a
      // coin-flip this pipeline cannot afford: a capture companion can be
      // digital silence (a lost audio feed still records a full-length empty
      // track), and picking it would replace the session's desktop audio with
      // nothing at all. Capture companions are never an audio source, so they
      // are excluded outright.
      const isCaptureCompanion = (file: string) =>
        /\s(?:screen|game)\s*capture(\s*\d+)?\.(wav|mp3|aac|flac|ogg|m4a)$/i
          .test(path.basename(file));

      // A recorder that is stopped and restarted mid-session writes its later parts as
      // "<same name> 2", "<same name> 3" — and that numbered sibling matches the SAME
      // audio pattern as the whole-session track it sits next to. Measured on the
      // 2026-08-12 session: "2026-08-12 screen audio 2.wav" (4823.7s, the restarted
      // part) and "2026-08-12 screen audio.wav" (13105.5s, the whole session) both
      // matched 'screen', and readdir returned the PART first — so the picked file was
      // the 80-minute fragment, silently, with the remaining 2h58m of desktop audio
      // simply absent from the mix.
      //
      // The rule is evidence-based, not a guess at naming: a candidate is a numbered
      // continuation only when the file it continues IS ALSO A CANDIDATE — its stem is
      // another candidate's stem plus " <digits>". That leaves "… mic 1.wav" alone
      // (there is no "… mic .wav" beside it) and never drops a lone numbered file.
      const stemOf = (file: string) => path.basename(file, path.extname(file));
      const continuationOf = (file: string, others: string[]): string | null => {
        const m = stemOf(file).match(/^(.*\S)\s+\d+$/);
        if (!m) return null;
        return others.find(o => o !== file && stemOf(o) === m[1]) || null;
      };

      // Second pass: separate VMix and soundboard files
      for (const [audioType, rawCandidates] of Object.entries(audioCandidatesByType)) {
        const kept = rawCandidates.filter(file => {
          if (!isCaptureCompanion(file)) return true;
          log.info(`Ignoring capture companion for ${audioType}: ${path.basename(file)}`);
          return false;
        });
        const candidates = kept.filter(file => {
          const base = continuationOf(file, kept);
          if (!base) return true;
          log.info(`Ignoring ${audioType} continuation part ${path.basename(file)} — ` +
                   `it is a numbered continuation of ${path.basename(base)}, which is the ` +
                   `whole-session track. It stays selectable by hand in the source list.`);
          return false;
        });
        if (candidates.length === 0) continue;

        // Separate soundboard files from VMix files
        const sbFiles = candidates.filter(file => {
          const basename = path.basename(file);
          // Match: " sb.", "_sb.", "-sb.", " sb ", "_sb ", "-sb "
          return basename.match(/[\s_-]sb[\s\.]/i) || basename.match(/[\s_-]sb\.(wav|mp3|aac|flac|ogg|m4a)$/i);
        });

        const nonSbFiles = candidates.filter(file => !sbFiles.includes(file));

        // Assign VMix files (non-sb)
        if (nonSbFiles.length > 0) {
          detectedAudio[audioType] = nonSbFiles[0];
          log.info(`Detected ${audioType} (VMix): ${path.basename(nonSbFiles[0])}`);
        }

        // Assign soundboard files as separate type (camelCase with Sb suffix)
        if (sbFiles.length > 0) {
          const sbType = audioType + 'Sb';  // e.g., mic1 -> mic1Sb, screen -> screenSb
          detectedAudio[sbType] = sbFiles[0];
          log.info(`Detected ${sbType} (Soundboard): ${path.basename(sbFiles[0])}`);
        }
      }

      // Also look for desktop audio soundboard file
      // Desktop audio is Windows desktop audio, not typically in VMix but on soundboard
      const desktopPattern = new RegExp(`^${escapedSession}.*desktop.*\\.(wav|mp3|aac|flac|ogg|m4a)$`, 'i');
      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        let stats: fs.Stats;
        try {
          stats = fs.statSync(itemPath);
        } catch (statErr: any) {
          log.warn(`Skipping unreadable entry ${itemPath}: ${statErr.message}`);
          continue;
        }
        if (stats.isFile() && desktopPattern.test(item)) {
          const basename = path.basename(item);
          // Match: " sb.", "_sb.", "-sb.", " sb ", "_sb ", "-sb "
          if (basename.match(/[\s_-]sb[\s\.]/i) || basename.match(/[\s_-]sb\.(wav|mp3|aac|flac|ogg|m4a)$/i)) {
            detectedAudio['desktopSb'] = itemPath;
            log.info(`Detected desktopSb (Soundboard): ${basename}`);
          }
        }
      }

      // Process video files - just take the first match
      for (const [videoType, candidates] of Object.entries(videoCandidatesByType)) {
        if (candidates.length > 0) {
          detectedVideo[videoType] = candidates[0];
          log.info(`Detected ${videoType}: ${path.basename(candidates[0])}`);
        }
      }

      return { success: true, audioFiles: detectedAudio, videoFiles: detectedVideo };
    } catch (error: any) {
      log.error('Error auto-detecting audio:', error);
      return { success: false, error: error.message };
    }
  });

  // Execute the processing workflow (cli/electron_workflow.py). stdin stays OPEN for the
  // whole run — the Dugan ducking_request protocol answers on it, and skip signals are
  // SIGUSR1 on the same child. Output goes to the WINDOW THAT INVOKED this (event.sender),
  // which is the editor, not the main window.
  ipcMain.handle('execute-workflow', async (event, options: any) => {
    try {
      const jobId = `job_${Date.now()}`;

      // Tell Python where the optional voice-isolation env lives (absolute path
      // or null when not installed). The `denoiseMics` boolean already arrives in
      // `options` from the frontend; this just supplies the env location Python
      // needs to run core/voice_separation.py.
      options.voiceSeparatorEnv = binaryResolver().getVoiceSeparatorEnvDir();

      log.info(`Starting workflow job: ${jobId}`, options);

      const sender = event.sender;
      pythonService().executeWorkflow(jobId, {
        inputData: options,
        onOutput: (data) => {
          if (sender.isDestroyed()) return;
          log.info(`[${jobId}] Sending workflow-output (stdout) to renderer:`, data);
          sender.send('workflow-output', { jobId, type: 'stdout', data });
        },
        onError: (data) => {
          if (sender.isDestroyed()) return;
          log.info(`[${jobId}] Sending workflow-output (stderr) to renderer:`, data);
          sender.send('workflow-output', { jobId, type: 'stderr', data });
        },
        onProgress: (progress, message, subProgress) => {
          if (sender.isDestroyed()) return;
          log.info(`[${jobId}] Sending workflow-output (progress) to renderer: ${progress}% - ${message}`);
          sender.send('workflow-output', { jobId, type: 'progress', data: message, progress, sub_progress: subProgress });
        },
        onComplete: (code, result) => {
          if (sender.isDestroyed()) {
            log.warn(`[${jobId}] Cannot send workflow-complete — WebContents destroyed`);
            return;
          }
          log.info(`[${jobId}] Sending workflow-complete to renderer: exitCode=${code}`);
          sender.send('workflow-complete', { jobId, exitCode: code, result });
        }
      });

      return { success: true, jobId };
    } catch (error: any) {
      log.error('Error executing workflow:', error);
      return { success: false, error: error.message };
    }
  });

  // Cancel a running Python workflow job.
  //
  // NAMESPACED: ACS answered on 'cancel-job', which ContentStudio already owns for metadata
  // generation jobs. Registering it twice makes ipcMain THROW at startup, and the two id
  // spaces are unrelated — a metadata job id means nothing to PythonService — so this is
  // 'editor:cancel-job'. Same request/response contract as ACS: (jobId) => { success }.
  ipcMain.handle('editor:cancel-job', async (_event, jobId: string) => {
    try {
      const killed = pythonService().killProcess(jobId);
      return { success: killed };
    } catch (error: any) {
      log.error('Error canceling job:', error);
      return { success: false, error: error.message };
    }
  });

  // Send skip signal to current workflow
  ipcMain.handle('send-skip-signal', async () => {
    try {
      log.info('[SKIP IPC] Skip signal received from renderer');
      const sent = pythonService().sendSkipSignal();
      log.info('[SKIP IPC] pythonService.sendSkipSignal() returned:', sent);
      return { success: sent };
    } catch (error: any) {
      log.error('[SKIP IPC] Error sending skip signal:', error);
      return { success: false, error: error.message };
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Projects registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Projects: the registry of session folders the user has opened, plus the scan that
 * classifies one folder by what it contains.
 *
 * A registry that has never been written is legitimately empty. A registry that EXISTS
 * but cannot be read as a version-1 registry is an error that propagates — it is never
 * reset or overwritten, because the file is the only record of where the user's projects
 * live and a silent reset would lose all of them.
 */
function setupProjectHandlers(): void {
  // The SAME config directory binary-resolver.ts exports as AUTOCUT_CONFIG_DIR, so the
  // registry sits beside drift_corrections.json and the other user config. The reader, the
  // writer and the path itself live at module scope because 'editor:delete-local-week' —
  // which is registered with the archive handlers, since it needs the ArchiveSync instance
  // to re-verify before it removes anything — rewrites this same file.
  const MASTER_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv'];
  const MASTER_PATTERN = /^(.+?)\s+master$/i;

  /**
   * The mount point a path lives on: `/Volumes/<name>` on macOS, the drive root on Windows,
   * `/` otherwise. Used to tell "this folder was deleted" from "its disk is not attached",
   * which decides whether a registry entry is dropped or merely greyed.
   *
   * Deliberately lexical, not a mount-table lookup: the whole point is to answer for a path
   * whose volume is ABSENT, and a disk that has gone away has no mount-table entry to find.
   */
  const volumeRootOf = (p: string): string => {
    const win = /^([a-zA-Z]:[\\/])/.exec(p);
    if (win) return win[1];
    const mac = /^(\/Volumes\/[^/]+)/.exec(p);
    if (mac) return mac[1];
    return path.parse(p).root || '/';
  };

  ipcMain.handle('projects:read-registry', async (): Promise<ProjectRegistry> => {
    return readProjectsRegistryFile();
  });

  ipcMain.handle('projects:write-registry', async (_event, registry: ProjectRegistry) => {
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
      throw new Error('projects:write-registry requires a registry object');
    }
    if (registry.version !== 1) {
      throw new Error(`projects:write-registry expects version 1, got ${JSON.stringify(registry.version)}`);
    }
    if (!Array.isArray(registry.projects)) {
      throw new Error('projects:write-registry expects projects to be an array');
    }
    registry.projects.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`projects:write-registry entry ${i} is not an object`);
      }
      if (typeof entry.path !== 'string' || entry.path.trim() === '') {
        throw new Error(`projects:write-registry entry ${i} has no non-empty path string`);
      }
    });

    writeProjectsRegistryFile(registry);
    return { success: true };
  });

  ipcMain.handle('projects:scan-folder', async (_event, folderPath: string): Promise<ProjectScanResult> => {
    if (typeof folderPath !== 'string' || folderPath.trim() === '') {
      throw new Error('projects:scan-folder requires a non-empty folderPath string');
    }

    // A folder that is gone is a STATE, not an error — but WHICH state matters, because the
    // renderer drops 'missing' entries from the registry and keeps 'unreachable' ones.
    //
    //   missing     — the volume is here, the folder is not. It was moved or deleted, and it
    //                 is not coming back on its own.
    //   unreachable — the volume itself is absent (external disk unplugged, share not
    //                 mounted). Everything on it would otherwise vanish from the list at once,
    //                 and remounting must bring it all back.
    const stat = fs.statSync(folderPath, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) {
      const volume = volumeRootOf(folderPath);
      const mounted = fs.existsSync(volume);
      return {
        folder: folderPath, realPath: null, exists: false,
        state: mounted ? 'missing' : 'unreachable',
        error: mounted
          ? undefined
          : `${volume} is not mounted — reconnect it and this project comes back.`
      };
    }

    const realPath = fs.realpathSync(folderPath);
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const fileNames = entries.filter(e => !e.isDirectory()).map(e => e.name);

    const masters = fileNames.filter(name => {
      if (!MASTER_EXTENSIONS.includes(path.extname(name).toLowerCase())) return false;
      return MASTER_PATTERN.test(path.basename(name, path.extname(name)));
    });

    if (masters.length === 0) {
      return {
        folder: folderPath, realPath, exists: true, state: 'unrecognized',
        error: `no master video in ${folderPath} — looked for a file named "<session> master" ` +
          `with extension ${MASTER_EXTENSIONS.join('/')}`
      };
    }
    if (masters.length > 1) {
      return {
        folder: folderPath, realPath, exists: true, state: 'unrecognized',
        error: `${masters.length} master videos in ${folderPath} — exactly one is required, found: ` +
          masters.join(', ')
      };
    }

    const masterName = masters[0];
    const session = path.basename(masterName, path.extname(masterName)).match(MASTER_PATTERN)![1].trim();
    const cleanName = session.replace(/ /g, '_');

    const zipPath = path.join(folderPath, `${cleanName}_compounds.zip`);
    const editsPath = path.join(folderPath, `${cleanName}_edits.json`);
    const hasZip = fs.existsSync(zipPath);
    const hasEdits = fs.existsSync(editsPath);
    const hasTranscript = fs.existsSync(path.join(folderPath, `${cleanName}_transcript.json`));

    const base: ProjectScanResult = {
      folder: folderPath,
      realPath,
      exists: true,
      state: 'raw',
      masterVideo: path.join(folderPath, masterName),
      session,
      cleanName,
      hasTranscript
    };
    if (hasZip) base.zipPath = zipPath;

    // Edits without the compounds zip they were made against: the folder is inconsistent,
    // and opening it as 'edited' would point the editor at a zip that is not there.
    if (hasEdits && !hasZip) {
      return {
        ...base,
        state: 'unrecognized',
        error: `${cleanName}_edits.json exists in ${folderPath} but ${cleanName}_compounds.zip does not ` +
          `— the saved edits refer to a processed session whose compounds zip is missing`
      };
    }

    base.state = hasEdits ? 'edited' : hasZip ? 'processed' : 'raw';
    return base;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Asset-path configuration (the relink modal's 16 overlay PNGs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read/write `paths.assets.{backgrounds,borders}` in autostudio_config.yaml — the overlay
 * PNG paths the Python compound generators consume. Request/response shapes are ACS's,
 * verbatim; only the channel names are namespaced.
 */
function setupEditorConfigHandlers(): void {
  const configPath = (): string => EditorPaths.ensureConfigFile('autostudio_config.yaml');

  // Load asset paths configuration
  ipcMain.handle('editor:get-asset-config', async () => {
    try {
      const p = configPath();
      log.info('Loading config from:', p);

      if (!fs.existsSync(p)) {
        log.error('Config file not found at:', p);
        return { success: false, error: `Config file not found at: ${p}` };
      }

      const configContent = fs.readFileSync(p, 'utf8');
      const config = yaml.load(configContent) as any;

      // Extract asset paths from config
      const assetPaths = {
        backgrounds: config.paths?.assets?.backgrounds || {},
        borders: config.paths?.assets?.borders || {}
      };

      log.info('Loaded asset config:', assetPaths);
      return { success: true, assetPaths };
    } catch (error: any) {
      log.error('Error loading asset config:', error);
      return { success: false, error: error.message };
    }
  });

  // Save asset paths configuration
  ipcMain.handle('editor:save-asset-config', async (_event, assetPaths: any) => {
    try {
      const p = configPath();
      log.info('Saving config to:', p);

      if (!fs.existsSync(p)) {
        log.error('Config file not found at:', p);
        return { success: false, error: `Config file not found at: ${p}` };
      }

      const configContent = fs.readFileSync(p, 'utf8');
      const config = yaml.load(configContent) as any;

      // Update asset paths in config
      if (!config.paths) config.paths = {};
      if (!config.paths.assets) config.paths.assets = {};

      config.paths.assets.backgrounds = assetPaths.backgrounds || {};
      config.paths.assets.borders = assetPaths.borders || {};

      // Write updated config back to file
      const updatedYaml = yaml.dump(config, {
        indent: 2,
        lineWidth: -1, // Don't wrap lines
        noRefs: true
      });

      fs.writeFileSync(p, updatedYaml, 'utf8');

      log.info('Saved asset config:', assetPaths);
      return { success: true };
    } catch (error: any) {
      log.error('Error saving asset config:', error);
      return { success: false, error: error.message };
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Archive sync (rsync to the backup NAS)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Archive sync: pushing a project folder to the backup NAS with rsync.
 *
 * The archive root and the server URL used to remount it are ordinary app settings, read
 * fresh on every call (with the default resolved AT THE READ SITE, per this app's
 * convention) so changing them in Settings takes effect without a restart.
 *
 * Progress goes to EVERY window, not just the main one: the sidebar that shows it lives in
 * the editor, which is its own BrowserWindow.
 */
function setupArchiveHandlers(store: Store<any>): void {
  const broadcast = (channel: string, payload: any) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  };

  const sync = new ArchiveSync(
    p => broadcast('archive:progress', p),
    r => broadcast('archive:complete', r),
    q => broadcast('archive:queue', q)
  );
  archiveSyncInstance = sync;

  /** The archive root, defaulted to where this user's NAS actually keeps projects. */
  const archiveRoot = (): string =>
    (store as any).get('archiveRoot') || DEFAULT_ARCHIVE_ROOT;

  /** The share URL used only to remount a volume that has gone away. */
  const archiveMountUrl = (): string =>
    (store as any).get('archiveMountUrl') || DEFAULT_ARCHIVE_MOUNT_URL;

  ipcMain.handle('archive:status', async () => {
    const root = archiveRoot();
    return { ...sync.status(root), busyPath: sync.busyPath };
  });

  ipcMain.handle('archive:connect', async () => {
    const root = archiveRoot();
    return { ...(await sync.connect(root, archiveMountUrl())), busyPath: sync.busyPath };
  });

  /**
   * Add folders to the transfer queue. Never refuses because something is already running —
   * that refusal ("a sync is already running") is exactly what this replaces.
   */
  ipcMain.handle('archive:sync', async (_event, payload: { items: Array<{ localPath: string; kind: 'week' | 'day' }> }) => {
    const items = payload?.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('archive:sync requires a non-empty items array');
    }
    items.forEach((it, i) => {
      if (!it || typeof it.localPath !== 'string' || !it.localPath.trim()) {
        throw new Error(`archive:sync item ${i} has no non-empty localPath`);
      }
      if (it.kind !== 'week' && it.kind !== 'day') {
        throw new Error(`archive:sync item ${i} kind must be 'week' or 'day', got ${JSON.stringify(it.kind)}`);
      }
    });
    // The other half of the delete/sync mutual exclusion. An rsync reading (or writing near)
    // a tree a deletion is tearing down is never acceptable — but only for the tree actually
    // being torn down. A sync of an unrelated week is no more dangerous during a delete than
    // it is at any other time, and refusing it was the same over-broad shape this phase
    // removed from the delete side.
    const root = archiveRoot();
    for (const it of items) {
      for (const { target, scope } of deleteTargets.values()) {
        const mine = scope === 'local' ? it.localPath : safeDestination(it.localPath, it.kind, root);
        if (mine && isAtOrUnder(target, mine)) {
          throw new Error(
            `${path.basename(it.localPath)} is inside ${path.basename(target)}, which is being deleted ` +
            `right now — nothing was queued. Syncing it would put back what the delete is removing.`
          );
        }
      }
    }
    return sync.enqueue(items, root, archiveMountUrl());
  });

  /** Stop work by the FOLDERS it covers — running or merely queued. */
  ipcMain.handle('archive:cancel', async (_event, payload?: { paths?: string[] }) => {
    return sync.cancel(payload?.paths || []);
  });

  ipcMain.handle('archive:queue', async () => sync.queueState());

  /**
   * What a push WOULD do, without doing it. Backs the sidebar's up-to-date marks.
   *
   * Deliberately does NOT mount the share: this runs for every project when the editor opens,
   * and a sleeping NAS must cost one failed stat rather than a mount attempt per row.
   */
  ipcMain.handle('archive:check', async (_event, payload: { localPath: string; kind: 'week' | 'day' }) => {
    if (!payload || typeof payload.localPath !== 'string' || !payload.localPath.trim()) {
      throw new Error('archive:check requires a non-empty localPath');
    }
    if (payload.kind !== 'week' && payload.kind !== 'day') {
      throw new Error(`archive:check kind must be 'week' or 'day', got ${JSON.stringify(payload.kind)}`);
    }
    const root = archiveRoot();
    const status = sync.status(root);
    if (!status.available) {
      throw new Error(status.reason || `${root} is not available.`);
    }
    return sync.check(payload.localPath, payload.kind, root);
  });

  /** Where a folder WOULD go. The UI shows this in the button tooltip before anything runs. */
  ipcMain.handle('archive:destination', async (_event, payload: { localPath: string; kind: 'week' | 'day' }) => {
    try {
      return { ok: true, destPath: destinationFor(payload.localPath, payload.kind, archiveRoot()) };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // ── Reclaiming space: deleting a local copy, or a copy on the archive server ──
  //
  // These three exist because the local volume runs at 96% full and the archive is the point
  // of the whole feature: once a week is verifiably on the NAS, the local copy is the
  // redundant one, and once a week has no local copy the NAS copy is the only thing that
  // remembers it. Both directions of that trade need a control, and both are irreversible.
  //
  // All three REJECT with a message rather than returning an envelope, matching every other
  // archive handler here (`archive:sync`, `archive:check`) — the sidebar shows the rejection
  // text verbatim on its inline error line, so the message IS the UI.

  /**
   * Week folders that exist on the archive server, so the sidebar can show the ones with no
   * local copy left as faded "ghost" rows.
   *
   * A WEEK, not merely a directory: the entry must contain a `files/` directory, which is
   * exactly what a week push puts there and the same rule `destinationFor` and the sidebar
   * both use to decide what a week IS. This matters — the archive root on this machine also
   * holds `assets/` (the shared overlay artwork every Final Cut library symlinks into, and
   * which nothing backs up), a `testlib.fcpbundle`, and loose documents. Listing those as
   * weeks would put a delete button beside the one folder here that has no other copy.
   *
   * Deliberately does NOT mount the share. An unreachable archive REJECTS, and the sidebar
   * simply shows no ghost rows — the same documented state as hiding the sync controls
   * when the host has no archive at all.
   */
  ipcMain.handle('archive:list-remote-weeks', async () => {
    const root = archiveRoot();
    const status = sync.status(root);
    if (!status.available) {
      throw new Error(status.reason || `${root} is not available.`);
    }

    const weeks: Array<{ name: string; path: string }> = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Dot entries are macOS/rsync bookkeeping (.DS_Store sidecars, .rsync-partial, and on
      // this share a stray .claude); NON_WEEK_ENTRIES covers the NAS's own trash and
      // thumbnail folders, which are ordinary directories with ordinary names.
      if (entry.name.startsWith('.')) continue;
      if (NON_WEEK_ENTRIES.has(entry.name.toLowerCase())) continue;

      const full = path.join(root, entry.name);
      const filesDir = fs.statSync(path.join(full, 'files'), { throwIfNoEntry: false });
      if (!filesDir || !filesDir.isDirectory()) continue;

      weeks.push({ name: entry.name, path: full });
    }
    weeks.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { root, weeks };
  });

  /**
   * Delete one week from the ARCHIVE SERVER. This is the only copy for a week that has no
   * local folder left, so every rail is checked before anything is removed, in this order:
   *
   *   1. a path was given at all;
   *   2. no other deletion is in flight (module-level guard, claimed synchronously);
   *   3. the archive is reachable — an unreachable root would make every path test meaningless;
   *   4. NO sync is running or queued, anywhere. Not "on this path": rsync writes with
   *      `--inplace` and a delete underneath a running transfer is corruption on a share
   *      whose only redundancy is the thing being deleted;
   *   5. the path is an existing directory;
   *   6. its REALPATH's parent is the archive root's REALPATH — symlinks resolved on both
   *      sides, so a link planted under the root cannot point the recursive delete elsewhere;
   *   7. its name is not a dot/system entry;
   *   8. it contains a `files/` directory, i.e. it is a week this app archived rather than
   *      `assets/` or a stray folder;
   *   9. still no sync (re-checked immediately before the irreversible call).
   */
  ipcMain.handle('archive:delete-remote-week', async (_event, payload: { path: string }) => {
    const target = payload?.path;
    if (typeof target !== 'string' || !target.trim()) {
      throw new Error('archive:delete-remote-week requires a non-empty path');
    }
    if (deletionInFlight) {
      throw new Error(`A deletion is already running (${deletionInFlight}) — wait for it to finish. Nothing was deleted.`);
    }

    const root = archiveRoot();

    // THE SEMANTIC CONFLICT, checked before anything is queued so the refusal is immediate.
    //
    // Ordering cannot solve this one. A queued sync whose destination is inside the folder
    // being deleted will push it straight back the moment the delete finishes: the operator
    // deletes a week, watches it succeed, and it reappears. Waiting for that sync would not
    // help either — it would simply re-upload what is about to be removed. The only honest
    // answer is to refuse and name the job in the way.
    //
    // Destinations, not sources: a sync's localPath is a LOCAL folder and can never be inside
    // an archive-side target. Comparing sources here would be a guard that never fires.
    const writers = sync.syncsWritingUnder(target);
    if (writers.length > 0) {
      throw new Error(
        `${path.basename(target)} has ${writers.length} sync${writers.length === 1 ? '' : 's'} ` +
        `running or queued that would upload straight back into it ` +
        `(${writers.map(w => path.basename(w.localPath)).join(', ')}) — nothing was deleted. ` +
        `Cancel ${writers.length === 1 ? 'it' : 'them'} first.`
      );
    }

    deletionInFlight = target;
    deleteTargets.set(target, { target, scope: 'remote' });
    try {
      const status = sync.status(root);
      if (!status.available) {
        throw new Error(`The archive is not reachable (${status.reason || `${root} is not available`}) — nothing was deleted.`);
      }

      // Everything below runs with the archive to itself. The queue is what makes the
      // rsync-vs-rm hazard impossible rather than merely unlikely: no transfer can be running
      // while this body is, and it waits for at most the one in flight rather than for the
      // whole batch behind it.
      return await sync.runExclusive('delete-remote', target, 'week', root, async () => {
        const stat = fs.statSync(target, { throwIfNoEntry: false });
        if (!stat || !stat.isDirectory()) {
          throw new Error(`${target} is not a folder on the archive — nothing was deleted.`);
        }

        const realTarget = fs.realpathSync(target);
        const realRoot = fs.realpathSync(root);
        if (path.dirname(realTarget) !== realRoot) {
          throw new Error(
            `${target} resolves to ${realTarget}, whose parent is ${path.dirname(realTarget)} and not the archive ` +
            `root ${realRoot}. Only a week folder DIRECTLY under the archive root can be deleted.`
          );
        }

        const name = path.basename(realTarget);
        if (name.startsWith('.') || NON_WEEK_ENTRIES.has(name.toLowerCase())) {
          throw new Error(`${name} is a system or excluded entry on the archive, not a deletable week — refusing to delete it.`);
        }
        const filesDir = fs.statSync(path.join(realTarget, 'files'), { throwIfNoEntry: false });
        if (!filesDir || !filesDir.isDirectory()) {
          throw new Error(
            `${realTarget} has no files/ directory, so it is not a week this app archived — refusing to delete it. ` +
            `Remove it by hand if that is really what you want.`
          );
        }

        // No "has a sync started?" re-check here any more, and its absence is the point: this
        // body holds the queue, so a transfer CANNOT have started during the work above. The
        // old check was the best a handler outside the queue could do — it narrowed the race
        // rather than closing it.
        log.warn(`[archive] deleting the ARCHIVE copy of ${name}: ${realTarget}`);
        broadcast('archive:delete-progress', { path: target, name, phase: 'deleting', filesRemoved: 0 });
        const { filesRemoved, leftovers } = await deleteArchiveTree(realTarget, n => {
          broadcast('archive:delete-progress', { path: target, name, phase: 'deleting', filesRemoved: n });
        });
        if (leftovers.length > 0) {
          // Space is reclaimed (every regular file the share showed us is gone) but a
          // skeleton survives — entries only the server itself can remove. Escalate to the
          // NAS over SSH, where they are ordinary symlinks, and verify through the mount.
          const sshHost = (store as any).get('archiveSshHost') || DEFAULT_ARCHIVE_SSH_HOST;
          log.warn(`[archive] ${leftovers.length} entries survived the SMB delete of ${name} — finishing on ${sshHost}`);
          broadcast('archive:delete-progress', { path: target, name, phase: 'finishing-on-nas', filesRemoved });
          const finishError = await finishRemoteDeleteOnNas(sshHost, name);

          if (finishError === null) {
            // The SMB attribute cache can report a just-deleted directory for a moment.
            for (let i = 0; i < 10 && fs.existsSync(realTarget); i++) {
              await new Promise(r => setTimeout(r, 300));
            }
            if (!fs.existsSync(realTarget)) {
              log.info(`[archive] deleted ${realTarget} (${filesRemoved} files over SMB, skeleton finished on ${sshHost})`);
              return { deleted: realTarget, name, finishedOnNas: true };
            }
          }

          const detail = leftovers.slice(0, 4).map(l => `${path.relative(root, l.path)} (${l.reason})`).join('; ');
          const more = leftovers.length > 4 ? ` …and ${leftovers.length - 4} more` : '';
          throw new Error(
            `Removed ${filesRemoved} files from ${name}, but ${leftovers.length} ` +
            `${leftovers.length === 1 ? 'entry' : 'entries'} cannot be deleted over the network share (${detail}${more}), ` +
            `and finishing on the NAS itself failed: ${finishError ?? `the folder still exists after ${sshHost} reported success`}. ` +
            `These are symlinks on the archive server — install its fcpx-rm-week helper ` +
            `(source: editor-backend/nas/fcpx-rm-week, install instructions in the file) or remove the folder from the ` +
            `NAS console by hand. The freed space is already reclaimed.`
          );
        }
        log.info(`[archive] deleted ${realTarget} from the archive (${filesRemoved} files)`);
        return { deleted: realTarget, name };
      });
    } finally {
      deletionInFlight = null;
      deleteTargets.delete(target);
    }
  });

  /**
   * Delete the LOCAL copy of a week, and drop every project under it from the registry.
   *
   * Registered here rather than with the other `projects:` handlers because the whole point
   * of it is the re-verification: it needs the ArchiveSync instance to run a fresh dry run,
   * and that instance lives in this function.
   *
   * THE GREEN CHECK IN THE SIDEBAR IS NEVER TRUSTED. It can be minutes or hours old, it can
   * have been earned before a file was edited, and the archive can have gone away since. The
   * check is re-run here, immediately before the delete, and its answer — not the mark —
   * decides. In order:
   *
   *   1. a weekPath was given at all;
   *   2. no other deletion is in flight;
   *   3. the registry parses (read here so a corrupt file stops this BEFORE anything is
   *      deleted rather than after — the rewrite is the last step);
   *   4. at least one registry project lives at `<weekPath>/files/<day>`, i.e. this really is
   *      the week folder a sidebar row represents and not some other directory;
   *   5. the path is an existing directory;
   *   6. it is NOT the archive root or anything under it — deleting "the local copy" must
   *      never be able to delete the archived one;
   *   7. nothing is syncing or queued for this week or any day inside it;
   *   8. the archive is reachable;
   *   9. a FRESH `archiveCheck` of the week says inSync, with zero pending files and not
   *      neverArchived (a check also refuses outright while any sync is running);
   *  10. still nothing syncing (re-checked immediately before the irreversible call).
   *
   * Only then is the folder removed and the registry rewritten atomically.
   */
  ipcMain.handle('editor:delete-local-week', async (_event, payload: { weekPath: string }) => {
    const weekPath = payload?.weekPath;
    if (typeof weekPath !== 'string' || !weekPath.trim()) {
      throw new Error('editor:delete-local-week requires a non-empty weekPath');
    }
    if (deletionInFlight) {
      throw new Error(`A deletion is already running (${deletionInFlight}) — wait for it to finish. Nothing was deleted.`);
    }
    const weekResolved = path.resolve(weekPath.replace(/[\\/]+$/, ''));

    // The semantic conflict, refused before anything is queued — same reasoning as the remote
    // delete, but comparing SOURCES: a local delete removes the folder a sync reads FROM.
    const localWriters = sync.jobsUnder(weekResolved).filter(j => j.op === 'sync');
    if (localWriters.length > 0) {
      throw new Error(
        `${path.basename(weekResolved)} has ${localWriters.length} sync${localWriters.length === 1 ? '' : 's'} ` +
        `running or queued (${localWriters.map(w => path.basename(w.localPath)).join(', ')}) — ` +
        `nothing was deleted while it is being uploaded. Cancel ${localWriters.length === 1 ? 'it' : 'them'} ` +
        `or let ${localWriters.length === 1 ? 'it' : 'them'} finish first.`
      );
    }

    deletionInFlight = weekPath;
    deleteTargets.set(weekPath, { target: weekResolved, scope: 'local' });
    try {
      return await sync.runExclusive('delete-local', weekResolved, 'week', archiveRoot(), async ctx => {
        const week = weekResolved;
        const name = path.basename(week);

        // The registry is read FIRST, and a corrupt one stops everything here. The rewrite is
        // the last step of this handler, so discovering the file is unreadable afterwards would
        // mean the folder was already gone with no way to record it.
        const registry = readProjectsRegistryFile();
        const underWeek = registry.projects.filter(p => isAtOrUnder(week, p.path));
        const isRegistryWeek = registry.projects.some(p => {
          const w = weekFolderOfProject(p.path);
          return !!w && path.resolve(w) === week;
        });
        if (!isRegistryWeek) {
          throw new Error(
            `No project in the list lives at ${week}/files/<day>, so ${name} is not a week folder this ` +
            `sidebar represents. Only a week the list actually groups can be deleted.`
          );
        }

        const stat = fs.statSync(week, { throwIfNoEntry: false });
        if (!stat || !stat.isDirectory()) {
          throw new Error(`${week} is not a folder — nothing was deleted.`);
        }

        const root = archiveRoot();
        if (isAtOrUnder(root, week)) {
          throw new Error(
            `${week} is inside the archive root ${root}. This deletes the LOCAL copy; it must never ` +
            `be pointed at the archived one.`
          );
        }

        // Re-checked here as a fail-loud backstop; the primary refusal happened before this was
        // queued. Filtering to 'sync' is what keeps this job from refusing on ITSELF — a queued
        // delete of week X is, quite correctly, a job under week X.
        //
        // Complete for the targets that exist, and only because of an invariant nothing else
        // states: both delete handlers are week-granular, so every job under consideration is
        // either this week or a day inside it, and isAtOrUnder catches both. A day-level delete
        // added later would make isAtOrUnder(day, pendingWeek) false, the guard would pass, and
        // the pending week sync would push the day straight back.
        const involved = sync.jobsUnder(week).filter(j => j.op === 'sync');
        if (involved.length > 0) {
          throw new Error(
            `${name} has a sync running or queued (${involved.map(j => j.localPath).join(', ')}) — ` +
            `nothing is deleted while it is being uploaded. Stop or finish the sync first.`
          );
        }

        const status = sync.status(root);
        if (!status.available) {
          throw new Error(
            `The archive is not reachable (${status.reason || `${root} is not available`}), so there is no way to ` +
            `confirm ${name} is safely archived — nothing was deleted.`
          );
        }

        // The re-verification. `ctx.check` runs the dry run DIRECTLY: this body already holds
        // the queue, and calling the public `check()` would queue a job behind the slot this
        // very body is occupying — a deadlock that presents as a hang, not an error.
        //
        // This is also the scan the old code could not run at all during a sync, which is what
        // made deleting an unrelated week fail.
        broadcast('archive:delete-progress', { path: weekPath, name, phase: 'verifying' });
        const check = await ctx.check(week, 'week', root);
        if (check.neverArchived) {
          throw new Error(
            `${name} has never been archived — ${check.destPath} does not exist. Nothing was deleted.`
          );
        }
        if (!check.inSync || check.pending.length > 0) {
          const bytes = check.pendingBytes;
          throw new Error(
            `${name} is NOT fully archived: ${check.pending.length} file${check.pending.length === 1 ? '' : 's'} ` +
            `(${bytes} bytes) would still be uploaded to ${check.destPath}. Nothing was deleted — sync it first.`
          );
        }

        // No "did a sync start?" re-check: this body holds the queue, so none can have. The old
        // check narrowed that race as far as a handler outside the queue could; the queue closes
        // it.
        //
        // The archive copy is confirmed identical as of a moment ago. Everything below is
        // irreversible, and the resolved realpath is used so a symlinked week folder deletes
        // the folder rather than following the link out of it.
        const realWeek = fs.realpathSync(week);
        if (isAtOrUnder(fs.realpathSync(root), realWeek)) {
          throw new Error(
            `${week} resolves to ${realWeek}, which is inside the archive root. This deletes the LOCAL copy only.`
          );
        }
        log.warn(`[archive] deleting the LOCAL copy of ${name}: ${realWeek} (archived at ${check.destPath})`);
        broadcast('archive:delete-progress', { path: weekPath, name, phase: 'deleting' });
        // Async so tens of GB of local unlinks don't freeze every window. The sync-vs-delete
        // race this opens is closed on the other side: archive:sync refuses to enqueue while
        // deletionInFlight is set.
        await fs.promises.rm(realWeek, { recursive: true, force: false });
        log.info(`[archive] deleted ${realWeek}; removing ${underWeek.length} project(s) from the registry`);
        broadcast('archive:delete-progress', { path: weekPath, name, phase: 'updating-registry' });

        const removedProjects = underWeek.map(p => p.path);
        try {
          writeProjectsRegistryFile({
            version: 1,
            projects: registry.projects.filter(p => !isAtOrUnder(week, p.path))
          });
        } catch (err: any) {
          // The folder is gone and the list still names it. Said out loud rather than swallowed:
          // the next load scans those folders, finds them missing, and prunes them — but the
          // user is told why the list looks stale until then.
          throw new Error(
            `${name} was deleted from ${realWeek}, but the projects list could not be updated: ` +
            `${err?.message || String(err)}. Its rows disappear on the next reload.`
          );
        }

        return { deleted: realWeek, destPath: check.destPath, removedProjects };
      });
    } finally {
      deletionInFlight = null;
      deleteTargets.delete(weekPath);
    }
  });
}
