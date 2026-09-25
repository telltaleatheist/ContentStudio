/**
 * The granularity dial: what each setting turns.
 *
 * Law 6 (amended, LEDGER #199): how finely the sections are kept is a DECLARED SETTING, never a
 * count derived from duration or computed in code. The setting turns three things:
 *
 *   1. the switch cost — Viterbi's flat penalty, in nats, for changing outline item between
 *      one sentence and the next (viterbi.ts). Higher = fewer, longer runs. 20 is the measured
 *      best on YTSeg for `detailed` (F1@±1 0.72, Pk 0.21-0.23; plan §10.2). The other three
 *      are defaults awaiting measurement in P8 (plan §0 #19, marked D). They are set ABOVE 20
 *      because a broad outline has fewer, farther-apart items and the cost only has to stop
 *      flicker between them; a stream's episodes are farther apart still.
 *   2. the outline prompt — which `snap_outline_*` body of chapters.yml the scorer model
 *      writes the level-1 outline with. The body carries the grain in words; the model
 *      decides the count under `{max_items}`.
 *   3. whether level 2 runs — the plan's two-level outline (§10.2 step 1): level 1 is broad,
 *      then a sub-outline per level-1 section over that section only. `detailed` refines the
 *      long sections; the other three publish level 1 as it is.
 *
 * The numbers are data about a measurement, so they are here, in one table, and nowhere else.
 */

import { Granularity } from './types';

export interface GranularitySetting {
  /** Viterbi's flat switch cost, in nats. */
  switchCost: number;
  /** The chapters.yml key of the level-1 outline body. */
  outlineKey: string;
  /** Run the second level (a sub-outline inside every long level-1 section). */
  refine: boolean;
  /** Whether the number is measured (segment.py on YTSeg) or a default awaiting P8's measurement. */
  provenance: 'measured' | 'default';
}

export const GRANULARITY: Readonly<Record<Granularity, GranularitySetting>> = {
  detailed: { switchCost: 20, outlineKey: 'snap_outline_detailed', refine: true, provenance: 'measured' },
  broad: { switchCost: 30, outlineKey: 'snap_outline_broad', refine: false, provenance: 'default' },
  stories: { switchCost: 30, outlineKey: 'snap_outline_stories', refine: false, provenance: 'default' },
  episodes: { switchCost: 45, outlineKey: 'snap_outline_episodes', refine: false, provenance: 'default' },
};

export const GRANULARITIES: readonly Granularity[] = ['detailed', 'broad', 'stories', 'episodes'];

/** The setting for one granularity; an unknown value throws (no quiet default grain). */
export function granularitySetting(granularity: Granularity): GranularitySetting {
  const setting = GRANULARITY[granularity];
  if (!setting) {
    throw new Error(`unknown chaptering granularity "${granularity}" — expected one of ${GRANULARITIES.join(', ')}`);
  }
  return setting;
}

/**
 * When a level-1 section is refined at `detailed` (Briefcase chapter-tree.ts TREE_DEFAULTS, the
 * numbers it shipped with): the method was benchmarked on whole videos of 60-320 sentences,
 * ~5-20 min, so a section past 15 min or 120 units is itself video-sized and a fresh outline
 * over it works at the measured grain; under 24 units there is too little text for an outline.
 */
export const REFINE = { longSeconds: 900, longUnits: 120, minUnits: 24 } as const;

export function isLongSection(units: number, seconds: number): boolean {
  return units >= REFINE.minUnits && (units > REFINE.longUnits || seconds > REFINE.longSeconds);
}
