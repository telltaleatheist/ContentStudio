/**
 * One plain-text model call, and the parsers that read its answers
 *
 * WHY THIS FILE EXISTS (operator's ruling, 2026-08-24): "no more JSON for these calls unless
 * absolutely necessary." Every generation call in the metadata pipeline asks for ONE thing —
 * ten titles, one tag line, one description, one chapter's name and summary — and wrapping
 * those answers in JSON string literals is where an entire failure class lived: the
 * close-quote runaway (a model writes ” where the string's closing " belongs and the schema
 * grammar masks end-of-message), the `"..."`-as-whole-body bail-out, the repair ladder, the
 * truncation recovery. A paragraph asked for as a paragraph has none of those places to fail.
 *
 * WHAT A PLAIN CALL IS. A filled prompt in, text out, with NO JSON machinery on either
 * transport:
 *   local — /api/generate with the run's context and output budgets, NO `format` field,
 *           NO `think` key (ollama-json trap 2: `think: false` relocates the reasoning into
 *           `response`), no sampling parameters (operator's ruling 2026-08-24: provider
 *           defaults everywhere).
 *   cloud — AIManagerService.runPlainRequest: no output_config, no JSON system nudge, no
 *           stop sequences; the 4000-token max_tokens stays as a runaway brake.
 *
 * Without `format: "json"` the local models put their reasoning in the separate `thinking`
 * field and the answer in `response`; a model that inlines `<think>` blocks anyway has them
 * stripped here, once, for every caller.
 *
 * WHAT THROWS vs WHAT RETURNS `ok: false` — the same split ollama-json.ts draws, because the
 * callers' policies are built on it: a TRANSPORT failure (host unreachable, model missing,
 * timeout, cancellation) throws, an unusable ANSWER (truncated by the output budget, empty)
 * comes back as a value and the caller applies its own declared policy.
 *
 * THE PARSERS live here so the formats have one home beside the transport that carries them.
 * Each one reads exactly the shape its prompt asks for and THROWS naming what it got when the
 * answer is not that shape — the caller's one-re-ask policy is the recovery, never a silent
 * repair (deliver-and-curate governs what happens after the re-ask, and it is the caller's
 * call).
 */

import { AxiosInstance } from 'axios';
import { isAbortError } from './cancellation';

/**
 * Inline reasoning, removed. `<think>...</think>` blocks are the one thing a plain answer can
 * carry that is not the answer; an unterminated block (the model hit its budget mid-thought)
 * takes everything from `<think>` on with it, because half a thought is not an answer either.
 */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();
}

export interface OllamaPlainRequest {
  /** Bare Ollama model name, as `ollama list` prints it. No provider prefix. */
  model: string;
  prompt: string;
  /** ONE value for the whole run (ollama-json trap 4) — the caller's budget resolves it. */
  numCtx: number;
  /** Output budget. Sized for THINKING as much as the answer — see the callers. */
  numPredict: number;
  keepAlive?: string;
  /**
   * Sampling temperature, sent only when set. The 2026-08-24 no-sampling-parameters ruling
   * stands for every ordinary call — provider defaults, and a model that cannot perform there
   * is replaced, not tuned. This field exists for the ONE caller that ruling was never about:
   * the chapter stage's consensus sampling (2026-08-30 campaign), which asks the same question
   * several times ON PURPOSE and majority-votes the answers. Diversity across those samples is
   * the mechanism, not a rescue, and 0.7 is the measured setting (chapter-campaign ledger,
   * rounds 8-12: default temp gave 19-vs-14-chapter run variance; 0.2 froze one mediocre
   * reading; 0.7 with a >=3-of-5 vote produced the boundary sets that matched the shipped
   * baseline). Leave it unset everywhere else.
   */
  temperature?: number;
  /**
   * `false` disables the model's thinking pass — set ONLY by the chapter stage's consensus
   * samples and its name-scaffold call (2026-08-30 campaign), and it changes the TRANSPORT:
   * the request goes to /api/chat, where `think: false` genuinely turns thinking off and the
   * answer arrives alone in `message.content`. It must never be sent to /api/generate — trap 2
   * (ollama-json.ts): there it does not disable thinking, it RELOCATES the reasoning into
   * `response`, which for a plain call means reasoning prose above the answer lines.
   *
   * Why it exists: five consensus samples at temperature 0.7 with thinking ON produced
   * 15-minute reasoning loops on a 10-minute video (verified on the first integration run);
   * the campaign's measured recipe ran /api/chat + think:false for every sample all night at
   * about a minute per sample with clean line output. Leave it unset everywhere else: the
   * detail calls' quality was measured with thinking on, and they keep it.
   */
  think?: false;
  timeoutMs: number;
  signal?: AbortSignal;
  /** What this call is FOR, in a few words. The noun in every log and error message here. */
  what: string;
  /** Log tag, e.g. `[Chapters] stage "detail"`. */
  logPrefix: string;
}

export type OllamaPlainResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'length' | 'empty'; detail: string };

/** Matches ollama-json's keep-alive so a mixed run still loads each model once. */
const PLAIN_KEEP_ALIVE = '10m';

/**
 * POST one prompt, get plain text back.
 *
 * No `format`, no `think`, no sampling options — the request body is the smallest thing that
 * carries the prompt and the two budgets.
 */
export async function askOllamaPlain(
  client: AxiosInstance,
  request: OllamaPlainRequest
): Promise<OllamaPlainResult> {
  const options = {
    num_ctx: request.numCtx,
    num_predict: request.numPredict,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  };
  let data: any;
  try {
    const response =
      request.think === false
        ? await client.post(
            '/api/chat',
            {
              model: request.model,
              messages: [{ role: 'user', content: request.prompt }],
              stream: false,
              think: false,
              keep_alive: request.keepAlive || PLAIN_KEEP_ALIVE,
              options,
            },
            { timeout: request.timeoutMs, signal: request.signal }
          )
        : await client.post(
            '/api/generate',
            {
              model: request.model,
              prompt: request.prompt,
              stream: false,
              keep_alive: request.keepAlive || PLAIN_KEEP_ALIVE,
              options,
            },
            { timeout: request.timeoutMs, signal: request.signal }
          );
    data = response.data;
  } catch (error) {
    throw plainTransportError(error, request);
  }

  if (data?.done_reason === 'length') {
    return {
      ok: false,
      reason: 'length',
      detail:
        `the model hit its ${request.numPredict}-token output ceiling on ${request.what}, so what came ` +
        `back is a truncated fragment rather than an answer`,
    };
  }

  const raw =
    request.think === false
      ? typeof data?.message?.content === 'string'
        ? data.message.content
        : ''
      : typeof data?.response === 'string'
        ? data.response
        : '';
  const text = stripThinking(raw);
  if (text.length === 0) {
    // The `thinking` field is deliberately NOT read as the answer here: without a JSON
    // grammar there is nothing to push the answer into it, so a run whose `response` is
    // empty produced reasoning and no answer — which is an unusable answer, not a hidden one.
    return { ok: false, reason: 'empty', detail: `the model returned no answer text on ${request.what}` };
  }
  return { ok: true, text };
}

/** Transport failures, named so the message says what to DO — mirrors ollama-json's wording. */
function plainTransportError(error: any, request: OllamaPlainRequest): Error {
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
      `${request.what} could not reach Ollama at ${error?.config?.baseURL || 'the configured host'}: ` +
        `${detail}. Nothing is substituted for a host that is not answering — start Ollama and run it again.`
    );
  }
  return new Error(`${request.what} failed on model ${request.model}: ${detail}`);
}

// ---------------------------------------------------------------------------
// The parsers — one per output shape the prompts ask for
// ---------------------------------------------------------------------------

/**
 * A leading list marker, tolerated as NORMALIZATION rather than demanded: the prompts ask for
 * bare lines, and a model that numbers them anyway has still answered — "1. " or "- " in front
 * of a title is decoration, not content. Anything beyond these two shapes is the line's text.
 */
const LIST_MARKER = /^\s*(?:[-*•]\s+|\d{1,3}[.)]\s+)/;

/**
 * One answer per line.
 *
 * Blank lines separate nothing and are dropped; list markers are stripped. An answer with no
 * lines at all throws — there is nothing for the caller's count checks to even count.
 */
export function parseLines(text: string, what: string): string[] {
  const lines = text
    .split('\n')
    .map((line) => line.replace(LIST_MARKER, '').trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error(`The answer to ${what} contains no lines at all (got: "${text.slice(0, 120)}")`);
  }
  return lines;
}

/**
 * A description: the hook on the first line, a blank line, then the body.
 *
 * The blank line is the format's one structural element and it is REQUIRED: a first "line"
 * that runs straight into the body is a model that did not write a standalone search snippet,
 * and no split this code could invent would recover the sentence it did not write. The caller's
 * one-re-ask policy is the recovery.
 */
export function parseHookBody(text: string, what: string): { hook: string; body: string } {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const blankAt = normalized.search(/\n\s*\n/);
  if (blankAt === -1) {
    throw new Error(
      `The answer to ${what} is not in the hook / blank line / body shape — it has no blank line ` +
        `(got: "${normalized.slice(0, 120)}")`
    );
  }
  const hook = normalized.slice(0, blankAt).replace(/\n/g, ' ').trim();
  const body = normalized.slice(blankAt).trim();
  if (hook.length === 0 || body.length === 0) {
    throw new Error(
      `The answer to ${what} has an empty ${hook.length === 0 ? 'opening line' : 'body'} around its blank line`
    );
  }
  return { hook, body };
}

/**
 * A chapter: its title on the first line, its detail on the lines after it.
 *
 * The detail lines are joined into one paragraph — the prompt asks for 2-3 sentences, and a
 * model that wraps them across lines has still written one detail. A missing detail is NOT an
 * error here: the caller's declared policy for a chapter that could not be described is a
 * warning and an empty detail, so the empty string is an answer this parser must be able to
 * hand back.
 */
export function parseTitleDetail(text: string, what: string): { title: string; detail: string } {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(LIST_MARKER, '').trim());
  const firstAt = lines.findIndex((line) => line.length > 0);
  if (firstAt === -1) {
    throw new Error(`The answer to ${what} contains no title line at all (got: "${text.slice(0, 120)}")`);
  }
  const title = lines[firstAt];
  const detail = lines
    .slice(firstAt + 1)
    .filter((line) => line.length > 0)
    .join(' ')
    .trim();
  return { title, detail };
}
