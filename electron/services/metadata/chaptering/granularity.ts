/**
 * The grains, and how each is drawn.
 *
 * Owen, 2026-09-25 (LEDGER #208): there are two grains, `chapters` ("what makes it to youtube -
 * subject changes in videos") and `stories` ("stream-level splits that are completely different
 * subjects, not just small changes within the same subjects"). Since #212 they are drawn by two
 * METHODS:
 *
 *   chapters  OUTLINE + ASSIGN + Viterbi (chaptering.service.ts runLevel). Law 6 (amended, #199):
 *             how finely the sections are kept is a DECLARED SETTING, the switch cost, never a
 *             count derived from duration. The setting turns: the switch cost (Viterbi's flat
 *             penalty, in nats; 20 is the measured best on YTSeg, F1@±1 0.72), the outline body
 *             (`snap_outline_chapters`, segment.py's), level 2 (a sub-outline inside every long
 *             level-1 section, plan §10.2) and the ad prior (Owen places his ads at about 5:00 and
 *             10:00 of a VIDEO, #208; plugs.ts AD_PRIOR).
 *   stories   45-second JUNCTIONS judged one against the last (stories.ts, #212): the editor's old
 *             analyzer re-done on snap. Its constants are the reference's own (STORY_METHOD),
 *             including the duration-derived over-segmentation #212 adopts for this grain ("the 45
 *             second resolution trick we used before"); consolidation, not a count, says how many
 *             stories stay. The merged stream outline (#208) is gone: it found 2 of Owen's 7 edges
 *             on the 2026-09-23 stream (docs/crucible/P8b.md).
 *
 * #213: the metadata pipeline's per-run pick is `chapters` (the default) or `stories` and nothing
 * else; the old detailed / broad values read as `chapters` (metadata-generator.service.ts). The
 * chapters grain always runs at its measured switch cost, 20: nothing in the queue turns it.
 */

import { Granularity } from './types';

export interface OutlineSetting {
  method: 'outline';
  /** Viterbi's flat switch cost, in nats. */
  switchCost: number;
  /** The chapters.yml key of the level-1 outline body. */
  outlineKey: string;
  /** Run the second level (a sub-outline inside every long level-1 section). */
  refine: boolean;
  /** Apply the ad prior at the channel's usual ad marks (plugs.ts). */
  adPrior: boolean;
  /** Whether the number is measured (segment.py on YTSeg) or a default awaiting measurement. */
  provenance: 'measured' | 'default';
}

export interface JunctionSetting {
  method: 'junctions';
  /** The reference's method (docs/crucible/reference/chapter-splitter.ts); its constants are stories.ts STORY_METHOD. */
  provenance: 'reference';
}

export type GranularitySetting = OutlineSetting | JunctionSetting;

export const GRANULARITY: Readonly<{ chapters: OutlineSetting; stories: JunctionSetting }> = {
  // segment.py's own outline body and cost: the setup YTSeg measured (plan §10.2).
  chapters: { method: 'outline', switchCost: 20, outlineKey: 'snap_outline_chapters', refine: true, adPrior: true, provenance: 'measured' },
  stories: { method: 'junctions', provenance: 'reference' },
};

export const GRANULARITIES: readonly Granularity[] = ['chapters', 'stories'];

/** The setting for one grain; an unknown value throws (no quiet default grain). */
export function granularitySetting(granularity: Granularity): GranularitySetting {
  const setting = (GRANULARITY as Readonly<Record<string, GranularitySetting>>)[granularity];
  if (!setting) {
    throw new Error(`unknown chaptering granularity "${granularity}" — expected one of ${GRANULARITIES.join(', ')}`);
  }
  return setting;
}

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

/**
 * The metadata pipeline's per-run pick (the inputs page's "Chapters detect" selector, LEDGER #213):
 * `chapters` for every single video, however long, and `stories` for a weekly podcast compilation.
 * Owen, 2026-09-25: "we'll generate stories for cases where i send a podcast episode through ... and
 * for everything else, we'll use chapters."
 */
export type ChapterPick = 'chapters' | 'stories';

export const CHAPTER_PICKS: readonly ChapterPick[] = ['chapters', 'stories'];

/**
 * A pick as stored or sent, read as #213's two values. The retired three-way selector's `detailed`
 * and `broad` (#170) were both single-video chaptering, so they read as `chapters` and the caller
 * logs the migration once (`migratedFrom`). Anything else is refused by name.
 */
export function chapterPickOf(value: unknown): { pick: ChapterPick; migratedFrom: 'detailed' | 'broad' | null } {
  if (value === 'chapters' || value === 'stories') return { pick: value, migratedFrom: null };
  if (value === 'detailed' || value === 'broad') return { pick: 'chapters', migratedFrom: value };
  throw new Error(`unknown chapter pick ${JSON.stringify(value)} — expected ${CHAPTER_PICKS.join(' or ')}`);
}
