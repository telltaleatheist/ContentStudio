#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Prompt Harness — run the REAL metadata pipeline against a local model.
 *
 * WHY: iterating on prompt wording by running the whole Electron app against a paid cloud
 * model is slow and costs money. This drives the REAL compiled services — AIManagerService,
 * planMetadataUnits, runMetadataTasks — so the assembled prompts are byte-identical to
 * production, but the round trip is free.
 *
 * WHAT CHANGED, AND WHY THE OLD FLAGS ARE GONE. This used to call `generateMetadata()`, which
 * was the LEGACY single whole-metadata call, and its "variants" were whole per-channel YAML
 * prompt sets dropped in prompt-harness/variants/. Neither exists any more: every field is
 * written by a routed UNIT, and a channel is a small data file inside a shared prompt tree
 * (electron/assets/prompts/). So the harness now takes an ASSETS ROOT and a CHANNEL, plans the
 * same units a real run plans, and prints the same prompts a real run sends.
 *
 * A/B'ING A PROMPT CHANGE is therefore a directory copy rather than a file copy:
 *
 *   cp -R electron/assets/prompts /tmp/prompts-idea && $EDITOR /tmp/prompts-idea/...
 *   node prompt-harness/run.js --assets electron/assets/prompts --out before.json
 *   node prompt-harness/run.js --assets /tmp/prompts-idea    --out after.json
 *
 * NO CHAPTERS, deliberately: the fixture is a raw transcript with no timings, so this
 * exercises the TEXT-SUBJECT path — the one that used to fall through to the legacy call and
 * now plans routed units like everything else.
 *
 * PREREQ:
 *   npm run build:electron        # once, and after any change under electron/
 *   ollama pull qwen3.8:27b       # or pass --units none to only print prompts
 */

const path = require('path');
const fs = require('fs');
const Module = require('module');

const HARNESS_DIR = __dirname;
const REPO_ROOT = path.join(HARNESS_DIR, '..');
const DIST = path.join(REPO_ROOT, 'dist', 'main');

// The compiled main process imports electron and electron-log, neither of which exists
// outside an Electron runtime. Same stub the pure-check tool uses.
const STUB = path.join(REPO_ROOT, 'tools', '_electron-stub.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron' || request === 'electron-log') return require.resolve(STUB);
  return originalResolve.call(this, request, ...rest);
};

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

/**
 * Prefer the local working copy (<base>.txt — gitignored, may hold real or private material),
 * else the committed <base>.example.txt so the harness runs out of the box on a fresh clone.
 */
function defaultFixture(dir, base) {
  const working = path.join(dir, `${base}.txt`);
  return fs.existsSync(working) ? working : path.join(dir, `${base}.example.txt`);
}

function printHelp() {
  console.log(`
Prompt Harness — run the real metadata pipeline against a local model.

  node prompt-harness/run.js [options]

Options:
  --assets <dir>      Prompt assets root (default: electron/assets/prompts)
  --channel <id>      Channel id from channels/*.yml (default: youtube-telltale)
  --runs <n>          Runs, to see consistency (default: 1)
  --units <spec>      Which planned units to actually RUN:
                        all      every unit (default)
                        none     print the prompts and send nothing
                        <fields> comma-separated field ids, e.g. titles,thumbnail_text
                                 (a field whose input another field writes still needs that
                                  one in the list — thumbnail_text reads the titles)
  --source <filename> Source filename context fed to the prompt
  --transcript <path> Override the transcript fixture
  --insights <path>   Override the insights fixture
  --no-insights       Run without the CHANNEL PERFORMANCE DATA block
  --out <path>        Write prompts + results as JSON here (also always saved to out/)
  --prompts <path>    Write the assembled prompts as plain text here
  --help, -h          This help
`);
}

function parseArgs(argv) {
  const args = {
    assets: path.join(REPO_ROOT, 'electron', 'assets', 'prompts'),
    channel: 'youtube-telltale',
    runs: 1,
    units: 'all',
    source: 'marcus-wray-prosperity-sermon.mp4',
    transcript: null,
    insights: null,
    noInsights: false,
    out: null,
    prompts: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a === '--assets') args.assets = path.resolve(argv[++i]);
    else if (a === '--channel') args.channel = argv[++i];
    else if (a === '--runs') args.runs = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === '--units') args.units = argv[++i];
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--transcript') args.transcript = path.resolve(argv[++i]);
    else if (a === '--insights') args.insights = path.resolve(argv[++i]);
    else if (a === '--no-insights') args.noInsights = true;
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--prompts') args.prompts = path.resolve(argv[++i]);
    else fail(`Unknown option: ${a}  (--help for usage)`);
  }
  return args;
}

async function main() {
  if (!fs.existsSync(DIST)) {
    fail(`Compiled main process not found at ${DIST}\n  Build it first:  npm run build:electron`);
  }
  const args = parseArgs(process.argv.slice(2));

  const { AIManagerService } = require(path.join(DIST, 'services/metadata/ai-manager.service.js'));
  const tasks = require(path.join(DIST, 'services/metadata/metadata-tasks.js'));
  const routing = require(path.join(DIST, 'services/metadata/metadata-routing.js'));
  const entities = require(path.join(DIST, 'services/metadata/entity-extraction.js'));

  if (!fs.existsSync(args.assets)) fail(`Prompt assets not found: ${args.assets}`);

  const fixturesDir = path.join(HARNESS_DIR, 'fixtures');
  const transcriptPath = args.transcript || defaultFixture(fixturesDir, 'transcript');
  if (!fs.existsSync(transcriptPath)) fail(`Transcript fixture not found: ${transcriptPath}`);
  const transcript = fs.readFileSync(transcriptPath, 'utf-8').trim();

  const insightsPath = args.insights || defaultFixture(fixturesDir, 'insights');
  let insightsBlock = '';
  if (!args.noInsights) {
    if (!fs.existsSync(insightsPath)) fail(`Insights fixture not found: ${insightsPath}  (--no-insights to skip)`);
    insightsBlock = fs.readFileSync(insightsPath, 'utf-8').trim();
  }

  /**
   * `promptSetsDir` is the PARENT of the assets root, because AIManagerService looks for
   * `<promptSetsDir>/prompts` — exactly as it does against userData in the app.
   */
  const mgr = new AIManagerService({
    provider: 'ollama',
    summarizationModel: routing.SUMMARIZATION_MODEL,
    promptSet: args.channel,
    promptSetsDir: path.dirname(args.assets),
    insightsBlock: insightsBlock || undefined,
  });
  const ok = await mgr.initialize();
  if (!ok) fail(`AIManagerService init failed: ${mgr.lastInitError}`);

  // The text-subject path: no chapters, so the transcript IS the subject every call reads.
  //
  // `alsoLoads` is empty and that is TRUE HERE rather than a convenience: the harness runs no
  // chapter pipeline, and it hands the transcript over whole rather than summarizing it, so the
  // only local models this process loads are the ones the units name.
  const plan = tasks.planMetadataUnits({
    routing: routing.resolveMetadataRouting(undefined),
    defaultHost: 'http://localhost:11434',
    aiManager: mgr,
    hasInsights: Boolean(insightsBlock),
    hasChapters: false,
    alsoLoads: [],
  });

  const warnings = [];
  const ctx = {
    content: transcript,
    sourceLabel: args.source,
    chapterSubjects: [],
    chapterDetails: [],
    videoTitle: args.source,
    promptSetName: args.channel,
    entities: entities.topEntities(transcript, 12),
    keyPhrases: entities.candidateKeyPhrases(transcript).slice(0, 40),
    contentText: transcript,
    // Filled as each call returns, and read by the calls that take an earlier field as input
    // data. Reset per run below, so run 2 never reads run 1's titles.
    generated: {},
    warn: (m) => { warnings.push(m); console.error(`  ! ${m}`); },
  };

  console.error(`\nPrompt Harness`);
  console.error(`  assets:     ${path.relative(REPO_ROOT, args.assets)}`);
  console.error(`  channel:    ${args.channel}`);
  console.error(`  transcript: ${path.relative(REPO_ROOT, transcriptPath)} (${transcript.length} chars)`);
  console.error(`  insights:   ${args.noInsights ? '(disabled)' : path.relative(REPO_ROOT, insightsPath)}`);
  console.error(`  plan:       ${plan.summary}`);
  console.error(`  models:     ${plan.roster.summary}${plan.roster.overBudget ? '  ** OVER BUDGET **' : ''}`);
  for (const w of plan.warnings) console.error(`  ! ${w}`);
  console.error(`  running:    ${args.units}\n`);

  const prompts = tasks.buildTaskPromptsForDisplay({ plan, ctx });
  const promptText = prompts.join('\n\n\n');
  if (args.prompts) {
    fs.writeFileSync(args.prompts, promptText, 'utf8');
    console.error(`  prompts written: ${args.prompts} (${promptText.length} chars)`);
  }

  const wanted = plan.units.filter((u) => {
    if (args.units === 'none') return false;
    if (args.units === 'all') return true;
    const asked = args.units.split(',').map((f) => f.trim()).filter(Boolean);
    return u.fields.some((f) => asked.includes(f));
  });

  const runs = [];
  for (let r = 1; r <= args.runs && wanted.length > 0; r++) {
    console.error(`  → run ${r}/${args.runs}`);
    const t0 = Date.now();
    const merged = {};
    // One call per field means the interesting number is PER CALL, not per run: which field
    // cost what, and whether a second call on the same model started fast (model resident) or
    // slow (model reloaded). Recorded here rather than inferred from the total.
    const calls = [];
    let error = null;
    try {
      for (const unit of wanted) {
        const c0 = Date.now();
        const fields = await unit.generate(ctx);
        const csecs = Number(((Date.now() - c0) / 1000).toFixed(1));
        // Exactly what runMetadataTasks does, and in the same order: a later call that takes
        // this field as input data reads it from here.
        Object.assign(ctx.generated, fields);
        Object.assign(merged, fields);
        calls.push({ unit: unit.label, fields: unit.fields, secs: csecs });
        console.error(`      ${unit.label}  ${csecs}s`);
      }
      // The grounding check, run exactly as production runs it, so the harness reports the
      // same declared warnings the app would.
      const grounding = tasks.titleGroundingText(ctx);
      const ungrounded = tasks.ungroundedTitles(merged.titles, grounding);
      if (ungrounded.length > 0) merged._ungrounded = ungrounded;
    } catch (e) {
      error = e.message;
    }
    const secs = Number(((Date.now() - t0) / 1000).toFixed(1));
    console.error(error ? `    FAILED (${secs}s): ${error}` : `    run ${r} ok (${secs}s total, ${(merged.titles || []).length} titles)`);
    runs.push({ run: r, secs, calls, error, fields: merged });
    // Nothing carries between runs: run 2 must write its own titles before the thumbnail call
    // reads any, exactly as a second item in a real job would.
    ctx.generated = {};
  }
  for (const unit of plan.units) {
    if (typeof unit.unload === 'function') await unit.unload();
  }

  const bar = '='.repeat(74);
  console.log(`\n${bar}`);
  console.log(`TITLES — ${args.channel} via ${path.relative(REPO_ROOT, args.assets)}`);
  console.log(bar);
  for (const run of runs) {
    console.log(`\n--- run ${run.run} (${run.secs}s)`);
    if (run.error) { console.log(`  ✖ ${run.error}`); continue; }
    (run.fields.titles || []).forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. ${t}  [${t.length}]`));
    if (run.fields.thumbnail_text) console.log(`  thumbnail: ${run.fields.thumbnail_text.slice(0, 6).join('  ·  ')}`);
    if (run.fields._ungrounded) {
      console.log(`  ungrounded: ${run.fields._ungrounded.map((u) => u.invented.join(', ')).join(' | ')}`);
    }
  }

  const payload = {
    args: { ...args },
    plan: plan.summary,
    roster: plan.roster,
    planWarnings: plan.warnings,
    prompts,
    runs,
    warnings,
  };
  const outDir = path.join(HARNESS_DIR, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(outDir, `run-${stamp}.json`), JSON.stringify(payload, null, 2));
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(payload, null, 2));
  console.log(`\nFull output saved: ${path.relative(process.cwd(), path.join(outDir, `run-${stamp}.json`))}\n`);

  // The compiled services keep handles open (queue manager timers); force a clean exit.
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
