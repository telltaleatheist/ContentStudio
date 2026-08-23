import { ipcMain, dialog, app, BrowserWindow } from 'electron';
import Store from 'electron-store';
import * as log from 'electron-log';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as yaml from 'js-yaml';
import { AIManagerService, AIConfig } from '../services/metadata/ai-manager.service';
import type { ContentItem } from '../services/metadata/input-handler.service';
import { parseTranscriptImport, wordsToSegments, buildTranscriptSlices, TranscriptSliceCut } from '../services/metadata/transcript-import.service';
import { EpisodeSplitterService } from '../services/metadata/episode-splitter.service';
import { AnalyticsStoreService } from '../services/analytics/analytics-store.service';
import { IngestServerService } from '../services/analytics/ingest-server.service';
import { DistillationService } from '../services/analytics/distillation.service';
import { seedFakeData } from '../services/analytics/seed-fake-data';
import { resolveInsightsBlockForPromptSet } from '../services/analytics/insights-prompt';
import type { ChannelRegistryEntry } from '../services/analytics/analytics-types';
import { YouTubeAuthService } from '../services/youtube/youtube-auth.service';
import { YouTubeApiService } from '../services/youtube/youtube-api.service';
import { ApiCollectorService } from '../services/youtube/api-collector.service';
import {
  PublishStoreService,
  GeneratedFallback,
  GeneratedIndex,
} from '../services/publish/publish-store.service';
import {
  createGeneratedIndexReader,
  sourceFilenameOf,
} from '../services/metadata/generated-index';
import { createReportIndexReader } from '../services/metadata/report-index';
import { OutputHandlerService, deleteJobTxtFiles } from '../services/metadata/output-handler.service';
import {
  ReportMigrationReceipt,
  describeMigration,
  migrateReports,
  migrationIsNoteworthy,
} from '../services/metadata/report-migration';
import {
  SelectionMigrationReceipt,
  describeSelectionMigration,
  migrateSelections,
  selectionMigrationIsNoteworthy,
} from '../services/publish/selection-migration';
import { isItemId } from '../services/metadata/item-identity';
import {
  inspectSavedTranscript,
  resolveOutputDirectory,
} from '../services/metadata/saved-transcript.service';
import { composeChapterBlock, composeDescription, composeTags } from '../services/metadata/description-composer';
import {
  SUMMARIZATION_MODEL,
  buildRoutingView,
  describeRouting,
  migrateStoredRouting,
  probeOllamaInventory,
  resolveChapterModelOption,
  resolveMetadataRouting,
  validateRoutingSelections,
} from '../services/metadata/metadata-routing';
import { PROMPTS_SUBDIR, initPromptAssets, promptAssets } from '../services/metadata/prompt-assets';
import { setupPublishIpc } from '../services/publish/publish-ipc';
import { SpreakerConfigService } from '../services/spreaker/spreaker-config.service';
import { SpreakerApiService } from '../services/spreaker/spreaker-api.service';
import { setupSpreakerIpc } from '../services/spreaker/spreaker-ipc';
import { FfprobeBridge, getRuntimePaths } from '../lib/bridges';
import { PublishBridge } from '../services/publish/publish-bridge';
import { setupEditorIpc } from '../services/editor/editor-ipc';
import { setupTranscriptLinkIpc } from '../services/metadata/transcript-link-ipc';
import { resolveRef } from '../services/metadata/editor-transcript-link';
import type { TranscriptRef } from '../services/publish/publish-types';
import type { TranscriptLink } from '../services/metadata/editor-transcript-link';
import { getMainWindow } from '../main';

/**
 * Analytics services created in main.ts at startup and shared with the IPC layer.
 */
export interface AnalyticsServices {
  analyticsStore: AnalyticsStoreService;
  ingestServer: IngestServerService;
  youtubeAuth: YouTubeAuthService;
  youtubeApi: YouTubeApiService;
  apiCollector: ApiCollectorService;
  publishStore: PublishStoreService;
  /**
   * The Spreaker access token + show id, on disk in userData.
   *
   * Here rather than constructed in this file for the reason every other service in this
   * struct is: the userData path is resolved once, in main.ts, and handed down. It is the
   * only thing in the app that reads the token, and it hands publish/ a show WITHOUT it.
   */
  spreakerConfig: SpreakerConfigService;
}

/**
 * IPC Handlers
 * Handles communication between renderer and main process
 */

/**
 * Get the prompt sets directory path (user-writable location)
 * All prompts are stored in userData/prompt_sets for both dev and production
 */
function getPromptSetsDirectory(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'prompt_sets');
}

/**
 * Get the path to bundled sample prompts
 */
function getSamplePromptsDirectory(): string {
  // In production, assets are in the app.asar at electron/assets
  // In development, they're at electron/assets relative to app path
  const appPath = app.getAppPath();
  return path.join(appPath, 'electron', 'assets');
}

/**
 * Which SHIPPED version of each bundled prompt-set file is installed under
 * userData/prompt_sets.
 *
 * `shippedHash` is the sha256 of the BUNDLED asset at the moment we last wrote that file
 * into the user's directory — never the hash of what is on disk now. Comparing the
 * installed file against it is exactly what tells us whether the user has hand-edited it
 * since we put it there.
 */
interface PromptSetProvenance {
  version: number;
  files: Record<string, { shippedHash: string; updatedAt: string }>;
}

const PROMPT_SET_PROVENANCE_VERSION = 1;

/**
 * Bundled prompt updates that were withheld at startup because the installed file carries
 * local edits. Parked here for the renderer to pull — a main-process log line is invisible
 * to the person whose prompts are out of date, and that invisibility is the whole bug this
 * mechanism exists to fix.
 */
interface PromptAssetNotice {
  withheld: string[];
}
let pendingPromptAssetNotice: PromptAssetNotice | null = null;

/**
 * Report migration state, for the session.
 *
 * `reportsMigrated` flips only after a sweep that actually READ the reports directory.
 * The directory lives on an external volume, so "we could not look" must not be recorded
 * as "there was nothing to do" — the next request has to try again.
 *
 * `pendingMigrationReceipt` is drained by the request that asks for it, in the same shape
 * as the prompt-asset notice above: a migration nobody was told about is a migration the
 * operator has to discover by noticing something missing.
 *
 * ONE PASS, TWO HALVES, IN ORDER. The reports sweep mints the item ids; the selections
 * sweep can only turn a stored (jobId, itemIndex) into an id by asking the files the
 * first half just wrote. So they run back to back inside `ensureReportsMigrated` below,
 * under one flag, and both receipts ride back on the same response. Running them on two
 * triggers would mean a window in which selections were migrated against reports that had
 * no ids yet — every one of them would orphan, and the operator's chosen A/B titles would
 * quietly move to a folder called `orphaned`.
 */
let reportsMigrated = false;
let pendingMigrationReceipt: ReportMigrationReceipt | null = null;
let pendingSelectionReceipt: SelectionMigrationReceipt | null = null;

/**
 * Where the provenance manifest lives. Deliberately OUTSIDE prompt_sets/: that directory
 * belongs to the user, and bookkeeping sitting among their prompts invites a "what is
 * this?" deletion — which would make every installed file look unrecognised.
 */
function getPromptSetProvenancePath(): string {
  return path.join(app.getPath('userData'), 'prompt-set-provenance.json');
}

function sha256OfFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Read the manifest. Absent means "first run of this mechanism on this install", which is
 * a real state with a defined handling below. Present-but-unreadable is NOT folded into
 * it: treating a corrupt manifest as absent would let the next start overwrite files whose
 * history we merely failed to read.
 */
function readPromptSetProvenance(): PromptSetProvenance {
  const provenancePath = getPromptSetProvenancePath();
  if (!fs.existsSync(provenancePath)) {
    return { version: PROMPT_SET_PROVENANCE_VERSION, files: {} };
  }

  const parsed = JSON.parse(fs.readFileSync(provenancePath, 'utf8')) as PromptSetProvenance;
  if (!parsed || typeof parsed !== 'object' || !parsed.files || typeof parsed.files !== 'object') {
    throw new Error(`Prompt-set provenance manifest is malformed: ${provenancePath}`);
  }
  if (parsed.version !== PROMPT_SET_PROVENANCE_VERSION) {
    throw new Error(
      `Prompt-set provenance manifest is version ${parsed.version}, this build reads ` +
      `version ${PROMPT_SET_PROVENANCE_VERSION}: ${provenancePath}`
    );
  }
  return parsed;
}

function writePromptSetProvenance(provenance: PromptSetProvenance): void {
  fs.writeFileSync(getPromptSetProvenancePath(), JSON.stringify(provenance, null, 2), 'utf8');
}

/**
 * Every bundled YAML asset, as paths relative to the asset root, deepest last.
 *
 * Recursive because the prompt assets are a tree now. Relative paths (with forward slashes on
 * every platform, so a manifest written on one reads on another) are what the provenance
 * manifest keys on; the old flat layout's bare filenames are relative paths too, so nothing has
 * to be migrated for the manifest to keep matching.
 */
function listBundledPromptAssets(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listBundledPromptAssets(root, rel));
    } else if (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * The per-channel prompt sets this build superseded, and what happens to the copies already
 * sitting in the user's directory.
 *
 * THE DECISION, stated because the alternative — leaving them there unread — is exactly the
 * kind of silence this codebase forbids. A file the app installed, that the operator can see,
 * that looks like the thing generating his metadata and is not, is worse than either deleting
 * it or moving it. So:
 *
 *   - UNTOUCHED since we installed it (its hash still matches the provenance manifest): the
 *     operator never edited it and nothing is lost. It is MOVED to `prompt_sets/superseded/`,
 *     out of the way, and the move is logged by name.
 *   - HAND-EDITED, or present with no provenance record at all: it stays exactly where it is
 *     and is named in a LOUD warning, plus the same renderer notice the withheld-update path
 *     uses. Those edits are the operator's work and the app does not get to decide they are
 *     obsolete — but he does need to know they are no longer being read.
 *
 * Either way the file is never read again: prompt assembly comes from `prompts/` (see
 * prompt-assets.ts) and there is no code path left that opens `prompt_sets/<channel>.yml`.
 *
 * `.bak*` files are not touched, looked at, or mentioned. They are the operator's.
 */
const SUPERSEDED_PROMPT_SETS = [
  'youtube-telltale.yml',
  'youtube-fireside.yml',
  'youtube-unfiltered.yml',
  'youtube-shorts.yml',
  'podcast-spreaker.yml',
  'summarization_prompts.yml',
];

function retireSupersededPromptSets(provenance: PromptSetProvenance): string[] {
  const promptSetsDir = getPromptSetsDirectory();
  const archiveDir = path.join(promptSetsDir, 'superseded');
  const keptForEdits: string[] = [];
  const archived: string[] = [];

  for (const file of SUPERSEDED_PROMPT_SETS) {
    const filePath = path.join(promptSetsDir, file);
    if (!fs.existsSync(filePath)) continue;

    const record = provenance.files[file];
    const installedHash = sha256OfFile(filePath);

    if (record && record.shippedHash === installedHash) {
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.renameSync(filePath, path.join(archiveDir, file));
      delete provenance.files[file];
      archived.push(file);
      continue;
    }
    keptForEdits.push(file);
  }

  if (archived.length > 0) {
    log.info(
      `Superseded prompt sets moved to ${archiveDir}: ${archived.join(', ')}. They were byte-identical to the ` +
        `versions this app installed, so nothing of yours was in them. Prompts now come from ` +
        `${path.join(promptSetsDir, 'prompts')}.`
    );
  }
  if (keptForEdits.length > 0) {
    log.warn(
      `These prompt sets have local edits and are NO LONGER READ: ${keptForEdits.join(', ')} (in ${promptSetsDir}). ` +
        `They have been left exactly where they are rather than moved or deleted. Prompt text now lives in ` +
        `${path.join(promptSetsDir, 'prompts')} — the shared editorial core, the per-field instruction blocks and ` +
        `the per-channel data files — and your edits need porting there to take effect again.`
    );
  }
  return keptForEdits;
}

/**
 * Install and refresh the bundled prompt-set assets in userData/prompt_sets.
 *
 * The old rule was "seed only when the directory is empty", so a prompt improvement
 * shipped with the app NEVER reached an install that already existed — a new channel_tags
 * field shipped in the repo asset and silently never arrived. The rule is now per FILE and
 * decided by the provenance manifest above:
 *
 *   - not installed        → install it, record the shipped hash
 *   - installed, untouched → the user has not edited it, so a changed bundled asset
 *                            replaces it and the provenance moves forward
 *   - installed, edited    → NEVER overwritten. If the bundled asset moved on too, the
 *                            file is named in a notice the renderer shows the user.
 *
 * Nothing is merged and nothing is skipped quietly: an unreadable asset or a failed write
 * throws, which aborts startup in main.ts rather than leaving a half-migrated prompt
 * directory that looks fine.
 */
function ensurePromptSetsDirectory(): void {
  const promptSetsDir = getPromptSetsDirectory();
  if (!fs.existsSync(promptSetsDir)) {
    fs.mkdirSync(promptSetsDir, { recursive: true });
    log.info(`Created prompt sets directory: ${promptSetsDir}`);
  }

  const samplePromptsDir = getSamplePromptsDirectory();
  if (!fs.existsSync(samplePromptsDir)) {
    // The assets are part of the app. Missing means a broken build or package, and going
    // on would hand the user an install with no prompts and no explanation.
    throw new Error(`Bundled prompt assets not found at: ${samplePromptsDir}`);
  }

  // Every YAML under the asset directory, RECURSIVELY, as paths relative to it — not a
  // hardcoded list: a new prompt set ships by dropping a file in and nothing here changes.
  //
  // Recursive as of this build, because the assets became a TREE
  // (prompts/shared/fields/titles.yml, prompts/channels/telltale.yml and so on) rather than a
  // flat directory of per-channel sets. Relative paths are what the provenance manifest keys
  // on now; a bare filename from the old flat layout is still a valid relative path, so an
  // existing manifest keeps resolving without a version bump.
  const bundledFiles = listBundledPromptAssets(samplePromptsDir);

  const provenance = readPromptSetProvenance();
  const withheld: string[] = [];
  let installed = 0;
  let updated = 0;
  let provenanceChanged = false;

  for (const file of bundledFiles) {
    const srcPath = path.join(samplePromptsDir, file);
    const destPath = path.join(promptSetsDir, file);
    // The tree has subdirectories now. Making them here rather than assuming a flat
    // destination is what lets the same per-file provenance rules apply unchanged.
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const bundledHash = sha256OfFile(srcPath);
    const record = provenance.files[file];

    // Not installed: fresh install, or a prompt set that did not exist in the last build.
    // A provenance record for a file that is gone means the user deleted a set we had
    // installed; it comes back, and the log says which of the two happened.
    if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
      provenance.files[file] = { shippedHash: bundledHash, updatedAt: new Date().toISOString() };
      provenanceChanged = true;
      installed++;
      log.info(record ? `Reinstalled deleted prompt asset: ${file}` : `Installed bundled prompt asset: ${file}`);
      continue;
    }

    const installedHash = sha256OfFile(destPath);

    // Byte-identical to what we ship IS the shipped version, whatever the history says.
    // This is also how an install that predates the manifest adopts its provenance, and
    // how a user who reconciled their own edits stops being told about the update.
    if (installedHash === bundledHash) {
      if (!record || record.shippedHash !== bundledHash) {
        provenance.files[file] = { shippedHash: bundledHash, updatedAt: new Date().toISOString() };
        provenanceChanged = true;
      }
      continue;
    }

    // No record and it differs from what we ship: this install predates the manifest and
    // nothing says the file came from us. It is the user's — announce, do not claim it.
    if (!record) {
      withheld.push(file);
      continue;
    }

    // Untouched since we installed it, and it differs from the bundle (checked above), so
    // the bundle is what moved. Replace it.
    if (installedHash === record.shippedHash) {
      fs.copyFileSync(srcPath, destPath);
      provenance.files[file] = { shippedHash: bundledHash, updatedAt: new Date().toISOString() };
      provenanceChanged = true;
      updated++;
      log.info(`Updated unmodified prompt asset to the shipped version: ${file}`);
      continue;
    }

    // Hand-edited. Their edits stand. Say so only when the bundle also moved past the
    // version they edited — that is the update they are not getting.
    if (bundledHash !== record.shippedHash) {
      withheld.push(file);
    }
  }

  // AFTER the install pass, so a machine that has never run this build gets the new tree first
  // and only then has the old flat sets retired out from under it. Ordering the other way would
  // leave a window in which neither layout was present.
  const supersededWithEdits = retireSupersededPromptSets(provenance);
  if (supersededWithEdits.length > 0) provenanceChanged = true;

  if (provenanceChanged) {
    writePromptSetProvenance(provenance);
  }

  if (installed > 0 || updated > 0) {
    log.info(`Prompt assets: ${installed} installed, ${updated} updated in ${promptSetsDir}`);
  }

  const allWithheld = [...withheld, ...supersededWithEdits];
  pendingPromptAssetNotice = allWithheld.length > 0 ? { withheld: allWithheld } : null;
  if (withheld.length > 0) {
    log.warn(
      `Prompt assets NOT updated because they have local edits: ${withheld.join(', ')}. ` +
      `Newer bundled versions ship with this build (${samplePromptsDir}).`
    );
  }

  /**
   * Load them. Right here, at startup, immediately after they are known to be on disk.
   *
   * The AIManagerService constructor calls this too and it is idempotent — but a broken or
   * incomplete prompt tree should stop the app while it is starting, not an hour into a run
   * when the first metadata call goes to assemble a prompt.
   */
  initPromptAssets(path.join(promptSetsDir, PROMPTS_SUBDIR));
}

// Track running jobs and their cancellation callbacks
const runningJobs = new Map<string, { cancel: () => void }>();

/**
 * Send an IPC message to the MAIN window's renderer, re-fetching it on every call.
 * Guards against "Object has been destroyed" crashes when the window is closed while a
 * long-running job's progress callback is still firing.
 *
 * This used to be `BrowserWindow.getAllWindows()[0]`, which was only ever right because the
 * app had exactly one window. The timeline editor opens a second one, and getAllWindows()
 * has no defined order — so metadata progress could be delivered to the editor, where
 * nothing is listening for it. Everything routed through here belongs to the main window;
 * events that belong to the caller go to `event.sender` instead.
 */
function sendToRenderer(channel: string, payload: any): void {
  const win = getMainWindow();
  if (win && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// ==================== TWO-PHASE PIPELINE ====================
// Phase 1: Transcription pool — up to 5 concurrent (WhisperService supports concurrent jobs)
// Phase 2: AI generation queue — 1 at a time, sequential (protects AI API rate limits)

interface PipelineJob {
  jobId: string;
  metadataParams: any;
  progressCallback: (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => void;
  contentItems?: ContentItem[];
  resolve: (value: any) => void;
  reject: (error: any) => void;
  cancelled: boolean;
  /**
   * Fired by cancel(), alongside the `cancelled` flag.
   *
   * The flag is polled — it can only be read BETWEEN stages, which is no help at all
   * during the one long model call a cancel is most likely to arrive in the middle of.
   * The signal is handed to the provider clients so that call is aborted outright
   * instead of running to completion and being billed.
   */
  abortController: AbortController;
}

interface AiGenerationJob {
  jobId: string;
  execute: () => Promise<any>;
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

const MAX_CONCURRENT_TRANSCRIPTIONS = 5;
let activeTranscriptions = 0;
const transcriptionQueue: PipelineJob[] = [];
const aiGenerationQueue: AiGenerationJob[] = [];
let isAiGenerationRunning = false;

// ==================== "SHOW PROMPT" HELD TRANSCRIPTS ====================
// When a job runs with showPrompt=true we transcribe + assemble the prompt but STOP
// before the AI call, holding the transcription result (ContentItem[]) here keyed by
// jobId. "Send to AI" (send-held-prompt) then re-runs generation against this SAME
// transcript via preTranscribedContent — NO re-transcription. Transcripts are NOT
// otherwise cached (the pipeline transcribes to a temp dir and deletes it), so this
// map is the only place the result survives between the two IPC calls.
//
// Lifecycle: entries are removed on send (success), discard, or job cancel/removal.
// There is no timer — the frontend MUST send or discard, and cancel/removal is a
// safety net. Practically bounded by the number of pending queue items.
const heldTranscripts = new Map<string, {
  contentItems: ContentItem[];
  metadataParams: any;
  // Chapters the show-prompt assembly already paid for. They are part of the
  // prompt the user is looking at, so "Send to AI" must send THOSE chapters,
  // not a fresh pipeline run that could land its boundaries somewhere else.
  computedChapters?: { [sourceLabel: string]: any };
}>();

function enqueuePipelineJob(job: PipelineJob): void {
  const queuePosition = transcriptionQueue.length + activeTranscriptions;
  log.info(`[Pipeline] Enqueueing job: ${job.jobId} (${queuePosition} jobs ahead)`);
  transcriptionQueue.push(job);
  processTranscriptionQueue();
}

function processTranscriptionQueue(): void {
  while (activeTranscriptions < MAX_CONCURRENT_TRANSCRIPTIONS && transcriptionQueue.length > 0) {
    const job = transcriptionQueue.shift()!;

    if (job.cancelled) {
      job.resolve({ success: false, error: 'Job cancelled by user' });
      continue;
    }

    activeTranscriptions++;
    log.info(`[Pipeline] Starting transcription for job: ${job.jobId} (${activeTranscriptions} active, ${transcriptionQueue.length} queued)`);

    // Run transcription in background (don't await — allows multiple to run concurrently)
    runTranscription(job).finally(() => {
      activeTranscriptions--;
      log.info(`[Pipeline] Transcription finished for job: ${job.jobId} (${activeTranscriptions} active)`);
      processTranscriptionQueue();
    });
  }
}

async function runTranscription(job: PipelineJob): Promise<void> {
  try {
    const { WhisperService } = require('../services/metadata/whisper.service');
    const { InputHandlerService } = require('../services/metadata/input-handler.service');
    const { resolveSpeakerTagging, announceSpeakerTagging, SpeakerTagger } =
      require('../services/metadata/speaker-tagging.service');
    const { getRuntimePaths } = require('../lib/bridges');

    const whisperService = new WhisperService();
    // The same directory the generator will write this job's report into, resolved the
    // same way — the saved transcripts sit beside it, and the "does this video have one?"
    // check the UI makes has to look in the directory the run will actually use.
    const outputDir = resolveOutputDirectory(job.metadataParams.outputPath);

    // THIS is where speaker tagging actually happens for the ordinary route: the pipeline
    // transcribes here and hands the generator finished content items, so the mode has to be
    // resolved on this side of the handoff. Resolved once for the job, announced once, and any
    // problem with the enrollment throws before a single video is read.
    const speakerMode = await resolveSpeakerTagging(
      job.metadataParams.speakerEnrollmentAudio, getRuntimePaths().speakerModel);
    announceSpeakerTagging(speakerMode);
    const speakerTagger = speakerMode.enabled ? new SpeakerTagger(speakerMode) : undefined;

    const inputHandler = new InputHandlerService(
      whisperService, outputDir, job.progressCallback, speakerTagger);

    // Normalize inputs
    const normalizedInputs = job.metadataParams.inputs.map((input: any) => {
      if (typeof input === 'string') return input;
      if (input && typeof input === 'object' && input.path) return input.path;
      return String(input);
    });

    // Set up whisper progress forwarding
    whisperService.on('progress', (progress: any) => {
      if (job.cancelled) return;
      if (job.progressCallback && progress.videoPath) {
        const filename = progress.videoPath.split('/').pop() || progress.videoPath;
        let itemIndex: number | undefined = undefined;
        for (let i = 0; i < normalizedInputs.length; i++) {
          if (normalizedInputs[i] === progress.videoPath) {
            itemIndex = i;
            break;
          }
        }
        job.progressCallback('transcription', progress.message, progress.percent, filename, itemIndex);
      }
    });

    // Process inputs (transcription happens here). Collect per-input failures so
    // skipped items surface in result.warnings instead of silently vanishing.
    const customNotesMap = new Map(Object.entries(job.metadataParams.inputNotes || {}));
    // The Phase-2 declaration per input, keyed by the input's absolute path.
    // Entries whose value is a FinalOnlyDeclaration are the DECLARED final-only
    // mode and must survive the trip intact, not be dropped to "absent" — the two mean
    // different things downstream (spec §3.2).
    const transcriptLinkMap = new Map(Object.entries(job.metadataParams.inputTranscripts || {})) as
      Map<string, TranscriptLink>;
    // A slot with no declaration in it is a renderer bug, not a mode. Say so here rather
    // than let it read downstream as "never offered a link".
    for (const [inputPath, link] of transcriptLinkMap) {
      if (!link || typeof link !== 'object' || typeof (link as { kind?: unknown }).kind !== 'string') {
        throw new Error(
          `inputTranscripts["${inputPath}"] is not a transcript declaration. Every entry must ` +
          `be a TranscriptRef or a FinalOnlyDeclaration; omit the key entirely for an input ` +
          `that was never offered a link.`);
      }
    }
    // Which inputs the operator asked to run from their SAVED transcript rather than
    // transcribing again. Only ticked boxes travel: an absent key means "transcribe",
    // which is the default for every video and the state of every video the store has
    // never seen. A key with anything other than `true` under it is a renderer bug — say
    // so here rather than let a truthy string decide an hour of Whisper.
    const useSavedTranscriptMap = new Map<string, boolean>();
    for (const [inputPath, flag] of Object.entries(job.metadataParams.useSavedTranscripts || {})) {
      if (flag !== true) {
        throw new Error(
          `useSavedTranscripts["${inputPath}"] is ${JSON.stringify(flag)}. The map carries only ` +
          `the inputs whose "Use saved transcript" box is ticked, each with the value true; ` +
          `omit the key for an input that should be transcribed.`);
      }
      useSavedTranscriptMap.set(inputPath, true);
    }

    const inputFailures: string[] = [];
    const contentItems = await inputHandler.processMultipleInputs(
      normalizedInputs, customNotesMap, inputFailures, transcriptLinkMap, useSavedTranscriptMap);

    if (job.cancelled) {
      job.resolve({ success: false, error: 'Job cancelled by user' });
      return;
    }

    if (contentItems.length === 0) {
      const errorMessage = inputFailures.length > 0
        ? `No content could be processed: ${inputFailures.join('; ')}`
        : 'No content could be processed';
      sendToRenderer('generation-progress', {
        phase: 'error',
        message: errorMessage,
        jobId: job.jobId
      });
      job.resolve({ success: false, error: errorMessage });
      return;
    }

    // Store content items and move to AI generation queue
    job.contentItems = contentItems;

    // Send queued status if AI generation is busy
    if (isAiGenerationRunning || aiGenerationQueue.length > 0) {
      sendToRenderer('generation-progress', {
        phase: 'queued',
        message: 'Waiting for AI generation...',
        jobId: job.jobId
      });
    }

    // Enqueue AI generation for this job
    enqueueAiGenerationJob(job.jobId, async () => {
      if (job.cancelled) {
        return { success: false, error: 'Job cancelled by user' };
      }

      const { MetadataGeneratorService } = require('../services/metadata/metadata-generator.service');

      const paramsWithCallback = {
        ...job.metadataParams,
        preTranscribedContent: job.contentItems,
        inputWarnings: inputFailures,
        progressCallback: job.progressCallback,
        cancelCallback: () => job.cancelled,
        cancelSignal: job.abortController.signal
      };

      const jobResult = await MetadataGeneratorService.generate(paramsWithCallback);

      // "Show prompt" flow: the transcript is done and the prompt is assembled, but
      // NO metadata call happened. Hold the transcript so "Send to AI" can reuse it,
      // and do NOT emit a terminal 'complete' — the frontend keys off the RESOLVED
      // value here, not a progress event. On failure we still surface a terminal
      // 'error' as usual. Warnings are forwarded because chapters DO run in this flow
      // now, so "chapters failed, the prompt you are reading has no chapter subjects"
      // has to reach the user while they are still deciding whether to send it.
      if (job.metadataParams.showPrompt) {
        if (jobResult.success) {
          heldTranscripts.set(job.jobId, {
            contentItems: job.contentItems!,
            metadataParams: job.metadataParams,
            computedChapters: jobResult.computedChapters,
          });
          return {
            success: true,
            prompts: jobResult.prompts,
            jobId: job.jobId,
            held: true,
            warnings: jobResult.warnings,
          };
        }
        sendToRenderer('generation-progress', {
          phase: 'error',
          message: jobResult.error || 'Unknown error'
        });
        return jobResult;
      }

      if (jobResult.success) {
        sendToRenderer('generation-progress', {
          phase: 'complete',
          message: 'Metadata generation complete!'
        });
      } else {
        sendToRenderer('generation-progress', {
          phase: 'error',
          message: jobResult.error || 'Unknown error'
        });
      }

      return jobResult;
    }).then(result => {
      job.resolve(result);
    }).catch(error => {
      // Generation THREW (rather than returning success:false) — emit a terminal error
      // event so progress-stream UIs don't hang on "generating".
      sendToRenderer('generation-progress', {
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
        jobId: job.jobId
      });
      job.reject(error);
    });

  } catch (error) {
    log.error(`[Pipeline] Transcription failed for job ${job.jobId}:`, error);
    sendToRenderer('generation-progress', {
      phase: 'error',
      message: error instanceof Error ? error.message : String(error),
      jobId: job.jobId
    });
    job.resolve({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function enqueueAiGenerationJob(jobId: string, execute: () => Promise<any>): Promise<any> {
  return new Promise((resolve, reject) => {
    const queuePosition = aiGenerationQueue.length + (isAiGenerationRunning ? 1 : 0);
    log.info(`[AiQueue] Enqueueing AI job: ${jobId} (position ${queuePosition})`);

    aiGenerationQueue.push({ jobId, execute, resolve, reject });

    // Send queue position to frontend for non-pipeline jobs
    if (queuePosition > 0) {
      sendToRenderer('generation-progress', {
        phase: 'queued',
        message: `Queued (position ${queuePosition})`,
        jobId
      });
    }

    processAiGenerationQueue();
  });
}

async function processAiGenerationQueue(): Promise<void> {
  if (isAiGenerationRunning || aiGenerationQueue.length === 0) {
    return;
  }

  isAiGenerationRunning = true;
  const job = aiGenerationQueue.shift()!;

  log.info(`[AiQueue] Starting AI job: ${job.jobId} (${aiGenerationQueue.length} remaining)`);

  try {
    const result = await job.execute();
    job.resolve(result);
  } catch (error) {
    log.error(`[AiQueue] AI job ${job.jobId} failed:`, error);
    job.reject(error);
  } finally {
    isAiGenerationRunning = false;
    log.info(`[AiQueue] AI job ${job.jobId} completed`);
    processAiGenerationQueue();
  }
}

export function setupIpcHandlers(store: Store<any>, analytics: AnalyticsServices) {

  const { setSelectedWhisperModel } = require('../lib/bridges/runtime-paths');
  const componentManager = require('../components/component-manager');
  setSelectedWhisperModel((store as any).get('whisperModel', 'small'));

  ipcMain.handle('components:list', async () => componentManager.listStatus());
  ipcMain.handle('components:install', async (event, id: string) =>
    componentManager.install(id, (progress: any) => event.sender.send('component-progress', progress)));
  ipcMain.handle('components:cancel', async (_event, id: string) => {
    componentManager.cancel(id);
    return { success: true };
  });
  ipcMain.handle('components:uninstall', async (_event, id: string) => {
    const selected = (store as any).get('whisperModel', 'small');
    if (id === `whisper-${selected}`) {
      return { success: false, error: 'Choose and save a different default Whisper model before removing this one.' };
    }
    componentManager.uninstall(id);
    return { success: true };
  });

  ipcMain.handle('get-startup-readiness', async () => {
    const settings = (store as any).store;
    const provider = settings.metadataProvider || settings.aiProvider || 'openai';
    const model = settings.metadataModel || settings.ollamaModel || '';
    let aiReady = false;
    let aiReason = '';

    if (!model) {
      aiReason = 'No AI model is selected.';
    } else if (provider === 'openai' || provider === 'claude') {
      const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');
      let keys: any = {};
      if (fs.existsSync(apiKeysPath)) {
        keys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
      }
      const key = provider === 'openai' ? keys.openaiApiKey : keys.claudeApiKey;
      aiReady = typeof key === 'string' && key.trim().length > 0;
      if (!aiReady) aiReason = `The selected ${provider === 'openai' ? 'OpenAI' : 'Claude'} provider has no API key.`;
    } else if (provider === 'ollama') {
      const host = String(settings.ollamaHost || 'http://localhost:11434').replace(/\/$/, '');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch(`${host}/api/tags`, { signal: controller.signal });
        if (response.ok) {
          const data = await response.json() as any;
          const models = Array.isArray(data.models) ? data.models.map((item: any) => item.name) : [];
          aiReady = models.includes(model);
          if (!aiReady) aiReason = `The selected Ollama model (${model}) is not installed.`;
        } else {
          aiReason = `Ollama returned HTTP ${response.status}.`;
        }
      } catch {
        aiReason = `Ollama is not reachable at ${host}.`;
      } finally {
        clearTimeout(timeout);
      }
    } else {
      aiReason = `Unsupported AI provider: ${provider}.`;
    }

    const whisperModel = settings.whisperModel || 'small';
    const requiredToolIds = ['ffmpeg', 'whisper-engine'];
    const selectedModelId = `whisper-${whisperModel}`;
    const componentStatuses = componentManager.listStatus();
    const missingRequiredTools = requiredToolIds.flatMap((id: string) => {
      const status = componentStatuses.find((item: any) => item.component.id === id);
      return status?.state === 'installed' ? [] : [{ id, name: status?.component?.name || id }];
    });
    const installedWhisperModels = componentStatuses
      .filter((status: any) => status.component.category === 'whisper' && status.state === 'installed')
      .map((status: any) => ({ id: status.component.id, name: status.component.name }));
    const selectedModelInstalled = installedWhisperModels.some((item: any) => item.id === selectedModelId);
    const missingComponents = [
      ...missingRequiredTools.map((item: any) => item.name),
      ...(selectedModelInstalled ? [] : [componentStatuses.find((item: any) => item.component.id === selectedModelId)?.component.name || selectedModelId]),
    ];

    return {
      ready: aiReady && missingComponents.length === 0,
      ai: { ready: aiReady, provider, model, reason: aiReason },
      transcription: {
        ready: missingComponents.length === 0,
        missingComponents,
        missingRequiredTools,
        installedWhisperModels,
        selectedModelInstalled,
      },
    };
  });

  // Ensure prompt sets directory exists
  ensurePromptSetsDirectory();

  // Get settings
  ipcMain.handle('get-settings', async () => {
    try {
      // Get all store data using electron-store API
      const settings = { ...(store as any).store };

      // Single source of truth for the default output directory. The frontend no
      // longer hardcodes a fallback, so populate it here when unset. This is NOT
      // persisted to disk — it only fills the returned object.
      // NOTE: must stay in sync with MetadataGeneratorService.getDefaultOutputPath()
      // in electron/services/metadata/metadata-generator.service.ts.
      if (!settings.outputDirectory) {
        settings.outputDirectory = path.join(os.homedir(), 'Documents', 'ContentStudio Output');
      }

      return settings;
    } catch (error) {
      log.error('Error getting settings:', error);
      throw error;
    }
  });

  // Update settings
  ipcMain.handle('update-settings', async (_event, settings) => {
    try {
      Object.keys(settings).forEach(key => {
        (store as any).set(key, settings[key]);
      });
      if (settings.whisperModel) setSelectedWhisperModel(settings.whisperModel);
      return { success: true };
    } catch (error) {
      log.error('Error updating settings:', error);
      throw error;
    }
  });

  // ---------------------------------------------------------------------------
  // Per-task model routing (metadata-routing.ts)
  //
  // The registry is the single source of truth and it lives in code; these two handlers
  // are the only way the renderer sees or changes it. The payload shape is FROZEN — the
  // settings modal is written against exactly this — so a new task or option changes the
  // contents and never the shape.
  // ---------------------------------------------------------------------------

  ipcMain.handle('metadata-routing:get', async () => {
    // Not wrapped in a try/catch that returns a shape: a stored selection this build
    // cannot honour must reach the user as an error, because it is the same error their
    // next generation would fail with.
    // Migrated on the way out, and WRITTEN BACK when the migration changed anything, so
    // the notice is logged once on the first open after an upgrade rather than on every
    // open for the rest of the install's life. Without this the modal is the screen that
    // throws on the very setting the user came here to fix.
    const migration = migrateStoredRouting((store as any).get('metadataRouting'));
    if (migration.changed) {
      (store as any).set('metadataRouting', migration.selections);
      log.warn(
        `[IPC] metadataRouting migrated and rewritten (${migration.notices.length} entry/entries dropped): ` +
          migration.notices.join(' | ')
      );
    }
    const stored = migration.selections;
    // Which local models are actually installed, read fresh on every open. The host is
    // the one generation resolves against (passed down as aiHost), so what the modal
    // marks installed is what a run would find.
    const inventory = await probeOllamaInventory(
      String((store as any).get('ollamaHost', 'http://localhost:11434'))
    );
    return buildRoutingView(stored, inventory);
  });

  ipcMain.handle('metadata-routing:set', async (_event, selections) => {
    // Validated against the registry BEFORE it is written. A store holding an option this
    // build does not know would fail every subsequent job, far from the click that caused
    // it.
    const validated = validateRoutingSelections(selections);
    (store as any).set('metadataRouting', validated);
    log.info(`[IPC] Metadata routing saved: ${describeRouting(resolveMetadataRouting(validated))}`);
    return { success: true };
  });

  // Select files or directories
  ipcMain.handle('select-files', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Files',
        properties: ['openFile', 'multiSelections']
      });

      if (result.canceled) {
        return { success: false, files: [] };
      }

      return { success: true, files: result.filePaths };
    } catch (error) {
      log.error('Error selecting files:', error);
      throw error;
    }
  });

  // Speaker enrollment recording picker. This cannot reuse 'select-files': that
  // dialog is multiSelections with no filters and hands back files: string[],
  // whereas enrollment is exactly one media file and the operator benefits from
  // the audio/video filter narrowing a folder full of project junk.
  ipcMain.handle('select-enrollment-audio', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Voice Enrollment Recording',
        filters: [
          { name: 'Audio & Video', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mov', 'mkv', 'webm'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile']
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, file: null };
      }

      return { success: true, file: result.filePaths[0] };
    } catch (error) {
      log.error('Error selecting enrollment audio:', error);
      throw error;
    }
  });

  // Select directory
  ipcMain.handle('select-directory', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Directory',
        properties: ['openDirectory']
      });

      if (result.canceled) {
        return { success: false, directory: null };
      }

      return { success: true, directory: result.filePaths[0] };
    } catch (error) {
      log.error('Error selecting directory:', error);
      throw error;
    }
  });

  // Select output directory
  ipcMain.handle('select-output-directory', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Output Directory',
        properties: ['openDirectory', 'createDirectory']
      });

      if (result.canceled) {
        return { success: false, directory: null };
      }

      return { success: true, directory: result.filePaths[0] };
    } catch (error) {
      log.error('Error selecting output directory:', error);
      throw error;
    }
  });

  // Check if path is a directory
  ipcMain.handle('is-directory', async (_event, filePath) => {
    try {
      const stats = await fs.promises.stat(filePath);
      return stats.isDirectory();
    } catch (error) {
      log.error('Error checking if path is directory:', error);
      return false;
    }
  });

  // Read directory (list subdirectories and files)
  ipcMain.handle('read-directory', async (_event, dirPath) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      const directories = [];
      const files = [];

      for (const entry of entries) {
        const fullPath = `${dirPath}/${entry.name}`;
        const stats = await fs.promises.stat(fullPath);

        if (entry.isDirectory()) {
          directories.push({
            name: entry.name,
            path: fullPath,
            mtime: stats.mtime,
            size: stats.size
          });
        } else if (entry.isFile()) {
          files.push({
            name: entry.name,
            path: fullPath,
            mtime: stats.mtime,
            size: stats.size
          });
        }
      }

      return { success: true, directories, files };
    } catch (error) {
      log.error('Error reading directory:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Read file content
  ipcMain.handle('read-file', async (_event, filePath) => {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return content;
    } catch (error) {
      log.error('Error reading file:', error);
      throw error;
    }
  });

  // `delete-directory` used to live here: an unbounded `fs.rm(anyPath, { recursive: true,
  // force: true })` handed to the renderer, whose only caller was the reports page's
  // delete — where it was pointed at a single .txt file, at a JSON report, and (had the
  // dead `txt_files` branch ever populated) at whatever else a report happened to carry.
  // `force: true` also meant "already gone" reported success. Reports now delete through
  // `reports-delete-item`, which names its own paths in the main process, so the
  // primitive has no callers and is gone rather than left lying around.

  // Show in folder
  ipcMain.handle('show-in-folder', async (_event, filePath) => {
    try {
      const { shell } = require('electron');
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (error) {
      log.error('Error showing in folder:', error);
      throw error;
    }
  });

  // Check directory exists and is writable (auto-creates if missing)
  ipcMain.handle('check-directory', async (_event, dirPath) => {
    try {
      const fs = require('fs').promises;
      const path = require('path');

      // Check if directory exists, create if not
      try {
        const stats = await fs.stat(dirPath);
        if (!stats.isDirectory()) {
          return { exists: false, writable: false };
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          // Directory doesn't exist, try to create it
          try {
            await fs.mkdir(dirPath, { recursive: true });
            log.info(`Created output directory: ${dirPath}`);
          } catch (mkdirError) {
            log.error('Failed to create directory:', mkdirError);
            return { exists: false, writable: false };
          }
        } else {
          throw error;
        }
      }

      // Check if directory is writable by trying to create a temp file
      try {
        const testFile = path.join(dirPath, `.write-test-${Date.now()}`);
        await fs.writeFile(testFile, 'test');
        await fs.unlink(testFile);
        return { exists: true, writable: true };
      } catch (error) {
        return { exists: true, writable: false };
      }
    } catch (error) {
      log.error('Error checking directory:', error);
      return { exists: false, writable: false };
    }
  });

  // Cancel job
  ipcMain.handle('cancel-job', async (_event, jobId: string) => {
    try {
      log.info(`[IPC] Cancelling job: ${jobId}`);

      // A "Show prompt" job may be holding a transcript with no active run — drop it
      // so cancelling/removing the job can't leak the held ContentItem[].
      heldTranscripts.delete(jobId);

      const job = runningJobs.get(jobId);
      if (job) {
        job.cancel();
        runningJobs.delete(jobId);
        return { success: true };
      } else {
        return { success: false, error: 'Job not found or already completed' };
      }
    } catch (error) {
      log.error('Error cancelling job:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Generate metadata
  ipcMain.handle('generate-metadata', async (_event, params) => {
    // A job id is required. It is what the report file is named after, what the publish
    // selections are keyed by, what cancellation is registered under, and what the renderer's
    // queue row matches on — so a job without one is unnameable, uncancellable and
    // undeletable from the moment it starts. The renderer has always sent it; this makes the
    // absence a loud error rather than a silent default (see the pipelineJob note below).
    if (!params || typeof params.jobId !== 'string' || !params.jobId.trim()) {
      throw new Error('generate-metadata requires a non-empty jobId');
    }
    try {
      log.info('Starting metadata generation with params:', JSON.stringify(params, null, 2));

      // Get settings using electron-store API
      const settings = (store as any).store;

      // Determine AI provider from settings
      // Try new separate provider fields first, fall back to legacy aiProvider field
      const metaProvider = settings.metadataProvider || settings.aiProvider;

      // Load API keys from api-keys.json
      const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');
      let apiKeys: any = {};
      if (fs.existsSync(apiKeysPath)) {
        apiKeys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
      }

      // Reconstruct full model with provider prefix (e.g., "claude:claude-sonnet-4-5")
      // Settings stores provider and model separately, but AIManagerService needs prefixed format
      // Prefer newer metadataProvider/metadataModel fields over legacy aiProvider/aiModel
      const aiModel = settings.metadataModel || settings.aiModel || settings.ollamaModel;
      const aiProvider = settings.metadataProvider || settings.aiProvider || 'ollama';
      const fullModel = aiModel ? `${aiProvider}:${aiModel}` : undefined;

      // Get the API key strictly for the provider that fullModel is built from.
      // (OR-ing meta/summ providers here would pick the wrong key when they differ —
      // e.g. metadata=claude + summarization=openai must send Claude requests with the Claude key.)
      let apiKey = undefined;
      if (aiProvider === 'openai') {
        apiKey = apiKeys.openaiApiKey;
      } else if (aiProvider === 'claude') {
        apiKey = apiKeys.claudeApiKey;
      }

      /**
       * WHAT THE SETTINGS PAGE'S "AI MODEL" STILL GOVERNS, which is much less than it did.
       *
       * It used to be the model that wrote every field of every chapterless item (the legacy
       * whole-metadata call) AND the model that summarized every transcript on every path. The
       * first is gone: those items are routed like all the others, against the routing table
       * the operator sets in the routing dialog. The second is gone too — summarization runs on
       * SUMMARIZATION_MODEL, declared in metadata-routing.ts, so a transcript is not silently
       * read by a cloud provider on a run whose every visible field is local; and as of
       * 2026-08-23 it runs for COMPILATION ONLY.
       *
       * What is left is COMPILATION packaging, which is a declared mode the operator selects,
       * and the provider clients this service constructs. That is why `fullModel` is still
       * resolved and still passed — and why the log line now says which of the two it is for.
       */
      log.info(
        `[IPC] Settings AI model ${fullModel} (provider: ${aiProvider}, model: ${aiModel}) is used for COMPILATION ` +
          `packaging only; per-field metadata follows the routing table, and summarization — now ` +
          `compilation's alone — runs on ${SUMMARIZATION_MODEL}`
      );

      // Performance-feedback loop: when the active prompt set maps to a
      // registered analytics channel that has computed insights, append the
      // "CHANNEL PERFORMANCE DATA" block to the generation prompt. null = no
      // mapping / no insights yet — expected state, block simply omitted.
      /**
       * The channel this run publishes to. NO DEFAULT.
       *
       * This used to end `|| 'sample-youtube'`, which named a prompt set that has not existed
       * in this repo for as long as anyone can check — so a run with no channel selected went
       * looking for a file that was never there and failed later, somewhere else, saying
       * something unrelated. A missing channel is a missing decision and it fails here, naming
       * the channels that do exist.
       */
      const activePromptSet = params.promptSet || settings.promptSet;
      if (!activePromptSet) {
        const known = promptAssets().channelIds().join(', ');
        throw new Error(
          `No channel selected for this run: neither the request nor Settings names one. Pick one of: ${known}`
        );
      }
      const insightsBlock = resolveInsightsBlockForPromptSet(analytics.analyticsStore, activePromptSet);

      // The summarizer follows the writing-model slot exactly as chapters do
      // (resolveChapterModelOption): condensation rewrites the words every content field
      // reads, so the model trusted to write them is the model trusted to condense them —
      // and a cloud-routed run must not fire up a 17GB local model to do it (measured
      // 2026-08-23: a 60,695-char podcast spent ~7 minutes in local summarization before
      // its first cloud call). A disagreeing store falls back to the declared local
      // constant, never to the Settings provider (that path was the measured defect the
      // constant replaced).
      //
      // IT IS RESOLVED FOR COMPILATION MODE ONLY, as of the same day. The per-item path stopped
      // summarizing entirely: over the direct-pass ceiling its field calls read the chapter
      // digest (chapter-digest.ts), so on an individual run this value is carried and never
      // used. Compilation joins every item into one prompt and has no chapter list to digest,
      // which is why the resolution stays here rather than moving into that branch.
      const resolvedRouting = resolveMetadataRouting(migrateStoredRouting(settings.metadataRouting).selections);
      const summarizerOption = resolveChapterModelOption(resolvedRouting);
      const summarizationModel =
        summarizerOption.kind === 'cloud' ? summarizerOption.model : SUMMARIZATION_MODEL;

      // Prepare metadata generation parameters
      const metadataParams = {
        inputs: params.inputs,
        mode: params.mode || settings.defaultMode,
        aiProvider: metaProvider, // Use metadata provider as primary
        aiModel: fullModel, // Full prefixed model (e.g., "claude:claude-sonnet-4-5")
        summarizationModel,
        metadataModel: fullModel,
        aiApiKey: apiKey,
        aiHost: settings.ollamaHost || 'http://localhost:11434',
        outputPath: params.outputPath || settings.outputDirectory,
        promptSet: activePromptSet,
        promptSetsDir: getPromptSetsDirectory(),
        jobId: params.jobId,
        jobName: params.jobName,
        // The Phase-2 declaration for each input, keyed by the input's absolute
        // path. A TranscriptRef means "generate content fields from this
        // editor story"; a FinalOnlyDeclaration means "final export only" and carries WHY
        // — the operator said so, or he linked nothing and this is the default. Both are
        // DECLARED MODES and both are recorded (spec §3.2). An absent key means the input
        // was never offered a link at all. The input stage resolves a ref into the item's
        // `contentSource`, and a declared link it cannot honor fails that item rather
        // than quietly running final-only (§3.4 rule 4).
        inputTranscripts: params.inputTranscripts || {},
        // Which inputs run from their SAVED Whisper transcript instead of being
        // transcribed again, keyed by the input's absolute path and only ever `true`.
        // Absent is the default and the ordinary case: an unticked row, or a video the
        // transcript store has never seen. Validated where it is consumed, in
        // runTranscription — a ticked box whose record has gone missing FAILS that item
        // rather than quietly costing the operator the hour he declined.
        useSavedTranscripts: params.useSavedTranscripts || {},
        // The operator's voice enrollment, read from the settings AT JOB TIME and carried on
        // the job. Present means every caption this run transcribes is scored against it and
        // tagged HOST / CLIP / UNSURE; absent or blank is the untagged mode, announced once in
        // the log, in which the run behaves exactly as it did before speaker tagging existed.
        // Not seeded in the store's `defaults` — there is no sensible default recording, and a
        // path nobody chose is worse than no path.
        speakerEnrollmentAudio: settings.speakerEnrollmentAudio || undefined,
        chapterNumCtx: settings.chapterNumCtx || undefined,
        // Per-task model routing, read from the store AT JOB TIME. The registry supplies
        // the defaults at the read site (metadata-routing.ts), never the store's
        // `defaults` block: a seeded default freezes the shipped routing into every
        // existing install, so a task whose default changes would never reach the users
        // who already have a store. An absent key means "the shipped routing"; a present
        // one means the user chose something, and a bad one fails the job by name.
        //
        // Migrated first. A store written before 2026-08-22 names the removed 'chapters'
        // task or a removed option id, and `resolveMetadataRouting` throws on those —
        // which would fail the JOB rather than the setting. The migration drops exactly
        // those entries, with a logged notice naming each one (metadata-routing.ts); an id
        // this build never had still throws.
        //
        // It does NOT decide the chapter models. Chapters are not a routed task any more.
        metadataRouting: resolveMetadataRouting(migrateStoredRouting(settings.metadataRouting).selections),
        // Keys for whatever providers the routing reaches, which need not be the provider
        // `aiApiKey` belongs to.
        cloudApiKeys: { claude: apiKeys.claudeApiKey, openai: apiKeys.openaiApiKey },
        inputNotes: params.inputNotes || {},
        insightsBlock: insightsBlock || undefined,
        // "Show prompt": transcribe + assemble the prompt, then STOP (no AI call).
        // The transcript is held server-side so "Send to AI" can reuse it.
        showPrompt: params.showPrompt || false
      };

      const safeMetadataParams = {
        ...metadataParams,
        aiApiKey: metadataParams.aiApiKey ? '***' : undefined,
        // Summarized: the full block is several KB and would drown the log
        insightsBlock: insightsBlock ? `<CHANNEL PERFORMANCE DATA, ${insightsBlock.length} chars>` : undefined
      };
      log.info('Prepared metadata params:', JSON.stringify(safeMetadataParams, null, 2));
      log.info(`[IPC] Metadata routing for this job: ${describeRouting(metadataParams.metadataRouting)}`);

      // Send progress update
      sendToRenderer('generation-progress', {
        phase: 'starting',
        message: 'Initializing metadata generation...'
      });

      // Submit to two-phase pipeline (transcription pool → AI generation queue)
      const result = await new Promise<any>((resolve, reject) => {
        const progressCallback = (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => {
          log.info(`[IPC] Progress event: phase=${phase}, message=${message}, percent=${percent}, filename=${filename}, itemIndex=${itemIndex}`);
          sendToRenderer('generation-progress', {
            phase,
            message,
            percent,
            ...(filename && { filename }),
            ...(itemIndex !== undefined && { itemIndex })
          });
        };

        const pipelineJob: PipelineJob = {
          // No `|| 'metadata-job'`. That default was unreachable — the single renderer caller
          // always sends nextJob.id — and one new caller away from being reachable, at which
          // point every such job would share one literal id AND skip the cancellation
          // registration ten lines below, which is guarded on `params.jobId` being truthy.
          // An uncancellable job whose id collides with every other uncancellable job is not
          // a default worth having; the guard above makes the absence impossible instead.
          jobId: params.jobId,
          metadataParams,
          progressCallback,
          resolve,
          reject,
          cancelled: false,
          abortController: new AbortController()
        };

        // Store cancellation callback
        if (params.jobId) {
          runningJobs.set(params.jobId, {
            cancel: () => {
              pipelineJob.cancelled = true;
              // Aborts whatever provider call is in flight right now. This is the event
              // the generator needed: nothing polls for it, and nothing waits for the
              // current stage to end.
              pipelineJob.abortController.abort();
              log.info(`[Pipeline] Job ${params.jobId} marked as cancelled`);
              // Remove from transcription queue if still waiting
              const tIdx = transcriptionQueue.indexOf(pipelineJob);
              if (tIdx !== -1) {
                transcriptionQueue.splice(tIdx, 1);
                resolve({ success: false, error: 'Job cancelled by user' });
              }
            }
          });
        }

        enqueuePipelineJob(pipelineJob);
      });

      return result;

    } catch (error) {
      log.error('Error generating metadata:', error);
      // Terminal error event so progress-stream UIs don't hang on "generating"
      // when generation rejects rather than returning success:false.
      sendToRenderer('generation-progress', {
        phase: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      // Always release the cancel closure — on rejection too, not just success.
      if (params.jobId) {
        runningJobs.delete(params.jobId);
      }
    }
  });

  // "Send to AI" for a held ("Show prompt") transcript. Reuses the already-made
  // transcript (NO re-transcription) and runs the full metadata + chapters + output
  // generation, wiring progress + a terminal 'complete'/'error' exactly like the
  // normal AI phase so the frontend's existing progress handling finalizes the job.
  ipcMain.handle('send-held-prompt', async (_event, { jobId }: { jobId: string }) => {
    const held = heldTranscripts.get(jobId);
    if (!held) {
      // No fallback: never silently re-transcribe. Fail loud so the UI can tell the
      // user the transcript is gone and the analysis must be re-run.
      return { success: false, error: `No held transcript for job ${jobId} (it may have expired)` };
    }

    // Same progress forwarding the normal AI phase uses (see generate-metadata).
    const progressCallback = (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => {
      sendToRenderer('generation-progress', {
        phase,
        message,
        percent,
        ...(filename && { filename }),
        ...(itemIndex !== undefined && { itemIndex })
      });
    };

    try {
      // Serialize through the AI generation queue (1-at-a-time) like every other AI run.
      const result = await enqueueAiGenerationJob(jobId, async () => {
        const { MetadataGeneratorService } = require('../services/metadata/metadata-generator.service');

        const jobResult = await MetadataGeneratorService.generate({
          ...held.metadataParams,
          showPrompt: false,
          preTranscribedContent: held.contentItems,
          preComputedChapters: held.computedChapters,
          progressCallback,
        });

        if (jobResult.success) {
          sendToRenderer('generation-progress', {
            phase: 'complete',
            message: 'Metadata generation complete!'
          });
        } else {
          sendToRenderer('generation-progress', {
            phase: 'error',
            message: jobResult.error || 'Unknown error'
          });
        }

        return jobResult;
      });

      // Transcript consumed on success — drop it so it can't leak. On failure keep it
      // so the user can retry "Send to AI" without re-transcribing (cleared later by
      // discard-held-prompt or job cancel/removal).
      if (result && result.success) {
        heldTranscripts.delete(jobId);
      }
      return result;
    } catch (error) {
      // Generation THREW — emit a terminal error event so progress-stream UIs don't
      // hang on "generating". The held transcript is retained for a possible retry.
      sendToRenderer('generation-progress', {
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
        jobId
      });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Discard a held ("Show prompt") transcript without sending it to the AI.
  ipcMain.handle('discard-held-prompt', async (_event, { jobId }: { jobId: string }) => {
    heldTranscripts.delete(jobId);
    return { success: true };
  });

  /**
   * Does this video have a saved transcript that is still a transcript OF it?
   *
   * The question the Inputs list asks about every video row, so it can offer the "Use
   * saved transcript" checkbox — and only offer it when ticking it would work. A record
   * whose video has been re-rendered since is reported as `exists: false` WITH the
   * reason: the checkbox stays hidden (there is nothing safe to reuse) and the reason is
   * logged rather than swallowed, because "I transcribed that yesterday, where is the
   * box?" needs an answer.
   *
   * The output directory is resolved exactly as a run resolves it, from the same setting.
   * If the two ever disagreed the checkbox would offer a record the pipeline then looks
   * for somewhere else — which is why `resolveOutputDirectory` is one function.
   */
  ipcMain.handle('has-saved-transcript', async (_event, videoPath: string) => {
    if (typeof videoPath !== 'string' || !videoPath.trim()) {
      throw new Error('has-saved-transcript requires a video path');
    }

    const settings = (store as any).store;
    const outputDir = resolveOutputDirectory(settings.outputDirectory);
    const lookup = inspectSavedTranscript(outputDir, videoPath);

    if (!lookup.exists) {
      log.info(`[IPC] No reusable saved transcript for ${videoPath}: ${lookup.reason}`);
      return { exists: false, reason: lookup.reason };
    }

    return {
      exists: true,
      savedAt: lookup.record.saved_at,
      whisperModel: lookup.record.whisper_model,
    };
  });

  // Get app version
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  // Get app path
  ipcMain.handle('get-app-path', () => {
    return app.getAppPath();
  });

  // Logging from renderer
  ipcMain.on('log', (_event, level, ...args) => {
    switch (level) {
      case 'info':
        log.info(...args);
        break;
      case 'warn':
        log.warn(...args);
        break;
      case 'error':
        log.error(...args);
        break;
      default:
        log.debug(...args);
    }
  });

  // Drain the startup notice about bundled prompt updates that were NOT applied because
  // the installed file has local edits. Race-free pull, in the shape of the editor's
  // handoff park: the notice is computed before any window exists, so it cannot be pushed.
  // null means nothing was withheld, which is not an error.
  ipcMain.handle('prompt-assets:take-pending-notice', async () => {
    const notice = pendingPromptAssetNotice;
    pendingPromptAssetNotice = null;
    return notice;
  });

  // Get prompt sets directory path
  ipcMain.handle('get-prompt-sets-path', async () => {
    const promptSetsDir = getPromptSetsDirectory();
    return { success: true, path: promptSetsDir };
  });

  /**
   * List the channels, for the channel picker.
   *
   * IT READS THE ASSETS NOW, not the directory. It used to `readdirSync` the prompt-sets
   * folder and treat every .yml in it as a selectable channel, which stopped being true when a
   * channel became a small data file inside prompts/channels/ — and which would otherwise have
   * listed whatever superseded or hand-edited files happen to be lying around beside them.
   *
   * `instructions_prompt` is still returned because the analytics screen reads it to work out
   * which fields a channel publishes. It is the assembled one.
   */
  ipcMain.handle('list-prompt-sets', async () => {
    try {
      const assets = promptAssets();
      const promptSets = assets.channelIds().map((id: string) => {
        const channel = assets.channel(id);
        return {
          id: channel.id,
          name: channel.name,
          platform: id.startsWith('podcast-') ? 'podcast' : 'youtube',
          instructions_prompt: channel.fields
            .map((field: string) => assets.fieldSection(channel, field))
            .join('\n\n'),
        };
      });
      return { success: true, promptSets };
    } catch (error) {
      log.error('Error listing prompt sets:', error);
      return { success: false, error: String(error) };
    }
  });

  /** One channel, assembled exactly as generation assembles it. Read-only — see below. */
  ipcMain.handle('get-prompt-set', async (_event, promptSetId: string) => {
    try {
      const assets = promptAssets();
      if (!assets.hasChannel(promptSetId)) {
        return { success: false, error: `No channel "${promptSetId}" (known: ${assets.channelIds().join(', ')})` };
      }
      const channel = assets.channel(promptSetId);
      return {
        success: true,
        promptSet: {
          id: channel.id,
          name: channel.name,
          editorial_prompt: assets.editorialPrompt(channel),
          instructions_prompt: channel.fields
            .map((field: string) => assets.fieldSection(channel, field))
            .join('\n\n'),
          description_links: channel.descriptionLinks,
          /**
           * Read-only, and the renderer is TOLD so rather than left to discover it by having a
           * save silently do nothing. What is returned above is ASSEMBLED from several files —
           * the shared editorial core, the shared per-field blocks, this channel's data — and
           * there is no way to take an edited copy of the assembled string and work out which
           * of those the operator meant to change.
           */
          readOnly: true,
          readOnlyReason:
            'Prompts live in ' + path.join(getPromptSetsDirectory(), PROMPTS_SUBDIR) + '. This view shows what ' +
            'that assembles to for this channel; edit the files there — shared/editorial-core.yml for the voice ' +
            'and doctrine, shared/fields/*.yml for a single field, channels/*.yml for what this channel is and ' +
            'publishes.',
        },
      };
    } catch (error) {
      log.error('Error getting prompt set:', error);
      return { success: false, error: String(error) };
    }
  });

  /**
   * Creating, editing and deleting a channel from inside the app is NOT SUPPORTED, and says so.
   *
   * These three used to write a flat YAML into the prompt-sets directory. Nothing reads those
   * files any more, so leaving the handlers in place would let the operator write a prompt set,
   * see it saved, and have it never once reach a model — which is the exact failure mode this
   * whole change exists to remove. They refuse, and the refusal names where the prompts
   * actually are.
   */
  const promptEditingUnsupported = (verb: string) => ({
    success: false,
    error:
      `${verb} a channel from inside the app is not supported in this build. Prompts live in ` +
      `${path.join(getPromptSetsDirectory(), PROMPTS_SUBDIR)} as a set of files — shared/editorial-core.yml for ` +
      `the voice and doctrine, shared/fields/*.yml for one field's instructions, channels/*.yml for what a ` +
      `channel is and which fields it publishes. Edit those. (Anything saved here would be written and never ` +
      `read, which is worse than this message.)`,
  });

  ipcMain.handle('create-prompt-set', async () => promptEditingUnsupported('Creating'));
  ipcMain.handle('update-prompt-set', async () => promptEditingUnsupported('Editing'));
  ipcMain.handle('delete-prompt-set', async () => promptEditingUnsupported('Deleting'));
  // Get job history
  // Returns only text/subject-input jobs from the last 4 weeks.
  // Auto-prunes older job metadata files.
  ipcMain.handle('get-job-history', async () => {
    try {
      const settings = (store as any).store;
      const outputDirectory = settings.outputDirectory;

      if (!outputDirectory) {
        return [];
      }

      const metadataDir = path.join(outputDirectory, '.contentstudio', 'metadata');

      if (!fs.existsSync(metadataDir)) {
        return [];
      }

      const files = fs.readdirSync(metadataDir);
      const jobs = [];
      // Resolved timestamp per job (created_at/createdAt, or file mtime fallback).
      // Used for both pruning and sorting so invalid dates never randomize order.
      const jobDates = new Map<any, number>();
      const fourWeeksAgo = Date.now() - (4 * 7 * 24 * 60 * 60 * 1000);

      for (const file of files) {
        if (file.startsWith('job-') && file.endsWith('.json')) {
          try {
            const filePath = path.join(metadataDir, file);
            const content = fs.readFileSync(filePath, 'utf8');
            const job = JSON.parse(content);

            // Auto-prune jobs older than 4 weeks. Fall back to the file's mtime when
            // created_at/createdAt is missing or invalid (otherwise NaN < cutoff is
            // false, so stale jobs never prune and NaN sort order is random).
            let createdAt = new Date(job.created_at || job.createdAt).getTime();
            if (isNaN(createdAt)) {
              createdAt = fs.statSync(filePath).mtimeMs;
            }
            if (createdAt < fourWeeksAgo) {
              log.info(`[JobHistory] Pruning old job: ${file} (created ${new Date(createdAt).toISOString()})`);
              try {
                // The job's OWN text files, by recorded path — never the folder. It is
                // named after the job, so every regeneration of the same source shares
                // it (seven jobs share one folder in the live data) and `rm -rf` on it
                // took the other jobs' output with it. Items with no recorded path are
                // pre-migration and their text is left, which the counts state.
                const cleanup = deleteJobTxtFiles(job);
                log.info(`[JobHistory] Pruned text for ${file}:`, cleanup);
                fs.unlinkSync(filePath);
              } catch (deleteError) {
                log.warn(`[JobHistory] Failed to prune ${file}:`, deleteError);
              }
              continue;
            }

            // Only include text/subject-input jobs in history
            // Jobs with input_types field: check if all types are 'subject'
            // Jobs without input_types: skip (legacy jobs will age out)
            if (job.input_types && Array.isArray(job.input_types)) {
              const allSubjects = job.input_types.every((t: string) => t === 'subject');
              if (!allSubjects) {
                continue;
              }
            } else {
              // No input_types field — legacy job, skip from history display
              continue;
            }

            job.metadataPath = filePath;
            jobDates.set(job, createdAt);
            jobs.push(job);
          } catch (error) {
            log.warn(`Error reading job metadata file ${file}:`, error);
          }
        }
      }

      // Sort by creation date (newest first), using the resolved timestamps
      jobs.sort((a, b) => (jobDates.get(b) ?? 0) - (jobDates.get(a) ?? 0));

      return jobs;
    } catch (error) {
      log.error('Error getting job history:', error);
      return [];
    }
  });

  /**
   * Bring the reports directory up to schema_version 2, and the publish selections onto
   * item ids, once per session.
   *
   * LAZY, never at boot: with the output volume unmounted a boot-time sweep would report
   * "0 files migrated", which reads as success and is a statement about a directory it
   * never opened.
   *
   * BOTH HALVES, IN THIS ORDER, IN ONE PASS. `migrateSelections` turns a stored
   * (jobId, itemIndex) into an item id by asking the report file what the item at that
   * index is now called — which only has an answer once `migrateReports` has minted the
   * ids. Splitting them across two triggers would give the selections sweep a window in
   * which no report had an id yet: every selection would resolve to null and be moved,
   * correctly by its own rules and disastrously in fact, to `selections/orphaned/`.
   *
   * Throws on failure rather than recording a migration that did not happen, so the next
   * caller tries again. Both receipts are stashed for the request that asks for them.
   */
  const ensureReportsMigrated = (metadataDir: string): void => {
    if (reportsMigrated) return;

    const reports = migrateReports(metadataDir);
    log.info('[ReportMigration]', reports);

    // The resolver reads the files migrateReports just wrote. Report files are small and
    // there are ~100 of them, so this reads each at most once and holds only the id map.
    const idsByJob = new Map<string, string[]>();
    const resolveItemId = (jobId: string, itemIndex: number): string | null => {
      if (!idsByJob.has(jobId)) {
        const file = path.join(metadataDir, `${jobId}.json`);
        if (!fs.existsSync(file)) {
          idsByJob.set(jobId, []);
        } else {
          // A report we cannot read is a report that cannot resolve anything. It is not a
          // reason to guess, and the selection file it fails to resolve is moved intact
          // to selections/orphaned/ rather than dropped.
          try {
            const job = JSON.parse(fs.readFileSync(file, 'utf8'));
            const items = Array.isArray(job?.items) ? job.items : [];
            idsByJob.set(jobId, items.map((i: any) => (isItemId(i?.item_id) ? i.item_id : '')));
          } catch (error) {
            log.error(`[SelectionMigration] Cannot read report ${file}:`, error);
            idsByJob.set(jobId, []);
          }
        }
      }
      const id = idsByJob.get(jobId)![itemIndex];
      return id ? id : null;
    };

    const selections = migrateSelections(
      path.dirname(analytics.publishStore.selectionsItemsDir),
      analytics.publishStore.selectionsItemsDir,
      resolveItemId
    );
    log.info('[SelectionMigration]', selections);

    // Only once BOTH halves have completed. A flag set between them would leave the
    // selections un-migrated for the rest of the session with nothing to say so.
    reportsMigrated = true;
    if (migrationIsNoteworthy(reports)) pendingMigrationReceipt = reports;
    if (selectionMigrationIsNoteworthy(selections)) pendingSelectionReceipt = selections;
  };

  /**
   * The reports page's call site: run the pass and tell the operator what it did.
   *
   * The receipt rides back on this response rather than through a separate pull: the
   * request that caused the work is the one place where the work is guaranteed to have a
   * listener.
   */
  ipcMain.handle('reports-ensure-migrated', async () => {
    const settings = (store as any).store;
    const outputDirectory = settings.outputDirectory;
    if (!outputDirectory) {
      return { ran: false, receipt: null, message: null, error: 'No output directory configured' };
    }

    const metadataDir = path.join(outputDirectory, '.contentstudio', 'metadata');
    if (!fs.existsSync(metadataDir)) {
      // Not there is not the same as not readable, and it is not this handler's error to
      // report: the caller is about to list that same directory and say what it found
      // (including the older layout it may find instead). It is still not recorded as
      // migrated — a directory that does not exist has not been migrated.
      return { ran: false, receipt: null, message: null, notFound: true };
    }

    try {
      ensureReportsMigrated(metadataDir);
    } catch (error) {
      // The sweep could not read the directory. Say so and stay un-migrated, so the
      // next attempt tries again instead of trusting a run that never happened.
      const message = error instanceof Error ? error.message : String(error);
      log.error('[ReportMigration] Failed:', error);
      return { ran: false, receipt: null, message: null, error: message };
    }

    const receipt = pendingMigrationReceipt;
    const selectionReceipt = pendingSelectionReceipt;
    pendingMigrationReceipt = null;
    pendingSelectionReceipt = null;

    const message = [
      receipt ? describeMigration(receipt) : '',
      selectionReceipt ? describeSelectionMigration(selectionReceipt) : '',
    ].filter(Boolean).join(' ');

    return {
      ran: receipt !== null || selectionReceipt !== null,
      receipt,
      selectionReceipt,
      message: message || null,
    };
  });

  /**
   * Delete ONE generated item: its text file, its row in the report, its publish selection.
   *
   * The renderer sends two ids and no paths. It used to do this itself over
   * `delete-directory` plus a read-modify-write of the report JSON that bypassed the
   * output handler's write queue, then renumbered its own rows in memory whether or not
   * the write had succeeded. Every part of that is now one transaction in the main
   * process, and it throws rather than reporting a delete it did not do.
   */
  ipcMain.handle('reports-delete-item', async (_event, jobId: string, itemId: string) => {
    const settings = (store as any).store;
    const outputDirectory = settings.outputDirectory;
    if (!outputDirectory) {
      throw new Error('No output directory configured — cannot delete a report item.');
    }

    const metadataDir = path.join(outputDirectory, '.contentstudio', 'metadata');
    if (!fs.existsSync(metadataDir)) {
      throw new Error(`Reports directory not found: ${metadataDir}`);
    }

    const handler = OutputHandlerService.forOutputDir(outputDirectory);
    const receipt = await handler.deleteItem(jobId, itemId, {
      // One unlink. Selections are per-item files keyed by this same id, so a sibling's
      // deletion cannot move this record and there is nothing to renumber.
      removeSelection: (id) => analytics.publishStore.clearItem(id),
    });

    // Deleting the last item deletes the job, and a held "Show prompt" transcript for a
    // job that no longer exists is a transcript nothing can ever send.
    if (receipt.jobFileDeleted) {
      heldTranscripts.delete(jobId);
    }

    return receipt;
  });

  // Delete job history entry
  ipcMain.handle('delete-job-history', async (_event, jobId: string) => {
    // A job id is required, and an absent one is a caller bug rather than an empty delete.
    // Without this, history.ts's `job.job_id || job.id || ''` sends '' for a report file
    // carrying neither, nothing matches, and the already-gone branch below reports a
    // completed delete for a job that was never identified.
    if (typeof jobId !== 'string' || !jobId.trim()) {
      return { success: false, error: 'delete-job-history requires a non-empty jobId' };
    }

    try {
      // Removing a job also drops any held "Show prompt" transcript for it.
      heldTranscripts.delete(jobId);

      const settings = (store as any).store;
      const outputDirectory = settings.outputDirectory;

      if (!outputDirectory) {
        return { success: false, error: 'No output directory configured' };
      }

      const metadataDir = path.join(outputDirectory, '.contentstudio', 'metadata');

      if (!fs.existsSync(metadataDir)) {
        return { success: false, error: 'Metadata directory not found' };
      }

      // The operator's publish selections go too.
      //
      // `clearItemsOfJob` is a scan-and-match now, not an unlink: selections are one file
      // per ITEM, and the job is no longer a directory entry. Each record carries the job
      // it came from as a back-reference, and that is what is matched. A record that
      // cannot be read is LEFT and NAMED below rather than deleted — a file we could not
      // attribute to this job is not a file to delete on this job's behalf, which is the
      // same rule the per-item text cleanup follows.
      //
      // AFTER the pre-flight guards and BEFORE the report files, and both halves of that are
      // deliberate. Before the files, because if a report delete fails partway the operator
      // still has a job they can see and retry, whereas the reverse order orphans the
      // selections with no jobId left in any UI to reach them by. After the guards, because
      // those return `success: false` — clearing first meant a delete that reported doing
      // NOTHING had already destroyed the operator's hand-curated A/B choices, and the
      // likeliest way to reach it is an output directory that has been moved or renamed,
      // which is exactly when someone is tidying up.
      //
      // Failure here does not abort the delete — the selections are a side record, and
      // refusing to remove a job because its leftovers could not be tidied would be the
      // tail wagging the dog — but it is reported rather than swallowed.
      let selectionsWarning: string | null = null;
      try {
        const cleared = await analytics.publishStore.clearItemsOfJob(jobId);
        log.info(`[JobHistory] Publish selections cleared for ${jobId}:`, cleared);
        if (cleared.unreadable.length > 0) {
          selectionsWarning =
            `${cleared.unreadable.length} publish selection file${cleared.unreadable.length === 1 ? '' : 's'} ` +
            `could not be read, so they were left in place: ${cleared.unreadable.join('; ')}`;
        }
      } catch (err: any) {
        selectionsWarning = `Its publish selections could not be removed: ${err?.message || String(err)}`;
        log.warn(`[JobHistory] Could not clear publish selections for ${jobId}:`, err);
      }

      const files = fs.readdirSync(metadataDir);

      for (const file of files) {
        if (file.startsWith('job-') && file.endsWith('.json')) {
          const filePath = path.join(metadataDir, file);

          try {
            const content = fs.readFileSync(filePath, 'utf8');
            const job = JSON.parse(content);

            // Check both job.id and job.job_id for compatibility
            if (job.id === jobId || job.job_id === jobId) {
              // The job's own text files, one recorded path at a time.
              //
              // This used to be `fs.rmSync(job.txt_folder, { recursive: true, force: true })`,
              // and it was destroying other reports' work: `txt_folder` is derived from the
              // job NAME, so regenerating a source produces a new job that writes into the
              // same folder — seven jobs share `4 - satanism` in the live data. Deleting any
              // one of them deleted all seven jobs' text output.
              //
              // Items that predate the migration recorded no path. Their .txt files are LEFT,
              // and the result says so: a file we cannot attribute to this job is not a file
              // to delete on this job's behalf.
              const cleanup = deleteJobTxtFiles(job);
              log.info(`[JobHistory] Text cleanup for ${jobId}:`, cleanup);

              // Delete the JSON metadata file
              fs.unlinkSync(filePath);
              log.info(`Deleted job history entry: ${jobId}`);

              const notes: string[] = [];
              if (cleanup.left > 0) {
                notes.push(
                  `${cleanup.left} text file${cleanup.left === 1 ? '' : 's'} were left in ${job.txt_folder} ` +
                  `because the report recorded no per-item path for them.`
                );
              }
              for (const failure of cleanup.failed) {
                notes.push(`${failure.path} could not be removed (${failure.error}).`);
              }
              if (selectionsWarning) {
                notes.push(selectionsWarning);
              }

              return {
                success: true,
                txtFilesDeleted: cleanup.deleted,
                txtFilesMissing: cleanup.missing,
                txtFilesLeft: cleanup.left,
                txtFolderRemoved: cleanup.folderRemoved,
                ...(notes.length > 0 ? { warning: notes.join(' ') } : {}),
              };
            }
          } catch (parseError) {
            log.warn(`Could not parse job file ${file}:`, parseError);
            continue;
          }
        }
      }

      // Nothing matched. That is not necessarily a failure: the operator may be deleting a
      // job whose report file is already gone — deleted from the reports page, pruned by the
      // four-week sweep in get-job-history, or removed by hand. Reporting `success: false`
      // for "it is already in the state you asked for" made the History page's clear-all show
      // an error for work that was, in fact, done.
      //
      // The publish selections were cleared above regardless, which is the part that would
      // otherwise be left behind, so there is genuinely nothing outstanding here.
      log.info(`[JobHistory] No report file for ${jobId} — already gone; selections cleared.`);
      // `alreadyGone` is carried on BOTH shapes. It used to be dropped whenever a warning was
      // present, so a caller trying to tell "already gone" from "just deleted" got the wrong
      // answer precisely when something else had also gone wrong. A flag that does not
      // survive its own error path is worse than no flag.
      return {
        success: true,
        alreadyGone: true,
        ...(selectionsWarning
          ? { warning: `No report file for this job (it was already gone). ${selectionsWarning}` }
          : {}),
      };
    } catch (error) {
      log.error('Error deleting job history:', error);
      return { success: false, error: String(error) };
    }
  });

  // Open folder in file explorer
  ipcMain.handle('open-folder', async (_event, folderPath: string) => {
    try {
      const { shell } = require('electron');
      await shell.openPath(folderPath);
      return { success: true };
    } catch (error) {
      log.error('Error opening folder:', error);
      return { success: false, error: String(error) };
    }
  });

  // Write text file
  ipcMain.handle('write-text-file', async (_event, filePath: string, content: string) => {
    try {
      await fs.promises.writeFile(filePath, content, 'utf-8');
      log.info(`Wrote text file: ${filePath}`);
      return { success: true };
    } catch (error) {
      log.error('Error writing text file:', error);
      return { success: false, error: String(error) };
    }
  });


  // Save logs
  ipcMain.handle('save-logs', async (_event, frontendLogs: string) => {
    try {
      const logsDir = path.join(app.getPath('userData'), 'logs');

      // Create logs directory if it doesn't exist
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

      // Save frontend logs
      const frontendPath = path.join(logsDir, `frontend-${timestamp}.log`);
      fs.writeFileSync(frontendPath, frontendLogs, 'utf-8');

      // Get backend logs from electron-log
      const backendPath = path.join(logsDir, `backend-${timestamp}.log`);
      const backendLogPath = log.transports.file.getFile().path;

      // Copy electron-log file to the logs directory
      if (fs.existsSync(backendLogPath)) {
        fs.copyFileSync(backendLogPath, backendPath);
      } else {
        fs.writeFileSync(backendPath, '(No backend logs available)', 'utf-8');
      }

      log.info(`Logs exported - Frontend: ${frontendPath}, Backend: ${backendPath}`);

      return {
        success: true,
        frontendPath,
        backendPath
      };
    } catch (error) {
      log.error('Error saving logs:', error);
      return { success: false, error: String(error) };
    }
  });

  // AI Setup - Check Ollama availability and get models
  ipcMain.handle('check-ollama', async () => {
    try {
      const host = String((store as any).get('ollamaHost', 'http://localhost:11434')).replace(/\/$/, '');
      const response = await fetch(`${host}/api/tags`);
      if (!response.ok) {
        return { available: false, models: [] };
      }
      const data = await response.json() as any;
      const models = data.models ? data.models.map((m: any) => m.name) : [];
      return { available: true, models };
    } catch (error) {
      log.info('Ollama not available:', error);
      return { available: false, models: [] };
    }
  });

  // AI Setup - Get available models for a provider
  // Reads API keys from stored file if not provided
  ipcMain.handle('get-available-models', async (_event, provider: 'ollama' | 'openai' | 'claude', apiKey?: string, host?: string) => {
    try {
      log.info(`Getting available models for ${provider}`);

      // If no API key provided, read from stored keys file
      let key = apiKey;
      if (!key && (provider === 'openai' || provider === 'claude')) {
        const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');
        if (fs.existsSync(apiKeysPath)) {
          const data = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
          if (provider === 'openai') {
            key = data.openaiApiKey;
          } else if (provider === 'claude') {
            key = data.claudeApiKey;
          }
        }
      }

      const models = await AIManagerService.getAvailableModels(provider, key, host);
      log.info(`Found ${models.length} models for ${provider}`);
      return { success: true, models };
    } catch (error) {
      log.error(`Error getting models for ${provider}:`, error);
      return { success: false, models: [], error: String(error) };
    }
  });

  // AI Setup - Get API keys
  ipcMain.handle('get-api-keys', async () => {
    try {
      const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');

      if (!fs.existsSync(apiKeysPath)) {
        return { claudeApiKey: undefined, openaiApiKey: undefined };
      }

      const data = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));

      // Return masked keys for security (frontend just needs to know if they exist)
      return {
        claudeApiKey: data.claudeApiKey ? '***' : undefined,
        openaiApiKey: data.openaiApiKey ? '***' : undefined
      };
    } catch (error) {
      log.error('Error getting API keys:', error);
      return { claudeApiKey: undefined, openaiApiKey: undefined };
    }
  });

  // AI Setup - Save API key
  ipcMain.handle('save-api-key', async (event, provider: string, apiKey: string) => {
    try {
      const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');

      let existingKeys: any = {};
      if (fs.existsSync(apiKeysPath)) {
        existingKeys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
      }

      // Update the appropriate key
      if (provider === 'claude') {
        existingKeys.claudeApiKey = apiKey;
      } else if (provider === 'openai') {
        existingKeys.openaiApiKey = apiKey;
      } else {
        return { success: false, error: 'Invalid provider' };
      }

      // Save to file
      fs.writeFileSync(apiKeysPath, JSON.stringify(existingKeys, null, 2), 'utf-8');

      log.info(`API key saved for ${provider}`);
      return { success: true };
    } catch (error) {
      log.error('Error saving API key:', error);
      return { success: false, error: String(error) };
    }
  });

  // Open external URL
  ipcMain.handle('open-external', async (_event, url: string) => {
    try {
      const { shell } = require('electron');
      await shell.openExternal(url);
      log.info(`Opened external URL: ${url}`);
      return { success: true };
    } catch (error) {
      log.error('Error opening external URL:', error);
      return { success: false, error: String(error) };
    }
  });

  // ==================== TRANSCRIPT IMPORT ====================

  // Pick one or more AutoCutStudio transcript JSON files, validate them, and
  // return a per-story summary the renderer turns into input items. The heavy
  // lifting (words -> segments) happens later in the pipeline via InputHandler.
  ipcMain.handle('import-transcript', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Import Transcript',
        filters: [
          { name: 'Transcript JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile', 'multiSelections']
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, items: [], errors: [] };
      }

      const items: any[] = [];
      const errors: string[] = [];

      for (const filePath of result.filePaths) {
        try {
          const raw = await fs.promises.readFile(filePath, 'utf-8');
          const parsed = parseTranscriptImport(raw, filePath);
          if (parsed.ok) {
            items.push({ path: filePath, ...parsed.data.summary });
          } else {
            errors.push(`${path.basename(filePath)}: ${parsed.error}`);
          }
        } catch (err) {
          errors.push(`${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return { success: items.length > 0, items, errors };
    } catch (error) {
      log.error('Error importing transcript:', error);
      return { success: false, items: [], errors: [String(error)] };
    }
  });

  // Analyze an imported transcript for logical subject-change boundaries.
  // Returns a chronological CANDIDATE menu; the user picks which become cuts.
  ipcMain.handle('analyze-transcript-split', async (_event, params: { filePath: string }) => {
    try {
      const { filePath } = params || ({} as any);
      if (!filePath) return { success: false, error: 'No transcript file provided.' };

      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = parseTranscriptImport(raw, filePath);
      if (!parsed.ok) return { success: false, error: parsed.error };

      const srtSegments = wordsToSegments(parsed.data.words, parsed.data.meta.speakers);
      const totalDurationSeconds = parsed.data.summary.durationSeconds;

      // Resolve AI provider/model/key from settings — identical to generate-metadata.
      const settings = (store as any).store;
      const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');
      let apiKeys: any = {};
      if (fs.existsSync(apiKeysPath)) apiKeys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
      const aiModel = settings.metadataModel || settings.aiModel || settings.ollamaModel;
      const aiProvider = (settings.metadataProvider || settings.aiProvider || 'ollama') as 'ollama' | 'openai' | 'claude';
      const fullModel = aiModel ? `${aiProvider}:${aiModel}` : undefined;
      let apiKey: string | undefined;
      if (aiProvider === 'openai') apiKey = apiKeys.openaiApiKey;
      else if (aiProvider === 'claude') apiKey = apiKeys.claudeApiKey;

      const aiConfig: AIConfig = {
        provider: aiProvider,
        metadataModel: fullModel,
        summarizationModel: fullModel,
        apiKey,
        host: settings.ollamaHost || 'http://localhost:11434',
        // Where the prompt assets live. Every prompt is an asset now, including the
        // episode-split one, so a service built without this has nowhere to read them from.
        promptSetsDir: getPromptSetsDirectory(),
      };
      const aiService = new AIManagerService(aiConfig);
      const initialized = await aiService.initialize();
      if (!initialized) {
        return {
          success: false,
          error: aiService.lastInitError
            ? `Failed to initialize AI service: ${aiService.lastInitError}`
            : 'Failed to initialize AI service',
        };
      }

      try {
        const chapters = await EpisodeSplitterService.detectChapters({
          srtSegments,
          totalDurationSeconds,
          aiService,
          provider: aiProvider,
        });
        return {
          success: true,
          title: parsed.data.meta.story.title,
          durationSeconds: totalDurationSeconds,
          chapters,
        };
      } finally {
        aiService.cleanup();
      }
    } catch (error) {
      log.error('Error analyzing transcript split:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Finalize a split: write N standalone transcript-import files (rebased to 0)
  // next to the original and return them as queue-item descriptors.
  ipcMain.handle('commit-transcript-split', async (_event, params: { filePath: string; cuts: TranscriptSliceCut[] }) => {
    try {
      const { filePath, cuts } = params || ({} as any);
      if (!filePath) return { success: false, error: 'No transcript file provided.' };
      if (!Array.isArray(cuts) || cuts.length === 0) return { success: false, error: 'No split points provided.' };

      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = parseTranscriptImport(raw, filePath);
      if (!parsed.ok) return { success: false, error: parsed.error };

      const slices = buildTranscriptSlices(parsed.data, cuts);
      const dir = path.dirname(filePath);
      const base = path.basename(filePath, path.extname(filePath));
      const total = slices.length;

      const items: any[] = [];
      for (let i = 0; i < slices.length; i++) {
        const slice = slices[i];
        const outPath = path.join(dir, `${base}.part${i + 1}-of-${total}.json`);
        await fs.promises.writeFile(outPath, JSON.stringify(slice.file, null, 2), 'utf-8');
        items.push({
          path: outPath,
          displayName: slice.displayName,
          startSeconds: slice.startSeconds,
          endSeconds: slice.endSeconds,
          durationSeconds: slice.durationSeconds,
          wordCount: slice.wordCount,
        });
      }

      return { success: true, items };
    } catch (error) {
      log.error('Error committing transcript split:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ==================== END TRANSCRIPT IMPORT ====================

  // ==================== ANALYTICS ====================

  const { analyticsStore, ingestServer } = analytics;
  const distillation = new DistillationService(analyticsStore);

  // Channel registry CRUD
  ipcMain.handle('analytics-list-channels', async () => {
    try {
      return { success: true, channels: analyticsStore.listChannels() };
    } catch (error) {
      log.error('Error listing analytics channels:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('analytics-add-channel', async (_event, entry: ChannelRegistryEntry) => {
    try {
      if (!entry || !entry.channelId || !entry.name) {
        return { success: false, error: 'Channel requires channelId and name' };
      }
      const channels = analyticsStore.listChannels();
      if (channels.some((c) => c.channelId === entry.channelId)) {
        return { success: false, error: `Channel ${entry.channelId} is already registered` };
      }
      channels.push({ channelId: entry.channelId, name: entry.name, promptSets: entry.promptSets || [] });
      await analyticsStore.saveChannels(channels);
      return { success: true, channels };
    } catch (error) {
      log.error('Error adding analytics channel:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('analytics-update-channel', async (_event, channelId: string, entry: ChannelRegistryEntry) => {
    try {
      const channels = analyticsStore.listChannels();
      const index = channels.findIndex((c) => c.channelId === channelId);
      if (index === -1) {
        return { success: false, error: `Channel ${channelId} is not registered` };
      }
      channels[index] = { channelId: entry.channelId, name: entry.name, promptSets: entry.promptSets || [] };
      await analyticsStore.saveChannels(channels);
      return { success: true, channels };
    } catch (error) {
      log.error('Error updating analytics channel:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('analytics-delete-channel', async (_event, channelId: string) => {
    try {
      const channels = analyticsStore.listChannels();
      const remaining = channels.filter((c) => c.channelId !== channelId);
      if (remaining.length === channels.length) {
        return { success: false, error: `Channel ${channelId} is not registered` };
      }
      await analyticsStore.saveChannels(remaining);
      return { success: true, channels: remaining };
    } catch (error) {
      log.error('Error deleting analytics channel:', error);
      return { success: false, error: String(error) };
    }
  });

  // Ingest server info: port, token, status (incl. port-conflict error state)
  ipcMain.handle('analytics-get-ingest-info', async () => {
    try {
      const status = ingestServer.getStatus();
      return {
        success: true,
        port: status.port,
        token: ingestServer.getToken(),
        running: status.running,
        error: status.error,
        lastIngestAt: status.lastIngestAt,
      };
    } catch (error) {
      log.error('Error getting ingest info:', error);
      return { success: false, error: String(error) };
    }
  });

  // Per-channel summary: video count, snapshot count, last capture time
  ipcMain.handle('analytics-get-summary', async () => {
    try {
      const channels = analyticsStore.listChannels().map((channel) => {
        const stats = analyticsStore.getSnapshotStats(channel.channelId);
        return {
          channelId: channel.channelId,
          name: channel.name,
          promptSets: channel.promptSets,
          videoCount: analyticsStore.listVideos(channel.channelId).length,
          snapshotCount: stats.snapshotCount,
          lastIngestAt: stats.lastCapturedAt,
        };
      });
      return { success: true, channels };
    } catch (error) {
      log.error('Error getting analytics summary:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('analytics-run-distillation', async () => {
    try {
      const summary = await distillation.runDistillation();
      return { success: true, summary };
    } catch (error) {
      log.error('Error running distillation:', error);
      return { success: false, error: String(error) };
    }
  });

  // Insights: per-channel + cross-channel (null where not yet computed)
  ipcMain.handle('analytics-get-insights', async () => {
    try {
      const channels = analyticsStore.listChannels().map((channel) => ({
        channelId: channel.channelId,
        name: channel.name,
        insights: analyticsStore.loadChannelInsights(channel.channelId),
      }));
      return {
        success: true,
        channels,
        crossChannel: analyticsStore.loadCrossChannelInsights(),
      };
    } catch (error) {
      log.error('Error getting analytics insights:', error);
      return { success: false, error: String(error) };
    }
  });

  // DEV: seed plausible fake data so the whole loop can be exercised end-to-end
  ipcMain.handle('analytics-seed-fake-data', async () => {
    try {
      const summary = await seedFakeData(analyticsStore);
      return { success: true, summary };
    } catch (error) {
      log.error('Error seeding fake analytics data:', error);
      return { success: false, error: String(error) };
    }
  });

  // ==================== END ANALYTICS ====================

  // ==================== YOUTUBE (OAuth + API collector) ====================

  const { youtubeAuth, apiCollector } = analytics;

  // Kick off the interactive OAuth flow for ONE channel. Resolves with the
  // discovered {channelId, channelTitle}. On failure the NAMED error message is
  // returned verbatim so the UI can show it (missing creds, denied, timeout…).
  ipcMain.handle('youtube-connect-channel', async () => {
    try {
      const result = await youtubeAuth.connectChannel();
      return { success: true, channelId: result.channelId, channelTitle: result.channelTitle };
    } catch (error) {
      log.error('YouTube connect failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Revoke + remove a channel's tokens.
  ipcMain.handle('youtube-disconnect-channel', async (_event, channelId: string) => {
    try {
      if (!channelId) return { success: false, error: 'channelId is required' };
      await youtubeAuth.disconnect(channelId);
      return { success: true };
    } catch (error) {
      log.error('YouTube disconnect failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Connections with EVERY secret stripped (never send tokens to the renderer).
  ipcMain.handle('youtube-list-connections', async () => {
    try {
      return { success: true, connections: youtubeAuth.listConnections() };
    } catch (error) {
      log.error('YouTube list connections failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Run a collection cycle now — all connected channels, or one when channelId given.
  ipcMain.handle('youtube-collect-now', async (_event, channelId?: string) => {
    try {
      const results = await apiCollector.collectAll(channelId);
      return { success: true, results };
    } catch (error) {
      log.error('YouTube collect-now failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Collector schedule + per-channel last-run stats.
  ipcMain.handle('youtube-get-collector-state', async () => {
    try {
      return { success: true, state: apiCollector.getState() };
    } catch (error) {
      log.error('YouTube get collector state failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ==================== END YOUTUBE ====================

  // ==================== PUBLISH (title A/B) ====================

  /** Where the generator writes its per-job reports. Throws rather than guessing. */
  const metadataReportsDir = (): string => {
    const outputDirectory = (store as any).store?.outputDirectory;
    if (!outputDirectory) {
      throw new Error('No output directory configured — cannot locate metadata reports.');
    }
    return path.join(outputDirectory, '.contentstudio', 'metadata');
  };

  // The report index the shelf's browser pages through. Format knowledge lives in
  // services/metadata; publish/ only ever receives the result.
  const readGeneratedIndex = createGeneratedIndexReader(metadataReportsDir);

  // The BROWSE projection of the same files: one row per item, carrying where it lives
  // and what to print. Backs `publish-list-index`, which is what the reports page lists
  // from and what the publish calendar reads — neither of them scans the directory in the
  // renderer any more.
  const readReportIndex = createReportIndexReader(metadataReportsDir);

  const listReportRowsForPublish = () => {
    // Same lazy migration gate as listGeneratedForPublish below, and for the same reason:
    // every row is keyed by an item id that the migration is what mints, and the calendar
    // can be the first page opened in a session. A directory that does not exist is not
    // migrated — nothing has been generated yet, and the reader reports that as
    // directoryMissing rather than as a fault.
    const reportsDir = metadataReportsDir();
    if (fs.existsSync(reportsDir)) ensureReportsMigrated(reportsDir);

    const result = readReportIndex();
    for (const problem of result.problems) {
      log.error(`[Publish] cannot index report ${problem.file}: ${problem.message}`);
    }
    return result;
  };

  const listGeneratedForPublish = (): GeneratedIndex => {
    // The publish surface REQUIRES item_id on every item (generated-index.summarizeJob
    // throws without one), so the migration that mints them has to have run before the
    // index is read — and the extension can reach this without the reports page ever
    // having been opened. Same lazy, once-per-session pass, from the other entry point.
    // It throws rather than serving an index built from un-migrated files.
    //
    // A reports directory that does not EXIST is skipped, not migrated: nothing has been
    // generated yet, and readGeneratedIndex below already reports that as an empty index.
    // Only "the directory is there and cannot be read" is a fault, and migrateReports
    // raises it.
    const reportsDir = metadataReportsDir();
    if (fs.existsSync(reportsDir)) ensureReportsMigrated(reportsDir);

    const result = readGeneratedIndex();
    // The COUNT travels to the shelf; the detail goes to the log, so an unreadable report
    // is both visible to the operator and diagnosable.
    for (const problem of result.problems) {
      log.error(`[Publish] cannot read report ${problem.file}: ${problem.message}`);
    }
    return { items: result.items, unreadable: result.unreadable };
  };

  // Registered as a single seam. `readGenerated` is injected so the publish module
  // never imports from services/metadata — see electron/services/publish/README notes
  // in publish-types.ts.
  //
  // Takes ONLY the item id. Which report file the item lives in is a fact about the item,
  // looked up in the index (which is cached per file by mtime), not something a caller
  // asserts alongside a position — the pair could disagree, and when it did the wrong
  // item's titles were served. The jobId travels back out with the item so the selection
  // record can keep its display back-reference.
  const readGeneratedForPublish = (itemId: string): GeneratedFallback | null => {
    // OUTSIDE the catch below. Listing the index can fail for reasons that are not "this
    // item does not exist" — an unmounted output volume, a migration that could not run —
    // and turning those into a null would tell the operator their report is gone. The
    // catch below covers reading ONE report file, which is the only thing null describes.
    const summary = listGeneratedForPublish().items.find((i) => i.itemId === itemId);
    if (!summary) return null;

    try {
      const jsonPath = path.join(metadataReportsDir(), `${summary.jobId}.json`);
      if (!fs.existsSync(jsonPath)) return null;

      const job = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const items = Array.isArray(job?.items) ? job.items : [];
      const item = items.find((i: any) => i?.item_id === itemId);
      if (!item) return null;

      return {
        jobId: summary.jobId,
        titles: Array.isArray(item.titles) ? item.titles : [],
        // COMPOSED, not raw: chapters at the top and hashtags before the link block, which
        // is what the reports page shows and therefore what has to reach YouTube. Sending
        // item.description alone silently dropped both.
        //
        // BOTH compositions are read here, and which one is published is decided in
        // resolveChosenMetadata from the item's own `chaptersInDescription` flag. The
        // decision cannot be made here: this reader takes an item id and nothing else, on
        // purpose — it is injected into six call sites that have no business knowing about
        // selection records.
        description: composeDescription(item, { includeChapters: true }),
        descriptionWithoutChapters: composeDescription(item, { includeChapters: false }),
        chapterBlock: composeChapterBlock(item),
        tags: composeTags(item),
        // Source filename drives draft matching. Read off the item's own recorded
        // source_path, not inferred from array alignment.
        sourceFilename: sourceFilenameOf(item),
        // The full path, for the thumbnail proposal and for automatic discovery: only this
        // can say which week's thumbnails/ folder to look in. Read off the item's own
        // record, never inferred.
        sourcePath: typeof item.source_path === 'string' ? item.source_path : null,
        // The prompt set the operator picked BEFORE generating, which is what automatic
        // channel routing reads (auto-config.ts). The item's own `_prompt_set` is
        // preferred over the job's `prompt_set` for one reason: they can differ. The job
        // key is the run's setting, the item key is what that item was actually generated
        // with, and on a run whose items came from different sets the job key would route
        // some of them to the wrong channel. Both are read off the report; neither is
        // guessed.
        promptSet:
          typeof item._prompt_set === 'string' && item._prompt_set
            ? item._prompt_set
            : typeof job?.prompt_set === 'string' && job.prompt_set
              ? job.prompt_set
              : null,
        // TODO: probe the source with ffprobe so the duration guard can verify the
        // match. Null is handled — it downgrades the match to 'filename' (unverified)
        // rather than failing.
        sourceDurationSec: null,
        // The editor-story link the RUN honored — the seed for the selection record's
        // own transcriptRef, used only when that record is first created. Read off the
        // item's recorded provenance and nothing else: an item written before provenance
        // existed has no ref to seed from, and `undefined` says exactly that, where a
        // null would claim the run declared final-only.
        transcriptRef: item.content_provenance
          ? (item.content_provenance.transcript_ref ?? null)
          : undefined,
      };
    } catch (error) {
      log.error(`[Publish] readGenerated failed for ${itemId}:`, error);
      return null;
    }
  };

  setupPublishIpc({
    store: analytics.publishStore,
    readGenerated: readGeneratedForPublish,
    listRecentUploads: (channelId: string) => analytics.youtubeApi.listRecentUploads(channelId),
    // Read fresh on every call, not captured: connecting a channel or editing its prompt
    // sets has to take effect without a restart. ChannelRegistryEntry satisfies
    // RoutableChannel structurally, which is what keeps publish/ free of an analytics
    // import.
    listChannels: () => analyticsStore.listChannels(),
    // The same index the shelf pages through, including each item's recorded source_key —
    // which is what carry-forward joins two runs of one video on. Injected rather than
    // imported, exactly like readGenerated: the report FORMAT is services/metadata's
    // business and publish/ never learns it.
    listGenerated: listGeneratedForPublish,
    // The browse projection of the same index, for the one call the reports list and the
    // calendar share. Injected exactly like listGenerated: publish/ never learns the
    // report file format.
    listReportRows: listReportRowsForPublish,
    // And the resolver that decides whether a stored transcript link still names the file
    // it was made against. Carry-forward carries only 'ok'; 'missing' and 'changed' are
    // refused with this function's own reason, which names the path and the disagreement.
    resolveTranscriptRef: resolveRef,
    // The three YouTube WRITES the push action needs, bound one by one rather than by
    // handing publish/ the whole client. Same reason as listRecentUploads above, with a
    // sharper edge: these are the only calls in the app that modify a live video, so the
    // set of them is written out here where it can be read at a glance.
    pushApi: {
      getVideoParts: (channelId: string, videoId: string) =>
        analytics.youtubeApi.getVideoParts(channelId, videoId),
      updateVideo: (
        channelId: string,
        parts: Array<'snippet' | 'status'>,
        body: { id: string; snippet?: Record<string, any>; status?: Record<string, any> }
      ) => analytics.youtubeApi.updateVideo(channelId, parts, body),
      setThumbnail: (
        channelId: string,
        videoId: string,
        image: Buffer,
        mime: 'image/png' | 'image/jpeg'
      ) => analytics.youtubeApi.setThumbnail(channelId, videoId, image, mime),
    },
    // The ONE Spreaker write, bound the same way the YouTube writes are: a narrow
    // function, not the client. A mistake here creates a public episode on a live
    // podcast feed, so this is the seam an upload can be exercised across without one.
    spreakerApi: new SpreakerApiService({
      // Read fresh on every call, never captured: a token saved in Settings has to work
      // without a restart, and an expired one has to fail as an expired one.
      requireCredentials: () => analytics.spreakerConfig.requireCredentials(),
    }),
    // The show, WITHOUT the token. publish/ never sees the credential; what it needs is
    // the id to post to and a name to put in a confirmation, plus the assurance —
    // carried by this call throwing — that there is a token to authenticate with.
    requireSpreakerTarget: () => analytics.spreakerConfig.requireTarget(),
    // ffprobe. Constructed per call, exactly as editor-transcript-link's probeDrift does
    // it: the bridge holds nothing but a path string, and resolving the path at call time
    // means a component installed after launch is picked up without a restart.
    probeAudio: async (file: string) => {
      const ffprobe = new FfprobeBridge(getRuntimePaths().ffprobe);
      const info = await ffprobe.getMediaInfo(file);
      return {
        durationSec: info.duration,
        hasAudio: info.hasAudio,
        hasVideo: info.hasVideo,
        audioCodec: info.audioCodec ?? null,
      };
    },
  });

  // The Spreaker credentials themselves: read by the settings page and by the publish
  // panel (which shows "not configured" with the file path rather than a dead button).
  // Its own seam, like publish/ and editor/ — these channels are about the machine's
  // connection to Spreaker, not about any one item.
  setupSpreakerIpc(analytics.spreakerConfig);

  // Expose the publish routes on the existing localhost ingest server so the companion
  // extension has one port to talk to. The server only knows a structural interface, so
  // analytics/ and publish/ remain independent.
  analytics.ingestServer.setPublishRoutes(
    new PublishBridge(analytics.publishStore, readGeneratedForPublish, listGeneratedForPublish)
  );

  // ==================== END PUBLISH ====================

  // ==================== EDITOR ====================
  // The ported AutoCutStudio timeline editor: its own BrowserWindow, its own Python
  // backend under editor-backend/, and its own channels. Registered as one seam, the
  // same way publish/ is. `store` is passed for the archive settings (archiveRoot,
  // archiveMountUrl), whose defaults are resolved at the read site.
  setupEditorIpc(store);
  // ==================== END EDITOR ====================

  // ==================== TRANSCRIPT LINK ====================
  // Phase 2: finding, probing and resolving the editor story transcript behind a final
  // export. Registered as its own seam like publish/ and editor/. Answers only — the
  // operator confirms every link on the Inputs page.
  setupTranscriptLinkIpc();
  // ==================== END TRANSCRIPT LINK ====================

  log.info('IPC handlers registered');
}
