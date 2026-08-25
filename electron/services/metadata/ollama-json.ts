/**
 * Ollama sizing rules and housekeeping, shared by every local caller.
 *
 * THIS FILE USED TO BE the one JSON-call implementation (`askOllamaJson`), with the four
 * thinking-model traps documented at length. The JSON path died with the plain-text ruling
 * (law 12, 2026-08-24: no JSON in generation calls — see plain-call.ts for the living
 * plain-text equivalent, which inherits the same traps) and was deleted in the 2026-08-25
 * cleanup. What remains is what every local caller still needs:
 *
 *  - `OLLAMA_KEEP_ALIVE` / `unloadOllamaModels`: one job loads a model once; the job's
 *    lifecycle releases the set at the end (model-lifecycle.ts).
 *  - `bucketNumCtx` (trap 4, still real): Ollama fully reloads the model on ANY num_ctx
 *    change, so one bucketed value serves the whole run, and it REFUSES rather than
 *    truncating — a prompt that does not fit is a prompt that lies about what it covers.
 *  - `estimateTokens` / `TOKENS_PER_WORD`: the sizing estimates this codebase uses.
 */

import { AxiosInstance } from 'axios';
import * as log from 'electron-log';
import { isAbortError } from './cancellation';

/**
 * Long enough to span the gap between consecutive calls, so the model stays resident.
 *
 * This is the whole mechanism by which one job loads a model once. It only works because
 * NOTHING releases a model between stages any more: model-lifecycle.ts holds the job's set and
 * releases it in a finally at the end of the JOB. The per-stage unloads this replaced were
 * defeating exactly this value.
 */
export const OLLAMA_KEEP_ALIVE = '10m';

/** Trap 4. Ollama fully reloads the model on ANY num_ctx change — bucket coarsely. */
export const CTX_BUCKET = 4096;

/** Tokens per transcript word / per prompt character — the estimates this codebase uses. */
export const TOKENS_PER_WORD = 1.4;
const CHARS_PER_TOKEN = 3.5;

export function bucketNumCtx(options: {
  /** Largest prompt this run will send, in tokens. */
  promptTokens: number;
  numPredict: number;
  /** Configured floor. Can only raise the computed value, never lower it. */
  configured?: number;
  /** Hard refusal point. */
  max: number;
  /** Warn-and-continue point. Omit when the caller has no measurement for one. */
  gpuCeiling?: number;
  logPrefix: string;
  /** Named in the refusal so the operator knows what to shorten. */
  what: string;
}): number {
  const needed = options.promptTokens + options.numPredict + 512;
  const bucketed = Math.ceil(needed / CTX_BUCKET) * CTX_BUCKET;
  const numCtx = Math.max(bucketed, options.configured || 0);

  if (numCtx > options.max) {
    throw new Error(
      `${options.what} needs a context window of ~${numCtx} tokens, above the ${options.max} ceiling. ` +
        `Truncating it would send a prompt that covers less than it claims to, so the run stops instead.`
    );
  }
  if (options.gpuCeiling && numCtx > options.gpuCeiling) {
    log.warn(
      `${options.logPrefix} num_ctx ${numCtx} is above the ~${options.gpuCeiling} point where the KV cache ` +
        `still fits on the GPU; this run will be slower (still correct)`
    );
  }
  return numCtx;
}

/** Prompt characters -> tokens, using this codebase's estimate. */
export function estimateTokens(promptChars: number): number {
  return Math.ceil(promptChars / CHARS_PER_TOKEN);
}

/**
 * Let the resident models go.
 *
 * Housekeeping, and warned rather than thrown: a model this fails to release costs VRAM
 * until Ollama's own keep-alive timer fires, which is not worth failing a finished run over.
 */
export async function unloadOllamaModels(
  client: AxiosInstance,
  models: Iterable<string>,
  logPrefix: string
): Promise<void> {
  for (const model of new Set([...models].filter(Boolean))) {
    try {
      await client.post('/api/generate', { model, prompt: '', keep_alive: 0 }, { timeout: 30_000 });
    } catch (error: any) {
      log.warn(`${logPrefix} could not unload "${model}": ${error?.message || error}`);
    }
  }
}
