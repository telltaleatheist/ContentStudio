/**
 * Offline checks for Mute words (LEDGER #226) — `npm run check:mutes` (after build:electron).
 *
 * WHAT IT PROVES, on synthetic data only (no media, no model, nothing of Owen's):
 *   the Python pass (tools/word-mute-driver.py, run on the editor's own Python) —
 *     the word matcher and the um/uh seam; the rule (group modes, the opening window, "all
 *     swearing"); padding, clamp, merge and the 720000 number format; time mapping through the
 *     cut table (a word spanning an auto-editor cut muted on both sides, a word auto-editor
 *     removed reported and not muted, an editor cut through a word, a word cut entirely); the
 *     window measured on the EXPORTED timeline; the <mute> placement on a ref-clip in DTD order
 *     and a rebuild of Owen's sample byte-for-structure; export and Apply end to end, Apply
 *     repeatable, loud refusals.
 *   the main process (compiled mute-words.js) — the same settings accepted and refused as
 *     Python's validator (Law 10); save / load / remembered default / ensure on a temp folder;
 *     a broken saved file is refused, never replaced.
 *   the renderer's summary line (model/mute-words.ts, transpiled here).
 *
 * No test framework, on purpose: one line per check, like the other check scripts.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`ok   ${name}`); } else { failed++; console.log(`FAIL ${name}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); }
}

function editorPython() {
  if (process.env.CS_EDITOR_PYTHON) return process.env.CS_EDITOR_PYTHON;
  const managed = path.join(os.homedir(), 'Library', 'Application Support', 'OwenMorgan', 'runtime', 'autocutstudio-env', 'bin', 'python3');
  if (fs.existsSync(managed)) return managed;
  throw new Error(`No editor Python to run the Mute words checks with: set CS_EDITOR_PYTHON (the managed env was not at ${managed})`);
}

const DRIVER = path.join(__dirname, 'word-mute-driver.py');

// ── 1. the Python pass ───────────────────────────────────────────────────────
{
  const r = spawnSync(editorPython(), [DRIVER], { encoding: 'utf8' });
  const lines = (r.stdout || '').trim().split('\n');
  let summary = null;
  for (const line of lines) {
    if (line.startsWith('ok   ')) { passed++; console.log(line); } else if (line.startsWith('FAIL ')) { failed++; console.log(line); } else if (line.startsWith('{')) summary = JSON.parse(line);
  }
  if (!summary || r.status !== 0) {
    failed++;
    console.log(`FAIL python driver exited ${r.status}${r.stderr ? `: ${r.stderr.split('\n').filter((l) => !l.startsWith('[')).slice(-15).join('\n')}` : ''}`);
  }
}

// ── 2. the main process module ───────────────────────────────────────────────
const mw = require(path.join(ROOT, 'dist', 'main', 'services', 'editor', 'mute-words.js'));
const CATALOG_PATH = path.join(ROOT, 'editor-backend', 'core', 'mute_words.json');
const catalog = mw.readMuteCatalog(CATALOG_PATH);
check('main: reads the one word list the Python pass matches with (same groups, same words)',
  JSON.stringify(catalog.groups) === JSON.stringify(JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')).muteGroups.map((g) => ({ id: g.id, label: g.label, contains: g.contains || [], exact: g.exact || [] })))
  && catalog.padMs === 50 && catalog.defaultMinutes === 3);

const blank = mw.blankMuteSettings(catalog);
const variant = (f) => { const s = JSON.parse(JSON.stringify(blank)); f(s); return s; };
const samples = [
  blank,
  variant((s) => { s.groups.harsh = 'everywhere'; s.openingWindow = { allSwearing: true, minutes: 2.5 }; }),
  variant((s) => { s.customWords = ['bs*', '*hole', 'frick']; s.customMode = 'opening'; }),
  variant((s) => { s.schemaVersion = 2; }),
  variant((s) => { delete s.groups.harsh; }),
  variant((s) => { s.groups.extra = 'off'; }),
  variant((s) => { s.groups.harsh = 'sometimes'; }),
  variant((s) => { s.customWords = ['***']; }),
  variant((s) => { s.customWords = 'fuck'; }),
  variant((s) => { s.customMode = 'on'; }),
  variant((s) => { s.openingWindow.minutes = 0; }),
  variant((s) => { s.openingWindow.minutes = 601; }),
  variant((s) => { s.openingWindow.minutes = '3'; }),
  variant((s) => { s.openingWindow.allSwearing = 'yes'; }),
  null,
];
{
  const r = spawnSync(editorPython(), [DRIVER, 'validate'], { input: JSON.stringify(samples), encoding: 'utf8' });
  const py = JSON.parse(r.stdout.trim());
  const ts = samples.map((s) => { try { mw.validateMuteSettings(s, catalog); return null; } catch (e) { return e.message; } });
  const disagree = samples.map((_s, i) => i).filter((i) => (py[i] === null) !== (ts[i] === null));
  check('main and Python accept and refuse the same settings (15 cases, 3 good, 12 bad)',
    disagree.length === 0 && ts.filter((x) => x === null).length === 3, { disagree, py, ts });
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-main-'));
  const conf = path.join(dir, 'config');
  const projA = path.join(dir, 'A');
  const projB = path.join(dir, 'B');
  fs.mkdirSync(projA);
  fs.mkdirSync(projB);
  try {
    const first = mw.loadProjectMuteSettings(catalog, projA, 'a', conf);
    check('main: a project with nothing saved anywhere starts blank and says it is not saved',
      first.saved === false && first.source === 'blank' && Object.values(first.settings.groups).every((m) => m === 'off'));
    const chosen = variant((s) => { s.groups.harsh = 'everywhere'; s.customWords = [' heck ', 'darn']; s.customMode = 'everywhere'; });
    mw.saveProjectMuteSettings(catalog, projA, 'a', conf, chosen);
    const again = mw.loadProjectMuteSettings(catalog, projA, 'a', conf);
    check('main: save writes <cleanName>_mute-words.json in the project folder and reads back (words trimmed)',
      again.saved && fs.existsSync(path.join(projA, 'a_mute-words.json')) && again.settings.groups.harsh === 'everywhere'
      && JSON.stringify(again.settings.customWords) === '["heck","darn"]');
    const other = mw.loadProjectMuteSettings(catalog, projB, 'b', conf);
    check('main: a new project starts from the remembered choice, marked not saved yet',
      other.saved === false && other.source === 'remembered' && other.settings.groups.harsh === 'everywhere');
    const ens = mw.ensureProjectMuteSettings(catalog, projB, 'b', conf);
    const ens2 = mw.ensureProjectMuteSettings(catalog, projB, 'b', conf);
    check('main: starting a run keeps the remembered choice for the project, once, never overwriting',
      ens.wrote === true && ens2.wrote === false && fs.existsSync(path.join(projB, 'b_mute-words.json')));
    fs.writeFileSync(path.join(projA, 'a_mute-words.json'), '{"schemaVersion": 1, "groups": {}}');
    let threw = null;
    try { mw.loadProjectMuteSettings(catalog, projA, 'a', conf); } catch (e) { threw = e.message; }
    check('main: a broken saved choice is refused by name, not replaced by the default',
      threw && threw.includes('a_mute-words.json') && fs.readFileSync(path.join(projA, 'a_mute-words.json'), 'utf8').includes('"groups": {}'), threw);
    let bad = null;
    try { mw.projectMuteSettingsPath(projA, '../evil'); } catch (e) { bad = e.message; }
    check('main: a session name with a path separator is refused', !!bad);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 3. the renderer's summary line ───────────────────────────────────────────
{
  const ts = require(path.join(ROOT, 'node_modules', 'typescript'));
  const src = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'app', 'components', 'editor', 'model', 'mute-words.ts'), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', js)(mod, mod.exports);
  const { muteSummary, parseCustomWords, windowClock } = mod.exports;
  const s1 = variant((s) => { s.groups.harsh = 'everywhere'; s.openingWindow = { allSwearing: true, minutes: 3 }; });
  const s2 = variant((s) => { s.groups['swearing'] = 'opening'; s.customWords = ['heck']; s.customMode = 'everywhere'; s.openingWindow.minutes = 2.5; });
  check('summary: "Harsh words everywhere; all swearing in the first 3:00"',
    muteSummary(s1, catalog) === 'Harsh words everywhere; all swearing in the first 3:00', muteSummary(s1, catalog));
  check('summary: group modes and your words read plainly; nothing on reads "Nothing muted"',
    muteSummary(s2, catalog) === 'your words everywhere; General swearing in the first 2:30' && muteSummary(blank, catalog) === 'Nothing muted',
    [muteSummary(s2, catalog), muteSummary(blank, catalog)]);
  check('summary: custom words split on commas and new lines; minutes shown as m:ss',
    JSON.stringify(parseCustomWords('a, b\n c,,')) === '["a","b","c"]' && windowClock(0.5) === '0:30');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
