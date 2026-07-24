#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Prompt Harness — battery-test metadata prompt variants against a local model.
 *
 * WHY: iterating on prompt wording by running the full Electron app + a cloud
 * model is slow and costs money. This drives the REAL compiled AIManagerService
 * against a local Ollama model (default cogito:32b) so the assembled prompt is
 * byte-identical to production, but the round-trip is free and fast. Cogito is
 * NOT the final model — it's a cheap stand-in for rapid A/B on prompt wording.
 * Once a variant's wording wins here, port it into electron/assets/*.yml and the
 * live userData prompt_sets, then confirm on the real cloud model.
 *
 * It calls generateMetadata() directly with the transcript as-is (no summarizer),
 * which mirrors the short-video production path exactly. Long transcripts get
 * summarized first in the real app; keep harness transcripts short so you're
 * testing the titling prompt, not the summarizer.
 *
 * PREREQ: build the electron TS once (and after any electron/ change):
 *   npm run build:electron
 * Ollama must be running with the model pulled (e.g. `ollama pull cogito:32b`).
 *
 * USAGE:
 *   node prompt-harness/run.js                      # all variants, cogito:32b, 1 run each
 *   node prompt-harness/run.js --runs 3             # 3 runs per variant (see consistency)
 *   node prompt-harness/run.js --variant baseline   # just one variant
 *   node prompt-harness/run.js --model ollama:cogito:14b   # faster/smaller while iterating
 *   node prompt-harness/run.js --no-insights        # test without the analytics block
 *   node prompt-harness/run.js --transcript path.txt --insights path.txt
 */

const path = require('path');
const fs = require('fs');

const HARNESS_DIR = __dirname;
const REPO_ROOT = path.join(HARNESS_DIR, '..');
const AI_MANAGER_PATH = path.join(REPO_ROOT, 'dist', 'main', 'services', 'metadata', 'ai-manager.service.js');

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

// Resolve a fixture: prefer the local working copy (<base>.txt — gitignored, may
// hold real/private transcripts or analytics), else the committed <base>.example.txt
// template so the harness runs out of the box on a fresh clone.
function defaultFixture(dir, base) {
  const working = path.join(dir, `${base}.txt`);
  return fs.existsSync(working) ? working : path.join(dir, `${base}.example.txt`);
}

function printHelp() {
  console.log(`
Prompt Harness — battery-test metadata prompt variants against a local model.

  node prompt-harness/run.js [options]

Options:
  --model <provider:model>  AI model (default: ollama:cogito:32b)
  --runs <n>                Runs per variant, to see consistency (default: 1)
  --variant <name>          Only run this variant (basename, no .yml)
  --source <filename>       Source filename context fed to the prompt
                            (default: marcus-wray-prosperity-sermon.mp4)
  --transcript <path>       Override the transcript fixture
  --insights <path>         Override the insights fixture
  --no-insights             Run without the CHANNEL PERFORMANCE DATA block
  --help, -h                This help

Variants live in prompt-harness/variants/*.yml (same schema as a real prompt set).
Drop a new .yml in there to add a variant. Full output is saved to prompt-harness/out/.
`);
}

function parseArgs(argv) {
  const args = {
    model: 'ollama:cogito:32b',
    runs: 1,
    variant: null,
    source: 'marcus-wray-prosperity-sermon.mp4',
    transcript: null,
    insights: null,
    noInsights: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') args.model = argv[++i];
    else if (a === '--runs') args.runs = parseInt(argv[++i], 10);
    else if (a === '--variant') args.variant = argv[++i];
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--transcript') args.transcript = argv[++i];
    else if (a === '--insights') args.insights = argv[++i];
    else if (a === '--no-insights') args.noInsights = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else fail(`Unknown argument: ${a}  (try --help)`);
  }
  if (!args.model || !args.model.includes(':')) {
    fail(`--model must be provider-prefixed, e.g. ollama:cogito:32b (got "${args.model}")`);
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) fail(`--runs must be a positive integer`);
  return args;
}

function discoverVariants(variantsDir, only) {
  if (!fs.existsSync(variantsDir)) fail(`No variants directory: ${variantsDir}`);
  let files = fs.readdirSync(variantsDir).filter((f) => /\.ya?ml$/.test(f)).sort();
  if (only) {
    const want = only.replace(/\.ya?ml$/, '');
    files = files.filter((f) => f.replace(/\.ya?ml$/, '') === want);
    if (files.length === 0) fail(`Variant "${only}" not found in ${variantsDir}`);
  }
  if (files.length === 0) fail(`No .yml variants found in ${variantsDir}`);
  return files;
}

async function runVariant(AIManagerService, name, variantsDir, args, transcript, insightsBlock) {
  const mgr = new AIManagerService({
    provider: 'ollama',
    // Both models point at the test model. Summary model is unused for a short
    // transcript (generateMetadata is called directly), but must be a valid
    // ollama: model so provider detection initializes Ollama.
    summarizationModel: args.model,
    metadataModel: args.model,
    promptSet: name,
    promptSetsDir: variantsDir,
    insightsBlock: insightsBlock || undefined,
  });

  const ok = await mgr.initialize();
  if (!ok) {
    console.error(`  ✖ [${name}] init failed: ${mgr.lastInitError}`);
    return { variant: name, error: mgr.lastInitError, runs: [] };
  }

  const runs = [];
  for (let r = 1; r <= args.runs; r++) {
    process.stderr.write(`  → [${name}] run ${r}/${args.runs} ... `);
    const t0 = Date.now();
    try {
      const meta = await mgr.generateMetadata(transcript, args.source);
      const secs = Number(((Date.now() - t0) / 1000).toFixed(1));
      console.error(`ok (${secs}s, ${meta.titles ? meta.titles.length : 0} titles)`);
      runs.push({ ok: true, secs, meta });
    } catch (e) {
      const secs = Number(((Date.now() - t0) / 1000).toFixed(1));
      console.error(`FAILED (${secs}s): ${e.message}`);
      runs.push({ ok: false, secs, error: e.message });
    }
  }
  return { variant: name, runs };
}

function printReport(results, args) {
  const bar = '='.repeat(74);
  console.log(`\n${bar}`);
  console.log('RESULTS — read the titles: which variant stays faithful to who said what,');
  console.log('and reads the sarcasm as sarcasm rather than a sincere claim?');
  console.log(bar);
  for (const res of results) {
    console.log(`\n### ${res.variant}`);
    if (res.error) { console.log(`  (init error: ${res.error})`); continue; }
    res.runs.forEach((run, i) => {
      const tag = args.runs > 1 ? ` [run ${i + 1}]` : '';
      if (!run.ok) { console.log(`  ✖${tag} ${run.error}`); return; }
      const meta = run.meta;
      console.log(`  titles${tag} (${run.secs}s):`);
      (meta.titles || []).forEach((t, idx) => console.log(`    ${String(idx + 1).padStart(2)}. ${t}`));
      if (meta.thumbnail_text && meta.thumbnail_text.length) {
        console.log(`  thumbnail_text: ${meta.thumbnail_text.slice(0, 6).join('  ·  ')}`);
      }
    });
  }
  console.log(`\n${'-'.repeat(74)}`);
}

function saveReport(results, args, fixtures) {
  const outDir = path.join(HARNESS_DIR, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `run-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ args, fixtures, results }, null, 2));
  console.log(`Full output (all fields, all runs) saved: ${path.relative(process.cwd(), outPath)}\n`);
}

async function main() {
  if (!fs.existsSync(AI_MANAGER_PATH)) {
    fail(`Compiled service not found at ${AI_MANAGER_PATH}\n  Build it first:  npm run build:electron`);
  }
  const { AIManagerService } = require(AI_MANAGER_PATH);

  const args = parseArgs(process.argv.slice(2));
  const variantsDir = path.join(HARNESS_DIR, 'variants');
  const fixturesDir = path.join(HARNESS_DIR, 'fixtures');

  const transcriptPath = args.transcript || defaultFixture(fixturesDir, 'transcript');
  if (!fs.existsSync(transcriptPath)) fail(`Transcript fixture not found: ${transcriptPath}`);
  const transcript = fs.readFileSync(transcriptPath, 'utf-8').trim();

  const insightsPath = args.insights || defaultFixture(fixturesDir, 'insights');
  let insightsBlock = '';
  if (!args.noInsights) {
    if (!fs.existsSync(insightsPath)) fail(`Insights fixture not found: ${insightsPath}  (use --no-insights to skip)`);
    insightsBlock = fs.readFileSync(insightsPath, 'utf-8').trim();
  }

  const variantFiles = discoverVariants(variantsDir, args.variant);

  console.error(`\nPrompt Harness`);
  console.error(`  model:      ${args.model}`);
  console.error(`  transcript: ${path.relative(REPO_ROOT, transcriptPath)} (${transcript.length} chars)`);
  console.error(`  insights:   ${args.noInsights ? '(disabled)' : path.relative(REPO_ROOT, insightsPath)}`);
  console.error(`  variants:   ${variantFiles.map((f) => f.replace(/\.ya?ml$/, '')).join(', ')}`);
  console.error(`  runs each:  ${args.runs}\n`);

  const results = [];
  for (const file of variantFiles) {
    const name = file.replace(/\.ya?ml$/, '');
    // eslint-disable-next-line no-await-in-loop
    results.push(await runVariant(AIManagerService, name, variantsDir, args, transcript, insightsBlock));
  }

  printReport(results, args);
  saveReport(results, args, {
    transcript: path.relative(REPO_ROOT, transcriptPath),
    insights: args.noInsights ? null : path.relative(REPO_ROOT, insightsPath),
  });

  // AIManagerService (via electron-log / queue-manager) leaves handles open that
  // keep the event loop alive; force a clean exit.
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
