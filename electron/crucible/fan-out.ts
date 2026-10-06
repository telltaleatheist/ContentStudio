/**
 * ONE JOB'S INDEPENDENT MODEL CALLS, SENT TOGETHER (LEDGER #270, Owen 2026-10-06: "Yes, where
 * independent").
 *
 * THE FACT THIS RESTS ON (crucible-pc-1, 2026-10-06). Every 9B/27B engine Crucible runs serves 16
 * chats side by side: vLLM `--max-num-seqs 16` on the PC, mlx-lm `--decode-concurrency 16` on the
 * Mac. Past 16 the server queues them (ContentStudio sends no `queue` member, so they wait). Until
 * #269 a video's field calls went one at a time, because the lane's SLOT (lanes.ts) let one GPU
 * call run on a server at a time, and the cloud ones were simply awaited in a loop.
 *
 * WHAT THIS MODULE IS: two small tools the pipeline's schedulers share, and nothing that decides
 * WHAT is independent (each scheduler states its own dependency map where it schedules:
 * metadata-tasks.ts `runMetadataTasks`, scrub.ts `scrubGeneratedItem`, reroll/gate.ts `runGate`).
 *
 *   settleTogether(tasks, cap)  runs the tasks at once, at most `cap` in flight, WAITS FOR EVERY
 *                               ONE TO SETTLE (a failure never leaves a sibling running unowned
 *                               after the stage that sent it has moved on), and answers each
 *                               task's outcome IN TASK ORDER. The caller reads them in that order,
 *                               so the first failure it throws is the one a one-at-a-time loop
 *                               would have met first, and what it writes lands in the order it
 *                               always did.
 *   inOrder(effect)             a side effect whose ORDER is part of the output (a `_prompt_trace`
 *                               entry, a run warning): run now outside a fan-out; inside one, held
 *                               by its task and run when the fan-out settles, task by task. Nested
 *                               fan-outs compose: an inner one's effects land in its enclosing
 *                               task's list, in order.
 *
 * WHY THE EFFECTS ARE HELD. Several calls in flight finish in whatever order the engine answers
 * them; a trace or a warnings list written as they finish would differ run to run for the same
 * work. Held and replayed in task order, a run's trace and warnings read exactly as the sequential
 * run's did. Nothing is dropped: a task that failed still has its effects replayed (a request that
 * failed was still sent, Law 8).
 *
 * THE CAP IS {@link JOB_CALLS_PER_SERVER}, the engine width. The lane's slot enforces it for a
 * job's GPU calls on one server (lanes.ts); the fan-out enforces it for any mix, cloud included.
 */
import { AsyncLocalStorage } from 'async_hooks';

/**
 * How many of ONE admitted job's own model calls may be in flight together on one server, and how
 * many tasks one fan-out runs at once. 16 is the engine width Crucible states for every 9B/27B
 * engine (vLLM `--max-num-seqs 16`, mlx-lm `--decode-concurrency 16`, crucible-pc-1 2026-10-06):
 * more than that would only wait in the server's own queue. Whether the CARD holds that many at the
 * calls' size is a separate question the job's session asks the server before each extra call
 * (session.ts `CardSession.admit`, the width question).
 */
export const JOB_CALLS_PER_SERVER = 16;

interface Branch {
  readonly effects: Array<() => void>;
}

const branchStore = new AsyncLocalStorage<Branch>();

/** Run `effect` now, or, inside a fan-out task, when the fan-out settles, in task order (see the header). */
export function inOrder(effect: () => void): void {
  const branch = branchStore.getStore();
  if (branch === undefined) effect();
  else branch.effects.push(effect);
}

/**
 * Run every task at once (at most `cap` in flight), wait for all of them, replay their held effects
 * in task order, and answer each outcome in task order. Never rejects: the caller decides what a
 * failure costs (see {@link valuesInOrder}).
 */
export async function settleTogether<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  cap: number = JOB_CALLS_PER_SERVER,
): Promise<Array<PromiseSettledResult<T>>> {
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`a fan-out's cap is a whole number of calls, at least 1; got ${cap}`);
  const branches: Branch[] = tasks.map(() => ({ effects: [] }));
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await branchStore.run(branches[i], tasks[i]) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cap, tasks.length) }, () => worker()));
  // In the caller's own context: an enclosing fan-out's task holds them in turn.
  for (const branch of branches) for (const effect of branch.effects) inOrder(effect);
  return results;
}

/** Every task's value in task order, or the FIRST failure in task order thrown as itself. */
export function valuesInOrder<T>(settled: ReadonlyArray<PromiseSettledResult<T>>): T[] {
  const values: T[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'rejected') throw outcome.reason;
    values.push(outcome.value);
  }
  return values;
}
