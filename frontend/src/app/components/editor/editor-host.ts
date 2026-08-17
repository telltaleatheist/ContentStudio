// src/app/components/editor/editor-host.ts
//
// THE PORT. This file is the whole contract between the timeline editor and whatever
// application hosts it. The editor injects EDITOR_HOST and nothing else from the host;
// re-hosting the editor means writing one class that implements EditorHost, not auditing
// the host's service layer.
//
// Rules for this file:
//   - It must NOT import from the host's services (electron.service, processing.service).
//     A port that references the thing it replaces is not a port.
//   - Every member below exists because something under components/editor/ calls it.
//     Nothing is here speculatively; nothing the editor uses is missing.
//   - Members are grouped by capability. A host may back several groups with one mechanism
//     (AutoCutStudio backs all of them with Electron IPC) — that is the adapter's business.
//
// Types that describe host data live here too, for the same reason: importing them from the
// host would reattach the dependency this file exists to cut.

import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { EditorManifest } from './host-data/editor-manifest';

// ── Host data shapes ──────────────────────────────────────────────────────────

/**
 * What one scan of a project folder concluded.
 *
 *   missing       — the folder is not there (unmounted volume, moved, deleted).
 *   unrecognized  — the folder exists but is not a session folder; `error` says exactly why,
 *                   and nothing is ever skipped quietly.
 *   raw           — a master video, not processed yet.
 *   processed     — a compounds zip exists.
 *   edited        — processed, plus edit state.
 */
export interface ProjectScanResult {
  folder: string;
  /** Symlink-resolved absolute path — the identity used to dedupe. null when missing. */
  realPath: string | null;
  exists: boolean;
  state: 'missing' | 'unrecognized' | 'raw' | 'processed' | 'edited';
  masterVideo?: string;
  session?: string;
  cleanName?: string;
  zipPath?: string;
  hasTranscript?: boolean;
  /** Populated for 'unrecognized' (and any scan that failed): the verbatim reason. */
  error?: string;
}

/** The on-disk projects list. Only these three fields are persisted; scans are recomputed. */
export interface ProjectsRegistry {
  version: 1;
  projects: Array<{ path: string; name: string; lastOpened: string }>;
}

/** One long-running processing job, as the editor observes it. */
export interface ProcessingJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  progress: number;
  message: string;
  output: string[];
  error?: string;
  /** Structured error text emitted by the backend, preferred over scraped console output. */
  emittedError?: string;
  /** Success payload from the backend (zipPath/clips/session), delivered on completion. */
  results?: any;
  startTime?: Date;
  endTime?: Date;
  currentOperation?: string;
  canSkipCurrent?: boolean;
  subProgress?: number;
  skipDecisions?: any;
}

/** Whether the backup archive is reachable, and what is being pushed to it right now. */
export interface ArchiveStatus {
  available: boolean;
  /** The configured archive root, for naming it in a tooltip. */
  root: string;
  /** Why it is not available. Always set when `available` is false. */
  reason?: string;
  /** The local folder a sync is currently running on, or null. */
  busyPath: string | null;
}

/** A tick from the running archive sync. `percent` is null until the file list is built. */
export interface ArchiveProgress {
  id: string;
  localPath: string;
  destPath: string;
  percent: number | null;
  transferred: number;
  rate: string;
  eta: string;
}

/** The end of one archive sync, successful or not. */
export interface ArchiveResult {
  id: string;
  localPath: string;
  destPath: string;
  ok: boolean;
  error?: string;
  /** Set when the transfer ran but skipped something (rsync 23/24). Still a success. */
  warning?: string;
  filesTransferred?: number;
  bytesTransferred?: number;
  /** Symlinks deliberately not archived (absolute paths to this Mac; useless on the server). */
  symlinksSkipped?: number;
  /** The user stopped it. Distinct from a failure — the UI returns to idle, not to an error. */
  canceled?: boolean;
}



/** One file a push would send, and how big it is. */
export interface PendingFile {
  path: string;
  bytes: number;
}


/** Who is running and who is waiting. */
export interface ArchiveQueue {
  running: { id: string; localPath: string; kind: 'week' | 'day' } | null;
  pending: Array<{ id: string; localPath: string; kind: 'week' | 'day' }>;
}

/** What a dry run says a push would do right now — backs the sidebar's up-to-date marks. */
export interface ArchiveCheck {
  localPath: string;
  destPath: string;
  /** Nothing would be transferred: this folder is already in the archive as it stands. */
  inSync: boolean;
  /** Paths relative to localPath that WOULD be sent. Lets one week scan settle its days too. */
  pending: PendingFile[];
  /** Sum of `pending` — what a sync of this exact folder would move right now. */
  pendingBytes: number;
  /** The destination does not exist at all, so no scan was run. */
  neverArchived?: boolean;
}

/** One week folder that exists on the archive server. `path` is its absolute path there. */
export interface RemoteWeek {
  name: string;
  path: string;
}

/**
 * Every week the archive server holds. `root` is echoed back so the UI can name the archive
 * it is describing without keeping its own copy of the setting.
 *
 * A "week" here is a directory DIRECTLY under the archive root that contains a `files/`
 * directory — the same structural rule that decides where a week is archived to. The archive
 * root also holds shared assets and loose documents, and those are not weeks.
 */
export interface RemoteWeekListing {
  root: string;
  weeks: RemoteWeek[];
}

/** What deleting a week from the archive server removed. */
export interface DeleteRemoteWeekResult {
  /** The symlink-resolved path that was actually removed. */
  deleted: string;
  name: string;
}

/** What deleting the local copy of a week removed. */
export interface DeleteLocalWeekResult {
  /** The symlink-resolved local week folder that was actually removed. */
  deleted: string;
  /** Where the archived copy that made this safe lives — verified moments before the delete. */
  destPath: string;
  /** Registry project paths dropped with it. The host has already rewritten the registry. */
  removedProjects: string[];
}

/**
 * The overlay artwork the compound generators composite with, as the host persists it.
 *
 * Shape mirrors the on-disk config verbatim (`paths.assets.*` in autostudio_config.yaml) —
 * the relink modal reads it, edits it, and writes the SAME object back, so any reshaping here
 * would be a translation layer that has to exist identically in the host. Every leaf is an
 * absolute path to a PNG; '' means "not linked yet", which the modal reports rather than hides.
 */
export interface AssetPaths {
  backgrounds: { [key: string]: string };
  borders: {
    cam_dc: { [key: string]: string };
    gs: { [key: string]: string };
    gs_dc: { [key: string]: string };
    ssb: { [key: string]: string };
    ssb_dc: { [key: string]: string };
    shorts: { [key: string]: string };
  };
}

/**
 * The host's downloadable environment, as the environment modal renders it.
 *
 * These four shapes mirror the host's own asset contract exactly (AutoCutStudio's
 * electron/services/editor/asset-types.ts). They are restated here rather than imported for the
 * usual reason: a port that imports the host's types is not a port. Any host that can install
 * components answers in these shapes; a host that cannot omits the whole group below.
 */

/** What one component is doing right now. 'available' means installable but not installed. */
export type AssetComponentState = 'installed' | 'available' | 'installing' | 'error';

/** Where an install got to. The modal turns these into the words a user reads. */
export type AssetInstallPhase =
  | 'resolve' | 'download' | 'verify' | 'extract' | 'postinstall' | 'done' | 'error';

/** What the host recorded when a component landed. Rendered only as its version, if any. */
export interface AssetInstalledRecord {
  id: string;
  version?: string;
  installedAt: string;
}

/** One row of the environment list. */
export interface AssetComponentStatus {
  id: string;
  name: string;
  description: string;
  /** The editor cannot open a project without this one. Comes from the host's catalog. */
  required: boolean;
  state: AssetComponentState;
  /**
   * False when the host has no artifact it could actually fetch for this machine. The modal
   * says so instead of offering an Install button that would only fail.
   */
  installable: boolean;
  /** Download size in bytes, 0 when the host does not know it. */
  sizeBytes: number;
  version?: string;
  installed?: AssetInstalledRecord;
}

/** A tick from a running install. `pct` is 0–100 WITHIN the current phase, not overall. */
export interface AssetInstallProgress {
  id: string;
  phase: AssetInstallPhase;
  pct: number;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

/** The end of one install. `ok:false` always carries the host's verbatim reason. */
export interface AssetInstallResult {
  id: string;
  ok: boolean;
  error?: string;
}

/** A batch of subjects handed to the host's titling surface. One entry per upload. */
export interface TitleHandoff {
  subjects: string[];
  format?: 'normal' | 'livestream';
  source?: string;
  /** Story-relative chapter times, for the host's saved report only — never model input. */
  chapters?: { timestamp: string; title: string }[];
}

// ── The port ──────────────────────────────────────────────────────────────────

export interface EditorHost {

  // ── Environment ─────────────────────────────────────────────────────────────

  /**
   * True when the host can actually service the calls below. The editor uses this to skip
   * optional probes (model listing) rather than to decide whether to run at all — every
   * other method is expected to REJECT, not resolve empty, when the host cannot serve it.
   */
  isElectron(): boolean;

  // ── Session payload & manifest ──────────────────────────────────────────────

  /**
   * The session this editor instance was opened on, pulled once at startup. null when the
   * window was opened with no payload (the user picks a project from the sidebar instead).
   */
  getEditorPayload(): Promise<{ zipPath: string } | null>;

  /** Pushed equivalent of getEditorPayload: the host asking this editor to load a session. */
  onEditorPayload(callback: (payload: { zipPath: string }) => void): void;

  /** Detach the onEditorPayload listener. Called from ngOnDestroy. */
  removeEditorListeners(): void;

  /** Read the timeline manifest (tracks, segments, frame rate) out of a compounds zip. */
  getEditorManifest(zipPath: string): Promise<EditorManifest>;

  // ── Edit state (the _edits.json sidecar) ────────────────────────────────────

  /** Load the saved edit state for a session, or null if it was never edited. */
  loadEditorEdits(payload: { zipPath: string }): Promise<any | null>;

  /** Persist edit state. Resolves with the path written. */
  saveEditorEdits(payload: { zipPath: string; edits: any }): Promise<{ path: string }>;

  /**
   * Discard the derived state of a session that is about to be re-processed — the edit and
   * transcript sidecars, both of which are written in TIMELINE coordinates and so cannot
   * survive the timeline being rebuilt. Resolves with the basenames actually removed (empty
   * when there was nothing to remove). Source media and `_processed` audio are untouched.
   */
  clearEditorSessionState(payload: { zipPath: string }): Promise<{ removed: string[] }>;

  // ── Export ──────────────────────────────────────────────────────────────────

  /**
   * Render the cut list to the host's editorial format (AutoCutStudio: a revised
   * master-hybrid FCPXML). Resolves with the backend's result object
   * ({ path, cutsApplied, micMuteBlocks, … }); REJECTS with the backend's verbatim message,
   * which the editor shows as-is rather than paraphrasing.
   */
  exportEditorCuts(payload: {
    zipPath: string;
    cuts: Array<{ startFrame: number; endFrame: number }>;
    /**
     * Playback ORDER as a partition of the SURVIVORS — the complement of `cuts`, in playback
     * order, ORIGINAL seconds, frame-aligned. Absent = source order.
     */
    sequence?: Array<{ start: number; end: number }>;
    stories?: Array<{ number: number; title: string; regions: Array<{ start: number; end: number }> }>;
    output?: 'fcpxml' | 'transcripts';
    /**
     * Split every mic lane where the SCREEN track has speech and that mic has none, and
     * disable the middle piece. Derived from the transcript, so the export must FAIL LOUDLY
     * without one rather than quietly skip the muting.
     */
    muteMicDuringScreen?: boolean;
  }): Promise<any>;

  // ── Transcription ───────────────────────────────────────────────────────────

  /** Start transcribing a session. Resolves with the job id used to cancel it. */
  transcribeSession(payload: { zipPath: string }): Promise<{ jobId: string }>;

  /** Cancel a running transcription by job id. */
  cancelTranscription(payload: { jobId: string }): Promise<any>;

  /** Progress ticks for the running transcription. */
  onTranscribeProgress(callback: (data: { jobId: string; progress: number; message: string }) => void): void;

  /** Terminal event for a transcription — success or failure, with the verbatim message. */
  onTranscribeComplete(
    callback: (data: { jobId: string; exitCode: number; result: any; errorMessage?: string }) => void
  ): void;

  /** Detach both transcription listeners. Called from ngOnDestroy. */
  removeTranscribeListeners(): void;

  /** Read the transcript sidecar for a session. */
  loadTranscript(payload: { zipPath: string }): Promise<any>;

  // ── Story analysis (LLM) ────────────────────────────────────────────────────

  /** Models the host's local LLM runtime currently offers. */
  ollamaListModels(host?: string): Promise<{ connected: boolean; models: Array<{ id: string; name: string }> }>;

  /**
   * Split a span of transcript into chapters. `consolidate: false` when the span IS one
   * story the user defined — consolidation exists to find the seam BETWEEN stories, so
   * inside a declared story every merge it makes costs the user a marker.
   */
  analyzeStoryChapters(payload: {
    segments: Array<{ text: string; startSeconds: number; endSeconds: number; speaker: 'host' | 'clip' }>;
    model: string;
    host?: string;
    consolidate?: boolean;
  }): Promise<{ chapters: Array<{
    index: number; startSeconds: number; endSeconds: number; label: string; detail: string; verbalCue: boolean;
    /** This start is a raw ±45 s junction, not a mapped quote — no quote could be located. */
    startApprox?: boolean;
    /** The pre-consolidation chapters this one was merged from. Length 1 = never merged. */
    subChapters: Array<{ startSeconds: number; endSeconds: number; label: string; detail: string; startApprox?: boolean }>;
  }> }>;

  /** Suggest one title from a story's subject list (preferred) or raw transcript text. */
  suggestStoryTitle(payload: { text: string | string[]; model: string; host?: string }): Promise<{ title: string }>;

  /** Abort the in-flight analysis at its next boundary. */
  cancelStoryAnalysis(): Promise<{ stopped: boolean }>;

  /** Evict a model from the runtime's memory. Housekeeping — the editor ignores failures. */
  unloadStoryModel(payload: { model: string; host?: string }): Promise<{ ok: boolean }>;

  /** Progress ticks for chapter analysis. */
  onStoryAnalyzeProgress(callback: (p: { phase: string; done: number; total: number }) => void): void;

  /** Detach the analysis-progress listener. Called from ngOnDestroy. */
  removeStoryAnalyzeProgressListener(): void;

  // ── Media ───────────────────────────────────────────────────────────────────

  /**
   * Waveform peaks for a window of one media file, bucketed. Backs the timeline's waveform
   * cache; called many times concurrently, so the host is expected to be cheap or queued.
   */
  alignmentExtractPeaks(opts: {
    filePath: string; startSec: number; durationSec: number; buckets: number
  }): Promise<{ success?: boolean; min?: number[]; max?: number[]; error?: any }>;

  // ── Files & dialogs ─────────────────────────────────────────────────────────

  /** Native open-file dialog. `canceled` is how a user dismissal is reported. */
  selectFile(options?: { title?: string; filters?: any[]; properties?: any[] }):
    Promise<{ canceled: boolean; filePaths: string[] }>;

  /** Native choose-folder dialog. */
  selectDirectory(options?: { title?: string }): Promise<{ canceled: boolean; filePaths: string[] }>;

  /** List a folder (used to offer companion-file candidates next to a master video). */
  readDirectory(dirPath: string): Promise<{ success: boolean; directories?: any[]; files?: any[] }>;

  /** Does this path exist? Used to grey out recents that have gone away. */
  checkFileExists(filePath: string): Promise<{ exists: boolean }>;

  /** Reveal a path in the OS file manager. */
  showInFolder(filePath: string): Promise<any>;

  /**
   * The absolute path behind a dropped File. Separate from File.path, which Electron 32
   * removed; a browser host has no answer here and should throw rather than return ''.
   */
  getPathForFile(file: File): string;

  // ── Asset relinking (File ▸ Relink…) ────────────────────────────────────────
  //
  // The overlay PNGs the compound generators composite with live on whatever disk the user
  // keeps them on, so their absolute paths are host state, not editor state. These three are
  // the whole surface: read the stored paths, write them back, and find files by name under a
  // folder the user points at. Result-envelope shaped (`{ success, …, error }`) rather than
  // rejecting, because the modal shows every one of these outcomes as a line in its own UI.

  /** Read the stored asset paths. `assetPaths` is absent when the host has never stored any. */
  getAssetConfig(): Promise<{ success: boolean; assetPaths?: AssetPaths; error?: string }>;

  /** Persist the asset paths. The host writes the whole object; there is no partial update. */
  saveAssetConfig(assetPaths: AssetPaths): Promise<{ success: boolean; error?: string }>;

  /**
   * Find files by exact (case-insensitive) BASENAME anywhere under `rootPath`, so a user can
   * point at one assets folder and relink all sixteen at once. `maxDepth` bounds the walk;
   * `foundFiles` maps each requested filename to the FIRST absolute path found for it, and
   * omits the ones that were not found — an absent key means "not there", never a guess.
   */
  searchFilesRecursive(opts: { rootPath: string; filenames: string[]; maxDepth?: number }):
    Promise<{ success: boolean; foundFiles?: Record<string, string>; error?: string }>;

  // ── Projects registry ───────────────────────────────────────────────────────

  /** Read the projects list. A corrupt registry must THROW — never silently reset. */
  readProjectsRegistry(): Promise<ProjectsRegistry>;

  /** Write the projects list back. */
  writeProjectsRegistry(registry: ProjectsRegistry): Promise<{ success: boolean }>;

  /** Classify one folder. The single source of truth for a project's state. */
  scanProjectFolder(folderPath: string): Promise<ProjectScanResult>;

  /**
   * Delete the LOCAL copy of a week folder and drop every registry entry under it.
   *
   * It lives with the registry rather than with the archive group below because that is what
   * it changes: a week folder on this machine and the list of projects that pointed into it.
   * Nothing about the archive is touched — the archived copy is the reason this is safe, not
   * its subject.
   *
   * OPTIONAL, on its own and not as part of a group: a host that cannot delete folders must
   * omit it rather than resolve as though it had, and the sidebar hides the control when it
   * is absent. The sidebar additionally only OFFERS it where the archive group is present and
   * has verified this week, because a local copy is only redundant if a checked remote one
   * exists.
   *
   * The host MUST re-verify immediately before deleting — a fresh in-sync check, a reachable
   * archive, no sync running or queued on the folder — and REJECT naming the specific reason
   * when any of that fails. The caller's green mark is a memory, never a permission.
   */
  deleteLocalWeek?(payload: { weekPath: string }): Promise<DeleteLocalWeekResult>;

  // ── Processing (turning a raw project into an editable one) ─────────────────

  /** Infer every companion source from a master video's filename. Pre-fills the setup modal. */
  autoDetectAudio(masterVideoPath: string): Promise<{
    success: boolean;
    audioFiles?: { [key: string]: string };
    videoFiles?: { [key: string]: string };
    error?: string;
  }>;

  /**
   * Install state of the host's downloadable components. REQUIRED member, because two things
   * read it: the Denoise toggle (which needs `voice-separator-env` alone) and the environment
   * modal (which lists all of them). A host with no components answers with an empty list;
   * a host that cannot answer at all reports `success:false` and its reason, which the modal
   * prints verbatim rather than showing an empty list that would read as "nothing to install".
   */
  listAssets(): Promise<{ success: boolean; components?: AssetComponentStatus[]; error?: string }>;

  /** Start a processing run with the payload the shared workflow builder produced. */
  startWorkflow(options: any): Promise<void>;

  /** The current job, or null. The editor RENDERS this; it never owns job state. */
  getCurrentJob(): Observable<ProcessingJob | null>;

  /** Cancel the current job. */
  cancelJob(): Promise<void>;

  /** Tell a running job to skip the operation it is on (when the job says it may be skipped). */
  sendSkipSignal(): Promise<void>;

  // ── Installing the environment (OPTIONAL as a GROUP) ────────────────────────
  //
  // `listAssets` above is required — every host can at least SAY what it has. Installing what
  // is missing is not: a host may ship its toolchain in the bundle, or manage it somewhere the
  // editor has no business reaching into. So these five travel together and the editor tests
  // `installAsset` before it offers any of them, the same way the sidebar tests
  // `archiveStatus` before it shows a sync control. A host implements all five or none —
  // an installer with no way to cancel, or one whose progress never arrives, is worse than a
  // window that tells the user to install the components themselves.
  //
  // The editor's use of the group is the environment modal (File ▸ Environment…), which is
  // also opened automatically when a REQUIRED component is missing at startup. Nothing here
  // is ever called without that modal on screen: a multi-gigabyte download must be visible.

  /**
   * Install one component by id. Resolves with the OUTCOME — a failure is `{ ok: false, error }`,
   * not a rejection, because the modal renders every outcome as a line in its own UI. The
   * host's `error` text is shown verbatim.
   */
  installAsset?(id: string): Promise<AssetInstallResult>;

  /** Abort an install in flight. A no-op when that component is not installing. */
  cancelAsset?(id: string): Promise<{ success: boolean }>;

  /**
   * Install every REQUIRED component that is missing, in order. `failed` names the ones that
   * did not land — an empty `failed` is the only success. `success:false` means the run could
   * not even be attempted, and `error` says why.
   */
  ensureRequiredAssets?(): Promise<{ success: boolean; ok?: boolean; failed?: string[]; error?: string }>;

  /** Progress ticks for whichever install is running. One listener serves all of them. */
  onAssetProgress?(callback: (p: AssetInstallProgress) => void): void;

  /** Detach the progress listener. Called from the modal's ngOnDestroy. */
  removeAssetProgressListener?(): void;

  // ── Host handoffs (OPTIONAL — a host may not have the surface at all) ───────

  /**
   * Push each story to the host's titling queue as its own item.
   *
   * OPTIONAL: this is AutoCutStudio's Metadata tab. A host without one omits the method,
   * and the caller reports that in the same place a failed send is reported — the Send
   * buttons must never appear to work and do nothing.
   */
  sendSubjectsToTitles?(payload: { handoffs: TitleHandoff[] }): Promise<{ success: boolean }>;

  // ── Backup archive (OPTIONAL — a host may have nowhere to push to) ──────────
  //
  // OPTIONAL as a GROUP: a host either implements all of them or none. The sidebar tests
  // `archiveStatus` alone and hides every sync control when it is absent, because a visible
  // button that cannot work is worse than no button.

  /** Is the archive reachable? Must NOT mount anything — this runs on every sidebar load. */
  archiveStatus?(): Promise<ArchiveStatus>;

  /** Try to bring the archive up, then report the same status. Failure is a status, not a throw. */
  archiveConnect?(): Promise<ArchiveStatus>;

  /**
   * Push a project folder to the archive. `kind` says whether this is a whole week or one
   * day under it, which is how the host derives the destination.
   *
   * Resolves once the transfer is RUNNING; the outcome arrives on onArchiveComplete.
   * REJECTS when nothing was started — another sync is running, the folder is not there,
   * or the layout gives no destination.
   */
  archiveSync?(payload: { items: Array<{ localPath: string; kind: 'week' | 'day' }> }): Promise<{ ids: string[] }>;

  /** Stop the running sync. Partial transfers resume on the next run. */
  archiveCancel?(payload: { paths: string[] }): Promise<{ canceled: number }>;

  /** Told whenever the running job or the waiting list changes. */
  onArchiveQueue?(callback: (q: ArchiveQueue) => void): void;

  /**
   * Ask what a push WOULD do, without doing it. Backs the up-to-date marks in the sidebar.
   * A week's answer also settles the days inside it, via `pending`.
   */
  archiveCheck?(payload: { localPath: string; kind: 'week' | 'day' }): Promise<ArchiveCheck>;

  /** Progress ticks for the running sync. */
  onArchiveProgress?(callback: (p: ArchiveProgress) => void): void;

  /** Terminal event for a sync — success, failure, or cancellation. */
  onArchiveComplete?(callback: (r: ArchiveResult) => void): void;

  /**
   * Every week the archive server holds, so the sidebar can show the ones with no local copy
   * left as faded ghost rows.
   *
   * REJECTS when the archive is unreachable, and must NOT mount anything to answer. The
   * sidebar then shows no ghost rows at all — the same documented state as hiding every sync
   * control on a host with no archive, and for the same reason: a row that claims a remote
   * copy exists must be backed by having just looked.
   */
  archiveListRemoteWeeks?(): Promise<RemoteWeekListing>;

  /**
   * Delete one week from the ARCHIVE SERVER. For a ghost week this is the only copy there is,
   * so the host re-checks everything before it acts — reachable archive, an existing directory
   * directly under the archive root with symlinks resolved, and no sync running or queued
   * ANYWHERE (a delete underneath a live rsync is corruption, not a race) — and REJECTS naming
   * the specific reason.
   */
  archiveDeleteRemoteWeek?(payload: { path: string }): Promise<DeleteRemoteWeekResult>;

  /** Detach both archive listeners. Called from ngOnDestroy. */
  removeArchiveListeners?(): void;
}

/**
 * Inject this, not a concrete service. The HOST application provides it
 * (`{ provide: EDITOR_HOST, useClass: … }` in the host's root module) — EditorModule
 * deliberately does not, because the editor must not know any implementation exists.
 */
export const EDITOR_HOST = new InjectionToken<EditorHost>('EDITOR_HOST');
