/**
 * The main-process half of the editor's transcription protocol (P5, plan §8.2; LEDGER #206).
 *
 * `editor-backend/cli/transcribe.py` keeps every piece of audio logic — extraction, the VAD
 * compaction, the loop regions, map_words, the atomic sidecar — and asks main for ONE thing,
 * the decode, one compact WAV at a time:
 *
 *   python → {"type":"asr_request","id":N,"wav":"/abs/x.wav","trackId":"t0","region":[s,e]|null}
 *   main   → {"type":"asr_progress","id":N,"percent":P}   (while the job runs)
 *   main   → {"type":"asr_response","id":N,"wordsPath":"/abs/x.wav.words.json","model":"crucible:<server>:qwen3-asr-1.7b"}
 *          | {"type":"asr_error","id":N,"message":"<the server's own words>"}
 *
 * The words file is the aligner's words in Crucible's word shape `{word,start,end,probability}`,
 * already given their punctuation and joined where the aligner split a token ("don" + "t" →
 * "don't", from `don`'s start): crucible-transcript.ts `segmentTokens`. Seconds of the WAV
 * sent; `probability` null (Qwen scores nothing). Python maps them onto the timeline exactly
 * as it mapped whisper.cpp's words.
 *
 * Kept free of Electron so the acceptance tools and the protocol test drive the same code the
 * app does (python-service.ts is the app's caller).
 */

import * as fs from 'fs';

import { transcribeOnCrucible } from '../transcription/crucible-transcription';
import { readCrucibleTranscript, transcriptTokens } from '../transcription/crucible-transcript';

export interface EditorAsrRequest {
  readonly type: 'asr_request';
  readonly id: number;
  readonly wav: string;
  readonly trackId: string;
  /** A loop region's [start, end] in the compact WAV's seconds, or null for a whole track. */
  readonly region: readonly [number, number] | null;
}

/** A stdout message → an asr_request, or null when it is some other message. A malformed one throws (Law 10). */
export function readAsrRequest(message: unknown): EditorAsrRequest | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as Record<string, unknown>;
  if (m['type'] !== 'asr_request') return null;
  const bad = (why: string): never => { throw new Error(`transcribe.py sent a malformed asr_request (${why}): ${JSON.stringify(message).slice(0, 300)}`); };
  if (typeof m['id'] !== 'number' || !Number.isInteger(m['id'])) bad('id is not an integer');
  if (typeof m['wav'] !== 'string' || m['wav'] === '') bad('wav is not a path');
  if (typeof m['trackId'] !== 'string' || m['trackId'] === '') bad('trackId is not a string');
  const region = m['region'];
  if (region !== null && !(Array.isArray(region) && region.length === 2 && region.every((x) => typeof x === 'number' && Number.isFinite(x)))) {
    bad('region is neither null nor [start, end]');
  }
  return {
    type: 'asr_request',
    id: m['id'] as number,
    wav: m['wav'] as string,
    trackId: m['trackId'] as string,
    region: region === null ? null : [(region as number[])[0], (region as number[])[1]],
  };
}

export interface ServedAsrRequest {
  readonly wordsPath: string;
  readonly model: string;
  readonly jobId: string;
  readonly words: number;
  /** Pieces the server's loop guard re-decoded (its `redecoded` rows): the editor's loop count. */
  readonly redecoded: number;
  readonly wallSeconds: number;
}

/**
 * Run the Crucible job for one request and write its words file beside the WAV. Throws the
 * job's error unchanged (CrucibleAsrError carries the server's message); the caller turns it
 * into an asr_error line.
 */
export async function serveEditorAsrRequest(
  request: EditorAsrRequest,
  options: {
    /** The session's asr context (asr-facts.ts editorTrackFacts → buildAsrContext). */
    readonly context: string;
    /** The editor's job id, for the clientRef and the log. */
    readonly jobId: string;
    readonly signal?: AbortSignal;
    readonly onProgress?: (percent: number, message: string) => void;
  }
): Promise<ServedAsrRequest> {
  const where = request.region ? ` region ${request.region[0].toFixed(1)}-${request.region[1].toFixed(1)}s` : '';
  const outcome = await transcribeOnCrucible({
    audioFile: request.wav,
    context: options.context,
    clientRefStem: `editor:${options.jobId}:${request.trackId}${request.region ? ':loop' : ''}`,
    tag: `${options.jobId} ${request.trackId}${where}`,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    band: { from: 0, to: 100 },
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  const transcript = readCrucibleTranscript(outcome.transcript);
  const tokens = transcriptTokens(transcript);
  const wordsPath = `${request.wav}.words.json`;
  const doc = {
    model: outcome.model,
    server: outcome.server,
    serverVersion: outcome.serverVersion,
    jobId: outcome.jobId,
    region: request.region,
    // Pieces the server's loop guard re-cut and decoded again: the editor's loop count.
    redecoded: transcript.redecoded,
    words: tokens.map((t) => ({ word: t.word, start: t.start, end: t.end, probability: null })),
  };
  const temp = `${wordsPath}.writing`;
  fs.writeFileSync(temp, JSON.stringify(doc), 'utf-8');
  fs.renameSync(temp, wordsPath);
  return { wordsPath, model: outcome.model, jobId: outcome.jobId, words: tokens.length, redecoded: transcript.redecoded, wallSeconds: outcome.wallSeconds };
}

/** The line that answers `request`: a response, or the error the run fails with. */
export function asrAnswerLine(request: EditorAsrRequest, answer: { wordsPath: string; model: string } | { error: string }): string {
  return `${JSON.stringify('error' in answer
    ? { type: 'asr_error', id: request.id, message: answer.error }
    : { type: 'asr_response', id: request.id, wordsPath: answer.wordsPath, model: answer.model })}\n`;
}

/** A progress line for `request`. */
export function asrProgressLine(request: EditorAsrRequest, percent: number): string {
  return `${JSON.stringify({ type: 'asr_progress', id: request.id, percent: Math.round(percent) })}\n`;
}

/**
 * The whole main-side protocol for one transcribe.py run: hand it every parsed stdout message;
 * it answers the asr_requests on `write` (the child's stdin) and returns true for them, false
 * for anything else (progress/success/error, which the caller handles as before). Requests are
 * served one after another in arrival order; transcribe.py sends one and waits.
 *
 * A failed job becomes an asr_error line carrying its message whole (`asr_decode_loop` and its
 * time range included), and transcribe.py fails the run with it: never swallowed, never a
 * different engine.
 */
export function createAsrResponder(options: {
  readonly context: string;
  readonly jobId: string;
  readonly signal?: AbortSignal;
  readonly write: (line: string) => void;
  readonly log: (line: string) => void;
}): (message: unknown) => boolean {
  let chain: Promise<void> = Promise.resolve();
  return (message: unknown): boolean => {
    const request = readAsrRequest(message);
    if (request === null) return false;
    chain = chain.then(async () => {
      options.log(`asr_request ${request.id}: ${request.trackId} ${request.wav}${request.region ? ` (loop region ${request.region[0]}-${request.region[1]} s)` : ''}`);
      try {
        const served = await serveEditorAsrRequest(request, {
          context: options.context,
          jobId: options.jobId,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          onProgress: (percent) => options.write(asrProgressLine(request, percent)),
        });
        options.log(`asr_request ${request.id}: ${served.words} words from job ${served.jobId} in ${served.wallSeconds.toFixed(1)} s` +
          `${served.redecoded > 0 ? `, ${served.redecoded} piece(s) re-decoded by the server's loop guard` : ''} → ${served.wordsPath}`);
        options.write(asrAnswerLine(request, served));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        options.log(`asr_request ${request.id} failed: ${text}`);
        options.write(asrAnswerLine(request, { error: text }));
      }
    });
    return true;
  };
}
