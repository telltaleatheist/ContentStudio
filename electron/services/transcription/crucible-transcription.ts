/**
 * TRANSCRIBE ON CRUCIBLE: the one door the pipeline and the editor both go through (P5,
 * LEDGER #206: "no more local whisper ... That covers the pipeline and the editor").
 *
 * It owns three things neither caller should own twice:
 *
 *  - THE VENUE: which server and which client. P1 builds the registry; until it is merged into
 *    `crucible` nothing is wired, and a transcription FAILS naming that (Law 1: never "so run
 *    whisper"). P1's wiring is one call to {@link setAsrVenueResolver} (docs/crucible/P5.md).
 *  - ONE JOB AT A TIME PER SERVER, in this process. The pipeline runs up to five transcriptions
 *    at once and the editor one more; Crucible's lane takes one asr job and refuses the rest
 *    `409 server_busy`. Until P3's lanes exist, jobs for one server queue here in arrival order,
 *    and the wait is logged with what it is waiting on (Law 8). Another CLIENT holding the lane
 *    is not queued behind: its 409 fails the item with the holder's line (P3 parks it).
 *  - THE CHECK before the upload (`/v1/info`'s asr and align rows), the job, the progress
 *    bands, and the model name the saved transcript records: `crucible:<server>:qwen3-asr-1.7b`.
 */

import * as crypto from 'crypto';
import * as log from 'electron-log';

import {
  QWEN_ASR_MODEL,
  asrParams,
  requireAsrOffer,
  runAsrJob,
  safeUploadName,
  CrucibleAsrError,
  type AsrJobProgress,
  type AsrVenue,
} from '../../crucible/asr';

// ─────────────────────────────────────────────────────────────────────────────── the venue

let venueResolver: (() => AsrVenue) | null = null;

/**
 * Wire the server transcription runs on. P1 calls this once at startup with its registry's
 * selected server and SDK client (the SDK's `CrucibleClient` satisfies `AsrCrucibleClient`
 * structurally); the acceptance tools call it with the raw-fetch client under tools/.
 * Passing null unwires it (tests).
 */
export function setAsrVenueResolver(resolver: (() => AsrVenue) | null): void {
  venueResolver = resolver;
}

/** The server to transcribe on now, or a refusal naming why there is none. */
export function resolveAsrVenue(): AsrVenue {
  if (venueResolver === null) {
    throw new CrucibleAsrError('unavailable', 'crucible_not_connected', '',
      'Transcription runs on Crucible (LEDGER #206), and no Crucible server is connected to ContentStudio. ' +
      'Connect one in Settings › Crucible Servers.');
  }
  return venueResolver();
}

/** What the saved transcript and the editor sidecar record as the model: which server, which model. */
export function crucibleModelName(server: string): string {
  return `crucible:${server}:${QWEN_ASR_MODEL}`;
}

// ────────────────────────────────────────────────────────────── one job per server, here

const laneTails = new Map<string, Promise<void>>();
const laneDepth = new Map<string, number>();

/**
 * Run `work` after every earlier job this process sent to `server` has ended. `onWait` is
 * told how many are ahead, once, when there are any.
 */
export async function inServerLane<T>(server: string, work: () => Promise<T>, onWait?: (ahead: number) => void): Promise<T> {
  const ahead = laneDepth.get(server) ?? 0;
  laneDepth.set(server, ahead + 1);
  const previous = laneTails.get(server) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => mine);
  laneTails.set(server, tail);
  if (ahead > 0) onWait?.(ahead);
  try {
    await previous;
    return await work();
  } finally {
    release();
    const left = (laneDepth.get(server) ?? 1) - 1;
    if (left <= 0) {
      laneDepth.delete(server);
      if (laneTails.get(server) === tail) laneTails.delete(server);
    } else {
      laneDepth.set(server, left);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────── progress

/** `12:34` or `1:02:03`: the position the server reports, readable. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * The server's progress → a percentage in [from, to] of the caller's bar, and a message.
 *
 * The bands are by WORK, not by stage count (plan §0a: "weight the progress bar by work"): the
 * upload and the load are seconds; decoding the pieces and aligning them are the job, and on a
 * Qwen job they run over the whole input ONE AFTER THE OTHER, each reporting its own
 * `processed_s` of `total_s` — so they get consecutive bands (transcribing 70% of the span,
 * aligning the rest; measured on the Mac, see docs/crucible/P5.md), never one shared ratio
 * that would run to the end and back.
 */
export function asrProgressToBand(server: string, p: AsrJobProgress, from: number, to: number): { percent: number; message: string } {
  const span = to - from;
  const at = (share: number): number => Math.round(from + Math.min(1, Math.max(0, share)) * span);
  const where = (processed: number | null, total: number | null): string =>
    processed !== null && total !== null && total > 0 ? ` ${clock(processed)} of ${clock(total)}` : '';
  switch (p.kind) {
    case 'uploading': {
      const share = p.sentBytes !== null && p.totalBytes > 0 ? p.sentBytes / p.totalBytes : 0;
      const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;
      return {
        percent: at(0.03 * share),
        message: `Uploading the audio to Crucible on ${server}...${p.sentBytes !== null ? ` ${mb(p.sentBytes)} of ${mb(p.totalBytes)}` : ''}`,
      };
    }
    case 'queued':
      return { percent: at(0.03), message: `Queued on Crucible on ${server}${p.position !== null && p.position > 0 ? ` (position ${p.position})` : ''}...` };
    case 'warming':
      return { percent: at(0.04), message: `Crucible on ${server}: ${p.message ?? 'loading the model...'}` };
    case 'decoding':
      return { percent: at(0.05), message: `Reading the audio on ${server}...${p.processedS !== null ? ` ${clock(p.processedS)}` : ''}` };
    case 'working': {
      const share = p.processedS !== null && p.totalS !== null && p.totalS > 0 ? p.processedS / p.totalS : 0;
      return p.stage === 'transcribing'
        ? { percent: at(0.05 + 0.65 * share), message: `Transcribing on ${server}...${where(p.processedS, p.totalS)}` }
        : { percent: at(0.70 + 0.30 * share), message: `Timing the words on ${server}...${where(p.processedS, p.totalS)}` };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────── the job

export interface CrucibleTranscribeRequest {
  /** The audio to send: 16 kHz mono FLAC (pipeline) or a compact WAV (editor). */
  readonly audioFile: string;
  /** From asr-context.ts: the instruction and the item's facts. */
  readonly context: string;
  /** `pipeline:<jobId>` or `editor:<jobId>:<track>`; a random tail is added (unique per submit). */
  readonly clientRefStem: string;
  /** Log prefix. */
  readonly tag: string;
  readonly signal?: AbortSignal;
  /** The caller's band of its own bar this job fills. */
  readonly band: { readonly from: number; readonly to: number };
  readonly onProgress?: (percent: number, message: string) => void;
}

export interface CrucibleTranscribeOutcome {
  readonly server: string;
  readonly serverVersion: string | null;
  readonly jobId: string;
  /** `transcript.json`, parsed. */
  readonly transcript: unknown;
  /** `crucible:<server>:qwen3-asr-1.7b`. */
  readonly model: string;
  readonly wallSeconds: number;
}

/** One asr job for one file, on the wired server, in its lane. */
export async function transcribeOnCrucible(request: CrucibleTranscribeRequest): Promise<CrucibleTranscribeOutcome> {
  const venue = resolveAsrVenue();
  const { server } = venue;
  const params = asrParams(request.context);
  const say = (line: string): void => log.info(`[CrucibleASR] [${request.tag}] ${line}`);
  let last = request.band.from;
  const report = (p: AsrJobProgress): void => {
    const mapped = asrProgressToBand(server, p, request.band.from, request.band.to);
    // Never backwards: the queue's bar must not bounce between a job's two passes.
    last = Math.max(last, mapped.percent);
    request.onProgress?.(last, mapped.message);
  };

  return inServerLane(server, async () => {
    if (request.signal?.aborted) {
      throw new CrucibleAsrError('cancelled', 'cancelled', server, 'The transcription was cancelled before it reached Crucible.');
    }
    const { version } = await requireAsrOffer(venue);
    const started = Date.now();
    say(`transcribing ${request.audioFile} on ${server} (Crucible ${version ?? 'version not stated'}) with ${QWEN_ASR_MODEL}: ` +
      `language ${params.language}, vad_filter false, word_timestamps true, context of ${params.context.length} characters`);
    const outcome = await runAsrJob({
      venue,
      params,
      file: request.audioFile,
      filename: safeUploadName(request.audioFile),
      clientRef: `contentstudio:${request.clientRefStem}:${crypto.randomBytes(4).toString('hex')}`,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      // The venue's in-flight ledger (P3), so a kill mid-transcription leaves the sweep a job to cancel.
      ...(venue.ledger === undefined ? {} : { ledger: venue.ledger }),
      onLog: say,
      onProgress: report,
    });
    const wallSeconds = (Date.now() - started) / 1000;
    say(`job ${outcome.jobId} done in ${wallSeconds.toFixed(1)} s`);
    return {
      server,
      serverVersion: version,
      jobId: outcome.jobId,
      transcript: outcome.transcript,
      model: crucibleModelName(server),
      wallSeconds,
    };
  }, (ahead) => {
    say(`waiting for ${ahead} transcription(s) this app already sent to ${server} (one asr job at a time per server)`);
    request.onProgress?.(request.band.from, `Waiting for ${ahead} transcription(s) ahead of it on ${server}...`);
  });
}
