/**
 * Viterbi over per-sentence log-probabilities — segment.py `viterbi()`, `runs()` and
 * `boundaries()` (docs/crucible/reference/segment.py), by way of Briefcase's port
 * (backend/src/scorer/scorer-viterbi.ts), whose fixtures tools/chaptering-checks.js carries.
 *
 * Any item may follow any other at a flat cost per switch, so a subject the speaker returns
 * to after an aside can recur. The switch cost, in nats, is the granularity dial
 * (granularity.ts): higher gives fewer, longer runs. Ties break toward the lower item index,
 * as Python's max() over range(m) does, so the port reproduces the reference path exactly.
 */

/**
 * Best item per unit.
 * @param logProbs  logProbs[i][j] = log P(item j | unit i); every row the same length
 * @param switchCost flat penalty (nats) paid each time the item changes
 * @returns the item index for each unit (empty for no units)
 */
export function viterbi(logProbs: number[][], switchCost: number): number[] {
  const n = logProbs.length;
  if (n === 0) return [];
  const m = logProbs[0].length;
  if (m === 0) throw new Error('viterbi: rows must have at least one item');

  let dp = logProbs[0].slice();
  const back: Int32Array[] = [];
  for (let i = 1; i < n; i++) {
    const row = logProbs[i];
    if (row.length !== m) throw new Error(`viterbi: row ${i} has ${row.length} items, expected ${m}`);
    const bestJ = argmax(dp);
    const bestV = dp[bestJ] - switchCost;
    const next = new Array<number>(m);
    const from = new Int32Array(m);
    for (let j = 0; j < m; j++) {
      if (dp[j] >= bestV) {
        next[j] = dp[j] + row[j];
        from[j] = j;
      } else {
        next[j] = bestV + row[j];
        from[j] = bestJ;
      }
    }
    dp = next;
    back.push(from);
  }

  const path = new Array<number>(n);
  let j = argmax(dp);
  path[n - 1] = j;
  for (let i = n - 2; i >= 0; i--) {
    j = back[i][j];
    path[i] = j;
  }
  return path;
}

/** Maximal runs of `item` in `path`, as [start, endExclusive] unit indices (segment.py runs()). */
export function runsOf(path: number[], item: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === item) {
      let k = i;
      while (k < path.length && path[k] === item) k++;
      out.push([i, k]);
      i = k;
    } else {
      i++;
    }
  }
  return out;
}

/** Every maximal run in `path`, in order. */
export function segments(path: number[]): Array<{ item: number; start: number; end: number }> {
  const out: Array<{ item: number; start: number; end: number }> = [];
  let i = 0;
  while (i < path.length) {
    let k = i;
    while (k < path.length && path[k] === path[i]) k++;
    out.push({ item: path[i], start: i, end: k });
    i = k;
  }
  return out;
}

/** Indices where the item changes (segment.py boundaries()). */
export function boundaries(path: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < path.length; i++) if (path[i] !== path[i - 1]) out.push(i);
  return out;
}

function argmax(xs: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  return best;
}
