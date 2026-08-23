/**
 * One job's model residence, and the context floor that protects it
 *
 * WHY THIS FILE EXISTS. Every stage of a metadata job used to release its Ollama model in its
 * own `finally`: the chapter pipeline when chaptering finished, each field unit and the
 * description unit when runMetadataTasks finished. The next stage — usually the SAME model —
 * then re-streamed ~17GB of weights into unified memory, and the operator's machine froze for
 * the length of every one of those loads. It is visible in the live log as a memory dip, a jump
 * back to the same plateau, and a frozen UI in between. The 10-minute keep-alive in
 * ollama-json.ts exists precisely to span the gap between consecutive calls; the per-stage
 * unloads were defeating the one mechanism that made a job load a model once.
 *
 * So residence is a JOB-scoped fact and it is held here. A stage that makes a model resident
 * says so; the job releases the whole set ONCE, in a `finally` at the end of the job, on the
 * cancelled and failed paths as well as the finished one. Nothing here decides WHICH models a
 * job uses — the routing does, and this object only ever learns what the run actually loaded.
 *
 * THE SECOND RELOAD TRIGGER IS num_ctx. Ollama fully reloads a model on ANY num_ctx change
 * (ollama-json.ts trap 4), so two stages sharing a model and sizing their windows independently
 * reload it between them with nothing unloading anything. `contextFloor` is the ratchet: the
 * largest window this job has asked a model for is the floor for every later call on it. GROWTH
 * still reloads and that is legitimate — a prompt that does not fit needs a bigger window, and
 * refusing to grow would send a prompt that lies about what it covers. SHRINKAGE never is.
 *
 * A HOST THIS JOB STARTED is held separately from a model it made resident, because they are
 * released by different things: a resident model goes with `keep_alive: 0`, and the 32B MLX
 * shim's memory comes back only when its process exits (its keep-alive eviction is a deliberate
 * no-op). Holding both under one key would release one of them and report success.
 */

import axios from 'axios';
import * as log from 'electron-log';
import { unloadOllamaModels } from './ollama-json';

/**
 * The num_ctx floor for a call on a model already resident at `largestSoFar`, under that call's
 * own ceiling.
 *
 * PURE, so both properties are assertable without a model:
 *   - a later call never asks for a SMALLER window than one already resident, which would
 *     reload the model for nothing;
 *   - the ratchet never pushes a call past the ceiling its own stage refuses at. A stage whose
 *     ceiling is under the resident window reloads the model, and that is what a ceiling costs,
 *     not a defect in the floor.
 *
 * Zero means "no floor": it is what `bucketNumCtx` reads as an absent `configured`.
 */
export function contextFloor(largestSoFar: number | undefined, ceiling: number): number {
  if (largestSoFar === undefined) return 0;
  return Math.min(largestSoFar, ceiling);
}

/** What a job is holding: one Ollama model on one host. */
interface HeldModel {
  host: string;
  model: string;
  /** Named the way the operator would read it in the release line: `chapters`, `the titles call`. */
  what: string;
}

/** A server process THIS JOB started. Held apart from a model — see this file's header. */
interface HeldProcess {
  what: string;
  stop: () => void;
}

/**
 * One job's model residence. Created by the orchestrator, threaded to the stages, released once.
 *
 * Explicitly threaded and never a module-level singleton: two jobs are two objects, and a
 * process-wide one would let a finishing job unload the model a running one is mid-call on.
 */
export class JobModelLifecycle {
  /** `host::model` -> the first thing that pulled it in. Several stages on one model, one entry. */
  private readonly models = new Map<string, HeldModel>();
  private readonly processes = new Map<string, HeldProcess>();
  /** model -> the largest num_ctx this job has asked for on it. */
  private readonly contexts = new Map<string, number>();

  /**
   * Declare a model resident. Called by the stage that made it so, AFTER the call that loaded
   * it returned — a model a stage never reached is not this job's to release.
   */
  holdOllamaModel(host: string, model: string, what: string): void {
    const key = `${host}::${model}`;
    if (this.models.has(key)) return;
    this.models.set(key, { host, model, what });
    log.info(`[ModelLifecycle] "${model}" @ ${host} is resident for the rest of this job (${what})`);
  }

  /** Declare a server process this job started, and how to stop it. */
  holdProcess(key: string, what: string, stop: () => void): void {
    this.processes.set(key, { what, stop });
    log.info(`[ModelLifecycle] ${what} runs until the end of this job`);
  }

  /** The floor a call on `model` must not size below, under that call's own hard ceiling. */
  contextFloor(model: string, ceiling: number): number {
    return contextFloor(this.contexts.get(model), ceiling);
  }

  /** Record what a stage actually pinned, so the next stage on that model cannot go under it. */
  recordContext(model: string, numCtx: number): void {
    const previous = this.contexts.get(model);
    if (previous !== undefined && numCtx > previous) {
      log.info(
        `[ModelLifecycle] "${model}" num_ctx grows ${previous} -> ${numCtx} for this call, which reloads it: ` +
          `the prompt does not fit the resident window, and a window that does not fit is a truncated prompt`
      );
    }
    this.contexts.set(model, Math.max(previous ?? 0, numCtx));
  }

  /**
   * Give the machine its memory back, once, at the end of the job.
   *
   * Models before processes: a `keep_alive: 0` posted to a host that has already exited is a
   * warning about nothing. Every holder is released even when one of them fails, because a
   * failure to release is housekeeping (ollama-json's `unloadOllamaModels` warns rather than
   * throwing) and the ones after it are still holding real memory.
   */
  async releaseAll(): Promise<void> {
    if (this.models.size === 0 && this.processes.size === 0) {
      log.info('[ModelLifecycle] this job made no local model resident, so there is nothing to release');
      return;
    }
    const held = [...this.models.values()].map((m) => `${m.model} (${m.what})`);
    log.info(`[ModelLifecycle] releasing this job's models: ${held.join(', ') || 'none'}`);
    for (const model of this.models.values()) {
      await unloadOllamaModels(axios.create({ baseURL: model.host }), [model.model], '[ModelLifecycle]');
    }
    for (const process of this.processes.values()) {
      log.info(`[ModelLifecycle] stopping ${process.what} — its memory comes back when the process exits`);
      process.stop();
    }
    this.models.clear();
    this.processes.clear();
  }
}
