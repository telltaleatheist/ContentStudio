/**
 * Ad confirmation — segment.py `confirm_plugs()` (docs/crucible/reference/segment.py:86-103).
 *
 * The fixed ad / self-promotion item rides in every level-1 outline. Each stretch Viterbi
 * assigns to it is confirmed by one yes/no over the passage (quoted, never indexed); a
 * stretch under 0.5 has its ad column set to -1e9 and the path is run again without the ad
 * option there. Repeat until no unchecked ad run is left; a run is asked about once.
 *
 * The plan's §0a warning applies: a multi-option softmax leans on one option a little all
 * video, so the ad item is never trusted on the assign alone — the yes/no is the check, and
 * the verdicts are reported so an edge-error pattern (plan §10.2's open item: "ad-span edges
 * are a sentence or two too wide") can be measured rather than guessed at.
 */

import { PlugVerdict } from './types';
import { runsOf, viterbi } from './viterbi';

/** segment.py:103 — the ad column of a rejected stretch. */
export const REJECTED = -1e9;

/**
 * `L` is not mutated: the returned `logProbs` is the copy with rejections applied. `ask(a, b)`
 * returns P(yes) for units [a, b).
 */
export async function confirmPlugs(
  L: number[][],
  plug: number,
  switchCost: number,
  ask: (start: number, end: number) => Promise<number>,
): Promise<{ path: number[]; verdicts: PlugVerdict[]; logProbs: number[][] }> {
  const M = L.map((row) => row.slice());
  const checked = new Set<string>();
  const verdicts: PlugVerdict[] = [];
  for (;;) {
    const path = viterbi(M, switchCost);
    const todo = runsOf(path, plug).filter(([a, b]) => !checked.has(`${a}:${b}`));
    if (todo.length === 0) return { path, verdicts, logProbs: M };
    for (const [a, b] of todo) {
      const p = await ask(a, b);
      checked.add(`${a}:${b}`);
      verdicts.push({ start: a, end: b, p });
      if (p < 0.5) for (let i = a; i < b; i++) M[i][plug] = REJECTED;
    }
  }
}
