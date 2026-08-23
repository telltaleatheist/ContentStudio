/**
 * One Ollama JSON call, with the thinking-model traps handled once
 *
 * WHY THIS FILE EXISTS. Two very different callers now ask a local qwen model for a JSON
 * object: the chapter pipeline (chapter-whole-transcript.service.ts) and the metadata task units
 * (metadata-tasks.ts, since the text fields moved off the deleted headline adapters onto
 * base models). The chapter pipeline learned four things the hard way, all of them
 * documented in CHAPTERING.md's 2026-08-22 addenda, and none of them are guessable from
 * the Ollama API docs. A second implementation would rediscover them one production bug at
 * a time, so there is one implementation and both callers use it.
 *
 * THE FOUR TRAPS, in the order they bite:
 *
 *  1. `/api/generate`, never `/api/chat`. These models reason by default, and on /api/chat
 *     the reasoning lands in `message.thinking` while `message.content` comes back EMPTY.
 *     /api/generate returns `response` and `thinking` as SEPARATE fields.
 *  2. `think` is NOT sent. `think: false` does not disable thinking — it RELOCATES the
 *     reasoning into `response`, which breaks the JSON and costs more tokens than it saves.
 *  3. `format: "json"` constrains the WHOLE stream, reasoning channel included, so a
 *     thinking model sometimes puts the object in `thinking` and leaves `response` empty.
 *     Observed on nearly every call of the chapter validation run. Handled NARROWLY: read
 *     `thinking` when structured output was requested AND `response` is empty, and say so
 *     in the log. Never otherwise. A caller that sends a full JSON SCHEMA as `format`
 *     (`schema` below) gets the identical treatment — it is the same field and the same
 *     grammar mechanism, only tighter.
 *  4. ONE num_ctx for the whole run, bucketed. Ollama fully reloads the model on ANY
 *     num_ctx change, so a value computed per call turns a run into a series of reloads.
 *     `bucketNumCtx` below is the one sizing rule; it REFUSES rather than truncating,
 *     because a prompt that does not fit is a prompt that lies about what it covers.
 *
 * And one policy that is not a trap: `done_reason: "length"` is a HARD failure for the
 * call. The text is a truncated fragment — half a JSON object, half a quote — and there is
 * nothing to recover from it. It is reported as an unusable ANSWER (`ok: false`), which
 * lets each caller apply its own declared policy: the chapter pipeline drops that one
 * chapter and warns, the metadata units fail the field. Neither of them truncates around it.
 *
 * WHAT THROWS vs WHAT RETURNS `ok: false`. Transport failures throw: Ollama unreachable,
 * model not installed, timeout, cancellation. They affect every remaining call, not this
 * one. An unusable ANSWER — truncated, empty, no JSON in it, unparseable JSON — comes back
 * as a value, because whether that is fatal is the caller's policy and not this file's.
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

export interface OllamaJsonRequest {
  /** Bare Ollama model name, as `ollama list` prints it. No provider prefix. */
  model: string;
  prompt: string;
  /** Trap 4: ONE value for the whole run. Size it with `bucketNumCtx`, once. */
  numCtx: number;
  /** Output budget. Sized for THINKING, not for the answer — see the callers. */
  numPredict: number;
  temperature?: number;
  seed?: number;
  keepAlive?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * What this call is FOR, in a few words ("placing the boundary at 14:52", "the
   * description + tags group"). It is the noun in every log line and every error message
   * this module produces, so an operator reading the log knows which call failed.
   */
  what: string;
  /** Log tag, e.g. `[Chapters] stage "detail"`. */
  logPrefix: string;
  /**
   * A FULL JSON Schema for the answer, sent as Ollama's `format`, instead of the bare
   * `"json"` this module otherwise sends.
   *
   * Ollama's `format` accepts either the string `"json"` — a grammar that only requires
   * SOME valid JSON — or a JSON Schema object, which constrains the keys and their types
   * during decoding. The metadata spec (§5) asks for the schema form on the two mechanical
   * description calls, where the measured win is not the parse but the SUPPRESSED
   * OVER-REASONING: an unconstrained small model asked for one sentence has been measured
   * spending its whole output budget reasoning and never answering.
   *
   * The judgment callers deliberately do NOT set this. Schema-constraining a chapter
   * summarization measurably destroys it (spec §5, chaptering handoff trap #3) — the
   * reasoning that a grammar suppresses is doing real work there.
   *
   * Trap 3 applies to BOTH forms and is handled the same way for both: any structured
   * output can push the object into `thinking`.
   */
  schema?: Record<string, unknown>;
}

/**
 * The answer, or why there is not one.
 *
 * `text` is carried alongside `value` because callers that already own a parser want the
 * raw string: the metadata path runs the same JSON repair the cloud responses go through,
 * and re-serializing the object this module parsed would throw that away.
 */
export type OllamaJsonResult =
  | { ok: true; text: string; value: Record<string, unknown>; readFromThinking: boolean }
  | { ok: false; reason: 'length' | 'empty' | 'no-json' | 'unparseable'; detail: string };

/**
 * Size the context window ONCE for a run (trap 4).
 *
 * Bucketed up so small prompt differences between calls do not reload the model, floored by
 * whatever the caller configured, and REFUSED above `max`. The refusal is the point: the
 * alternative is silently sending a prompt that does not fit, which produces an answer about
 * the first half of the input and no indication that is what happened.
 *
 * `gpuCeiling` is a PERFORMANCE ceiling, not a correctness one — above it the KV cache
 * spills off the GPU and every token slows down — so crossing it warns and continues. A slow
 * correct answer beats a fast wrong one.
 */
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
 * POST one prompt, get one JSON object back.
 *
 * Every trap in this file's header is applied here and nowhere else. Callers supply policy
 * (what to do with `ok: false`) and nothing else.
 */
export async function askOllamaJson(
  client: AxiosInstance,
  request: OllamaJsonRequest
): Promise<OllamaJsonResult> {
  let data: any;
  try {
    const response = await client.post(
      '/api/generate',
      {
        model: request.model,
        prompt: request.prompt,
        stream: false,
        // Trap 3. Requested deliberately: it is what makes the answer parseable, and it is
        // also what can push the object into `thinking`, which readAnswer handles. A caller
        // that supplied a SCHEMA gets the schema — same field, same trap, tighter grammar.
        format: request.schema ?? 'json',
        keep_alive: request.keepAlive || OLLAMA_KEEP_ALIVE,
        // Trap 2: no `think` key. Adding one relocates the reasoning into `response`.
        options: {
          temperature: request.temperature ?? 0,
          // Sent ONLY when the caller asked for one. A pinned seed makes a measurement
          // repeatable (chaptering wants that) and makes a regeneration pointless (metadata
          // does not), so the choice belongs to the caller and there is no default.
          ...(request.seed === undefined ? {} : { seed: request.seed }),
          num_ctx: request.numCtx,
          num_predict: request.numPredict,
        },
      },
      { timeout: request.timeoutMs, signal: request.signal }
    );
    data = response.data;
  } catch (error) {
    throw transportError(error, request);
  }

  if (data?.done_reason === 'length') {
    return {
      ok: false,
      reason: 'length',
      detail:
        `the model hit its ${request.numPredict}-token output ceiling on ${request.what}, so what came back ` +
        `is a truncated fragment rather than an answer`,
    };
  }

  const { text, readFromThinking } = readAnswer(data, request);
  if (!text) {
    return { ok: false, reason: 'empty', detail: `the model returned nothing at all on ${request.what}` };
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      ok: false,
      reason: 'no-json',
      detail: `no JSON object in the answer to ${request.what}: ${text.slice(0, 200)}`,
    };
  }
  try {
    const parsed = JSON.parse(match[0]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        reason: 'unparseable',
        detail: `the answer to ${request.what} parsed to ${JSON.stringify(parsed)}, which is not an object`,
      };
    }
    return { ok: true, text, value: parsed as Record<string, unknown>, readFromThinking };
  } catch {
    return {
      ok: false,
      reason: 'unparseable',
      detail: `unparseable JSON in the answer to ${request.what}: ${match[0].slice(0, 200)}`,
    };
  }
}

/**
 * Trap 3, handled narrowly.
 *
 * Structured output was requested, so when `response` comes back EMPTY and `thinking` does
 * not, the JSON grammar constrained the reasoning channel and the object is in there. Read
 * it, and say so, rather than counting a perfectly good answer as a failure. `response`
 * wins whenever it has anything in it — this is not a preference for `thinking`.
 */
function readAnswer(data: any, request: OllamaJsonRequest): { text: string; readFromThinking: boolean } {
  const response = typeof data?.response === 'string' ? data.response : '';
  if (response.trim().length > 0) return { text: response, readFromThinking: false };

  const thinking = typeof data?.thinking === 'string' ? data.thinking : '';
  if (thinking.trim().length > 0) {
    log.info(
      `${request.logPrefix} answered ${request.what} in the "thinking" field with "response" empty ` +
        `(the format:json grammar constrained the whole stream) — reading the object from there`
    );
    return { text: thinking, readFromThinking: true };
  }
  return { text: '', readFromThinking: false };
}

/**
 * Transport failures, named so the message says what to DO.
 *
 * "Request failed with status code 404" is not an actionable error; "model X is not
 * installed, pull it with `ollama pull X`" is. Nothing here substitutes a model or a host.
 */
function transportError(error: any, request: OllamaJsonRequest): Error {
  if (isAbortError(error)) {
    return new Error(`${request.what} was cancelled by the user (model ${request.model})`);
  }
  const status = error?.response?.status;
  const detail = error?.response?.data?.error || error?.message || 'unknown error';
  if (status === 404) {
    return new Error(
      `${request.what} needs Ollama model "${request.model}", which is not installed. ` +
        `Pull it with: ollama pull ${request.model}`
    );
  }
  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
    return new Error(
      `${request.what} timed out after ${Math.round(request.timeoutMs / 1000)}s (model ${request.model})`
    );
  }
  if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND') {
    return new Error(
      `${request.what} could not reach Ollama at ${hostOf(error)}: ${detail}. ` +
        `Nothing is substituted for a host that is not answering — start Ollama and run it again.`
    );
  }
  return new Error(`${request.what} failed on model ${request.model}: ${detail}`);
}

function hostOf(error: any): string {
  return error?.config?.baseURL || 'the configured host';
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
