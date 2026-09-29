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
 *   - FRAGMENTS FOLDED (2026-09-28, Owen: "there are really only like 10 unique frames"). A moving
 *     camera (the rapture story's trees and sky) changes most cells from second to second, so its
 *     footage split into seven small scenes. Colour alone cannot tell those pieces from two
 *     different short clips (measured: the sky pieces sit 0.68-0.78 apart, the pink-hair two-shot
 *     and the woman against the sky 0.79), but TIME can: the pieces interleave inside one stretch
 *     of the story. So two scenes fold into one when both are small (each an original group of at
 *     most FRAGMENT_MAX_KEPT kept frames), their stretches of the story overlap or touch (within
 *     FRAGMENT_TOUCH_SAMPLES sampling intervals), and they differ on average in at most
 *     FRAGMENT_JOIN_FRACTION of the cells (looser than SCENE_JOIN_FRACTION); the closest such pair
 *     first, until none is left. Big scenes never fold, so the two hosts' clips stay apart.
 *
 * Scenes are numbered in order of first appearance. Tuned on "f1 - the rapture" (2026-09-24):
 * docs/thumbnails-lab.md has the groups it finds. The Thumbnails window's grid is at most
 * GRID_PER_SCENE of each scene's sharpest frames (`gridFrames`, below), with look-alikes across the
 * whole grid dropped (`distinctFrames`).
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

/** A group of at most this many kept frames is a possible fragment (see FRAGMENTS FOLDED). */
export const FRAGMENT_MAX_KEPT = 10;

/** Two fragments fold when their frames differ on average in at most this fraction of cells. */
export const FRAGMENT_JOIN_FRACTION = 0.8;

/** Two fragments' stretches "touch" when the gap between them is at most this many sampling intervals. */
export const FRAGMENT_TOUCH_SAMPLES = 2;

/**
 * Fold small groups that interleave or touch in time and look alike at the looser bar (see
 * FRAGMENTS FOLDED). `groups` are member indices into `frames` (time order not required); the
 * result is the folded groups, members ascending, ordered by first member.
 */
export function foldFragments(
  groups: readonly number[][],
  frames: ReadonlyArray<{ t: number; colour: Uint8Array }>,
  every: number,
): number[][] {
  const clusters = groups.map((members) => ({
    members: [...members],
    small: members.length <= FRAGMENT_MAX_KEPT,
    first: Math.min(...members.map((m) => frames[m].t)),
    last: Math.max(...members.map((m) => frames[m].t)),
  }));
  const touch = FRAGMENT_TOUCH_SAMPLES * every;
  const mean = (a: number[], b: number[]): number => {
    let sum = 0;
    for (const i of a) for (const j of b) sum += signatureDistance(frames[i].colour, frames[j].colour);
    return sum / (a.length * b.length);
  };
  for (;;) {
    let best: { i: number; j: number; d: number } | null = null;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i];
        const b = clusters[j];
        if (!a.small || !b.small) continue;
        if (a.first > b.last + touch || b.first > a.last + touch) continue;
        const d = mean(a.members, b.members);
        if (d <= FRAGMENT_JOIN_FRACTION && (best === null || d < best.d)) best = { i, j, d };
      }
    }
    if (best === null) break;
    const a = clusters[best.i];
    const b = clusters[best.j];
    a.members = [...a.members, ...b.members];
    a.first = Math.min(a.first, b.first);
    a.last = Math.max(a.last, b.last);
    clusters.splice(best.j, 1);
  }
  return clusters.map((c) => c.members.sort((x, y) => x - y)).sort((x, y) => x[0] - y[0]);
}

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
  const groups = foldFragments(averageLinkageGroups(ordered.map((f) => f.colour)), ordered, every);
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
 * THE GRID'S CANDIDATES (2026-09-29). Owen picks frames 1, 2 and 3 himself from one flat grid in the
 * Thumbnails window, so nothing ranks them any more (the vision model's frame scoring was removed
 * that day). Each scene offers at most GRID_PER_SCENE frames, so the grid is every shot once or
 * twice and never the same talking head over and over; a scene on screen under SHORT_SCENE_SECONDS
 * offers one.
 */
export const GRID_PER_SCENE = 2;

/** A scene on screen for less than this many seconds offers one frame, not GRID_PER_SCENE (Owen 2026-09-28: a few seconds of moving sky is not worth more). */
export const SHORT_SCENE_SECONDS = 10;

/** How many frames a scene offers the grid: GRID_PER_SCENE, one when it was on screen under SHORT_SCENE_SECONDS, never more than it kept. */
export function gridQuota(scene: { size: number; seconds: number }): number {
  if (!Number.isInteger(scene.size) || scene.size < 1) throw new Error(`gridQuota: a scene of ${scene.size} kept frames offers nothing.`);
  return Math.min(scene.seconds < SHORT_SCENE_SECONDS ? 1 : GRID_PER_SCENE, scene.size);
}

/**
 * The grid's frames: each scene's quota (gridQuota), the sharpest and spread across that scene's
 * own time on screen (`thinAcrossRange` over its first to last appearance: with two, the sharpest
 * of each half, so a scene the story returns to shows both visits). Returned in time order, which
 * is the order the grid shows them.
 */
export function gridFrames<T extends { t: number; sharpness: number }>(scenes: ReadonlyArray<Scene<T>>): T[] {
  const out: T[] = [];
  for (const scene of scenes) {
    if (scene.frames.length === 0) throw new Error(`gridFrames: scene ${scene.number} has no kept frames.`);
    const first = scene.frames[0].t;
    const last = scene.frames[scene.frames.length - 1].t;
    out.push(...thinAcrossRange(scene.frames, first, last + 1, gridQuota({ size: scene.frames.length, seconds: scene.seconds })));
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * LOOK-ALIKES DROPPED (2026-09-29, Owen: "can we programmatically select similar frames so we dont
 * have 60 frames that are basically identical to each other?"). A shot can still split into several
 * scenes (a window moved, a caption changed), and a scene's two frames can be the same talking head
 * twice. So the grid keeps a frame only when it differs from every frame already kept in more than
 * DISTINCT_MIN_FRACTION of the signature's cells, sharpest first, so of two look-alikes the sharper
 * stays. Measured on Owen's 2026-09-29 runs (their old grids of 105-120 frames): 0.25 took witzke to
 * 14 distinct shots and the varied Alex Jones trump story to 47; 0.1 left witzke at 23, 0.4 began
 * dropping different clips of one set.
 */
export const DISTINCT_MIN_FRACTION = 0.25;

/** The frames with look-alikes dropped (see LOOK-ALIKES DROPPED), in time order. */
export function distinctFrames<T extends { t: number; sharpness: number; colour: Uint8Array }>(frames: readonly T[]): T[] {
  const kept: T[] = [];
  for (const f of [...frames].sort((a, b) => b.sharpness - a.sharpness || a.t - b.t)) {
    if (kept.every((k) => signatureDistance(f.colour, k.colour) > DISTINCT_MIN_FRACTION)) kept.push(f);
  }
  return kept.sort((a, b) => a.t - b.t);
}
