#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * generate-metadata-cli — run ONE item through the REAL metadata pipeline, from the terminal.
 *
 * WHY THIS EXISTS, and how it differs from prompt-harness/run.js. The harness plans and runs
 * the routed FIELD units against a fixture transcript with no timings, so it deliberately never
 * touches the chapter pipeline, Whisper, the entity/key-phrase pools, the analytics insights
 * block or the output writer. This drives the whole thing through the app's own two entry
 * points — `InputHandlerService.processMultipleInputs` then `MetadataGeneratorService.generate`
 * — which is exactly the split ipc-handlers makes between its transcription job and its AI job.
 *
 * NOTHING IS REIMPLEMENTED HERE. Every prompt, model call and file write comes out of
 * electron/services/**; this file assembles parameter objects, caches what the app throws away,
 * and prints what came back.
 *
 * THREE DELIBERATE OVERRIDES, each printed loudly at startup:
 *
 *  1. --assets. The app reads its prompt tree from `<userData>/prompt_sets/prompts`, which is a
 *     COPY installed at startup, so an unshipped edit under electron/assets/prompts is invisible
 *     to it. The default here is the REPO's tree, passed through the same `promptSetsDir`
 *     parameter the app uses. A hash diff against the installed copy is printed.
 *
 *  2. THE TRANSCRIPT CACHE. Whisper deletes its SRT the moment it has parsed it
 *     (whisper.service.ts `cleanupJob`), so "the transcript the app used" never survives a run
 *     and every prompt iteration paid for a re-transcription. What is cached here is the exact
 *     `ContentItem[]` the real input stage produced, and it is replayed through
 *     `preTranscribedContent` — the app's OWN already-transcribed input (ipc-handlers passes
 *     `job.contentItems` through the same parameter after its transcription job). Same objects,
 *     same downstream code, no parallel branch. `--transcribe` forces a fresh run.
 *
 *  3. FIELD SELECTION. Which fields a run generates is the CHANNEL's statement — its `fields:`
 *     list, read by `AIManagerService.promptSetSectionKeys()` and honoured by
 *     `planMetadataUnits`. So `--titles` etc. do not filter units in this script: they build a
 *     COPY of the prompt tree whose channel file declares only those fields, and the real
 *     planner does the rest. The copy is verified to differ from the original in the `fields:`
 *     list and nowhere else.
 *
 * CHAPTERS ARE NOT A FIELD. Every item with a timestamped transcript gets them, so a field-only
 * run still needs a chapter list — without one the tags stop being pool-assembled and the
 * description loses its coverage, which is a materially different generation. They are computed
 * through the app's "Show prompt" flow (`showPrompt: true` returns `computedChapters`), cached,
 * and replayed through `preComputedChapters` — which is the same reuse path "Show prompt" →
 * "Send to AI" takes in the app. `--chapters` forces a fresh chapter run.
 *
 * PREREQ:
 *   npm run build:electron
 *   ollama serve   (qwen3.8:27b, qwen3.5:9b, nomic-embed-text)
 *
 * USAGE:
 *   node scripts/generate-metadata-cli.js --input "/path/video.mov" --channel youtube-telltale
 *   node scripts/generate-metadata-cli.js --input ... --description --pinned-comment
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Module = require('module');

const REPO_ROOT = path.join(__dirname, '..');
const DIST = path.join(REPO_ROOT, 'dist', 'main');
const SHIM = path.join(__dirname, '_electron-shim-real-userdata.js');
const SCRATCH = '/private/tmp/claude-501/-Volumes-Callisto-Projects-ContentStudio/6916f82d-8b3a-45a6-b254-fd2e7991e264/scratchpad';
const CACHE_DIR = path.join(SCRATCH, 'transcript-cache');

// The compiled main process imports `electron` and `electron-log`, neither of which loads
// outside an Electron runtime. The shim answers with the SAME values Electron would on this
// machine (real userData, real app paths) — see its header.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron' || request === 'electron-log') return require.resolve(SHIM);
  return originalResolve.call(this, request, ...rest);
};

const shim = require(SHIM);
const USER_DATA = shim.USER_DATA;
const yaml = require(path.join(REPO_ROOT, 'node_modules', 'js-yaml'));

// getResourcesPath() in lib/bridges/runtime-paths.ts reads this in development to find
// utilities/bin (whisper) and node_modules/@ffmpeg-installer. Stated rather than left to
// process.cwd(), so the CLI works from any directory.
process.env.CONTENTSTUDIO_PROJECT_ROOT = REPO_ROOT;

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

/** flag -> the field id the channel file declares. */
const FIELD_FLAGS = {
  '--titles': 'titles',
  '--description': 'description',
  '--tags': 'tags',
  '--thumbnail-text': 'thumbnail_text',
  '--hashtags': 'hashtags',
  '--pinned-comment': 'pinned_comment',
  '--clip-suggestions': 'clip_suggestions',
};

function printHelp() {
  console.log(`
generate-metadata-cli — one item through the real metadata pipeline.

  node scripts/generate-metadata-cli.js --input <file> [options]

Input / caching:
  --input <path>       REQUIRED. The video / audio / transcript the app would be given.
  --transcribe         Force a fresh Whisper run and overwrite the cached transcript.
                       Default: replay the cached ContentItem[] for this video if one exists.
  --chapters           Force a fresh chapter-pipeline run and overwrite the cached chapters.
                       With no field flag, the run STOPS after chapters (nothing is generated
                       and no report is written).

Field selection (no flag = every field the channel publishes):
  --titles  --description  --tags  --thumbnail-text  --hashtags
  --pinned-comment  --clip-suggestions
                       Each names a field in the channel's own \`fields:\` list. Selecting any
                       builds a verified copy of the prompt tree whose channel file declares
                       only those, so the REAL planner plans only those calls.
                       Granularity notes, printed again at run time:
                         - description = ONE unit that makes two calls (hook then body). The
                           hook and the body cannot be run separately.
                         - tags on a chaptered item are assembled in CODE from the entity and
                           key-phrase pools; no model writes them and no prompt is involved.
                         - hashtags are always derived in code from the tags and titles.
                         - thumbnail_text normally reads the titles as input data; without
                           --titles it runs with neither that block nor its cross-field check.

Everything else:
  --channel <id>       Channel (prompt set) id. Default: the 'promptSet' in the app settings.
  --route <f>=<m>      Route one field to one model for THIS run (repeatable), validated
                       against the app's own option lists, e.g. --route description=qwen38-27b.
                       The stored routing is never modified.
  --assets <dir>       Prompt assets root. Default: <repo>/electron/assets/prompts.
  --output-dir <dir>   Where the job's report .txt/.json go. Default: the app's outputDirectory.
  --out <path>         Also write the assembled report text here.
  --no-insights        Run without the CHANNEL PERFORMANCE DATA block.
  --recompute-insights Derive this channel's insights IN MEMORY from the stored verdicts and
                       ab-tests (DistillationService.computeChannelInsights) instead of reading
                       the stored insights.json. Needed when insights.json was written by an
                       older build and buildInsightsBlock rejects it — same data, this build's
                       derivation. Nothing is written back. Printed loudly when used.
  --help, -h
`);
}

function parseArgs(argv) {
  const args = {
    input: null,
    channel: null,
    assets: path.join(REPO_ROOT, 'electron', 'assets', 'prompts'),
    outputDir: null,
    out: null,
    noInsights: false,
    recomputeInsights: false,
    transcribe: false,
    freshChapters: false,
    fields: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a === '--input') args.input = path.resolve(argv[++i]);
    else if (a === '--channel') args.channel = argv[++i];
    else if (a === '--assets') args.assets = path.resolve(argv[++i]);
    else if (a === '--output-dir') args.outputDir = path.resolve(argv[++i]);
    else if (a === '--route') (args.routes = args.routes || []).push(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--no-insights') args.noInsights = true;
    else if (a === '--recompute-insights') args.recomputeInsights = true;
    else if (a === '--transcribe') args.transcribe = true;
    else if (a === '--chapters') args.freshChapters = true;
    else if (FIELD_FLAGS[a]) args.fields.push(FIELD_FLAGS[a]);
    else fail(`Unknown option: ${a}  (--help for usage)`);
  }
  if (!args.input) fail('--input is required');
  return args;
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);

/** Which prompt files differ between the assets root in use and the app's installed copy. */
function promptDrift(assetsRoot, installedRoot) {
  const drift = [];
  const walk = (rel) => {
    const dir = path.join(assetsRoot, rel);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) { walk(child); continue; }
      if (!/\.ya?ml$/.test(entry.name)) continue;
      const mine = path.join(assetsRoot, child);
      const theirs = path.join(installedRoot, child);
      if (!fs.existsSync(theirs)) { drift.push([child, sha(mine), 'ABSENT']); continue; }
      const a = sha(mine); const b = sha(theirs);
      if (a !== b) drift.push([child, a, b]);
    }
  };
  walk('');
  return drift;
}

// ---------------------------------------------------------------------------------------
// Field selection: a verified copy of the prompt tree whose channel declares fewer fields
// ---------------------------------------------------------------------------------------

/**
 * Copy `assetsRoot` to `destDir` and narrow ONE channel's `fields:` list to `wanted`.
 *
 * The edit is TEXTUAL — the `fields:` block and nothing else — and then verified by re-parsing
 * and deep-comparing every other key against the original. A YAML round-trip would have been
 * easier and would also have silently rewritten anchors, block scalars and comments in a file
 * whose exact text is the thing under test.
 */
function buildFilteredAssets(assetsRoot, channelId, wanted, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.cpSync(assetsRoot, destDir, { recursive: true });

  const channelDir = path.join(destDir, 'channels');
  let target = null;
  for (const file of fs.readdirSync(channelDir).filter((f) => /\.ya?ml$/.test(f))) {
    const full = path.join(channelDir, file);
    if (yaml.load(fs.readFileSync(full, 'utf8')).id === channelId) { target = full; break; }
  }
  if (!target) fail(`No channel file in ${channelDir} declares id "${channelId}"`);

  const raw = fs.readFileSync(target, 'utf8');
  const before = yaml.load(raw);
  const unknown = wanted.filter((f) => !before.fields.includes(f));
  if (unknown.length > 0) {
    fail(
      `Channel "${channelId}" does not publish ${unknown.join(', ')} — its fields are: ` +
        `${before.fields.join(', ')}. A field the channel does not declare has no instructions ` +
        `to run, so there is nothing to test.`
    );
  }
  // Channel order is EMISSION order; keep it rather than the order the flags were typed.
  const ordered = before.fields.filter((f) => wanted.includes(f));

  const blockPattern = /^fields:\n(?:[ \t]*-[^\n]*\n)+/m;
  if (!blockPattern.test(raw)) {
    fail(`Could not find a block-list "fields:" in ${target}; refusing to guess at its shape`);
  }
  const replaced = raw.replace(blockPattern, `fields:\n${ordered.map((f) => `  - ${f}`).join('\n')}\n`);
  fs.writeFileSync(target, replaced, 'utf8');

  // Verify: fields are exactly the selection, and NOTHING else moved.
  const after = yaml.load(fs.readFileSync(target, 'utf8'));
  if (JSON.stringify(after.fields) !== JSON.stringify(ordered)) {
    fail(`The filtered channel file's fields came out as ${JSON.stringify(after.fields)}, not ${JSON.stringify(ordered)}`);
  }
  const strip = (o) => { const c = { ...o }; delete c.fields; return JSON.stringify(c); };
  if (strip(before) !== strip(after)) {
    fail(`Narrowing the fields list in ${target} changed something else in the file; refusing to run`);
  }
  return { file: target, all: before.fields, selected: ordered };
}

// ---------------------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------------------

/** What the video looked like when something was cached from it. */
function videoStamp(videoPath) {
  const st = fs.statSync(videoPath);
  return { path: videoPath, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
}

function sameStamp(a, b) {
  return a && b && a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function cachePaths(videoPath) {
  const base = path.basename(videoPath).replace(/\.[^/.]+$/, '');
  return {
    transcript: path.join(CACHE_DIR, `${base}.transcript.json`),
    chapters: path.join(CACHE_DIR, `${base}.chapters.json`),
  };
}

/**
 * Read a cache file, or return null when there is none.
 *
 * A cache that EXISTS but describes a different or changed file is a hard failure, never a
 * quiet miss: silently re-transcribing (or worse, silently reusing) is the class of thing this
 * repo does not do. The operator is told which and can pass --transcribe / --chapters.
 */
function readCache(file, videoPath, what) {
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`The cached ${what} at ${file} is not readable JSON (${error.message}); delete it and re-run`);
  }
  if (parsed.version !== undefined && parsed.version < 2) {
    fail(
      `The cached ${what} at ${file} is version ${parsed.version}, written before speaker tagging ` +
        `existed, so its captions carry no attribution. Re-run with --transcribe to replace it.`
    );
  }
  if (!sameStamp(parsed.video, videoStamp(videoPath))) {
    fail(
      `The cached ${what} at ${file} was taken from a different file, or from this one before it ` +
        `changed:\n    cached: ${JSON.stringify(parsed.video)}\n     now:   ${JSON.stringify(videoStamp(videoPath))}\n` +
        `  Re-run with --transcribe to replace it.`
    );
  }
  return parsed;
}

function writeCache(file, payload) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(DIST)) {
    fail(`Compiled main process not found at ${DIST}\n  Build it first:  npm run build:electron`);
  }
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.input)) fail(`Input not found: ${args.input}`);
  if (!fs.existsSync(args.assets)) fail(`Prompt assets not found: ${args.assets}`);

  // ---- the app's real settings, read the way the app reads them ------------------------
  const Store = require('electron-store');
  const store = new Store({});
  const settings = store.store;

  const { setSelectedWhisperModel } = require(path.join(DIST, 'lib/bridges/runtime-paths.js'));
  const routing = require(path.join(DIST, 'services/metadata/metadata-routing.js'));
  const { AnalyticsStoreService } = require(path.join(DIST, 'services/analytics/analytics-store.service.js'));
  const { resolveInsightsBlockForPromptSet } = require(path.join(DIST, 'services/analytics/insights-prompt.js'));
  const { MetadataGeneratorService } = require(path.join(DIST, 'services/metadata/metadata-generator.service.js'));
  const { WhisperService } = require(path.join(DIST, 'services/metadata/whisper.service.js'));
  const { InputHandlerService } = require(path.join(DIST, 'services/metadata/input-handler.service.js'));
  const { resolveSpeakerTagging, announceSpeakerTagging, SpeakerTagger } =
    require(path.join(DIST, 'services/metadata/speaker-tagging.service.js'));
  const { getRuntimePaths } = require(path.join(DIST, 'lib/bridges/index.js'));

  // ipc-handlers.ts:760 — the selected Whisper model comes from the store.
  if (!settings.whisperModel) {
    fail(`The app's settings name no whisperModel; the app would transcribe with a model this ` +
         `CLI cannot guess. Set it in Settings → Transcription.`);
  }
  setSelectedWhisperModel(settings.whisperModel);

  const channel = args.channel || settings.promptSet;
  if (!channel) fail('No channel: pass --channel, or set one in the app settings (promptSet).');

  // ipc-handlers.ts:1146-1176 — provider/model/api key resolution, verbatim in shape.
  const metaProvider = settings.metadataProvider || settings.aiProvider;
  const apiKeysPath = path.join(USER_DATA, 'api-keys.json');
  const apiKeys = fs.existsSync(apiKeysPath) ? JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8')) : {};
  const aiModel = settings.metadataModel || settings.aiModel || settings.ollamaModel;
  const aiProvider = settings.metadataProvider || settings.aiProvider || 'ollama';
  const fullModel = aiModel ? `${aiProvider}:${aiModel}` : undefined;
  let apiKey;
  if (aiProvider === 'openai') apiKey = apiKeys.openaiApiKey;
  else if (aiProvider === 'claude') apiKey = apiKeys.claudeApiKey;

  const analyticsStore = new AnalyticsStoreService(path.join(USER_DATA, 'analytics'));
  let insightsBlock = null;
  let insightsSource = '(disabled with --no-insights)';
  if (!args.noInsights && !args.recomputeInsights) {
    // The app's own path: whatever the analytics store has on disk, rendered by
    // buildInsightsBlock. It THROWS on insights written before a field it needs existed —
    // that throw is the honest answer and is left to propagate.
    insightsBlock = resolveInsightsBlockForPromptSet(analyticsStore, channel);
    insightsSource = `${path.join(USER_DATA, 'analytics')} (stored insights.json)`;
  } else if (args.recomputeInsights) {
    const { DistillationService } = require(path.join(DIST, 'services/analytics/distillation.service.js'));
    const { buildInsightsBlock } = require(path.join(DIST, 'services/analytics/insights-prompt.js'));
    const registered = analyticsStore.listChannels().find((c) => c.promptSets.includes(channel));
    if (!registered) fail(`--recompute-insights: no analytics channel maps to prompt set "${channel}"`);
    const distillation = new DistillationService(analyticsStore);
    const channelInsights = distillation.computeChannelInsights(registered.channelId);
    insightsBlock = buildInsightsBlock(channelInsights, analyticsStore.loadCrossChannelInsights());
    insightsSource =
      `RECOMPUTED IN MEMORY from ${registered.channelId} verdicts + ab-tests ` +
      `(the stored insights.json was NOT read and was NOT modified)`;
  }

  const resolvedRouting = routing.resolveMetadataRouting(
    routing.migrateStoredRouting(settings.metadataRouting).selections
  );
  // --route field=model overrides the STORED routing for this run only, validated against the
  // same option lists the app's routing modal offers, so the CLI cannot route a field to a
  // model the app itself could not.
  for (const spec of args.routes || []) {
    const eq = spec.indexOf('=');
    if (eq < 1) fail(`--route wants field=model, got "${spec}"`);
    const field = spec.slice(0, eq);
    const model = spec.slice(eq + 1);
    const task = routing.METADATA_ROUTING_TASKS.find((t) => t.id === field);
    if (!task) fail(`--route: "${field}" is not a routed field. Routed fields: ${routing.METADATA_ROUTING_TASKS.map((t) => t.id).join(', ')}`);
    if (!task.options.includes(model)) fail(`--route: "${model}" is not an option for ${field}. Options: ${task.options.join(', ')}`);
    resolvedRouting[field] = model;
    console.error(`ROUTE OVERRIDE: ${field} -> ${model} (stored routing not modified)`);
  }

  const outputDir = args.outputDir || settings.outputDirectory;
  if (!outputDir) fail('No output directory: pass --output-dir, or set one in the app settings.');

  // ---- field selection ------------------------------------------------------------------
  let effectiveAssets = args.assets;
  let filter = null;
  if (args.fields.length > 0) {
    // The directory MUST be named `prompts`: AIManagerService is handed its PARENT as
    // `promptSetsDir` and appends the name itself, exactly as it does against userData.
    const dest = path.join(
      SCRATCH, 'prompt-trees', `${channel}-${args.fields.slice().sort().join('+')}`, 'prompts'
    );
    filter = buildFilteredAssets(args.assets, channel, args.fields, dest);
    effectiveAssets = dest;
  }
  // `--chapters` with no field flag is a chapter run and nothing else: it recomputes and
  // caches the list, prints it, and stops before any field is generated or any report written.
  // `--chapters` WITH field flags means "recompute the chapters, then generate those fields".
  const chaptersOnly = args.freshChapters && args.fields.length === 0;

  // `promptSetsDir` is the PARENT of the assets root — AIManagerService appends `prompts`,
  // exactly as it does against userData in the app.
  const promptSetsDir = path.dirname(effectiveAssets);
  const installedRoot = path.join(USER_DATA, 'prompt_sets', 'prompts');

  const bar = '='.repeat(78);
  console.error(`\n${bar}`);
  console.error('generate-metadata-cli — the REAL pipeline, driven from the terminal');
  console.error(bar);
  console.error(`  input:       ${args.input}`);
  console.error(`  channel:     ${channel}`);
  console.error(`  prompts:     ${args.assets}`);
  if (path.resolve(args.assets) !== path.resolve(installedRoot)) {
    const drift = promptDrift(args.assets, installedRoot);
    console.error('');
    console.error('  ** PROMPT SOURCE OVERRIDE **');
    console.error(`     The app reads ${installedRoot}`);
    console.error(`     This run reads ${args.assets}`);
    if (drift.length === 0) {
      console.error('     The two trees are byte-identical, so the override changes nothing.');
    } else {
      console.error(`     ${drift.length} file(s) DIFFER — this run is testing the working copy:`);
      for (const [file, mine, theirs] of drift) {
        console.error(`       ${file}\n         here: ${mine}   installed: ${theirs}`);
      }
    }
    console.error('');
  }
  if (filter) {
    console.error('  ** FIELD SELECTION **');
    console.error(`     Channel publishes: ${filter.all.join(', ')}`);
    console.error(`     This run declares: ${filter.selected.join(', ')}`);
    console.error(`     via a verified copy of the prompt tree at ${effectiveAssets}`);
    console.error(`     (only the channel file's "fields:" list differs from the original)`);
    for (const note of granularityNotes(filter.selected)) console.error(`     - ${note}`);
    console.error('');
  }
  console.error(`  whisper:     ${settings.whisperModel}`);
  console.error(`  routing:     ${Object.entries(resolvedRouting).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.error(`  chapters:    ${routing.CHAPTER_PIPELINE_MODELS.generation} (not routed)`);
  console.error(`  summarizer:  ${routing.SUMMARIZATION_MODEL}`);
  console.error(`  packaging:   ${fullModel} (compilation only)`);
  console.error(`  insights:    ${insightsBlock ? `${insightsBlock.length} chars` : '(none)'}`);
  console.error(`               ${insightsSource}`);
  if (args.recomputeInsights) {
    console.error('  ** INSIGHTS RECOMPUTED IN MEMORY — see --help; nothing was written back **');
  }
  console.error(`  output dir:  ${outputDir}`);
  console.error(`  ollama host: ${settings.ollamaHost || 'http://localhost:11434'}`);
  console.error(`${bar}\n`);

  const started = Date.now();
  const progressCallback = (phase, message, percent) => {
    const t = ((Date.now() - started) / 1000).toFixed(0).padStart(5);
    console.error(`  [${t}s] ${phase}: ${message}${percent !== undefined ? ` (${percent}%)` : ''}`);
  };

  const jobId = `cli-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const caches = cachePaths(args.input);

  // ---- STAGE 1: the content items ---------------------------------------------------------
  //
  // The app's transcription job (ipc-handlers `runTranscriptionJob`) is exactly this: an
  // InputHandlerService over the raw input paths, whose ContentItem[] is then handed to
  // MetadataGeneratorService through `preTranscribedContent`. The cache sits between the two.
  let contentItems;
  let transcriptSource;
  const cachedTranscript = args.transcribe ? null : readCache(caches.transcript, args.input, 'transcript');
  if (cachedTranscript) {
    contentItems = cachedTranscript.contentItems;
    transcriptSource =
      `CACHE HIT — ${caches.transcript}\n` +
      `                 cached ${cachedTranscript.cachedAt} from whisper "${cachedTranscript.whisperModel}", ` +
      `${(contentItems[0].srtSegments || []).length} caption segment(s), ${contentItems[0].content.length} chars`;
    console.error(`  TRANSCRIPT: ${transcriptSource}`);
    console.error('              Whisper was NOT run. Pass --transcribe to force a fresh transcription.\n');
  } else {
    console.error(`  TRANSCRIPT: ${args.transcribe ? 'FRESH (--transcribe)' : 'no cache for this video'} — running Whisper\n`);
    const whisperService = new WhisperService();
    whisperService.on('progress', (p) => {
      if (p.percent !== undefined) progressCallback('transcription', p.message, p.percent);
    });
    // Speaker tagging, resolved exactly as ipc-handlers' transcription job resolves it: once,
    // before any video is read, announced once. The CLI is the transcribing side here, so this
    // is the side that has to do it — the generator below is handed `preTranscribedContent` and
    // deliberately does not resolve a second time.
    const speakerMode = await resolveSpeakerTagging(
      settings.speakerEnrollmentAudio, getRuntimePaths().speakerModel);
    announceSpeakerTagging(speakerMode);
    console.error(
      `  SPEAKERS:   ${speakerMode.enabled
        ? `TAGGING ON — captions scored against ${speakerMode.enrollment.stamp}`
        : `tagging off — ${speakerMode.reason}`}\n`
    );
    const speakerTagger = speakerMode.enabled ? new SpeakerTagger(speakerMode) : undefined;

    const inputHandler = new InputHandlerService(
      whisperService, outputDir, progressCallback, speakerTagger);
    const inputFailures = [];
    contentItems = await inputHandler.processMultipleInputs([args.input], new Map(), inputFailures, new Map());
    if (contentItems.length === 0) {
      fail(`No content could be processed: ${inputFailures.join('; ') || '(no reason given)'}`);
    }
    if (inputFailures.length > 0) {
      for (const f of inputFailures) console.error(`  ! input stage: ${f}`);
    }
    writeCache(caches.transcript, {
      // 2: the ContentItem's segments may now carry speaker tags, and its `content` may be
      // screenplay-prefixed because of them. A version-1 cache is a transcript from before
      // tagging existed, and replaying it would generate an untagged description while the run
      // said tagging was on — the same confusion the saved-transcript store bumped its own
      // schema to refuse.
      version: 2,
      video: videoStamp(args.input),
      cachedAt: new Date().toISOString(),
      whisperModel: settings.whisperModel,
      contentItems,
    });
    transcriptSource = `FRESH Whisper run ("${settings.whisperModel}"), cached to ${caches.transcript}`;
    console.error(`\n  TRANSCRIPT: ${transcriptSource}\n`);
    // A fresh transcript invalidates chapters measured against the old one.
    if (fs.existsSync(caches.chapters)) {
      fs.rmSync(caches.chapters);
      console.error('  (the cached chapters were measured against the previous transcript, so they were dropped)\n');
    }
  }

  const item = contentItems[0];
  const sourceLabel = item.source || 'item_1';
  const hasCaptions = Array.isArray(item.srtSegments) && item.srtSegments.length > 0;

  const baseParams = {
    inputs: [args.input],
    mode: settings.defaultMode || 'individual',
    aiProvider: metaProvider,
    aiModel: fullModel,
    summarizationModel: routing.SUMMARIZATION_MODEL,
    metadataModel: fullModel,
    aiApiKey: apiKey,
    aiHost: settings.ollamaHost || 'http://localhost:11434',
    outputPath: outputDir,
    promptSet: channel,
    promptSetsDir,
    jobId,
    jobName: path.basename(args.input),
    inputTranscripts: {},
    chapterNumCtx: settings.chapterNumCtx || undefined,
    // Carried for parity with ipc-handlers' `generate-metadata`. It is a no-op on this call —
    // the generator only resolves a tagging mode when it is the one transcribing, and it is
    // handed `preTranscribedContent` here — but a params object that silently lacks a field the
    // real one has is how a CLI stops being the real pipeline.
    speakerEnrollmentAudio: settings.speakerEnrollmentAudio || undefined,
    metadataRouting: resolvedRouting,
    cloudApiKeys: { claude: apiKeys.claudeApiKey, openai: apiKeys.openaiApiKey },
    inputNotes: {},
    insightsBlock: insightsBlock || undefined,
    preTranscribedContent: contentItems,
    progressCallback,
  };

  // ---- STAGE 2: the chapters --------------------------------------------------------------
  let preComputedChapters;
  let chapterSource;
  const chapterWarnings = [];
  if (!hasCaptions) {
    chapterSource = 'this input has no timestamped transcript, so chapters do not apply';
    console.error(`  CHAPTERS:   ${chapterSource}\n`);
  } else {
    const cachedChapters = args.freshChapters ? null : readCache(caches.chapters, args.input, 'chapters');
    if (cachedChapters && cachedChapters.transcriptCachedAt !== transcriptStamp(caches.transcript)) {
      fail(
        `The cached chapters were computed from a different transcript than the one in play ` +
          `(chapters say ${cachedChapters.transcriptCachedAt}, transcript says ${transcriptStamp(caches.transcript)}). ` +
          `Re-run with --chapters.`
      );
    }
    if (cachedChapters) {
      preComputedChapters = { [cachedChapters.sourceLabel]: cachedChapters.result };
      chapterSource =
        `REUSED from ${caches.chapters} (computed ${cachedChapters.cachedAt}, ` +
        `${cachedChapters.result.chapters.length} chapters, ${cachedChapters.result.stats.calls} model call(s))`;
      console.error(`  CHAPTERS:   ${chapterSource}`);
      console.error('              The chapter pipeline was NOT run. Pass --chapters to recompute.');
      if (cachedChapters.sourceLabel !== sourceLabel) {
        fail(
          `The cached chapters are keyed to "${cachedChapters.sourceLabel}" but this item's source label is ` +
            `"${sourceLabel}"; MetadataGeneratorService looks them up by that label, so they would be ignored.`
        );
      }
      // The pipeline does not re-raise a reused list's warnings (resolveChapters says so
      // explicitly), so they are replayed here from the cache — otherwise a degraded chapter
      // list becomes invisible the second time it is used.
      // Already prefixed with the source label by resolveChapters when they were raised.
      for (const w of cachedChapters.warnings || []) {
        chapterWarnings.push(`[from the cached chapter run] ${w}`);
        console.error(`              ! ${w}`);
      }
      console.error('');
    } else {
      console.error(
        `  CHAPTERS:   ${args.freshChapters ? 'FRESH (--chapters)' : 'no cache for this transcript'} — running the ` +
          `chapter pipeline through the app's "Show prompt" flow\n`
      );
      // showPrompt: the app's own flow that runs the chapter pipeline for real, assembles the
      // prompts, and STOPS before any field call — and the one flow whose result hands the
      // ChapterPipelineResult back, so it can be cached and replayed through
      // preComputedChapters exactly as "Send to AI" replays it.
      const pass = await MetadataGeneratorService.generate({ ...baseParams, showPrompt: true });
      if (!pass.success) fail(`The chapter pass failed: ${pass.error}`);
      const result = (pass.computedChapters || {})[sourceLabel];
      if (!result) {
        fail(
          `The chapter pass returned no chapters for "${sourceLabel}" (it returned keys: ` +
            `${Object.keys(pass.computedChapters || {}).join(', ') || 'none'}). Its warnings: ` +
            `${(pass.warnings || []).join(' | ') || 'none'}`
        );
      }
      writeCache(caches.chapters, {
        version: 2,
        video: videoStamp(args.input),
        cachedAt: new Date().toISOString(),
        transcriptCachedAt: transcriptStamp(caches.transcript),
        sourceLabel,
        warnings: pass.warnings || [],
        result,
      });
      preComputedChapters = { [sourceLabel]: result };
      chapterSource = `COMPUTED FRESH (${result.chapters.length} chapters), cached to ${caches.chapters}`;
      for (const w of pass.warnings || []) chapterWarnings.push(w);
      if (pass.prompts && pass.prompts.length > 0) {
        const promptFile = path.join(SCRATCH, `${path.basename(args.input).replace(/\.[^/.]+$/, '')}.prompts.txt`);
        fs.writeFileSync(promptFile, pass.prompts.join('\n\n\n'), 'utf8');
        console.error(`\n  (assembled prompts from that pass written to ${promptFile})`);
      }
      console.error(`\n  CHAPTERS:   ${chapterSource}\n`);
    }
    console.error('  CHAPTER LIST');
    for (const c of preComputedChapters[sourceLabel].chapters) {
      console.error(`    ${c.timestamp} - ${c.title}`);
    }
    console.error('');
  }

  if (chaptersOnly) {
    console.error(`${bar}\nCHAPTERS ONLY (--chapters with no field flag): nothing was generated and no report was written.\n${bar}\n`);
    process.exit(0);
  }

  // ---- STAGE 3: the fields ----------------------------------------------------------------
  const result = await MetadataGeneratorService.generate({
    ...baseParams,
    preComputedChapters,
    showPrompt: false,
  });

  console.error(`\n${bar}`);
  if (!result.success) {
    console.error(`RUN FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.error(result.error);
    process.exit(1);
  }
  const allWarnings = [...chapterWarnings, ...(result.warnings || [])];
  console.error(`RUN OK in ${(result.processing_time || 0).toFixed(1)}s   job ${result.job_id}`);
  console.error(`  report json: ${result.json_file}`);
  for (const f of result.txt_files || []) console.error(`  report txt:  ${f}`);
  if (allWarnings.length) {
    console.error(`\n  DECLARED WARNINGS (${allWarnings.length}):`);
    for (const w of allWarnings) console.error(`    ! ${w}`);
  } else {
    console.error('\n  DECLARED WARNINGS: none');
  }
  console.error(`${bar}\n`);

  // The report text the app writes, echoed to stdout and optionally to --out. This is the
  // OutputHandlerService's own file, read back — not a second rendering of the fields.
  const written = (result.txt_files || []).filter((f) => fs.existsSync(f));
  const newest = written.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const body = newest ? fs.readFileSync(newest, 'utf8') : '';
  const footer = [
    '',
    '================================================================================',
    'DECLARED WARNINGS (from the run, not the report file)',
    '================================================================================',
    ...(allWarnings.length ? allWarnings.map((w) => `- ${w}`) : ['(none)']),
    '',
    `job id:        ${result.job_id}`,
    `report json:   ${result.json_file}`,
    `prompt assets: ${args.assets}`,
    `fields:        ${filter ? filter.selected.join(', ') + ' (filtered channel copy)' : 'every field the channel publishes'}`,
    `channel:       ${channel}`,
    `transcript:    ${transcriptSource.replace(/\n\s+/g, ' ')}`,
    `chapters:      ${chapterSource}`,
    `insights:      ${insightsBlock ? `${insightsBlock.length} chars — ${insightsSource}` : insightsSource}`,
    `elapsed:       ${(result.processing_time || 0).toFixed(1)}s`,
    '',
  ].join('\n');

  console.log(body);
  console.log(footer);
  if (args.out) {
    fs.writeFileSync(args.out, `${body}\n${footer}`, 'utf8');
    console.error(`  written: ${args.out}\n`);
  }

  // The compiled services keep handles open (queue-manager timers); force a clean exit.
  process.exit(0);
}

/** The transcript cache's own timestamp, used to tie a chapter cache to the transcript it read. */
function transcriptStamp(transcriptCacheFile) {
  if (!fs.existsSync(transcriptCacheFile)) return null;
  return JSON.parse(fs.readFileSync(transcriptCacheFile, 'utf8')).cachedAt;
}

/** What the operator needs to know about the granularity of the fields they selected. */
function granularityNotes(selected) {
  const notes = [];
  if (selected.includes('description')) {
    notes.push('description is ONE unit making two calls (hook, then body); they cannot be run apart');
  }
  if (selected.includes('tags')) {
    notes.push('tags on a chaptered item are assembled in CODE from the pools — no model, no prompt');
  }
  if (selected.includes('hashtags')) {
    notes.push('hashtags are derived in CODE from the tags and titles');
  }
  if (selected.includes('thumbnail_text') && !selected.includes('titles')) {
    notes.push(
      'thumbnail_text normally reads the titles as input data; without --titles it runs with ' +
        'neither that input block nor the cross-field self-check line that compares them'
    );
  }
  if (selected.includes('hashtags') && !selected.includes('titles')) {
    notes.push('hashtags dedupe against the titles; without --titles there are none to dedupe against');
  }
  return notes;
}

main().catch((e) => { console.error(e); process.exit(1); });
