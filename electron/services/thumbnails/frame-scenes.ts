/**
 * THE THUMBNAILS TAB'S SCENES: the kept frames grouped by what they LOOK like (Owen, 2026-09-28:
 * "grab a few scenes from each unique shot"). No model, only arithmetic on tiny colour frames.
 *
 * Owen's screen recording sits on one of a handful of clips for most of a story: the rapture story
 * keeps ~300 frames after the repeat and blur filters, and they are about ten shots (a two-shot of
 * two hosts, one host alone, vertical phone clips with a blurred side-fill, a sky, a desktop). The
 * repeat filter only drops near-identical frames, so a talking head that moves a little survives
 * dozens of times and the grid is one scene over and over. Grouping fixes that:
 *
 *   - THE SIGNATURE is the frame shrunk to SIG_COLS x SIG_ROWS colour cells (area average of the
 *     320x180 grid picture, measured on the fly by frame-sampler.ts). A clip's layout and
 *     background are in most of the cells; a speaker who moves changes only the few cells they
 *     cover.
 *   - THE DISTANCE between two frames is the FRACTION OF CELLS whose colour moved by more than
 *     CELL_COLOUR_TOLERANCE (straight RGB distance, 0-441). A fraction, not an average, so a speaker
 *     waving their hands (a few cells changing a lot) does not look like a different clip, and a
 *     different clip (most cells changing) does.
 *   - THE GROUPS come from average-linkage clustering over the WHOLE story, not neighbours in time:
 *     clips alternate (A B A B), and every return to A joins A. Two groups join while the average
 *     distance between their frames is at most SCENE_JOIN_FRACTION. Average linkage (rather than
 *     "any two frames close") keeps a transition frame from chaining two clips into one.
 *     The merge order is the nearest-neighbour-chain algorithm on the full distance matrix, O(n^2)
 *     for the at most 1,800 frames a run samples; average linkage never merges below an earlier
 *     merge, so cutting the tree at SCENE_JOIN_FRACTION gives the same groups as merging the closest
 *     pair until none is close enough.
 *
 * Scenes are numbered in order of first appearance. Tuned on "f1 - the rapture" (2026-09-24):
 * docs/thumbnails-lab.md has the groups it finds.
 *
 * PURE: signatures in, groups and counts out, so tools/thumbnail-lab-checks.js pins it on
 * synthetic frames.
 */
import { thinAcrossRange } from './frame-metrics';

/** The signature grid: 16 x 9 cells, 3 bytes (R, G, B) each. */
export const SIG_COLS = 16;
export const SIG_ROWS = 9;
export const SIG_BYTES = SIG_COLS * SIG_ROWS * 3;

/**
 * A cell counts as changed when its colour moved by more than this (RGB distance). 40 is well above
 * compression noise and a lighting flicker and well below a background swap. Tuned on the rapture
 * story: 30-50 gave the same main groups, 60 merged the two talking-head clips.
 */
export const CELL_COLOUR_TOLERANCE = 40;

/**
 * Two groups are one scene while their frames differ, on average, in at most this fraction of
 * cells. Tuned on the rapture story: 0.5 split the vertical clips into halves, 0.7 merged the two
 * hosts' clips and the sky shots; 0.6 found the shots Owen listed.
 */
export const SCENE_JOIN_FRACTION = 0.6;

/** Every scene offers at least this many frames to the vision model (or all it has, when fewer). */
export const SCENE_FLOOR = 3;

/** A scene on screen for less than this many seconds offers one frame, not SCENE_FLOOR (Owen 2026-09-28: a few seconds of moving sky is not worth three scoring slots). */
export const SHORT_SCENE_SECONDS = 10;

function floorOf(s: { size: number; seconds: number }): number {
  return Math.min(s.seconds < SHORT_SCENE_SECONDS ? 1 : SCENE_FLOOR, s.size);
}

/** How many of a scene's best frames the "Best by scene" view shows. */
export const SCENE_ROW_FRAMES = 4;

/** The fraction of the two signatures' cells whose colour differs by more than the tolerance. */
export function signatureDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== SIG_BYTES || b.length !== SIG_BYTES) {
    throw new Error(`signatureDistance: a signature is ${SIG_BYTES} bytes, and these are ${a.length} and ${b.length}.`);
  }
  const limit = CELL_COLOUR_TOLERANCE * CELL_COLOUR_TOLERANCE;
  let changed = 0;
  for (let i = 0; i < SIG_BYTES; i += 3) {
    const dr = a[i] - b[i];
    const dg = a[i + 1] - b[i + 1];
    const db = a[i + 2] - b[i + 2];
    if (dr * dr + dg * dg + db * db > limit) changed++;
  }
  return changed / (SIG_BYTES / 3);
}

/**
 * Average-linkage groups of the signatures, cut at `join`: the member indices of each group, each
 * in ascending order, the groups ordered by their first member. Nearest-neighbour chain with the
 * Lance-Williams update; ties go to the chain's previous element, then the lowest index, so the
 * result is fully determined by the input order.
 */
export function averageLinkageGroups(signatures: readonly Uint8Array[], join: number = SCENE_JOIN_FRACTION): number[][] {
  const n = signatures.length;
  if (n === 0) throw new Error('averageLinkageGroups: there are no frames to group.');
  const d = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = signatureDistance(signatures[i], signatures[j]);
      d[i * n + j] = v;
      d[j * n + i] = v;
    }
  }
  const size = new Array<number>(n).fill(1);
  const active = new Array<boolean>(n).fill(true);
  // Union-find over the original indices; a cluster lives in the slot of its lowest member.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const chain: number[] = [];
  let remaining = n;
  while (remaining > 1) {
    if (chain.length === 0) chain.push(active.indexOf(true));
    const a = chain[chain.length - 1];
    const prev = chain.length > 1 ? chain[chain.length - 2] : -1;
    let best = prev;
    let bestD = prev >= 0 ? d[a * n + prev] : Infinity;
    for (let c = 0; c < n; c++) {
      if (!active[c] || c === a) continue;
      if (d[a * n + c] < bestD) {
        bestD = d[a * n + c];
        best = c;
      }
    }
    if (best !== prev) {
      chain.push(best);
      continue;
    }
    // a and prev are each other's nearest: merge them into the lower slot.
    chain.pop();
    chain.pop();
    const keep = Math.min(a, prev);
    const gone = Math.max(a, prev);
    const sk = size[keep];
    const sg = size[gone];
    for (let c = 0; c < n; c++) {
      if (!active[c] || c === keep || c === gone) continue;
      const v = (sk * d[keep * n + c] + sg * d[gone * n + c]) / (sk + sg);
      d[keep * n + c] = v;
      d[c * n + keep] = v;
    }
    size[keep] = sk + sg;
    active[gone] = false;
    remaining--;
    // Monotone linkage: a merge above the cut is never followed, inside its subtree, by one below it.
    if (bestD <= join) parent[find(gone)] = find(keep);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(i);
    groups.set(root, list);
  }
  return [...groups.values()].sort((x, y) => x[0] - y[0]);
}

/** One scene: its number (1-based, by first appearance), its kept frames, and its time on screen. */
export interface Scene<T> {
  number: number;
  frames: T[];
  /** Sampled frames of the story that look like this scene (kept or dropped as a repeat or blur). */
  sampled: number;
  /** `sampled` x the sampling interval: how long the story shows this scene. */
  seconds: number;
}

/**
 * The kept frames' scenes, and every SAMPLED frame counted toward the scene it looks most like (the
 * lowest average distance to the scene's kept frames), so a held shot the repeat filter collapsed to
 * one frame still counts its full time on screen. Kept frames must be among the sampled ones (by
 * `index`); frames are taken in time order.
 */
export function groupScenes<T extends { index: number; t: number; colour: Uint8Array }>(
  kept: readonly T[],
  sampled: ReadonlyArray<{ index: number; colour: Uint8Array }>,
  every: number,
): Scene<T>[] {
  if (kept.length === 0) throw new Error('groupScenes: no frames were kept, so there are no scenes.');
  if (!(every > 0)) throw new Error(`groupScenes: a sampling interval of ${every} s is not a time.`);
  const ordered = [...kept].sort((a, b) => a.t - b.t || a.index - b.index);
  const groups = averageLinkageGroups(ordered.map((f) => f.colour));
  const sceneOfKept = new Map<number, number>();
  groups.forEach((members, g) => members.forEach((m) => sceneOfKept.set(ordered[m].index, g)));
  const counts = new Array<number>(groups.length).fill(0);
  for (const frame of sampled) {
    const own = sceneOfKept.get(frame.index);
    if (own !== undefined) {
      counts[own]++;
      continue;
    }
    let best = -1;
    let bestD = Infinity;
    groups.forEach((members, g) => {
      let sum = 0;
      for (const m of members) sum += signatureDistance(frame.colour, ordered[m].colour);
      const mean = sum / members.length;
      if (mean < bestD) {
        bestD = mean;
        best = g;
      }
    });
    counts[best]++;
  }
  return groups.map((members, g) => ({
    number: g + 1,
    frames: members.map((m) => ordered[m]),
    sampled: counts[g],
    seconds: counts[g] * every,
  }));
}

/**
 * How many frames each scene sends to the vision model, `cap` in all. Every scene first gets
 * SCENE_FLOOR, or one when it was on screen under SHORT_SCENE_SECONDS (never more than it has); the rest go one at a time to the scene with
 * the most screen time per extra frame already given (D'Hondt: seconds / (extra + 1)), never more
 * than a scene has. When the floors alone exceed the cap (a story of very many scenes), the scenes
 * take one frame each in rounds, longest on screen first, until the cap is reached; `short` then
 * says so. Ties go to the lower scene number.
 */
export function allocateScoring(scenes: ReadonlyArray<{ number: number; size: number; seconds: number }>, cap: number): { quota: Map<number, number>; short: boolean } {
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`allocateScoring: a cap of ${cap} frames is not a count.`);
  const quota = new Map<number, number>(scenes.map((s) => [s.number, 0]));
  const total = scenes.reduce((sum, s) => sum + s.size, 0);
  if (total <= cap) {
    for (const s of scenes) quota.set(s.number, s.size);
    return { quota, short: false };
  }
  const floors = scenes.reduce((sum, s) => sum + floorOf(s), 0);
  if (floors > cap) {
    const byTime = [...scenes].sort((a, b) => b.seconds - a.seconds || a.number - b.number);
    let given = 0;
    for (let round = 0; given < cap; round++) {
      for (const s of byTime) {
        if (given >= cap) break;
        if (round < floorOf(s)) {
          quota.set(s.number, quota.get(s.number)! + 1);
          given++;
        }
      }
    }
    return { quota, short: true };
  }
  for (const s of scenes) quota.set(s.number, floorOf(s));
  for (let left = cap - floors; left > 0; left--) {
    let pick: { number: number; size: number; seconds: number } | null = null;
    let pickValue = -1;
    for (const s of scenes) {
      const q = quota.get(s.number)!;
      if (q >= s.size) continue;
      const value = s.seconds / (q - floorOf(s) + 1);
      if (value > pickValue) {
        pickValue = value;
        pick = s;
      }
    }
    if (pick === null) break;
    quota.set(pick.number, quota.get(pick.number)! + 1);
  }
  return { quota, short: false };
}

/**
 * The frames to score: each scene's quota, spread across that scene's own time on screen (the
 * scene's frames thinned across its first to last appearance, sharpest first within a stretch).
 * Returned in time order.
 */
export function framesToScore<T extends { t: number; sharpness: number }>(scenes: ReadonlyArray<Scene<T>>, quota: ReadonlyMap<number, number>): T[] {
  const out: T[] = [];
  for (const scene of scenes) {
    const q = quota.get(scene.number) ?? 0;
    if (q === 0) continue;
    const first = scene.frames[0].t;
    const last = scene.frames[scene.frames.length - 1].t;
    out.push(...thinAcrossRange(scene.frames, first, last + 1, q));
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Two frames of one scene closer than this many seconds are the same moment; only the better shows. */
export const SCENE_MIN_GAP_SECONDS = 4;

export interface SceneRow {
  scene: number;
  /** Frame ids, best first, at most SCENE_ROW_FRAMES. */
  ids: string[];
  best: number;
}

/**
 * The "Best by scene" rows: for each scene, its best-ranked frames (at most `perRow`, never two
 * within SCENE_MIN_GAP_SECONDS), the scenes ordered by their best frame's score (ties: lower scene
 * number). `ranked` is best first and holds no rejected frame, so a scene whose frames were all
 * computer screens (or unreadable, or not scored) has no row; `empty` lists those scenes.
 */
export function sceneRows(
  ranked: ReadonlyArray<{ id: string; t: number; score: number }>,
  sceneOf: ReadonlyMap<string, number>,
  scenes: readonly number[],
  perRow: number = SCENE_ROW_FRAMES,
): { rows: SceneRow[]; empty: number[] } {
  const rows = new Map<number, SceneRow & { times: number[] }>();
  for (const frame of ranked) {
    const scene = sceneOf.get(frame.id);
    if (scene === undefined) throw new Error(`sceneRows: frame ${frame.id} belongs to no scene.`);
    const row = rows.get(scene) ?? { scene, ids: [], best: frame.score, times: [] };
    rows.set(scene, row);
    if (row.ids.length >= perRow || row.times.some((t) => Math.abs(t - frame.t) < SCENE_MIN_GAP_SECONDS)) continue;
    row.ids.push(frame.id);
    row.times.push(frame.t);
  }
  const ordered = [...rows.values()]
    .sort((a, b) => b.best - a.best || a.scene - b.scene)
    .map(({ scene, ids, best }) => ({ scene, ids, best }));
  return { rows: ordered, empty: scenes.filter((s) => !rows.has(s)) };
}
