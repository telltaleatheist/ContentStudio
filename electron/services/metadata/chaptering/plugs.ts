/**
 * Ad confirmation — segment.py `confirm_plugs()` (docs/crucible/reference/segment.py:86-103),
 * and the three things P8b adds around it (plan §0a; LEDGER #208).
 *
 * The fixed ad / self-promotion item rides in every level-1 outline. Each stretch Viterbi
 * assigns to it is confirmed by one yes/no over the passage (quoted, never indexed); a
 * stretch under its threshold has its ad column set to -1e9 and the path is run again without
 * the ad option there. Repeat until no unchecked ad run is left; a run is asked about once.
 *
 * WHAT P8b ADDS, each declared in the run's result:
 *
 *   1. THE PER-VIDEO BASELINE (`adBaseline`, `baselineRow`). A multi-option softmax leans on one option a
 *      little all video (plan §0a, Briefcase's flag finding), and P8a measured the ad item as the
 *      most probable option for 40-72 of 145 sentences of a 10-minute video (docs/crucible/
 *      P8a.md). So the ad option's probability is read as its RISE above its own median over the
 *      video, the median capped at 0.5 so an ad-heavy video's ads still read. The yes/no stays.
 *   2. THE PRIOR (`AD_PRIOR`, Owen 2026-09-25, #208: "ads sit at about 5:00 and 10:00"). A stretch
 *      that overlaps one of the usual marks is confirmed at a lower P(yes): prior odds of 3 to 1
 *      in favour of an ad there, so the answer's odds need only reach 1:3 (P(yes) >= 0.25).
 *      Everywhere else the threshold is segment.py's 0.5. The prior never places an ad: only a
 *      stretch snap already assigned to the ad item, or an outline-item candidate (3), is asked.
 *   3. OUTLINE-ITEM PLUGS (`isOutlineItemCandidate`). On Duffy the book promo came out under the
 *      outline's own "Promotion of the book" item and was never flagged (P8a). A run the outline
 *      named as an ordinary item, on which the ad option (after the baseline) ranks first or
 *      second for at least half the run's sentences, is asked the same yes/no; a yes flags it
 *      `isAd`, keeping its label. Two options claiming a stretch is what a plug the outline
 *      named looks like; an ordinary chapter's sentences put the ad option nowhere near the top
 *      once the video's lean is subtracted.
 */

import { PlugVerdict as RunVerdict } from './types';
import { runsOf, viterbi } from './viterbi';

/** A verdict on a run of the chunk's own units; the service adds how the answer was read and which kind of run it was. */
type PlugVerdict = Omit<RunVerdict, 'read' | 'source'>;

/** segment.py:103 — the ad column of a rejected stretch. */
export const REJECTED = -1e9;

/** segment.py:101 — P(yes) under this rejects a stretch, away from the prior's marks. */
export const CONFIRM_THRESHOLD = 0.5;

/**
 * Owen's ad marks as a prior (#208). `marksSeconds` are "about 5:00 and 10:00"; `windowSeconds`
 * is how far from a mark a stretch may start or end and still overlap it ("about"); `odds` is the
 * prior odds in favour of an ad there. Declared numbers, not measured ones: P8b reports every
 * verdict with the threshold it met so the prior's effect can be read off a run.
 */
export const AD_PRIOR = { marksSeconds: [300, 600], windowSeconds: 90, odds: 3 } as const;

/**
 * The P(yes) a stretch [startSec, endSec) must reach: the prior-odds threshold when it overlaps a
 * mark's window, else CONFIRM_THRESHOLD. With odds k, posterior odds = (p / (1 - p)) * k >= 1.
 */
export function confirmThreshold(startSec: number, endSec: number, prior: boolean): number {
  if (!prior) return CONFIRM_THRESHOLD;
  const near = AD_PRIOR.marksSeconds.some((m) => startSec <= m + AD_PRIOR.windowSeconds && endSec >= m - AD_PRIOR.windowSeconds);
  return near ? 1 / (1 + AD_PRIOR.odds) : CONFIRM_THRESHOLD;
}

/**
 * `L` is not mutated: the returned `logProbs` is the copy with rejections applied. `ask(a, b)`
 * returns P(yes) for units [a, b); `threshold(a, b)` the P(yes) it must reach (segment.py's 0.5
 * when absent, which is what the parity fixtures run).
 */
export async function confirmPlugs(
  L: number[][],
  plug: number,
  switchCost: number,
  ask: (start: number, end: number) => Promise<number>,
  threshold: (start: number, end: number) => number = () => CONFIRM_THRESHOLD,
): Promise<{ path: number[]; verdicts: Array<PlugVerdict & { threshold: number }>; logProbs: number[][] }> {
  const M = L.map((row) => row.slice());
  const checked = new Set<string>();
  const verdicts: Array<PlugVerdict & { threshold: number }> = [];
  for (;;) {
    const path = viterbi(M, switchCost);
    const todo = runsOf(path, plug).filter(([a, b]) => !checked.has(`${a}:${b}`));
    if (todo.length === 0) return { path, verdicts, logProbs: M };
    for (const [a, b] of todo) {
      const p = await ask(a, b);
      const need = threshold(a, b);
      checked.add(`${a}:${b}`);
      verdicts.push({ start: a, end: b, p, threshold: need });
      if (p < need) for (let i = a; i < b; i++) M[i][plug] = REJECTED;
    }
  }
}

/** The cap on the ad option's baseline: a video whose median ad probability is higher still reads its ads (plan §0a). */
export const BASELINE_CAP = 0.5;

/** The floor a baselined probability is clamped to before its log is taken (segment.py's 1e-12). */
const P_FLOOR = 1e-12;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The ad option's per-video baseline: the median of its probability over `rows` (one row per
 * sentence of the video, each a log distribution whose ad option sits at `plugOf(row)`), capped
 * at BASELINE_CAP.
 */
export function adBaseline(rows: ReadonlyArray<{ row: readonly number[]; plug: number }>): number {
  return Math.min(BASELINE_CAP, median(rows.map(({ row, plug }) => Math.exp(row[plug]))));
}

/**
 * One row with its ad option read as its rise above `baseline`, the row renormalised in log
 * space. The other options keep their relative weights. A row with no ad option is returned as it is.
 */
export function baselineRow(row: readonly number[], plug: number, baseline: number): number[] {
  if (plug < 0 || baseline <= 0) return row.slice();
  const p = row.map((lp) => Math.exp(lp));
  p[plug] = Math.max(P_FLOOR, p[plug] - baseline);
  const z = p.reduce((s, x) => s + x, 0);
  return p.map((x) => Math.log(x / z));
}

/** A run's share of sentences on which the ad option must rank first or second to be an outline-item candidate. */
export const CANDIDATE_SHARE = 0.5;

/**
 * Is a run the outline named as an ordinary item a plug candidate? `rows` are the run's
 * sentences' (already baselined) log distributions, each with the index of its own ad option
 * (a run may cross two chunks whose outlines differ). True when the ad option ranks first or
 * second on at least CANDIDATE_SHARE of them.
 */
export function isOutlineItemCandidate(rows: ReadonlyArray<{ row: readonly number[]; plug: number }>): boolean {
  if (rows.length === 0) return false;
  const near = rows.filter(({ row, plug }) => row.filter((x, j) => j !== plug && x > row[plug]).length <= 1).length;
  return near >= CANDIDATE_SHARE * rows.length;
}
