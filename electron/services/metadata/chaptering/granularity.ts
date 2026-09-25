/**
 * The grains, and the dial that draws them.
 *
 * Law 6 (amended, LEDGER #199): how finely the sections are kept is a DECLARED SETTING, never a
 * count derived from duration or computed in code. Owen, 2026-09-25 (LEDGER #208): there are two
 * grains, `chapters` ("what makes it to youtube - subject changes in videos") and `stories`
 * ("stream-level splits that are completely different subjects, not just small changes within
 * the same subjects"), and "in theory, we should be able to draw chapters out at any granularity
 * level". So a grain is a named setting of the dial, and the dial turns these things:
 *
 *   1. the switch cost — Viterbi's flat penalty, in nats, for changing outline item between
 *      one sentence and the next (viterbi.ts). Higher = fewer, longer runs. 20 is the measured
 *      best on YTSeg for subject-change chapters (F1@±1 0.72, Pk 0.21-0.23; plan §10.2). A run
 *      may state another (the `switchCost` option, and the pipeline's coarser `broad` pick,
 *      PIPELINE_DIAL below): that is the dial, declared and reported in the result.
 *   2. the outline prompt — which `snap_outline_*` body of chapters.yml the scorer model writes
 *      the level-1 outline with. The body carries the grain in words; the model decides the
 *      count under `{max_items}`.
 *   3. whether level 2 runs — the plan's two-level outline (§10.2 step 1): a sub-outline per long
 *      level-1 section over that section only. `chapters` refines the long sections (a long
 *      video's level 1 is broad by construction); `stories` publishes level 1 as it is.
 *   4. whether a long transcript gets ONE stream-level outline (#208): every chunk writes its own
 *      outline, those are merged into one (`snap_outline_stories_merge`, the 9B, ≤25 items), and
 *      every chunk is assigned against that one list, so one Viterbi pass runs over the whole
 *      stream. Measured need (docs/crucible/P8a.md): with an outline per ~40-min chunk the 9B
 *      wrote 7-13 "episodes" each, and a 3.4 h stream came out as 27 where Owen made 5.
 *   5. whether the ad prior applies (plugs.ts AD_PRIOR): Owen places his ads at about 5:00 and
 *      10:00 of a VIDEO (#208), so the prior is a chapters-grain fact; a stream's 5:00 is not
 *      an ad slot.
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
  /**
   * The chapters.yml key of the body that merges the chunk outlines into one stream-level
   * outline, or null for a grain that assigns each chunk against its own outline.
   */
  mergeKey: string | null;
  /** Apply the ad prior at the channel's usual ad marks (plugs.ts). */
  adPrior: boolean;
  /** Whether the number is measured (segment.py on YTSeg) or a default awaiting measurement. */
  provenance: 'measured' | 'default';
}

export const GRANULARITY: Readonly<Record<Granularity, GranularitySetting>> = {
  // segment.py's own outline body and cost: the setup YTSeg measured (plan §10.2).
  chapters: { switchCost: 20, outlineKey: 'snap_outline_chapters', refine: true, mergeKey: null, adPrior: true, provenance: 'measured' },
  // 45 is P8a's episodes cost, the coarsest it ran (docs/crucible/P8a.md); P8b measures it with
  // the stream-level outline on the 2026-09-23 stream against Owen's own story edges.
  stories: { switchCost: 45, outlineKey: 'snap_outline_stories', refine: false, mergeKey: 'snap_outline_stories_merge', adPrior: false, provenance: 'default' },
};

export const GRANULARITIES: readonly Granularity[] = ['chapters', 'stories'];

/** The setting for one grain; an unknown value throws (no quiet default grain). */
export function granularitySetting(granularity: Granularity): GranularitySetting {
  const setting = GRANULARITY[granularity];
  if (!setting) {
    throw new Error(`unknown chaptering granularity "${granularity}" — expected one of ${GRANULARITIES.join(', ')}`);
  }
  return setting;
}

/**
 * The metadata pipeline's per-run pick (the queue's "Chapters detect" selector, LEDGER #170),
 * read as a setting of the dial when the chapter engine is snap. Owen's #208 retires
 * detailed/broad as grains: both are `chapters`, and the difference is the switch cost. `stories`
 * is the stream-level grain (a compilation or a stream run through the pipeline). `broad`'s 30 is
 * P8a's unmeasured broad default, kept as the coarser setting of the same grain.
 */
export const PIPELINE_DIAL: Readonly<Record<'detailed' | 'broad' | 'stories', { granularity: Granularity; switchCost: number }>> = {
  detailed: { granularity: 'chapters', switchCost: GRANULARITY.chapters.switchCost },
  broad: { granularity: 'chapters', switchCost: 30 },
  stories: { granularity: 'stories', switchCost: GRANULARITY.stories.switchCost },
};

/**
 * When a level-1 section is refined at `chapters` (Briefcase chapter-tree.ts TREE_DEFAULTS, the
 * numbers it shipped with): the method was benchmarked on whole videos of 60-320 sentences,
 * ~5-20 min, so a section past 15 min or 120 units is itself video-sized and a fresh outline
 * over it works at the measured grain; under 24 units there is too little text for an outline.
 */
export const REFINE = { longSeconds: 900, longUnits: 120, minUnits: 24 } as const;

export function isLongSection(units: number, seconds: number): boolean {
  return units >= REFINE.minUnits && (units > REFINE.longUnits || seconds > REFINE.longSeconds);
}
