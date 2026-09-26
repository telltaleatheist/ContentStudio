/**
 * One-time retirement of what P10 removed: the app's own whisper.cpp binaries and models, and
 * the editor's voice-separator-env (CRUCIBLE-MIGRATION-PLAN.md 15 and 0a; Briefcase's
 * `backend/src/components/retired-components.ts` is the pattern).
 *
 * Builds before P10 installed them; this build runs none of them (transcription is Crucible's
 * `asr`, LEDGER #206; voice isolation is Crucible's `denoise`, #200). An upgraded machine still
 * has them on disk, several GB of them.
 *
 * WHAT IS REMOVED, AND HOW IT IS FOUND. Only paths the app's own installers wrote, at the fixed
 * places those installers wrote them. There are no globs:
 *
 *   1. ContentStudio's component manager (electron/components): `<userData>/components/<id>/`
 *      for the retired ids (`whisper-engine`, `whisper-<model>`), and their records in
 *      `<userData>/components/installed.json`.
 *   2. The editor's asset manager (electron/services/editor/asset-manager.ts), in each of the two
 *      stores it can have written: the OwenMorgan shared dir, and its per-app fallback under
 *      `<userData>/assets`. There: the whisper.cpp model files by their catalog filenames in
 *      `models/whisper/`, the `runtime/voice-separator-env/` dir (only when it looks like that
 *      conda env), and their records in the asset manager's own state file.
 *
 * NEVER: Ollama's model store, a Crucible directory, the shared dir's other slots (BookForge's
 * `llama-models` and `managed-bins`, the editor's own `runtime/autocutstudio-env`), or anything
 * outside the two roots. Every target is asserted to sit strictly inside its declared parent
 * and strictly inside one of the roots, when it is planned AND again immediately before it is
 * removed; a target that fails the assertion is never touched. A symlink is removed as a link
 * and never followed. A record that points anywhere else is left alone and logged.
 *
 * WHEN. main.ts runs it once, in the background after boot, never awaited by boot. It logs the
 * whole plan first (the dry run: every path and its size), then removes, then records completion
 * in the store under {@link RETIRED_STORE_KEY}[{@link RETIREMENT_ID}]. A run with any failure is
 * not recorded and is tried again at the next launch (every step is idempotent). The opt-out is
 * the store key {@link KEEP_RETIRED_STORE_KEY} set to `true`: the plan is still logged, nothing
 * is removed, nothing is recorded.
 *
 * PURE (no electron import): the dry-run tool (tools/retire-dry-run.js) and the check
 * (tools/retired-components-checks.js) call exactly what the app calls.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Bump to run a new retirement; the old id's record stays as history. */
export const RETIREMENT_ID = 'p10-crucible';

/** electron-store key holding `{ [retirementId]: { completedAt, bytesFreed, removed, droppedRecords } }`. */
export const RETIRED_STORE_KEY = 'retiredComponents';

/** electron-store key: `true` keeps the retired files on disk (the plan is still logged). */
export const KEEP_RETIRED_STORE_KEY = 'keepRetiredComponents';

/** ContentStudio component ids P10 retired (electron/components/catalog.ts before P10). */
export const RETIRED_COMPONENT_IDS: readonly string[] = [
  'whisper-engine',
  'whisper-tiny',
  'whisper-base',
  'whisper-small',
  'whisper-medium',
  'whisper-large-v3',
  'whisper-large-v3-turbo',
];

/** The components this build still installs under `<userData>/components`. Never touched. */
export const KEPT_COMPONENT_IDS: readonly string[] = ['ffmpeg', 'speaker-embedding'];

/** Editor asset ids P10 retired (electron/services/editor/asset-catalog.ts before P10, and AutoCutStudio's catalog it came from). */
export const RETIRED_ASSET_IDS: readonly string[] = [
  'voice-separator-env',
  'whisper-tiny',
  'whisper-base',
  'whisper-small',
  'whisper-medium',
  'whisper-large-v3',
  'whisper-large-v3-turbo',
];

/** The whisper.cpp model files those catalogs placed in `models/whisper/`. */
export const RETIRED_WHISPER_MODEL_FILES: readonly string[] = [
  'ggml-tiny.bin',
  'ggml-base.bin',
  'ggml-small.bin',
  'ggml-medium.bin',
  'ggml-large-v3.bin',
  'ggml-large-v3-turbo.bin',
];

export const SEPARATOR_ENV_DIR = 'voice-separator-env';

/** The editor asset dirs this build still uses in either store. Never touched. */
export const KEPT_ASSET_SUBPATHS: readonly string[] = [
  path.join('runtime', 'autocutstudio-env'),
  path.join('managed-bins', 'ffmpeg-tools'),
];

export interface RetirementRoots {
  /** The app's userData (`~/Library/Application Support/contentstudio` on the Mac). */
  userData: string;
  /** The OwenMorgan shared dir the editor's asset manager installs into, or null when it has none. */
  sharedDir: string | null;
}

export interface RetirementTarget {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  bytes: number;
  /** Which retired component it belonged to, in words. */
  reason: string;
  /** The directory it must sit strictly inside; re-asserted before removal. */
  parent: string;
}

export interface RecordDrop {
  /** The installed.json / state file the records are in. */
  file: string;
  ids: string[];
}

export interface RetirementPlan {
  roots: RetirementRoots;
  targets: RetirementTarget[];
  /** Records to drop once their files are gone. */
  records: RecordDrop[];
  /** Directories the old installers created, removed afterwards only if empty. */
  emptyDirs: string[];
  /** Things seen and deliberately left alone, with why. */
  skipped: Array<{ path: string; why: string }>;
  totalBytes: number;
}

export interface RetirementResult {
  removed: RetirementTarget[];
  bytesFreed: number;
  droppedRecords: string[];
  errors: Array<{ path: string; error: string }>;
}

export interface RetirementStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface RetirementLog {
  info(message: string): void;
  warn(message: string): void;
}

// ---------- layout ----------

interface AssetStore {
  /** The store's root: the shared dir, or `<userData>/assets`. */
  base: string;
  whisperDir: string;
  runtimeDir: string;
  modelsDir: string;
  stateFile: string;
  label: string;
}

export function retirementLayout(roots: RetirementRoots) {
  const componentsDir = path.join(roots.userData, 'components');
  const stores: AssetStore[] = [];
  const store = (base: string, stateFile: string, label: string): AssetStore => ({
    base,
    modelsDir: path.join(base, 'models'),
    whisperDir: path.join(base, 'models', 'whisper'),
    runtimeDir: path.join(base, 'runtime'),
    stateFile,
    label,
  });
  if (roots.sharedDir !== null) {
    stores.push(store(roots.sharedDir, path.join(roots.sharedDir, 'autocutstudio', 'installed.json'), 'the OwenMorgan shared dir'));
  }
  const fallback = path.join(roots.userData, 'assets');
  // The asset manager's per-app fallback puts each category at <userData>/assets/<category> and
  // its state at <userData>/assets/state/installed.json (asset-manager.ts categoryDir / stateDir).
  stores.push(store(fallback, path.join(fallback, 'state', 'installed.json'), 'the per-app asset fallback'));
  return {
    componentsDir,
    componentsManifest: path.join(componentsDir, 'installed.json'),
    stores,
  };
}

// ---------- safety ----------

/** True when `child` is strictly inside `parent` (not equal, not outside). */
export function isStrictlyInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The directories this build still uses, in either root: never a target, never inside one. */
export function keptPaths(roots: RetirementRoots): string[] {
  const L = retirementLayout(roots);
  return [
    ...KEPT_COMPONENT_IDS.map((id) => path.resolve(L.componentsDir, id)),
    ...L.stores.flatMap((s) => KEPT_ASSET_SUBPATHS.map((sub) => path.resolve(s.base, sub))),
  ];
}

/**
 * THE ASSERTION every removal passes, at plan time and again just before the unlink/rm: the
 * target is strictly inside its declared parent, strictly inside one of the roots, and neither
 * is nor contains nor sits inside a component this build still uses. It throws naming the
 * path; it never returns false for a caller to ignore.
 */
export function assertRemovable(target: string, parent: string, roots: RetirementRoots): void {
  const abs = path.resolve(target);
  const within = [roots.userData, ...(roots.sharedDir === null ? [] : [roots.sharedDir])];
  if (!isStrictlyInside(abs, parent)) {
    throw new Error(`refusing to remove ${abs}: it is not inside ${parent}`);
  }
  if (!within.some((root) => isStrictlyInside(abs, root))) {
    throw new Error(`refusing to remove ${abs}: it is outside the app's own directories (${within.join(', ')})`);
  }
  for (const kept of keptPaths(roots)) {
    if (abs === kept || isStrictlyInside(kept, abs) || isStrictlyInside(abs, kept)) {
      throw new Error(`refusing to remove ${abs}: it overlaps a component still in use (${kept})`);
    }
  }
}

// ---------- sizing ----------

async function sizeOf(p: string): Promise<number> {
  const st = await fs.promises.lstat(p);
  if (!st.isDirectory()) return st.isSymbolicLink() ? 0 : st.size;
  let total = 0;
  for (const name of await fs.promises.readdir(p)) total += await sizeOf(path.join(p, name));
  return total;
}

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(p);
  } catch (e: any) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return null;
    throw e;
  }
}

function existsNoFollow(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** A state/manifest file's `components` map; a missing file is none, a corrupt one throws (tried again next launch). */
function readComponents(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parsed?.components && typeof parsed.components === 'object' ? parsed.components : {};
}

// ---------- plan ----------

/** Everything the retirement would remove, with sizes. Reads only; the dry run is exactly this. */
export async function planRetirement(roots: RetirementRoots): Promise<RetirementPlan> {
  const L = retirementLayout(roots);
  const plan: RetirementPlan = { roots, targets: [], records: [], emptyDirs: [], skipped: [], totalBytes: 0 };
  const seen = new Set<string>();

  const consider = async (candidate: string, reason: string, expect: 'file' | 'dir', parent: string): Promise<void> => {
    const abs = path.resolve(candidate);
    if (seen.has(abs)) return;
    try {
      assertRemovable(abs, parent, roots);
    } catch (e: any) {
      plan.skipped.push({ path: abs, why: e.message });
      return;
    }
    const st = await lstatOrNull(abs);
    if (!st) return;
    seen.add(abs);
    if (st.isSymbolicLink()) {
      plan.targets.push({ path: abs, type: 'symlink', bytes: 0, reason: `${reason} (a link; only the link is removed)`, parent });
      return;
    }
    if (expect === 'file' ? !st.isFile() : !st.isDirectory()) {
      plan.skipped.push({ path: abs, why: `expected a ${expect}` });
      return;
    }
    plan.targets.push({ path: abs, type: st.isDirectory() ? 'dir' : 'file', bytes: await sizeOf(abs), reason, parent });
  };

  // 1. ContentStudio's own components.
  const componentRecords = readComponents(L.componentsManifest);
  const componentDrops: string[] = [];
  for (const id of RETIRED_COMPONENT_IDS) {
    const own = path.join(L.componentsDir, id);
    const rec = componentRecords[id];
    if (rec && typeof rec.path === 'string' && path.resolve(rec.path) !== path.resolve(own)) {
      plan.skipped.push({ path: path.resolve(rec.path), why: `the record for ${id} points outside components/${id}` });
    }
    await consider(own, id === 'whisper-engine' ? 'whisper.cpp engine (whisper-cli and its dylibs)' : `whisper.cpp model (${id})`, 'dir', L.componentsDir);
    if (rec) componentDrops.push(id);
  }
  if (componentDrops.length > 0) plan.records.push({ file: L.componentsManifest, ids: componentDrops });

  // 2. The editor's assets, in each store.
  for (const s of L.stores) {
    for (const f of RETIRED_WHISPER_MODEL_FILES) {
      await consider(path.join(s.whisperDir, f), `whisper.cpp model in ${s.label}`, 'file', s.whisperDir);
    }
    const env = path.join(s.runtimeDir, SEPARATOR_ENV_DIR);
    const envStat = await lstatOrNull(env);
    if (envStat) {
      const looksLikeIt = envStat.isSymbolicLink()
        || ['audio-separator-models', 'conda-meta'].some((n) => fs.existsSync(path.join(env, n)));
      if (looksLikeIt) await consider(env, `voice-separator-env in ${s.label}`, 'dir', s.runtimeDir);
      else plan.skipped.push({ path: env, why: 'does not look like voice-separator-env (no audio-separator-models or conda-meta)' });
    }
    let stateRecords: Record<string, any> = {};
    try {
      stateRecords = readComponents(s.stateFile);
    } catch (e: any) {
      throw new Error(`${s.stateFile} could not be read (${e.message}); nothing is retired until it can`);
    }
    const drops = RETIRED_ASSET_IDS.filter((id) => stateRecords[id] !== undefined);
    if (drops.length > 0) plan.records.push({ file: s.stateFile, ids: drops });
    plan.emptyDirs.push(s.whisperDir, s.modelsDir);
  }

  plan.totalBytes = plan.targets.reduce((n, t) => n + t.bytes, 0);
  return plan;
}

// ---------- execute ----------

/** Where a dropped record's files were, so a record is dropped only once they are gone. */
function recordOwnedPath(file: string, id: string, rec: any, roots: RetirementRoots): string | null {
  const L = retirementLayout(roots);
  if (path.resolve(file) === path.resolve(L.componentsManifest)) return path.join(L.componentsDir, id);
  const store = L.stores.find((s) => path.resolve(s.stateFile) === path.resolve(file));
  if (!store) return null;
  if (id === SEPARATOR_ENV_DIR) return path.join(store.runtimeDir, SEPARATOR_ENV_DIR);
  const version = typeof rec?.version === 'string' ? rec.version : id.replace(/^whisper-/, '');
  return path.join(store.whisperDir, `ggml-${version}.bin`);
}

/** Remove what the plan lists (each re-asserted first), drop the stale records, then prune empty dirs. */
export async function executeRetirement(plan: RetirementPlan): Promise<RetirementResult> {
  const result: RetirementResult = { removed: [], bytesFreed: 0, droppedRecords: [], errors: [] };

  for (const t of plan.targets) {
    try {
      assertRemovable(t.path, t.parent, plan.roots);
      if (t.type === 'dir') {
        await fs.promises.rm(t.path, { recursive: true, force: true });
      } else {
        // A file or a symlink: unlink never follows the link.
        await fs.promises.unlink(t.path).catch((e: any) => {
          if (e?.code !== 'ENOENT') throw e;
        });
      }
      result.removed.push(t);
      result.bytesFreed += t.bytes;
    } catch (e: any) {
      result.errors.push({ path: t.path, error: e?.message ?? String(e) });
    }
  }

  // Drop a record only when its files are gone. Synchronous read-modify-write, so it cannot
  // interleave with an install recording itself.
  for (const drop of plan.records) {
    try {
      const raw = JSON.parse(fs.readFileSync(drop.file, 'utf8'));
      const comps = raw?.components ?? {};
      let changed = false;
      for (const id of drop.ids) {
        if (!comps[id]) continue;
        const owned = recordOwnedPath(drop.file, id, comps[id], plan.roots);
        if (owned && existsNoFollow(owned)) continue;
        delete comps[id];
        changed = true;
        result.droppedRecords.push(`${id} (${drop.file})`);
      }
      if (changed) {
        const temporary = `${drop.file}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(raw, null, 2), 'utf8');
        fs.renameSync(temporary, drop.file);
      }
    } catch (e: any) {
      result.errors.push({ path: drop.file, error: e?.message ?? String(e) });
    }
  }

  for (const dir of plan.emptyDirs) {
    try {
      const st = await lstatOrNull(dir);
      if (st?.isDirectory() && (await fs.promises.readdir(dir)).length === 0) await fs.promises.rmdir(dir);
    } catch {
      // A dir that is not empty or not ours is simply left.
    }
  }
  return result;
}

// ---------- the dry run, as text ----------

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** The plan as log lines: what would be removed and how big it is, then what is left alone. */
export function describePlan(plan: RetirementPlan): string[] {
  const lines: string[] = [];
  if (plan.targets.length === 0) lines.push('nothing retired is on disk');
  for (const t of plan.targets) lines.push(`would remove ${formatBytes(t.bytes).padStart(10)}  ${t.type.padEnd(7)} ${t.path}  [${t.reason}]`);
  if (plan.targets.length > 0) lines.push(`would free ${formatBytes(plan.totalBytes)} (${plan.totalBytes} bytes) in ${plan.targets.length} item(s)`);
  for (const r of plan.records) lines.push(`would drop records ${r.ids.join(', ')} from ${r.file}`);
  for (const s of plan.skipped) lines.push(`left alone: ${s.path} (${s.why})`);
  return lines;
}

// ---------- once ----------

export function retirementDone(store: RetirementStore, id: string = RETIREMENT_ID): boolean {
  const raw = store.get(RETIRED_STORE_KEY) as Record<string, any> | undefined;
  return Boolean(raw && typeof raw === 'object' && raw[id]?.completedAt);
}

/**
 * Plan, log the plan, execute and record once. Never throws: a failure is logged and the run is
 * tried again at the next launch. Returns null when nothing ran (done already, opted out, or
 * the plan could not be made).
 */
export async function retireOnce(
  roots: RetirementRoots,
  store: RetirementStore,
  log: RetirementLog,
  now: () => Date = () => new Date(),
): Promise<RetirementResult | null> {
  try {
    if (retirementDone(store)) return null;
    const plan = await planRetirement(roots);
    for (const line of describePlan(plan)) log.info(`[retire] ${line}`);
    if (store.get(KEEP_RETIRED_STORE_KEY) === true) {
      log.info(`[retire] ${KEEP_RETIRED_STORE_KEY} is true in the store: the retired components stay on disk, and nothing is recorded`);
      return null;
    }
    const result = await executeRetirement(plan);
    for (const t of result.removed) log.info(`[retire] removed ${t.reason}: ${t.path} (${formatBytes(t.bytes)})`);
    for (const r of result.droppedRecords) log.info(`[retire] dropped record ${r}`);
    if (result.errors.length > 0) {
      for (const e of result.errors) log.warn(`[retire] could not remove ${e.path}: ${e.error}`);
      log.warn(`[retire] incomplete (${result.errors.length} failed); tried again at the next launch`);
      return result;
    }
    const raw = (store.get(RETIRED_STORE_KEY) as Record<string, unknown> | undefined) ?? {};
    store.set(RETIRED_STORE_KEY, {
      ...raw,
      [RETIREMENT_ID]: {
        completedAt: now().toISOString(),
        bytesFreed: result.bytesFreed,
        removed: result.removed.map((t) => ({ path: t.path, bytes: t.bytes, reason: t.reason })),
        droppedRecords: result.droppedRecords,
      },
    });
    log.info(result.removed.length > 0
      ? `[retire] retired components removed: ${result.removed.length} item(s), ${formatBytes(result.bytesFreed)} freed`
      : '[retire] no retired components on disk; recorded as done');
    return result;
  } catch (e: any) {
    log.warn(`[retire] skipped this launch: ${e?.message ?? e}`);
    return null;
  }
}
