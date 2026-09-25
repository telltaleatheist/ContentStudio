/**
 * THE CHECK BEFORE SENDING (plan 6.1, 7.2): a local call's prompt plus its
 * output budget must fit the context the model is LOADED with on the server
 * that will run it, or the call throws before anything is sent, naming the
 * model, the server and both numbers.
 *
 * It replaces the middle-truncation `makeOllamaRequest` used to do (Law 1: a
 * prompt cut to fit is a prompt that lies about what it covers), and it is the
 * same refusal `bucketNumCtx` has always made for a window this app sized
 * itself; the difference is that the window is now the server's, read off
 * `GET /v1/models`, never assumed.
 *
 * PURE, so every branch is assertable without a server.
 *
 * WHICH NUMBER IS "LOADED" (plan 0a, Briefcase's lesson): since Crucible 1.0.25
 * `max_model_len` is nullable. The order is:
 *   1. `max_model_len` of the resident model: what the engine was started with;
 *   2. else the context THIS job asked the load for (`params.context`), which
 *      the server holds to or refuses;
 *   3. else the host's ceiling for the model (`capability()`'s `generate` row,
 *      `context_ceilings`);
 *   4. else a named refusal. Briefcase shipped a 16K guess here first and had
 *      to take it out: a guessed window is a Law 1 fallback.
 */
import { CrucibleCallError } from './errors';

/**
 * This codebase's estimate: 3.5 characters a token. The rule stays today's
 * (plan 7.2); it moved here from ollama-json.ts so the door that checks and the
 * callers that size share one copy.
 */
export const CHARS_PER_TOKEN = 3.5;

/** Prompt characters to tokens, by this codebase's estimate. */
export function estimateTokens(promptChars: number): number {
  return Math.ceil(promptChars / CHARS_PER_TOKEN);
}

export interface LoadedContext {
  tokens: number;
  /** Which of the four sources above the number came from, for the refusal and the log. */
  source: 'max_model_len' | 'load_context' | 'context_ceiling';
}

/** The context in force, from what the server stated, or null when it stated none. */
export function loadedContextOf(stated: {
  maxModelLen: number | null;
  loadedAt: number | null;
  ceiling: number | null;
}): LoadedContext | null {
  if (stated.maxModelLen !== null) return { tokens: stated.maxModelLen, source: 'max_model_len' };
  if (stated.loadedAt !== null) return { tokens: stated.loadedAt, source: 'load_context' };
  if (stated.ceiling !== null) return { tokens: stated.ceiling, source: 'context_ceiling' };
  return null;
}

/** What one local call needs of a window: its estimated prompt tokens plus its output budget. */
export function tokensNeeded(promptChars: number, maxTokens: number): number {
  return estimateTokens(promptChars) + maxTokens;
}

/**
 * Throw `over_context` (or `context_unstated`) BEFORE the call is sent.
 * Returns the need, for the log line that says it fit.
 */
export function checkBeforeSending(call: {
  model: string;
  server: string;
  what: string;
  promptChars: number;
  maxTokens: number;
  loaded: LoadedContext | null;
}): number {
  const need = tokensNeeded(call.promptChars, call.maxTokens);
  if (call.loaded === null) {
    throw new CrucibleCallError(
      'context_unstated',
      `"${call.server}" states no context for ${call.model} (no max_model_len, no load context, no ` +
        `context ceiling), so ${call.what} cannot be checked against it before sending. Nothing was sent; ` +
        `a guessed window would be a prompt that might be cut without anyone saying so.`,
      call.server,
    );
  }
  if (need > call.loaded.tokens) {
    throw new CrucibleCallError(
      'over_context',
      `${call.what} needs ~${need} tokens (~${estimateTokens(call.promptChars)} of prompt plus a ` +
        `${call.maxTokens}-token output budget), and ${call.model} on "${call.server}" is loaded with ` +
        `${call.loaded.tokens} (${call.loaded.source.replace(/_/g, ' ')}). Nothing was sent and nothing ` +
        `was cut: shorten what this call carries, or route it to a model with more room.`,
      call.server,
    );
  }
  return need;
}
