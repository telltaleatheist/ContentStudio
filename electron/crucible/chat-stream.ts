/**
 * A STREAMED CHAT, READ WHOLE: the text, the engine's own `finish_reason` and its usage, and
 * a sign of life per chunk.
 *
 * WHY THE DOOR STREAMS (P3's contract, docs/crucible/P3.md): each queue job runs a 10-minute
 * STALL clock that silence ends and work does not. A non-streamed chat is silent until it is
 * whole, and a whole-transcript chapter call has been measured sitting for minutes on one
 * answer, so a long-thinking call would be ended as a stall while it was working. Streamed, it
 * beats on every chunk, reasoning included.
 *
 * WHY NOT THE SDK'S `chatStream()`: it yields the content deltas only, and drops the closing
 * frame's `finish_reason` and the usage frame. A `length` stop is the hard failure LEDGER #112
 * is built on, and a missing `finish_reason` must be REFUSED rather than read as `stop` (plan
 * 0a; Briefcase's `readReply`, which the SDK's non-streamed `chat()` also enforces). So this
 * reads the same frames the SDK reads, with the SDK's rules (`[DONE]` or it is truncated, a
 * non-string `content` is a protocol error, reasoning with no answer is refused by name), and
 * keeps the two fields it throws away.
 *
 * A REFUSAL IS THE SDK'S OWN TYPE (`refusalOf`): 401 CrucibleAuthError, 426
 * CrucibleVersionError, 5xx CrucibleServerError, 4xx CrucibleRefused, built from the server's
 * `{"error": {code, message, details}}` exactly as the SDK's `#failure` builds them, so P3's
 * `parkRefusalOf` reads a busy chat door by type and code the way it reads every other door.
 */
import {
  CrucibleAuthError,
  CrucibleProtocolError,
  CrucibleRefused,
  CrucibleServerError,
  CrucibleUnreachable,
  CrucibleVersionError,
} from '@crucible/client';

export interface StreamedChat {
  text: string;
  /** The engine's word, from the frame that carried it. Never defaulted. */
  finishReason: string;
  /** Null when no usage frame came; each count null where the engine did not state it. */
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | null;
  /** Characters of reasoning the engine streamed beside the answer (none when thinking is off). */
  reasoningChars: number;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** A non-2xx answer as the SDK's own refusal type (its `#failure`, for the chat door). */
export async function refusalOf(response: Response, url: string): Promise<Error> {
  const text = await response.text().catch(() => '');
  let envelope: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.error !== 'object' || parsed.error === null) throw new Error('no envelope');
    envelope = parsed.error as Record<string, unknown>;
  } catch {
    return new CrucibleProtocolError(`HTTP ${response.status} from ${url} is not a crucible error ({"error": {"code", "message"}}); it said: ${excerpt(text)}`);
  }
  const code = typeof envelope['code'] === 'string' ? envelope['code'] : `http_${response.status}`;
  const message = typeof envelope['message'] === 'string' ? envelope['message'] : `HTTP ${response.status}`;
  const details = 'details' in envelope ? envelope['details'] : null;
  if (response.status === 401) return new CrucibleAuthError(code, message);
  if (response.status === 426) {
    const stated = (details as { server_api_version?: unknown } | null)?.server_api_version;
    return new CrucibleVersionError(code, message, typeof stated === 'number' ? stated : null, 1);
  }
  if (response.status >= 500) return new CrucibleServerError(response.status, code, message, details);
  if (response.status >= 400) return new CrucibleRefused(response.status, code, message, details);
  return new CrucibleProtocolError(`HTTP ${response.status} from ${url} is neither a success nor a refusal`);
}

function count(usage: Record<string, unknown>, key: string): number | null {
  const value = usage[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Read an OpenAI `chat.completion.chunk` stream to its `[DONE]`. `onLife` is called for every
 * frame that carried anything (content, reasoning, the finish, the usage): the stall clock's beat.
 */
export async function readChatStream(response: Response, url: string, onLife: () => void): Promise<StreamedChat> {
  if (response.body === null) throw new CrucibleProtocolError(`the chat stream from ${url} has no body`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let text = '';
  let reasoningChars = 0;
  let finishReason: string | null = null;
  let usage: StreamedChat['usage'] = null;
  let done = false;
  const frame = (raw: string): void => {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '') continue;
      if (data === '[DONE]') {
        done = true;
        return;
      }
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        throw new CrucibleProtocolError(`a chat stream frame from ${url} is not JSON: ${excerpt(data)}`);
      }
      const error = chunk['error'];
      if (error !== null && typeof error === 'object') {
        const e = error as { code?: unknown; message?: unknown };
        throw new CrucibleServerError(502, typeof e.code === 'string' ? e.code : 'stream_error', typeof e.message === 'string' ? e.message : 'the engine failed mid-answer', error);
      }
      const choices = chunk['choices'];
      if (Array.isArray(choices) && choices.length > 0 && choices[0] !== null && typeof choices[0] === 'object') {
        const choice = choices[0] as Record<string, unknown>;
        const delta = (choice['delta'] ?? {}) as Record<string, unknown>;
        const content = delta['content'];
        if (content !== undefined && content !== null) {
          if (typeof content !== 'string') throw new CrucibleProtocolError(`a chat stream frame from ${url} carries a non-string content`);
          text += content;
        }
        for (const key of ['reasoning', 'reasoning_content']) {
          const reasoning = delta[key];
          if (typeof reasoning === 'string') reasoningChars += reasoning.length;
        }
        const reason = choice['finish_reason'];
        if (typeof reason === 'string') finishReason = reason;
      }
      const stated = chunk['usage'];
      if (stated !== null && typeof stated === 'object') {
        const u = stated as Record<string, unknown>;
        const promptTokens = count(u, 'prompt_tokens');
        const completionTokens = count(u, 'completion_tokens');
        usage = {
          promptTokens,
          completionTokens,
          totalTokens: count(u, 'total_tokens') ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null),
        };
      }
      onLife();
    }
  };
  try {
    while (!done) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      buffered += decoder.decode(value, { stream: true });
      let split: number;
      while (!done && (split = buffered.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffered.slice(0, split);
        buffered = buffered.slice(split).replace(/^\r?\n\r?\n/, '');
        frame(raw.replace(/\r/g, ''));
      }
    }
    if (!done && buffered.trim() !== '') frame(buffered.replace(/\r/g, ''));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!done) {
    throw new CrucibleUnreachable(url, "the chat completion stream ended without OpenAI's [DONE] terminator; the answer is truncated");
  }
  if (finishReason === null) {
    // Refused, never defaulted to `stop` (plan 0a): a `length` stop nobody reported would be
    // a truncated answer used as a whole one.
    throw new CrucibleProtocolError(`the chat stream from ${url} ended without a finish_reason, so a whole answer cannot be told from a cut-off one`);
  }
  if (text === '' && reasoningChars > 0 && finishReason !== 'length') {
    // The SDK's `refuseReasoningWithoutContent`, for a stream: a thinking pass and no answer.
    throw new CrucibleProtocolError(
      `the model streamed ${reasoningChars} characters of reasoning and no answer (finish_reason ${JSON.stringify(finishReason)}). ` +
        'This is a reasoning model thinking before it answers: raise the budget, or state thinking off.',
    );
  }
  return { text, finishReason, usage, reasoningChars };
}
