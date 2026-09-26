#!/usr/bin/env node
/**
 * check:legacy-gone: the grep test of P10 (CRUCIBLE-MIGRATION-PLAN.md 15). Ollama, whisper.cpp,
 * voice-separator-env and the openai / @anthropic-ai/sdk packages left the app; nothing may
 * reach for them again, and a clean install must download none of them.
 *
 * Scanned: electron/, frontend/src/, scripts/, tools/, editor-backend/, shared/, package.json,
 * setup.sh (node_modules and tools/fixtures, which is recorded data, are not). The patterns
 * are code-shaped (an import, a quoted id, a call, an identifier), so a comment that records
 * the history in words does not trip them.
 *
 * The retired-component cleanup is the one place that must name the retired files, to delete
 * them: electron/retired-components.ts and its check and dry-run tool are exempt from the
 * whisper.cpp / separator patterns, and from nothing else (so is P7's own guard in
 * tools/test-crucible-denoise.js, whose regex spells the separator's identifiers). Crucible's
 * own ASR ids (`whisper-large-v3-turbo`, `whisper-tiny` in the fake's lineup) are Crucible's
 * models, not the app's whisper.cpp, and are not matched.
 *
 * KNOWN EXCEPTIONS, removed by the parent after P4 merges: two files owned by the P4 worktree
 * (metadata-generator.service.ts, chapter-whole-transcript.service.ts) still import the
 * pipeline transcriber by its old name, through the temporary alias whisper.service.ts. P10 was
 * not allowed to edit them. docs/crucible/P10.md lists the exact edits; once they are applied,
 * delete whisper.service.ts and empty KNOWN_EXCEPTIONS below.
 *
 *   node tools/check-legacy-runtime-gone.js
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

const ROOTS = ['electron', path.join('frontend', 'src'), 'scripts', 'tools', 'editor-backend', 'shared'];
const FILES = ['package.json', 'setup.sh'];
const SKIP_DIRS = new Set(['node_modules', 'fixtures', '__pycache__', 'dist', 'utilities']);
const EXTENSIONS = /\.(ts|js|mjs|cjs|py|html|json|sh|toml|yml|yaml)$/;
const SELF = path.join('tools', 'check-legacy-runtime-gone.js');

/** The cleanup names the retired files in order to delete them; P7's guard names the separator's identifiers in order to forbid them. */
const CLEANUP_FILES = new Set([
  path.join('electron', 'retired-components.ts'),
  path.join('tools', 'retired-components-checks.js'),
  path.join('tools', 'retire-dry-run.js'),
  path.join('tools', 'test-crucible-denoise.js'),
]);

/**
 * Removed by the parent after P4 merges (docs/crucible/P10.md, "for the parent"). Each entry is
 * a file and the rule it is excused from, and nothing else.
 */
const KNOWN_EXCEPTIONS = [
  { file: path.join('electron', 'services', 'metadata', 'metadata-generator.service.ts'), rule: 'the old transcriber name' },
  { file: path.join('electron', 'services', 'metadata', 'chapter-whole-transcript.service.ts'), rule: 'the old transcriber name' },
  { file: path.join('electron', 'services', 'metadata', 'whisper.service.ts'), rule: 'the old transcriber name' },
];

const RULES = [
  // Ollama
  { rule: 'imports ollama-service', re: /(?:from\s+|require\(\s*)['"][^'"]*ollama-service['"]/ },
  { rule: 'imports ollama-json', re: /(?:from\s+|require\(\s*)['"][^'"]*ollama-json['"]/ },
  { rule: 'imports the ollama package', re: /(?:from\s+|require\(\s*)['"]ollama['"]/ },
  { rule: 'names Ollama\'s port 11434', re: /(?<![\d.])11434(?![\d])/ },
  { rule: 'names Ollama\'s api/generate', re: /api\/generate/ },
  { rule: 'calls an Ollama transport', re: /\b(?:askOllamaPlain|makeOllamaRequest|probeOllamaInventory)\s*\(|\bollamaClient\b/ },
  { rule: 'registers or invokes an Ollama IPC channel', re: /['"](?:check-ollama|get-available-models|ollama:list-models)['"]/ },
  { rule: 'tells someone to run Ollama', re: /\bollama\s+(?:pull|serve|run|list)\b/ },
  // whisper.cpp
  { rule: 'imports whisper-bridge', re: /(?:from\s+|require\(\s*)['"][^'"]*whisper-bridge['"]/ },
  { rule: 'names a whisper.cpp binding', re: /\b(?:WhisperBridge|getWhisperCliPath|getWhisperModelPath|getWhisperLibraryPath|setSelectedWhisperModel|getSelectedWhisperModel|whisperModelsDir|parse_whisper_json)\b/, cleanupMayName: true },
  { rule: 'names a whisper.cpp component or binary', re: /['"](?:whisper-engine|whisper-cli[\w.-]*)['"]|ggml-[\w.-]+\.bin/, cleanupMayName: true },
  { rule: 'passes a whisper.cpp flag', re: /--whisper-(?:bin|model)\b/ },
  { rule: 'runs the whisper.cpp download', re: /download-whisper-cpp|download-all\.sh/ },
  // voice-separator-env
  { rule: 'names voice-separator-env', re: /['"]voice-separator-env['"]|autocut-separator-env|getVoiceSeparatorEnvDir|voiceSeparatorEnv|\bseparate_chunk\b|run_audio_separator/, cleanupMayName: true },
  // SDKs
  { rule: 'imports the openai package', re: /(?:from\s+|require\(\s*|import\(\s*)['"]openai(?:\/[^'"]*)?['"]/ },
  { rule: 'imports @anthropic-ai/sdk', re: /(?:from\s+|require\(\s*|import\(\s*)['"]@anthropic-ai\/sdk(?:\/[^'"]*)?['"]/ },
  // The old transcriber name (a known exception until P4 merges)
  { rule: 'the old transcriber name', re: /\bWhisperService\b|['"][^'"]*\/whisper\.service(?:\.js)?['"]/ },
];

const violations = [];
const excused = [];

function scan(rel) {
  if (rel === SELF) return;
  const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const lines = text.split('\n');
  for (const r of RULES) {
    if (r.cleanupMayName && CLEANUP_FILES.has(rel)) continue;
    lines.forEach((line, i) => {
      if (!r.re.test(line)) return;
      const hit = { file: rel, line: i + 1, rule: r.rule, text: line.trim().slice(0, 160) };
      if (KNOWN_EXCEPTIONS.some((e) => e.file === rel && e.rule === r.rule)) excused.push(hit);
      else violations.push(hit);
    });
  }
}

function walk(relDir) {
  const abs = path.join(REPO, relDir);
  if (!fs.existsSync(abs)) return;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(relDir, e.name));
    } else if (e.isFile() && EXTENSIONS.test(e.name)) {
      scan(path.join(relDir, e.name));
    }
  }
}

for (const root of ROOTS) walk(root);
for (const f of FILES) scan(f);

// package.json: the packages, the keyword, and the bundled whisper-cli are gone.
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
for (const name of ['openai', '@anthropic-ai/sdk', 'ollama']) {
  if (deps[name] !== undefined) violations.push({ file: 'package.json', line: 0, rule: `depends on ${name}`, text: `${name}: ${deps[name]}` });
}
if ((pkg.keywords || []).includes('ollama')) violations.push({ file: 'package.json', line: 0, rule: 'the ollama keyword', text: 'keywords' });
for (const res of pkg.build?.extraResources || []) {
  if (/utilities/.test(res.from || '')) violations.push({ file: 'package.json', line: 0, rule: 'ships editor-backend/utilities (whisper-cli)', text: res.from });
}
const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
for (const name of ['openai', '@anthropic-ai/sdk']) {
  if (lock.packages?.['']?.dependencies?.[name] !== undefined || lock.packages?.[`node_modules/${name}`] !== undefined) {
    violations.push({ file: 'package-lock.json', line: 0, rule: `locks ${name}`, text: name });
  }
}

// A clean install downloads none of them: the two download catalogs, as built.
const dist = (p) => path.join(REPO, 'dist', 'main', p);
if (!fs.existsSync(dist(path.join('components', 'catalog.js')))) {
  console.error('dist/main is missing: run npm run build:electron first (the catalog check reads the built catalogs)');
  process.exit(1);
}
const retiredId = /whisper|ollama|separator/i;
const appCatalog = require(dist(path.join('components', 'catalog.js'))).getCatalog();
const editorCatalog = require(dist(path.join('services', 'editor', 'asset-catalog.js'))).getCatalog();
for (const [where, list] of [['electron/components/catalog.ts', appCatalog], ['electron/services/editor/asset-catalog.ts', editorCatalog]]) {
  for (const c of list) {
    const urls = (c.artifacts || []).map((a) => a.url).join(' ');
    if (retiredId.test(c.id) || /whisper|ggml|separator|ollama/i.test(urls)) {
      violations.push({ file: where, line: 0, rule: 'a download catalog offers a retired component', text: `${c.id} ${urls.slice(0, 100)}` });
    }
  }
}

console.log('check:legacy-gone (P10: Ollama, whisper.cpp, voice-separator-env, openai, @anthropic-ai/sdk)');
console.log(`app catalog: ${appCatalog.map((c) => c.id).join(', ')} | editor catalog: ${editorCatalog.map((c) => c.id).join(', ')}`);
for (const x of excused) console.log(`KNOWN EXCEPTION (removed by the parent after P4 merges)  ${x.file}:${x.line}  [${x.rule}]  ${x.text}`);
if (violations.length > 0) {
  for (const v of violations) console.log(`FAIL  ${v.file}${v.line ? `:${v.line}` : ''}  [${v.rule}]  ${v.text}`);
  console.log(`check:legacy-gone: ${violations.length} FAILED`);
  process.exit(1);
}
console.log(`check:legacy-gone: ALL PASS (${RULES.length} patterns over ${ROOTS.length} trees and ${FILES.length} files; package.json, package-lock.json and both download catalogs clean; ${excused.length} known exception line(s))`);
