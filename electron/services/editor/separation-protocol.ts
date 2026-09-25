/**
 * THE VOICE-ISOLATION EXCHANGE between editor-backend/core/voice_separation.py
 * and the main process (LEDGER #200, plan section 9).
 *
 * Python keeps the audio logic and asks for the model call, one chunk at a
 * time, on the workflow's stdout; main runs the Crucible `denoise` job
 * (electron/crucible/denoise.ts) and answers on its stdin:
 *
 *   ← {"type":"separation_request","wav","out","chunk","chunks","track"}
 *   → {"type":"separation_complete","out":<stem>}   or   {"type":"separation_complete","error":<why>}
 *   ← {"type":"separation_release"}                  the track is done: give the card back
 *
 * The message shapes are a cross-layer contract, so they are typed and parsed
 * here once (Law 10), and python-service.ts only routes lines to this module.
 * Every request is ANSWERED, error or not: Python blocks on stdin, and a
 * request that got no answer would hang the run instead of failing it.
 */
import type { VoiceIsolationProgress } from '../../crucible/denoise';

export const SEPARATION_REQUEST = 'separation_request';
export const SEPARATION_COMPLETE = 'separation_complete';
export const SEPARATION_RELEASE = 'separation_release';

export interface SeparationRequest {
  /** The 44.1 kHz chunk voice_separation.py extracted. */
  readonly wav: string;
  /** Where it wants the vocal stem written. */
  readonly out: string;
  /** 1-based, of `chunks`: the plan's numbering, silent chunks included. */
  readonly chunk: number;
  readonly chunks: number;
  /** "mic 1": what the operation row calls the track. */
  readonly track: string;
}

/**
 * Runs one request: resolves with the stem's path, or rejects with the reason
 * the run aborts. `signal` aborts when the workflow ends (a cancel kills the
 * process), and the job it was running is DELETEd.
 */
export type SeparationHandler = (request: SeparationRequest, signal: AbortSignal) => Promise<string>;

/** A request, or the reason it is not one (answered as an error, never dropped). */
export function parseSeparationRequest(message: Record<string, unknown>): SeparationRequest | string {
  const { wav, out, chunk, chunks, track } = message;
  if (typeof wav !== 'string' || wav === '') return "separation_request has no 'wav' path";
  if (typeof out !== 'string' || out === '') return "separation_request has no 'out' path";
  if (typeof chunk !== 'number' || typeof chunks !== 'number' || !Number.isInteger(chunk) || !Number.isInteger(chunks)
    || chunk < 1 || chunk > chunks) {
    return `separation_request's chunk ${String(chunk)} of ${String(chunks)} is not a position in a plan`;
  }
  if (typeof track !== 'string' || track === '') return "separation_request has no 'track' label";
  return { wav, out, chunk, chunks, track };
}

/**
 * One request, answered: the handler's stem path, or its failure's message.
 * `write` puts one line on the workflow's stdin.
 */
export async function answerSeparationRequest(
  message: Record<string, unknown>,
  handler: SeparationHandler | undefined,
  write: (line: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const answer = (body: { out: string } | { error: string }): void => {
    write(JSON.stringify({ type: SEPARATION_COMPLETE, ...body }) + '\n');
  };
  const request = parseSeparationRequest(message);
  if (typeof request === 'string') {
    answer({ error: request });
    return;
  }
  if (handler === undefined) {
    // A workflow started without a handler cannot isolate voice; saying so
    // beats Python waiting forever on a line nobody will write.
    answer({ error: 'this workflow was started without voice isolation wired to a Crucible' });
    return;
  }
  try {
    answer({ out: await handler(request, signal) });
  } catch (err) {
    answer({ error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * The operation row's line and bar for one job event, WITHIN the chunk: the
 * bar sits at `(chunk - 1 + fraction) / chunks`, between the CHUNK lines
 * electron_workflow.py emits after each chunk lands. A fraction is the
 * server's; warming, uploading and parked leave the bar where the chunk began.
 */
export function separationProgress(
  request: SeparationRequest,
  progress: VoiceIsolationProgress,
  server: string,
): { message: string; subProgress: number } {
  const fraction = progress.kind === 'progress' ? Math.min(1, Math.max(0, progress.fraction)) : 0;
  const subProgress = Math.round(((request.chunk - 1 + fraction) / request.chunks) * 1000) / 10;
  const head = `Isolating voice on ${request.track} — section ${request.chunk} of ${request.chunks}`;
  switch (progress.kind) {
    case 'uploading':
      return { message: `${head}, sending it to the Crucible on ${server}`, subProgress };
    case 'warming':
      return { message: `${head}: ${progress.message}`, subProgress };
    case 'progress':
      return { message: `${head}: ${progress.message}`, subProgress };
    case 'parked':
      return { message: `${head} waits for the Crucible on ${server} (${progress.holderLine})`, subProgress };
  }
}
