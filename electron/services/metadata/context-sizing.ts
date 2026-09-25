/**
 * How a local call's LOAD CONTEXT is sized, shared by every local caller.
 *
 * WHAT THIS REPLACED. This was ollama-json.ts: once the one JSON-call implementation, then the
 * Ollama sizing rules and housekeeping (`OLLAMA_KEEP_ALIVE`, `unloadOllamaModels`). Ollama left
 * the call path with P2 (every model call goes through Crucible, LEDGER #193), and with it the
 * keep-alive (a lease holds the model now, electron/crucible/lease.ts) and the unload (the job
 * releases its lease; nothing here unloads a model). What is left is what still decides a
 * number:
 *
 *  - `bucketLoadContext` (LEDGER #111, still real): loading a model at a different context is
 *    a FULL reload on Crucible just as a num_ctx change was on Ollama, so one bucketed value
 *    serves the whole run, and it REFUSES rather than truncating: a prompt that does not fit is
 *    a prompt that lies about what it covers. The number is what the job asks `load-model` for
 *    (`params.context`); the server holds to it or refuses above its ceiling.
 *  - `estimateTokens` / `TOKENS_PER_WORD`: the sizing estimates this codebase uses. The token
 *    estimate lives beside the check before sending (crucible/context-check.ts) so the door that
 *    checks and the callers that size share one copy.
 */

import * as log from 'electron-log';
import { estimateTokens } from '../../crucible/context-check';

export { estimateTokens };

/** Bucket coarsely: every different context is a reload (LEDGER #111). */
export const CONTEXT_BUCKET = 4096;

/** Tokens per transcript word, the estimate this codebase uses. */
export const TOKENS_PER_WORD = 1.4;

export function bucketLoadContext(options: {
  /** Largest prompt this run will send, in tokens; or give `promptChars`. */
  promptTokens?: number;
  promptChars?: number;
  /** The call's output budget. */
  maxTokens: number;
  /** Configured floor. Can only raise the computed value, never lower it. */
  configured?: number;
  /** Hard refusal point. */
  max: number;
  /** Warn-and-continue point. Omit when the caller has no measurement for one. */
  gpuCeiling?: number;
  logPrefix?: string;
  /** Named in the refusal so the operator knows what to shorten. */
  what: string;
}): number {
  const promptTokens = options.promptTokens ?? estimateTokens(options.promptChars ?? 0);
  const needed = promptTokens + options.maxTokens + 512;
  const bucketed = Math.ceil(needed / CONTEXT_BUCKET) * CONTEXT_BUCKET;
  const context = Math.max(bucketed, options.configured || 0);

  if (context > options.max) {
    throw new Error(
      `${options.what} needs a context window of ~${context} tokens, above the ${options.max} ceiling. ` +
        `Truncating it would send a prompt that covers less than it claims to, so the run stops instead.`
    );
  }
  if (options.gpuCeiling && context > options.gpuCeiling) {
    log.warn(
      `${options.logPrefix ?? '[Context]'} context ${context} is above the ~${options.gpuCeiling} point where the KV cache ` +
        `still fits on the GPU; this run will be slower (still correct)`
    );
  }
  return context;
}
