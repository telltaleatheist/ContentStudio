/**
 * One job's model residence: its Crucible leases, and the context floor that protects them
 *
 * WHY THIS FILE EXISTS. Every stage of a metadata job used to release its model in its own
 * `finally`: the chapter pipeline when chaptering finished, each field unit and the description
 * unit when runMetadataTasks finished. The next stage (usually the SAME model) then re-streamed
 * ~17GB of weights into unified memory, and the operator's machine froze for the length of
 * every one of those loads (LEDGER #110: NO UNIT RELEASES A MODEL).
 *
 * So residence is a JOB-scoped fact and it is held here. Since P2 it is held the way Crucible
 * holds a model for a client: ONE LEASE PER JOB PER LOCAL MODEL (plan 13.3), taken by the first
 * call that needs the model and released ONCE, in a `finally` at the end of the job, on the
 * cancelled and failed paths as well as the finished one. The mechanics are
 * electron/crucible/lease.ts (`JobLeases`); this is the face the metadata stages were already
 * threaded with, so none of them learns a second object. Nothing here decides WHICH models a job
 * uses (the routing does), and nothing here unloads one: the lease is released and the server
 * settles its own card.
 *
 * THE SECOND RELOAD TRIGGER IS THE CONTEXT. Loading a model at a different context is a full
 * reload (it was num_ctx on Ollama, LEDGER #111; it is `load-model`'s `params.context` on
 * Crucible), so two stages sharing a model and sizing their windows independently would reload
 * it between them. `contextFloor` is the ratchet: the largest window this job has asked a model
 * for is the floor for every later call on it. GROWTH still reloads and that is legitimate: a
 * prompt that does not fit needs a bigger window, and refusing to grow would send a prompt that
 * lies about what it covers. SHRINKAGE never is.
 */

import * as log from 'electron-log';
import { crucibleTransport } from '../../crucible/transport';
import type { JobLeases } from '../../crucible/lease';

/**
 * The context floor for a call on a model already loaded at `largestSoFar`, under that call's
 * own ceiling.
 *
 * PURE, so both properties are assertable without a model:
 *   - a later call never asks for a SMALLER window than one already loaded, which would
 *     reload the model for nothing;
 *   - the ratchet never pushes a call past the ceiling its own stage refuses at.
 *
 * Zero means "no floor": it is what `bucketLoadContext` reads as an absent `configured`.
 */
export function contextFloor(largestSoFar: number | undefined, ceiling: number): number {
  if (largestSoFar === undefined) return 0;
  return Math.min(largestSoFar, ceiling);
}

/**
 * One job's model residence. Created by the orchestrator, threaded to the stages, released once.
 *
 * Explicitly threaded and never a module-level singleton: two jobs are two objects, and a
 * process-wide one would let a finishing job release the lease a running one is mid-call on.
 */
export class JobModelLifecycle {
  /** model -> the largest context this job has asked for on it. */
  private readonly contexts = new Map<string, number>();
  private jobLeases: JobLeases | null = null;

  constructor(
    /** What the job is, for every lease log line. */
    private readonly what: string = 'the metadata job'
  ) {}

  /**
   * The job's Crucible leases, made on first use, so a job that never reaches a local model
   * (every row on `claude -p`) never needs a server at all.
   */
  get leases(): JobLeases {
    if (this.jobLeases === null) this.jobLeases = crucibleTransport().job(this.what);
    return this.jobLeases;
  }

  /** The floor a call on `model` must not size below, under that call's own hard ceiling. */
  contextFloor(model: string, ceiling: number): number {
    return contextFloor(this.contexts.get(model), ceiling);
  }

  /** Record what a stage actually sized, so the next stage on that model cannot go under it. */
  recordContext(model: string, context: number): void {
    const previous = this.contexts.get(model);
    if (previous !== undefined && context > previous) {
      log.info(
        `[ModelLifecycle] "${model}" load context grows ${previous} -> ${context} for this call, which reloads it: ` +
          `the prompt does not fit the loaded window, and a window that does not fit is a truncated prompt`
      );
    }
    this.contexts.set(model, Math.max(previous ?? 0, context));
  }

  /**
   * Give every lease back, once, at the end of the job. Never throws (it runs in the job's
   * `finally`); a lease that was LOST mid-job was already said loudly when it was lost, and
   * failed the next call on it, and it is said again here so the run log ends with it.
   */
  async releaseAll(): Promise<void> {
    if (this.jobLeases === null) {
      log.info('[ModelLifecycle] this job held no Crucible lease, so there is nothing to release');
      return;
    }
    const lost = await this.jobLeases.releaseAll();
    for (const line of lost) log.error(`[ModelLifecycle] this job's lease on ${line} was lost before the job ended`);
  }
}
