/**
 * ONE CRUCIBLE `asr` JOB, END TO END: upload → submit → follow events → fetch
 * `transcript.json` (CRUCIBLE-MIGRATION-PLAN.md §8, P5; LEDGER #203, #206).
 *
 * Every transcription ContentStudio makes is this job on `qwen3-asr-1.7b` (#206: "no more
 * local whisper ... we'll be using qwen asr ... probably the big model, 1.7b, since we want
 * accuracy"). The official id, never the `-mlx` port (#205, §21 Q15): the port drops fillers,
 * and Owen keeps the ums and uhs to cut on (#203).
 *
 * PORTED from Briefcase `backend/src/crucible/asr/crucible-asr-job.ts` and `asr-models.ts`
 * (cb7c45d), not re-derived. Kept: the upload streamed from disk (`fs.openAsBlob`, never read
 * whole); a submit whose answer never came is looked up by its `client_ref` before it is sent
 * again, so a lost answer never becomes a second job on the card; cancel is a `DELETE`, not a
 * hang-up (abandoning the stream leaves the job running and holding the lane); a dropped event
 * stream is re-opened above the last event seen on a stated budget, and past it the job is
 * DELETEd. Left behind: Briefcase's parked-upload blob cache and its park-on-busy outcome —
 * ContentStudio has no parking until P3's lanes, so a busy lane fails the item by name (below).
 *
 * THE CLIENT IS INJECTED. P1 builds `electron/crucible/`'s registry, SDK vendoring and
 * readiness in parallel; until it lands, this module names only the handful of calls it makes,
 * as {@link AsrCrucibleClient}. The interface is a STRUCTURAL SUBSET of the vendored SDK's
 * `CrucibleClient` (same names, same argument shapes, same result fields), so P1's client
 * passes as it is. docs/crucible/P5.md says exactly what it must provide.
 *
 * HOW IT ENDS, as one error class with a `kind` the caller can branch on (Law 10: a type, not a
 * message substring):
 *
 *   unavailable  Crucible cannot take the work: unreachable, no asr, the model or its aligner
 *                not offered or not downloaded, the token refused, the stream lost past its
 *                budget. Never "so use whisper" (Law 1, #206): the item fails naming the gap.
 *   busy         the lane is held (409 server_busy / leased). Fails the item with the holder's
 *                line; P3's lanes turn this into parking.
 *   refused      the server refused the request itself (a bad param, a language, a context).
 *   failed       the server ran the job and it failed: its own code and message, verbatim —
 *                `asr_decode_loop` naming the time range included. Never swallowed.
 *   cancelled    ours (the DELETE was sent) or the server's.
 */

import * as fs from 'fs';

// ─────────────────────────────────────────────────────────────── the model and its params

/** The transcriber (#206). One id on both backends since Crucible 1.0.29. */
export const QWEN_ASR_MODEL = 'qwen3-asr-1.7b';
/** Its forced aligner, an `align` model: word timestamps need it installed (plan §8 note). */
export const QWEN_ALIGNER_MODEL = 'qwen3-aligner';
/**
 * The language every job states. REQUIRED by the server for Qwen (`auto` is refused: Qwen
 * cannot detect), and every video ContentStudio makes is English. A constant, not a setting:
 * there is no other language to choose.
 */
export const ASR_LANGUAGE = 'en';

/**
 * The asr params, EXACTLY these four keys (#206: "Every request states `language`,
 * `word_timestamps:true`, `vad_filter:false` and a `context`"). `vad_filter:true` is refused
 * by Qwen (it has no VAD); words are always asked for, because a Qwen segment is a piece of up
 * to 180 s and only the aligner's words cut it into sentences (plan §8 "As shipped").
 */
export interface AsrParams {
  readonly language: string;
  readonly vad_filter: false;
  readonly word_timestamps: true;
  readonly context: string;
}

/**
 * The params for one job. `context` comes from asr-context.ts and is never blank: the server
 * refuses a blank context, and the builder always carries the verbatim instruction (#203).
 */
export function asrParams(context: string): AsrParams {
  if (typeof context !== 'string' || context.trim() === '') {
    throw new CrucibleAsrError('refused', 'crucible_asr_context_blank', '',
      'the asr context is blank; it always carries the verbatim-disfluency instruction (LEDGER #203), so a blank one is a bug upstream');
  }
  return { language: ASR_LANGUAGE, vad_filter: false, word_timestamps: true, context };
}

// ─────────────────────────────────────────────────────────────────── the client it takes

/** One model row of an `/v1/info` capability, as much as the offer check reads. */
export interface AsrModelRow {
  readonly id: string;
  readonly installed: boolean;
}

/** `/v1/info`, as much of the SDK's `ServerInfo` as this module reads. */
export interface AsrServerInfo {
  readonly server: { readonly version: string | null };
  readonly host: { readonly backend: string | null };
  readonly jobTypes: readonly string[];
  readonly capabilities: readonly { readonly jobType: string; readonly models: readonly unknown[] }[];
}

/** The SDK's job events, as much as this module reads (the SDK's `JobEvent`, narrowed). */
export type AsrJobEvent =
  | { readonly id: number; readonly event: 'queued'; readonly data: { readonly position: number | null } }
  | { readonly id: number; readonly event: 'warming'; readonly data: { readonly message: string | null } }
  | {
      readonly id: number;
      readonly event: 'progress';
      readonly data: {
        readonly fraction: number | null;
        readonly message: string | null;
        readonly extra: Readonly<Record<string, unknown>>;
      };
    }
  | { readonly id: number; readonly event: 'done'; readonly data: unknown }
  | { readonly id: number; readonly event: 'failed'; readonly data: { readonly error: { readonly code: string; readonly message: string } } }
  | { readonly id: number; readonly event: 'cancelled'; readonly data: unknown }
  | { readonly id: number; readonly event: string; readonly data: unknown };

/**
 * The calls one asr job makes, named and shaped as the vendored SDK's `CrucibleClient` names
 * and shapes them. A thrown error is read STRUCTURALLY (see `classifyDoorError`): the SDK's
 * errors carry `name` (`CrucibleUnreachable`, `CrucibleBusy`, ...) and, for a server refusal,
 * `code` and `serverMessage`. The raw-fetch client under tools/ throws the same shapes.
 */
export interface AsrCrucibleClient {
  info(): Promise<AsrServerInfo>;
  upload(data: Blob, options: { filename: string }): Promise<{ readonly blobId: string }>;
  submit(request: {
    type: string;
    model: string;
    params: Readonly<Record<string, unknown>>;
    inputs: Readonly<Record<string, { readonly blobId: string }>>;
    clientRef?: string;
  }): Promise<string>;
  events(jobId: string, options?: { lastEventId?: number }): AsyncIterable<AsrJobEvent>;
  artifact(jobId: string, name: string): Promise<Uint8Array>;
  cancel(jobId: string): Promise<{ readonly status: string }>;
  /** `GET /v1/jobs/{id}`: only `clientRef` is read, to adopt a submit whose answer was lost. */
  job(jobId: string): Promise<{ readonly clientRef: string | null }>;
  /** `GET /v1/activity`: the lane's running and queued jobs, to find a lost submit. */
  activity(): Promise<{
    readonly running: readonly { readonly jobId: string; readonly type: string }[];
    readonly queued: readonly { readonly jobId: string; readonly type: string }[];
  }>;
}

/** A server and the client that reaches it. `server` is the registry name, used in every sentence. */
export interface AsrVenue {
  readonly server: string;
  readonly client: AsrCrucibleClient;
}

// ─────────────────────────────────────────────────────────────────────────── the outcomes

export type CrucibleAsrErrorKind = 'unavailable' | 'busy' | 'refused' | 'failed' | 'cancelled';

export class CrucibleAsrError extends Error {
  constructor(
    readonly kind: CrucibleAsrErrorKind,
    /** The server's code (`asr_decode_loop`, `server_busy`, ...) or this module's own. */
    readonly code: string,
    readonly server: string,
    message: string,
    /** The job, once admitted; null before. */
    readonly jobId: string | null = null,
  ) {
    super(message);
    this.name = kind === 'cancelled' ? 'AbortError' : 'CrucibleAsrError';
  }
}

export function isCrucibleAsrError(err: unknown): err is CrucibleAsrError {
  return err instanceof CrucibleAsrError;
}

/** The SDK's error names this module reads, and nothing else about them. */
function errName(err: unknown): string {
  return typeof (err as { name?: unknown })?.name === 'string' ? (err as { name: string }).name : '';
}
function errCode(err: unknown): string | null {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' && code !== '' ? code : null;
}
function errText(err: unknown): string {
  const server = (err as { serverMessage?: unknown })?.serverMessage;
  if (typeof server === 'string' && server !== '') return server;
  return err instanceof Error ? err.message : String(err);
}

/** A dead socket or a server that did not answer: the one error that is weather, not a verdict. */
export function isUnreachable(err: unknown): boolean {
  return errName(err) === 'CrucibleUnreachable';
}

/**
 * An error at the door (upload, submit, info) as one of this module's outcomes. The SDK's
 * busy/leased classes carry a ready-made line naming the holder; a refusal carries the
 * server's code and message. Anything this module does not recognise is still named, never
 * passed through bare: "refused" with the error's own text.
 */
export function classifyDoorError(err: unknown, server: string, verb: string): CrucibleAsrError {
  if (err instanceof CrucibleAsrError) return err;
  const at = `Crucible on ${server}`;
  const name = errName(err);
  const code = errCode(err);
  if (name === 'CrucibleBusy' || name === 'CrucibleLeased' || code === 'server_busy' || code === 'leased') {
    const line = (err as { busyLine?: unknown; leasedLine?: unknown }).busyLine
      ?? (err as { leasedLine?: unknown }).leasedLine;
    return new CrucibleAsrError('busy', code ?? 'server_busy', server,
      `${at} is busy and cannot take ${verb} now: ${typeof line === 'string' && line ? line : errText(err)}`);
  }
  if (name === 'CrucibleUnreachable') {
    return new CrucibleAsrError('unavailable', 'crucible_unreachable', server, `${at} could not be reached for ${verb} (${errText(err)}).`);
  }
  if (name === 'CrucibleAuthError') {
    return new CrucibleAsrError('unavailable', code ?? 'crucible_auth', server,
      `${at} refused this computer's token (${errText(err)}). Pair it again.`);
  }
  if (name === 'CrucibleVersionError' || name === 'CrucibleNotACrucible' || name === 'CrucibleProtocolError') {
    return new CrucibleAsrError('unavailable', code ?? name, server, `${at} answered ${verb} with something API v1 does not describe: ${errText(err)}`);
  }
  // A server refusal (`CrucibleRefused`, 4xx with a code): env_missing and model_not_installed
  // are the server saying it cannot do this at all, which is `unavailable` by name.
  if (code === 'env_missing' || code === 'model_not_installed' || code === 'unknown_model' || code === 'job_type_disabled') {
    return new CrucibleAsrError('unavailable', code, server, `${at} cannot run ${verb} (${code}): ${errText(err)}`);
  }
  return new CrucibleAsrError('refused', code ?? 'crucible_refused', server, `${at} refused ${verb}${code ? ` (${code})` : ''}: ${errText(err)}`);
}

// ────────────────────────────────────────────────────────────────── can this server do it

function modelRow(info: AsrServerInfo, jobType: string, id: string): AsrModelRow | null {
  const capability = info.capabilities.find((c) => c.jobType === jobType);
  const rows = Array.isArray(capability?.models) ? capability!.models : [];
  const row = rows.find((r) => (r as { id?: unknown })?.id === id) as { id: string; installed?: unknown } | undefined;
  return row === undefined ? null : { id: row.id, installed: row.installed === true };
}

/**
 * Why `server` cannot transcribe with Qwen right now, or null when it can: the `asr` and
 * `align` rows of `/v1/info` read BEFORE anything is uploaded (plan §0a "Mechanics"), so a
 * missing model or env refuses by name instead of after a multi-gigabyte upload. Never a
 * reason to use another model (#206).
 */
export function asrUnavailableReason(server: string, info: AsrServerInfo): string | null {
  const at = `Crucible on ${server}`;
  if (!info.jobTypes.includes('asr')) return `${at} has no transcription engine (no asr job type).`;
  const qwen = modelRow(info, 'asr', QWEN_ASR_MODEL);
  if (qwen === null) return `${at} does not offer ${QWEN_ASR_MODEL}. Update it to Crucible 1.0.29 or later.`;
  if (!qwen.installed) return `${at} has not downloaded ${QWEN_ASR_MODEL} yet.`;
  if (!info.jobTypes.includes('align')) return `${at} has no align job type, which ${QWEN_ASR_MODEL}'s word timings need.`;
  const aligner = modelRow(info, 'align', QWEN_ALIGNER_MODEL);
  if (aligner === null) return `${at} does not offer ${QWEN_ALIGNER_MODEL}, which ${QWEN_ASR_MODEL}'s word timings need.`;
  if (!aligner.installed) return `${at} has not downloaded ${QWEN_ALIGNER_MODEL} (the word timings) yet.`;
  return null;
}

/** Read `/v1/info` and refuse by name when the server cannot run the job. Returns the version for the record. */
export async function requireAsrOffer(venue: AsrVenue): Promise<{ version: string | null }> {
  let info: AsrServerInfo;
  try {
    info = await venue.client.info();
  } catch (err) {
    throw classifyDoorError(err, venue.server, 'the question of what it offers (/v1/info)');
  }
  const why = asrUnavailableReason(venue.server, info);
  if (why !== null) throw new CrucibleAsrError('unavailable', 'crucible_asr_unavailable', venue.server, why);
  return { version: info.server.version };
}

// ────────────────────────────────────────────────────────────────────────────── progress

/** Progress as the server reported it, sorted by stage. */
export type AsrJobProgress =
  | { readonly kind: 'uploading'; readonly sentBytes: number | null; readonly totalBytes: number }
  | { readonly kind: 'queued'; readonly position: number | null }
  | { readonly kind: 'warming'; readonly message: string | null }
  /** The server decoding the input to samples; `processedS` moves, nothing is transcribed yet. */
  | { readonly kind: 'decoding'; readonly processedS: number | null }
  /**
   * `stage` is the server's: `transcribing` (pieces decoded) then `aligning` (pieces given word
   * times and landed). On a Qwen job both run over the whole input in turn, each with its own
   * `processed_s` of `total_s` — so a caller maps them onto separate bands.
   */
  | { readonly kind: 'working'; readonly stage: 'transcribing' | 'aligning'; readonly processedS: number | null; readonly totalS: number | null; readonly message: string | null };

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A warming line without the engine's log tail (Crucible appends it after an em dash). */
export function warmingHeadline(message: string | null): string | null {
  if (message === null) return null;
  const cut = message.indexOf(' — ');
  return cut < 0 ? message : message.slice(0, cut);
}

/**
 * One `progress` frame → an {@link AsrJobProgress}, or null for a stage this build does not
 * know (logged by the caller, never guessed at). The server's stages and keys, as its
 * `crucible/jobs/asr/qwen.py` writes them at v1.0.34: `stage` decoding|transcribing|aligning,
 * `processed_s`, `total_s` (0 while decoding).
 */
export function readProgressFrame(data: { fraction: number | null; message: string | null; extra: Readonly<Record<string, unknown>> }): AsrJobProgress | null {
  const extra = data.extra ?? {};
  const stage = extra['stage'];
  const processedS = numOrNull(extra['processed_s']);
  const totalS = numOrNull(extra['total_s']);
  if (stage === 'decoding') return { kind: 'decoding', processedS };
  if (stage === 'transcribing' || stage === 'aligning') {
    return { kind: 'working', stage, processedS, totalS: totalS !== null && totalS > 0 ? totalS : null, message: data.message };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────── the job

/** Retry budgets (Briefcase's). Before admission a dead server fails soon; a running job is worth waiting for. */
export const DOOR_DELAYS_MS: readonly number[] = [1_000, 3_000];
export const STREAM_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 45_000];
/** An upload in flight reports this often, so a long upload never looks stalled. */
export const UPLOAD_TICK_MS = 5_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** P3's in-flight ledger plugs in here: a job written down when admitted, settled when it ends. */
export interface AsrJobLedger {
  record(jobId: string): void;
  settle(jobId: string): void;
}

export interface RunAsrJobOptions {
  readonly venue: AsrVenue;
  readonly params: AsrParams;
  /** The audio file on disk (16 kHz mono FLAC from the pipeline, a compact WAV from the editor). */
  readonly file: string;
  /** Its name on the server. The extension is load-bearing: the server's ffmpeg reads the container off it. */
  readonly filename: string;
  /**
   * Names this submission on the server: `contentstudio:<what>:<id>:<random>`. Unique per call,
   * because a submit whose answer was lost is found again by it (`GET /v1/activity`, then each
   * candidate's `client_ref`).
   */
  readonly clientRef: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: AsrJobProgress) => void;
  readonly onLog?: (line: string) => void;
  readonly ledger?: AsrJobLedger;
  /** Only a test shortens these. */
  readonly doorDelaysMs?: readonly number[];
  readonly streamDelaysMs?: readonly number[];
  readonly uploadTickMs?: number;
}

export interface AsrJobOutcome {
  readonly jobId: string;
  /** `transcript.json`, JSON-parsed. Read with services/transcription/crucible-transcript.ts. */
  readonly transcript: unknown;
}

/** `fs.openAsBlob` typed as the optional it is on older runtimes. */
const openAsBlob: ((p: string) => Promise<Blob>) | undefined =
  (fs as unknown as { openAsBlob?: (p: string) => Promise<Blob> }).openAsBlob;

/**
 * The file as a blob-LIKE whose stream counts bytes as the request body pulls them (Briefcase's
 * `countingBlob`, verbatim in behaviour): FormData re-wraps a real Blob and would bypass the
 * count, while a blob-like is wrapped by delegation. Null when this runtime's FormData refuses
 * one: the upload then goes as the plain blob and the beat carries no byte count.
 */
function countingBlob(blob: Blob, filename: string, onBytes: (n: number) => void): Blob | null {
  const like = {
    size: blob.size,
    type: blob.type,
    name: filename,
    lastModified: Date.now(),
    [Symbol.toStringTag]: 'File',
    arrayBuffer: () => blob.arrayBuffer(),
    text: () => blob.text(),
    slice: (start?: number, end?: number, type?: string) => blob.slice(start, end, type),
    stream: (): ReadableStream<Uint8Array> => {
      const reader = (blob.stream() as ReadableStream<Uint8Array>).getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          onBytes(value.byteLength);
          controller.enqueue(value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
    },
  };
  try {
    new FormData().append('probe', like as unknown as Blob, filename);
    return like as unknown as Blob;
  } catch {
    return null;
  }
}

/** The job a submit refusal names: the lane's holder (`server_busy`), or the job that took our blob. */
function jobNamedBy(err: unknown): string | null {
  const direct = (err as { jobId?: unknown })?.jobId;
  if (typeof direct === 'string' && direct) return direct;
  const details = (err as { details?: unknown })?.details as { job_id?: unknown } | null | undefined;
  return typeof details?.job_id === 'string' ? details.job_id : null;
}

async function isOurs(client: AsrCrucibleClient, jobId: string, clientRef: string): Promise<boolean> {
  try {
    return (await client.job(jobId)).clientRef === clientRef;
  } catch {
    return false;
  }
}

/**
 * An admitted asr job carrying `clientRef`, or null. Crucible has no lookup by client_ref, so
 * the lane's running and queued jobs are read from `/v1/activity` and each asr one's own
 * record is asked. Any failure is "not found": the resend's refusal gets a second look.
 */
export async function findByClientRef(client: AsrCrucibleClient, clientRef: string): Promise<string | null> {
  try {
    const activity = await client.activity();
    for (const job of [...activity.running, ...activity.queued]) {
      if (job.type === 'asr' && await isOurs(client, job.jobId, clientRef)) return job.jobId;
    }
  } catch {
    // Not found is the safe reading: the resend is still checked.
  }
  return null;
}

export async function runAsrJob(options: RunAsrJobOptions): Promise<AsrJobOutcome> {
  const { venue, signal, clientRef } = options;
  const { client, server } = venue;
  const log = options.onLog ?? ((): void => undefined);
  const doorDelays = options.doorDelaysMs ?? DOOR_DELAYS_MS;
  const streamDelays = options.streamDelaysMs ?? STREAM_DELAYS_MS;
  const cancelledBeforeSubmit = (): CrucibleAsrError =>
    new CrucibleAsrError('cancelled', 'cancelled', server, 'The transcription was cancelled before it reached Crucible.');

  if (signal?.aborted) throw cancelledBeforeSubmit();
  let size: number;
  try {
    size = fs.statSync(options.file).size;
  } catch {
    throw new Error(`Audio file for transcription not found: ${options.file}`);
  }
  if (size === 0) throw new Error(`The audio file for transcription is empty: ${options.file}`);
  if (openAsBlob === undefined) {
    throw new CrucibleAsrError('unavailable', 'crucible_runtime_too_old', server,
      `uploading to Crucible needs fs.openAsBlob (Node 19.8+), which this runtime (${process.versions.node}) lacks.`);
  }

  // ── Upload. A re-upload is harmless (a second blob), so weather is retried. ──
  let blobId: string | undefined;
  for (let attempt = 0; blobId === undefined; attempt++) {
    let sent = 0;
    const blob = await openAsBlob(options.file);
    const counted = countingBlob(blob, options.filename, (n) => { sent += n; });
    const report = (): void => options.onProgress?.({ kind: 'uploading', sentBytes: counted === null ? null : Math.min(sent, size), totalBytes: size });
    report();
    const ticker = setInterval(report, options.uploadTickMs ?? UPLOAD_TICK_MS);
    ticker.unref?.();
    try {
      blobId = (await client.upload(counted ?? blob, { filename: options.filename })).blobId;
      report();
    } catch (err) {
      if (signal?.aborted) throw cancelledBeforeSubmit();
      if (isUnreachable(err) && attempt < doorDelays.length) {
        log(`upload to ${server} failed (${errText(err)}); trying again in ${doorDelays[attempt]! / 1000}s`);
        await sleep(doorDelays[attempt]!, signal);
        if (signal?.aborted) throw cancelledBeforeSubmit();
        continue;
      }
      throw classifyDoorError(err, server, 'the upload');
    } finally {
      clearInterval(ticker);
    }
  }
  if (signal?.aborted) throw cancelledBeforeSubmit();

  // ── Submit: the reservation. A submit with no answer may still have been admitted (the
  // answer, not the request, was lost): before it is sent again the job is looked for by its
  // client_ref, and a refusal on the resend that names a job is checked the same way. ──
  let unanswered = false;
  let jobId: string | undefined;
  for (let attempt = 0; jobId === undefined; attempt++) {
    try {
      jobId = await client.submit({
        type: 'asr',
        model: QWEN_ASR_MODEL,
        params: { ...options.params },
        inputs: { [options.filename]: { blobId: blobId! } },
        clientRef,
      });
    } catch (err) {
      if (signal?.aborted) throw cancelledBeforeSubmit();
      if (unanswered) {
        const named = jobNamedBy(err);
        if (named !== null && await isOurs(client, named, clientRef)) {
          log(`${server} named asr job ${named} as ours (${clientRef}); the earlier unanswered submit was admitted`);
          jobId = named;
          break;
        }
      }
      if (isUnreachable(err)) {
        unanswered = true;
        const found = await findByClientRef(client, clientRef);
        if (found !== null) {
          log(`${server} had admitted the unanswered asr submit as job ${found} (${clientRef}); following it`);
          jobId = found;
          break;
        }
        if (attempt < doorDelays.length) {
          log(`${server} did not answer the asr submit (${errText(err)}); asking again in ${doorDelays[attempt]! / 1000}s`);
          await sleep(doorDelays[attempt]!, signal);
          if (signal?.aborted) throw cancelledBeforeSubmit();
          continue;
        }
      }
      throw classifyDoorError(err, server, 'the asr job');
    }
  }
  const admitted = jobId;
  options.ledger?.record(admitted);
  log(`${server} admitted asr job ${admitted} (${QWEN_ASR_MODEL}, ${clientRef})`);

  // ── Cancel is a DELETE. ──
  let cancelAsked = false;
  let cancelAccepted = false;
  const cancel = async (why: string): Promise<void> => {
    if (cancelAsked) return;
    cancelAsked = true;
    log(`cancelling asr job ${admitted} on ${server} (${why})`);
    try {
      const result = await client.cancel(admitted);
      cancelAccepted = true;
      log(`asr job ${admitted} on ${server} is ${result.status}`);
    } catch (err) {
      log(`the cancel of asr job ${admitted} on ${server} was not accepted: ${errText(err)}`);
    }
  };
  const onAbort = (): void => { void cancel('cancel requested'); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  // ── Follow the events, re-opening above the last one on weather. ──
  let terminal: AsrJobEvent | null = null;
  let lastEventId = 0;
  let failures = 0;
  try {
    while (terminal === null) {
      try {
        const resume = lastEventId > 0 ? { lastEventId } : {};
        for await (const event of client.events(admitted, resume)) {
          failures = 0;
          if (event.id > lastEventId) lastEventId = event.id;
          if (event.event === 'queued') {
            options.onProgress?.({ kind: 'queued', position: numOrNull((event.data as { position?: unknown })?.position) });
          } else if (event.event === 'warming') {
            const message = (event.data as { message?: unknown })?.message;
            options.onProgress?.({ kind: 'warming', message: warmingHeadline(typeof message === 'string' ? message : null) });
          } else if (event.event === 'progress') {
            const data = event.data as { fraction: number | null; message: string | null; extra: Readonly<Record<string, unknown>> };
            const progress = readProgressFrame(data);
            if (progress === null) log(`asr job ${admitted}: a progress frame with a stage this build does not map (${JSON.stringify(data.extra)})`);
            else options.onProgress?.(progress);
          } else if (event.event === 'done' || event.event === 'failed' || event.event === 'cancelled') {
            terminal = event;
            break;
          }
        }
        if (terminal === null) {
          const lost = new Error(`the event stream for ${admitted} ended with no terminal event`);
          lost.name = 'CrucibleUnreachable';
          throw lost;
        }
      } catch (err) {
        if (cancelAsked) {
          throw new CrucibleAsrError('cancelled', 'cancelled', server, `The transcription was cancelled (Crucible job ${admitted} on ${server}).`, admitted);
        }
        if (!isUnreachable(err)) {
          // Not weather (a protocol or auth error on the stream): the job is still admitted and
          // holding the card. DELETE it before failing, or it transcribes on for nobody.
          await cancel(`the event stream failed: ${errText(err)}`);
          throw classifyDoorError(err, server, `the events of asr job ${admitted}`);
        }
        if (failures >= streamDelays.length) {
          await cancel('event stream lost past its budget');
          throw new CrucibleAsrError('unavailable', 'crucible_stream_lost', server,
            `Lost the connection to Crucible on ${server} while it transcribed (${errText(err)}); the job was cancelled rather than left holding the card.`, admitted);
        }
        const wait = streamDelays[failures]!;
        failures += 1;
        log(`the event stream for ${admitted} on ${server} dropped (${errText(err)}); re-opening after event ${lastEventId} in ${wait / 1000}s`);
        await sleep(wait, signal);
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (terminal !== null || cancelAccepted) options.ledger?.settle(admitted);
  }

  const ended = terminal as AsrJobEvent;
  if (ended.event === 'cancelled') {
    throw new CrucibleAsrError('cancelled', 'cancelled', server, cancelAsked
      ? `The transcription was cancelled (Crucible job ${admitted} on ${server}).`
      : `Crucible on ${server} cancelled the transcription (job ${admitted}).`, admitted);
  }
  if (ended.event === 'failed') {
    const error = (ended.data as { error?: { code?: unknown; message?: unknown } })?.error;
    const code = typeof error?.code === 'string' ? error.code : 'unstated';
    const message = typeof error?.message === 'string' ? error.message : '(the server gave no message)';
    // The server's own words, whole: `asr_decode_loop` names the time range that looped.
    throw new CrucibleAsrError('failed', code, server, `Crucible on ${server} could not transcribe this (${code}): ${message}`, admitted);
  }

  // ── Fetch transcript.json, retrying weather on the long budget. ──
  let bytes: Uint8Array | undefined;
  for (let attempt = 0; bytes === undefined; attempt++) {
    try {
      bytes = await client.artifact(admitted, 'transcript.json');
    } catch (err) {
      if (isUnreachable(err) && attempt < streamDelays.length) {
        log(`fetching transcript.json of ${admitted} failed (${errText(err)}); trying again in ${streamDelays[attempt]! / 1000}s`);
        await sleep(streamDelays[attempt]!);
        continue;
      }
      throw classifyDoorError(err, server, `fetching transcript.json of job ${admitted}`);
    }
  }
  let transcript: unknown;
  try {
    transcript = JSON.parse(Buffer.from(bytes).toString('utf-8'));
  } catch (err) {
    throw new CrucibleAsrError('failed', 'crucible_asr_transcript_unreadable', server,
      `transcript.json of job ${admitted} on ${server} is not JSON (${(err as Error).message})`, admitted);
  }
  log(`asr job ${admitted} on ${server} done`);
  return { jobId: admitted, transcript };
}

/**
 * The file's name on the server. The EXTENSION is what the server's ffmpeg reads the container
 * off, so it is kept exactly; the stem is reduced to safe characters (Briefcase's rule).
 */
export function safeUploadName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  const dot = base.lastIndexOf('.');
  const extRaw = dot > 0 ? base.slice(dot) : '';
  const ext = extRaw.toLowerCase().replace(/[^.a-z0-9]/g, '');
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80);
  return `${stem || 'audio'}${ext || '.bin'}`;
}
