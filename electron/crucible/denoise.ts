/**
 * THE EDITOR'S VOICE ISOLATION, ON A CRUCIBLE: one `denoise` job per chunk.
 *
 * LEDGER #200, plan section 9 and P7. Until now the editor isolated a mic track
 * by running audio-separator in a subprocess from the downloaded
 * `voice-separator-env`. The model call is now Crucible's `denoise` job on the
 * `vocals-roformer` manifest (crucible docs/PHASE4-AUDIO.md section 4.2), and
 * NOTHING ELSE MOVED: editor-backend/core/voice_separation.py still plans the
 * chunks at silences, skips the silent ones, extracts each at 44.1 kHz,
 * reassembles the stems and resamples back to 48 kHz. It asks for each chunk
 * with a `separation_request` on stdout; python-service.ts hands the request
 * here, and the stem path goes back on stdin.
 *
 * ── The job, as the server documents it ────────────────────────────────────
 *
 *   upload the chunk      POST /v1/uploads            -> blob id
 *   submit                POST /v1/jobs {type: 'denoise', model: 'vocals-roformer',
 *                                        params: {}, inputs: {<chunk>: {blob_id}}}
 *   follow                GET  /v1/jobs/{id}/events   warming, progress, artifact, done
 *   fetch the stem        GET  /v1/jobs/{id}/artifacts/{done.primary_stem}
 *   cancel                DELETE /v1/jobs/{id}
 *
 * `params` is `{}` and that IS every param stated: the server validates it with
 * `extra="forbid"` and every separation knob is an engine default nobody has a
 * reason to move (PHASE4-AUDIO.md 4.2, "`params` is empty, and that is the
 * contract"). The input must already be 44.1 kHz: the server never resamples,
 * and its worker fails a job whose input is any other rate. So the rate is
 * checked HERE, on the WAV header, before a byte is uploaded.
 *
 * ── The HTTP client is injected ────────────────────────────────────────────
 *
 * {@link DenoiseClient} is the six calls this door makes, typed as the vendored
 * SDK's own `CrucibleClient` spells them, so the SDK client (and its
 * `CrucibleSession`) satisfies it as it is and a keeper or a tool can hand in
 * anything else that does. This module never builds a client.
 * docs/crucible/P7.md says exactly what a client must provide.
 *
 * ── What it refuses, and what it never does ────────────────────────────────
 *
 * - **A server that cannot isolate voice is refused by name before any upload**
 *   (plan section 0a, "check `/v1/info` rows before uploading"): no `denoise`
 *   job type, no `vocals-roformer` row, or the row not installed. It never
 *   falls back to the local env (Law 1; LEDGER #200).
 * - **A missing env is `409 env_missing` at the submit** (plan section 0a,
 *   "Mechanics"), relayed in the server's words with the command that builds it.
 * - **A failed job aborts the run** with the server's message: the noisy
 *   original never ships (plan section 9, "Fail loud, as today").
 * - **Another app on the server is a wait in its line, not a refusal** (LEDGER
 *   #255): the pass runs in a queue session, which waits its turn in the
 *   server's line before the first chunk is submitted (`in_line` progress says
 *   where it stands). Nothing here loops, retries on a timer, or sends the work
 *   anywhere else.
 * - **A session the server ended aborts the run by name** (`session_closed`
 *   with its reason): no new session is opened to carry on.
 * - **Cancel is a DELETE**, then the stream's own `cancelled` frame: hanging up
 *   would leave the job running on the lane.
 *
 * ── One queue session for the pass (Crucible 1.0.76, LEDGER #255) ──────────
 *
 * The separator stays resident inside the session that loaded it, so a pass's
 * chunks pay the 913 MB checkpoint load once. The editor's voice isolation runs
 * OUTSIDE any queue job (the editor's own workflow), so the pass holds a session
 * of its own: asked for (or this install's open one joined, never a second one
 * beside it: session.ts) once the first chunk is uploaded, held across the
 * track's chunks, and let go of by {@link CrucibleVoiceIsolator.dispose}, which
 * the editor calls when a track is finished and again when the run ends. The
 * editor's own Python between chunks is work on this side, not on the server's:
 * the session's `idle_s` (900 s) covers it.
 *
 * Inside the editor's processing run the session is the RUN's (run-session.ts,
 * LEDGER #264): `open(onLog, run)` asks the run for it, the run keeps it (and
 * touches it) through the rest of the workflow and the transcription after it,
 * and `dispose` lets go of nothing the run still holds.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { SessionSource } from './session';
import {
  CrucibleRefused,
  CrucibleSessionClosed,
  type JobEvent,
  type JobRequest,
  type QueuePosition,
  type ServerInfo,
} from '@crucible/client';

/** The job type the server runs voice isolation as. */
export const DENOISE_JOB_TYPE = 'denoise';
/**
 * The manifest: Kimberley Jensen's Mel-Band RoFormer vocals model, the same
 * checkpoint `voice-separator-env` ran (`vocals_mel_band_roformer.ckpt`).
 * Crucible's `denoise-roformer` is a different model (it keeps the signal minus
 * room hiss, not the voice minus everything else) and is never substituted.
 */
export const VOICE_ISOLATION_MODEL = 'vocals-roformer';
/** The model's native rate (crucible/denoise/vocals-roformer.toml `sample_rate`). */
export const VOICE_ISOLATION_SAMPLE_RATE = 44_100;
/** EMPTY BY CONTRACT (PHASE4-AUDIO.md 4.2): the server forbids every key. Not an omission. */
export const VOICE_ISOLATION_PARAMS: Readonly<Record<string, never>> = Object.freeze({});
/** The act the pass's queue session names, which is what a bench shows. */
export const VOICE_ISOLATION_ACT = 'denoise';
/** What places the manifest's two files on a host (PHASE4-AUDIO.md 4.2). */
export const VOICE_ISOLATION_PULL_COMMAND = `crucible denoise pull ${VOICE_ISOLATION_MODEL}`;
/** What builds the env `denoise` runs in: it has none of its own (plan section 3.4, section 19 N3). */
export const VOICE_ISOLATION_ENV_COMMAND = 'crucible install rvc';

/**
 * THE CALLS THIS DOOR MAKES, and nothing else. Spelled as the vendored SDK's
 * `CrucibleClient` spells them (@crucible/client 1.0.76), so that client and its
 * `CrucibleSession` are one as they stand; anything else handed in must answer
 * in the same shapes and throw the SDK's error classes for a refusal (see
 * docs/crucible/P7.md).
 */
export interface DenoiseClient {
  /** `GET /v1/info`: job types and each one's model rows, with `installed`. */
  info(): Promise<ServerInfo>;
  /** `POST /v1/uploads` (multipart, part `file`). */
  upload(data: Blob, options: { filename: string }): Promise<{ readonly blobId: string }>;
  /** `POST /v1/jobs`. A refusal throws `CrucibleRefused`; an ended session is `CrucibleSessionClosed`. */
  submit(request: JobRequest): Promise<string>;
  /** `GET /v1/jobs/{id}/events`, ending after the first terminal frame. */
  events(jobId: string): AsyncIterable<JobEvent>;
  /** `GET /v1/jobs/{id}/artifacts/{name}`: the bytes. */
  artifact(jobId: string, name: string): Promise<Uint8Array>;
  /** `DELETE /v1/jobs/{id}`. */
  cancel(jobId: string): Promise<unknown>;
}

/** The queue session a pass's jobs run in: its client sends `X-Crucible-Session`. Let go of it once. */
export interface DenoiseSession {
  readonly client: DenoiseClient;
  release(): Promise<void>;
}

/**
 * Hold the queue session the pass runs in (lanes.ts `sessionOn`: this install's open session on
 * the server joined, else a new one). Resolves once it is open; `onQueue` hears its place in the
 * server's line while it waits; an aborted `signal` takes it out of the line.
 */
export type OpenDenoiseSession = (options: { onQueue: (position: QueuePosition) => void; signal?: AbortSignal }) => Promise<DenoiseSession>;

/** A refusal before or at the submit, or a result this side cannot use. The run aborts. */
export class VoiceIsolationRefused extends Error {
  constructor(readonly code: string, readonly server: string, message: string) {
    super(message);
    this.name = 'VoiceIsolationRefused';
  }
}

/** A job the server admitted, ran and ended `failed`. The run aborts; the noisy original never ships. */
export class VoiceIsolationFailed extends Error {
  constructor(readonly code: string, readonly server: string, readonly jobId: string, message: string) {
    super(message);
    this.name = 'VoiceIsolationFailed';
  }
}

/** The run was cancelled: before the submit (nothing was sent) or after it (the job was DELETEd). */
export class VoiceIsolationCancelled extends Error {
  constructor(readonly server: string, readonly jobId: string | null, message: string) {
    super(message);
    this.name = 'VoiceIsolationCancelled';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Can this server isolate voice? Read off /v1/info, never guessed.
// ─────────────────────────────────────────────────────────────────────────────

export type VoiceIsolationAvailability =
  | { readonly available: true; readonly vramBytes: number | null }
  | { readonly available: false; readonly code: string; readonly reason: string };

/**
 * One server's `/v1/info`, read for voice isolation. Every "no" names what is
 * missing and the command on that host that supplies it, because the editor's
 * Denoise row prints it where the toggle would have been.
 */
export function voiceIsolationAvailability(info: ServerInfo, server: string): VoiceIsolationAvailability {
  const at = `The Crucible on ${server}`;
  if (!info.jobTypes.includes(DENOISE_JOB_TYPE)) {
    return {
      available: false,
      code: 'voice_isolation_not_offered',
      reason: `${at} does not offer voice isolation (it runs ${info.jobTypes.join(', ') || 'no job types'}). `
        + `\`${VOICE_ISOLATION_ENV_COMMAND}\` there builds the env it runs in.`,
    };
  }
  const row = info.capabilities.find((c) => c.jobType === DENOISE_JOB_TYPE);
  const models = (row?.models ?? []) as readonly Readonly<Record<string, unknown>>[];
  const model = models.find((m) => m['id'] === VOICE_ISOLATION_MODEL);
  if (model === undefined) {
    return {
      available: false,
      code: 'voice_isolation_model_not_offered',
      reason: `${at} has no ${VOICE_ISOLATION_MODEL} manifest (its denoise models: `
        + `${models.map((m) => String(m['id'])).join(', ') || 'none'}). It shipped in Crucible 1.0.24; update that server.`,
    };
  }
  if (model['installed'] !== true) {
    return {
      available: false,
      code: 'voice_isolation_model_not_installed',
      reason: `${at} has not downloaded ${VOICE_ISOLATION_MODEL} yet. \`${VOICE_ISOLATION_PULL_COMMAND}\` there fetches it.`,
    };
  }
  const vram = model['vramBytes'];
  return { available: true, vramBytes: typeof vram === 'number' ? vram : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// The WAV header: the rate before upload, and the stem's length after
// ─────────────────────────────────────────────────────────────────────────────

export interface WavFormat {
  readonly sampleRate: number;
  readonly channels: number;
  /** The `fmt ` chunk's format tag: 1 is integer PCM; 0xFFFE (extensible) carries the real one in {@link subFormat}. */
  readonly formatTag: number;
  /** WAVE_FORMAT_EXTENSIBLE's sub-format tag (the first two bytes of its GUID), or null for a plain `fmt `. */
  readonly subFormat: number | null;
  readonly bitsPerSample: number;
  readonly blockAlign: number;
  readonly dataBytes: number;
  /** Sample frames: `dataBytes / blockAlign`. */
  readonly frames: number;
}

/**
 * The format and length of a RIFF or RF64 WAVE file, read from its header and
 * nothing else. The rate is what the server would refuse (its worker fails a
 * job whose input is not 44.1 kHz, after the upload); the frame count is how
 * the stem is held to the server's own invariant that it comes back the same
 * length, sample for sample. Anything that is not a WAVE with a `fmt ` and a
 * `data` chunk is refused by name rather than read as some rate.
 */
export function readWavFormat(file: string): WavFormat {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) !== 12) throw new Error(`${file} is ${size} bytes, too short to be a WAV`);
    const riff = head.toString('ascii', 0, 4);
    if ((riff !== 'RIFF' && riff !== 'RF64') || head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`${file} is not a WAVE file (it starts "${head.toString('latin1', 0, 4)}")`);
    }
    let at = 12;
    let fmt: { sampleRate: number; channels: number; formatTag: number; subFormat: number | null; bitsPerSample: number; blockAlign: number } | null = null;
    let rf64DataBytes: number | null = null;
    const chunk = Buffer.alloc(8);
    while (at + 8 <= size) {
      fs.readSync(fd, chunk, 0, 8, at);
      const id = chunk.toString('ascii', 0, 4);
      const length = chunk.readUInt32LE(4);
      if (id === 'ds64') {
        const ds64 = Buffer.alloc(16);
        fs.readSync(fd, ds64, 0, 16, at + 8);
        rf64DataBytes = Number(ds64.readBigUInt64LE(8));
      } else if (id === 'fmt ') {
        const body = Buffer.alloc(Math.max(16, Math.min(length, 40)));
        fs.readSync(fd, body, 0, body.length, at + 8);
        const formatTag = body.readUInt16LE(0);
        fmt = {
          formatTag,
          channels: body.readUInt16LE(2),
          sampleRate: body.readUInt32LE(4),
          blockAlign: body.readUInt16LE(12),
          bitsPerSample: body.readUInt16LE(14),
          // WAVE_FORMAT_EXTENSIBLE: cbSize at 16, then valid bits, channel mask, the GUID at 24.
          subFormat: formatTag === 0xfffe && length >= 40 ? body.readUInt16LE(24) : null,
        };
      } else if (id === 'data') {
        if (fmt === null) throw new Error(`${file} has its data before its fmt chunk`);
        // RF64 writes 0xFFFFFFFF here and the real size in ds64.
        const dataBytes = length === 0xffffffff && rf64DataBytes !== null ? rf64DataBytes : length;
        if (fmt.blockAlign === 0) throw new Error(`${file} states a block align of 0`);
        return { ...fmt, dataBytes, frames: Math.floor(dataBytes / fmt.blockAlign) };
      }
      at += 8 + length + (length % 2);
    }
    throw new Error(`${file} has no ${fmt === null ? 'fmt ' : 'data'} chunk`);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * THE STEM IS A 16-BIT PCM WAV, and nothing else is read. Crucible's `denoise` worker asks the
 * separator for WAV (`OUTPUT_FORMAT = "WAV"`, jobs/denoise/__init__.py) and refuses to publish
 * any other container; audio-separator writes it as int16 (`write_audio_pydub`). That is the
 * Mac's installed 1.0.40, read in its source during P10: the FLAC stems 1.0.38 published were
 * the bug its worker fixed (the model instance kept the load's format). voice_separation.py
 * writes its silent passthrough in the same pcm_s16le, so every stem it concatenates is one
 * format. A stem in any other container or depth is refused by name (Law 1): nothing converts.
 */
export const STEM_BITS_PER_SAMPLE = 16;

/** True when a WAV's samples are integer PCM (plain, or WAVE_FORMAT_EXTENSIBLE with the PCM sub-format). */
function isIntegerPcm(format: WavFormat): boolean {
  return format.formatTag === 1 || (format.formatTag === 0xfffe && format.subFormat === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Refusals: the server's words
// ─────────────────────────────────────────────────────────────────────────────

function describeRefusal(err: unknown, server: string, verb: string): Error {
  const at = `crucible "${server}"`;
  if (err instanceof CrucibleSessionClosed) {
    return new VoiceIsolationRefused('session_closed', server,
      `${at} ended the queue session voice isolation ran in (${err.reason}: ${err.serverMessage}), so ${verb} stops here. `
      + 'No new session is opened to carry on.');
  }
  if (err instanceof CrucibleRefused) {
    // `env_missing` and `denoise_model_missing` are the two a host can fix, and
    // the second already names its command in the server's message.
    const fix = err.code === 'env_missing' ? ` \`${VOICE_ISOLATION_ENV_COMMAND}\` on that host builds it.` : '';
    return new VoiceIsolationRefused(
      err.code, server, `${at} refused ${verb} (HTTP ${err.status} ${err.code}): ${err.serverMessage}.${fix}`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  const named = (err as { code?: unknown } | null)?.code;
  const code = typeof named === 'string' ? named : 'crucible_transport';
  return new VoiceIsolationRefused(code, server, `${at} could not complete ${verb}: ${message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The isolator: one per pass, one job per chunk
// ─────────────────────────────────────────────────────────────────────────────

/** What a chunk's job said about itself, for the editor's operation row. */
export type VoiceIsolationProgress =
  | { readonly kind: 'uploading' }
  /** The model being made ready for this job; no fraction. */
  | { readonly kind: 'warming'; readonly message: string }
  /** The server's own fraction for this chunk, 0..1, never re-derived here. */
  | { readonly kind: 'progress'; readonly fraction: number; readonly message: string }
  /** The pass's queue session waiting in the server's line: 1 is next, of `of` waiting. */
  | { readonly kind: 'in_line'; readonly position: number; readonly of: number };

export interface VoiceIsolatorOptions {
  /** The registered name, for every sentence. Never a URL. */
  readonly server: string;
  /** A plain client: what the server offers (`/v1/info`) and the uploads. */
  readonly client: DenoiseClient;
  /** The queue session the jobs run in, asked for once the first chunk is uploaded. */
  readonly session: OpenDenoiseSession;
  readonly onLog?: (line: string) => void;
}

export interface SeparateOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: VoiceIsolationProgress) => void;
}

export interface SeparatedChunk {
  /** Where the vocal stem was written: the caller's `out`, exactly (a 16-bit PCM WAV). */
  readonly stem: string;
  readonly jobId: string;
  /** `done.extra.load_seconds`: the load on the chunk that paid it, 0 on the rest while the session holds it. */
  readonly loadSeconds: number | null;
  readonly separateSeconds: number | null;
}

export class CrucibleVoiceIsolator {
  /** The registered name this pass runs on, for the operation row. */
  readonly server: string;
  private readonly client: DenoiseClient;
  private readonly openSession: OpenDenoiseSession;
  private readonly log: (line: string) => void;
  private offered = false;
  /** The pass's queue session: asked for by the first chunk, let go of by {@link dispose}. */
  private session: Promise<DenoiseSession> | null = null;

  constructor(options: VoiceIsolatorOptions) {
    if (typeof options.server !== 'string' || options.server.trim() === '') {
      throw new VoiceIsolationRefused('crucible_server_not_named', String(options.server),
        'voice isolation needs the NAME of a registered Crucible server. There is no default server.');
    }
    this.server = options.server;
    this.client = options.client;
    this.openSession = options.session;
    this.log = options.onLog ?? (() => undefined);
  }

  /**
   * Ask the server, once, whether it can isolate voice, BEFORE any chunk is
   * extracted or uploaded (plan section 0a). Resolves with the model's
   * declared memory; refuses by name otherwise.
   */
  async start(): Promise<{ vramBytes: number | null }> {
    let info: ServerInfo;
    try {
      info = await this.client.info();
    } catch (err) {
      throw describeRefusal(err, this.server, 'the /v1/info read voice isolation starts with');
    }
    const offer = voiceIsolationAvailability(info, this.server);
    if (!offer.available) throw new VoiceIsolationRefused(offer.code, this.server, offer.reason);
    this.offered = true;
    this.log(`voice isolation runs on crucible "${this.server}" (${VOICE_ISOLATION_MODEL}, `
      + `${offer.vramBytes === null ? 'memory not stated' : `${(offer.vramBytes / 2 ** 30).toFixed(2)} GiB declared`}); `
      + 'one job per chunk, nothing is loaded on this machine');
    return { vramBytes: offer.vramBytes };
  }

  /**
   * Separate ONE 44.1 kHz chunk; the vocal stem is written to `out`. Rejects
   * with {@link VoiceIsolationRefused}, {@link VoiceIsolationFailed} or
   * {@link VoiceIsolationCancelled}; any of them aborts the run.
   */
  async separate(chunk: string, out: string, options: SeparateOptions = {}): Promise<SeparatedChunk> {
    const { signal } = options;
    const progress = options.onProgress ?? (() => undefined);
    const server = this.server;
    if (!this.offered) {
      throw new VoiceIsolationRefused('voice_isolation_not_started', server,
        'a chunk was sent before the server was asked whether it isolates voice. start() asks, and skipping '
        + 'it would put the refusal after the upload.');
    }
    // THE RATE, BEFORE THE UPLOAD. The server never resamples (PHASE4-AUDIO.md
    // 4.2) and its worker fails any other rate after the bytes have crossed.
    let input: WavFormat;
    try {
      input = readWavFormat(chunk);
    } catch (err) {
      throw new VoiceIsolationRefused('voice_isolation_input_unreadable', server,
        `the chunk to isolate could not be read as a WAV: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (input.sampleRate !== VOICE_ISOLATION_SAMPLE_RATE) {
      throw new VoiceIsolationRefused('voice_isolation_input_not_44100', server,
        `${path.basename(chunk)} is ${input.sampleRate} Hz; ${VOICE_ISOLATION_MODEL} takes ${VOICE_ISOLATION_SAMPLE_RATE} Hz `
        + 'and the server does not resample. voice_separation.py extracts every chunk at 44.1 kHz, so this one '
        + 'did not come from it.');
    }
    if (input.frames === 0) {
      throw new VoiceIsolationRefused('voice_isolation_input_empty', server, `${path.basename(chunk)} holds no audio`);
    }
    if (!fs.existsSync(path.dirname(out))) {
      throw new VoiceIsolationRefused('voice_isolation_out_dir_missing', server,
        `the stem was to land in ${path.dirname(out)}, which does not exist. The caller creates it.`);
    }
    if (signal?.aborted) throw new VoiceIsolationCancelled(server, null, 'voice isolation was cancelled before the chunk was sent');

    const name = path.basename(chunk);
    progress({ kind: 'uploading' });
    const openAsBlob = (fs as unknown as { openAsBlob?: (p: string) => Promise<Blob> }).openAsBlob;
    if (openAsBlob === undefined) {
      throw new VoiceIsolationRefused('crucible_runtime_too_old', server,
        `uploading ${name} needs fs.openAsBlob (Node 19.8+); this runtime is ${process.versions.node}`);
    }
    let blobId: string;
    try {
      // Streamed from disk: a 6-8 minute 24-bit stereo chunk is ~100 MB.
      ({ blobId } = await this.client.upload(await openAsBlob(chunk), { filename: name }));
    } catch (err) {
      throw describeRefusal(err, server, `the upload of ${name}`);
    }

    const request: JobRequest = {
      type: DENOISE_JOB_TYPE,
      model: VOICE_ISOLATION_MODEL,
      params: VOICE_ISOLATION_PARAMS,
      inputs: { [name]: { blobId } },
      clientRef: `contentstudio:voice-isolation:${name}`,
    };
    // THE PASS'S SESSION, once the chunk is on the server (a blob waits for nobody's turn). The
    // first chunk asks for it and may wait in the server's line; the rest run in it.
    const inSession = await this.sessionFor(signal, progress);
    let jobId: string;
    try {
      jobId = await inSession.submit(request);
    } catch (err) {
      throw describeRefusal(err, server, `the voice-isolation job for ${name}`);
    }
    this.log(`crucible "${server}" admitted voice isolation of ${name} as ${jobId}`);

    const done = await this.follow(inSession, jobId, name, signal, progress);

    // THE STEM THE SERVER NAMES, never one picked by filename here: exactly one
    // output names the primary stem, and that is the server's invariant.
    const primary = done.extra['primary_stem'];
    if (typeof primary !== 'string' || primary === '') {
      throw new VoiceIsolationRefused('voice_isolation_primary_unnamed', server,
        `crucible "${server}" job ${jobId} ended done without naming its primary stem `
        + `(primary_stem = ${JSON.stringify(primary ?? null)})`);
    }
    if (!(done.artifacts ?? []).includes(primary)) {
      throw new VoiceIsolationRefused('voice_isolation_primary_unpublished', server,
        `crucible "${server}" job ${jobId} named "${primary}" as its stem and published `
        + `${(done.artifacts ?? []).join(', ') || 'nothing'}`);
    }
    // A 16-BIT PCM WAV, AT THE PATH PYTHON ASKED FOR (STEM_BITS_PER_SAMPLE above). A
    // primary stem named anything but .wav is refused before its bytes are fetched.
    if (path.extname(primary).toLowerCase() !== '.wav') {
      throw new VoiceIsolationRefused('voice_isolation_stem_not_wav', server,
        `crucible "${server}" job ${jobId} published its stem as "${primary}"; this side reads only a `
        + `${STEM_BITS_PER_SAMPLE}-bit PCM WAV stem, which Crucible's denoise has returned since 1.0.39`);
    }
    let bytes: Uint8Array;
    try {
      bytes = await inSession.artifact(jobId, primary);
    } catch (err) {
      throw describeRefusal(err, server, `the stem of job ${jobId}`);
    }
    const target = out;
    // Written beside, then renamed: a half-written stem must never be the one
    // voice_separation.py concatenates.
    const partial = `${target}.partial`;
    fs.writeFileSync(partial, bytes);
    let stem: WavFormat;
    try {
      stem = readWavFormat(partial);
    } catch (err) {
      fs.rmSync(partial, { force: true });
      throw new VoiceIsolationRefused('voice_isolation_stem_unreadable', server,
        `the stem of job ${jobId} is not a WAV this side can read: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isIntegerPcm(stem) || stem.bitsPerSample !== STEM_BITS_PER_SAMPLE) {
      fs.rmSync(partial, { force: true });
      throw new VoiceIsolationRefused('voice_isolation_stem_not_pcm16', server,
        `the stem of job ${jobId} is a WAV of format ${stem.formatTag}${stem.subFormat === null ? '' : `/${stem.subFormat}`} `
        + `at ${stem.bitsPerSample} bits; this side reads only ${STEM_BITS_PER_SAMPLE}-bit integer PCM`);
    }
    // THE SERVER'S TWO INVARIANTS, ASSERTED ON ARRIVAL (PHASE4-AUDIO.md 4.2:
    // "The app asserts the same thing"). voice_separation.py concatenates the
    // stems back in order, so a stem of another length would move every word
    // after it.
    if (stem.sampleRate !== input.sampleRate || stem.frames !== input.frames) {
      fs.rmSync(partial, { force: true });
      throw new VoiceIsolationRefused('voice_isolation_stem_mismatch', server,
        `the stem of job ${jobId} is ${stem.frames} frames at ${stem.sampleRate} Hz and ${name} was `
        + `${input.frames} frames at ${input.sampleRate} Hz`);
    }
    fs.renameSync(partial, target);

    const num = (key: string): number | null => (typeof done.extra[key] === 'number' ? done.extra[key] as number : null);
    return { stem: target, jobId, loadSeconds: num('load_seconds'), separateSeconds: num('separate_seconds') };
  }

  /** Let go of the pass's session. Idempotent and never throws, so it sits in a `finally`. */
  async dispose(): Promise<void> {
    const held = this.session;
    this.session = null;
    if (held === null) return;
    const session = await held.catch(() => null);
    if (session === null) return;
    await session.release();
    this.log(`let go of the queue session on crucible "${this.server}" (the separator goes with it unless other work of this app holds it)`);
  }

  /** The pass's session client: asked for once, waiting in the server's line if it must. */
  private async sessionFor(signal: AbortSignal | undefined, progress: (p: VoiceIsolationProgress) => void): Promise<DenoiseClient> {
    if (this.session === null) {
      const asking = this.openSession({
        onQueue: (position) => {
          this.log(`crucible "${this.server}" has other work on it; voice isolation waits in its line (${position.position} of ${position.of})`);
          progress({ kind: 'in_line', position: position.position, of: position.of });
        },
        ...(signal === undefined ? {} : { signal }),
      });
      this.session = asking;
      // A wait that was abandoned holds nothing: the next chunk asks again.
      asking.catch(() => { if (this.session === asking) this.session = null; });
    }
    try {
      return (await this.session).client;
    } catch (err) {
      if (signal?.aborted) throw new VoiceIsolationCancelled(this.server, null, 'voice isolation was cancelled while it waited in the server\'s line');
      throw describeRefusal(err, this.server, 'the queue session voice isolation runs in');
    }
  }

  /** Follow one job to its terminal frame. A DELETE on abort, then the stream's own `cancelled`. */
  private async follow(
    client: DenoiseClient,
    jobId: string,
    name: string,
    signal: AbortSignal | undefined,
    progress: (p: VoiceIsolationProgress) => void,
  ): Promise<{ artifacts?: readonly string[]; extra: Readonly<Record<string, unknown>> }> {
    const server = this.server;
    let cancelAsked = false;
    const cancel = (): void => {
      if (cancelAsked) return;
      cancelAsked = true;
      this.log(`cancelling crucible "${server}" job ${jobId}`);
      client.cancel(jobId).catch((err: unknown) => {
        // A job already past cancelling is the stream's news to deliver.
        this.log(`cancel of crucible "${server}" job ${jobId} was not accepted: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      for await (const event of client.events(jobId)) {
        if (event.event === 'warming') {
          progress({ kind: 'warming', message: event.data.message ?? 'warming up' });
        } else if (event.event === 'progress') {
          // A frame that states no fraction moved nothing (1.0.25 nullability).
          if (event.data.fraction !== null) {
            progress({ kind: 'progress', fraction: event.data.fraction, message: event.data.message ?? `${Math.round(event.data.fraction * 100)}%` });
          }
        } else if (event.event === 'failed') {
          throw new VoiceIsolationFailed(event.data.error.code, server, jobId,
            `crucible "${server}" could not isolate the voice in ${name} (job ${jobId}, ${event.data.error.code}): `
            + `${event.data.error.message}`);
        } else if (event.event === 'cancelled') {
          throw new VoiceIsolationCancelled(server, jobId, cancelAsked
            ? `voice isolation was cancelled; crucible "${server}" job ${jobId} was DELETEd`
            : `crucible "${server}" job ${jobId} was cancelled on the server`);
        } else if (event.event === 'done') {
          return { ...(event.data.artifacts === undefined ? {} : { artifacts: event.data.artifacts }), extra: event.data.extra };
        }
      }
    } catch (err) {
      if (err instanceof VoiceIsolationFailed || err instanceof VoiceIsolationCancelled) throw err;
      // The stream died with the job still on the lane: stop it rather than
      // leave it holding the card for nobody, then abort the run by name.
      cancel();
      throw describeRefusal(err, server, `the events of job ${jobId}`);
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
    throw new VoiceIsolationRefused('crucible_protocol', server, `the event stream of job ${jobId} ended with no terminal frame`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The editor's door: the routing's server, its capability, and the pass's session
// ─────────────────────────────────────────────────────────────────────────────

/** What the editor's IPC needs, built by {@link crucibleVoiceIsolation} over the app's Crucible context. */
export interface VoiceIsolationDeps {
  /** Can the selected server isolate voice? A reason on every "no", for the Denoise row. */
  status(): Promise<{ available: boolean; reason: string }>;
  /**
   * An isolator on the selected server, started (its /v1/info row checked). `sessions` is where its
   * queue session comes from: the editor run's (`RunSession`, run-session.ts, LEDGER #264), so
   * the transcription after it runs in the same session; the app's lanes when absent.
   */
  open(onLog: (line: string) => void, sessions?: SessionSource): Promise<CrucibleVoiceIsolator>;
}

/** The parts of the Crucible context this door reads (electron/crucible/context.ts). */
export interface VoiceIsolationContext {
  servers: { selected(): string };
  /** The model routing's server, which every action uses when it names one (Owen 2026-09-29). */
  routingServer(): string | null;
  factory: { clientFor(name: string, options?: { timeoutMs?: number }): Promise<DenoiseClient> };
  /** The lanes, which hand out queue sessions (lanes.ts `sessionOn`; session.ts). */
  lanes: SessionSource;
}

/** Voice isolation over the app's Crucible context: the routing's server, else the selected one (LEDGER #205; Owen 2026-09-29). */
export function crucibleVoiceIsolation(ctx: VoiceIsolationContext): VoiceIsolationDeps {
  return {
    async status() {
      let server: string;
      try {
        server = ctx.routingServer() ?? ctx.servers.selected();
      } catch (err) {
        return { available: false, reason: `Needs a Crucible with voice isolation: ${err instanceof Error ? err.message : String(err)}` };
      }
      try {
        const client = await ctx.factory.clientFor(server, { timeoutMs: 3_000 });
        const offer = voiceIsolationAvailability(await client.info(), server);
        return offer.available
          ? { available: true, reason: `Runs on the Crucible on ${server}.` }
          : { available: false, reason: `Needs a Crucible with voice isolation. ${offer.reason}` };
      } catch (err) {
        return { available: false, reason: `Needs a Crucible with voice isolation. The Crucible on ${server} did not answer: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    async open(onLog, sessions) {
      const server = ctx.routingServer() ?? ctx.servers.selected();
      // A work client: no deadline, which would cut off the event stream.
      const client = await ctx.factory.clientFor(server);
      const isolator = new CrucibleVoiceIsolator({
        server,
        client,
        session: async ({ onQueue, signal }) => {
          const hold = await (sessions ?? ctx.lanes).sessionOn(server, {
            act: VOICE_ISOLATION_ACT,
            what: 'the editor\'s voice isolation',
            onQueue,
            ...(signal === undefined ? {} : { signal }),
          });
          return { client: hold.card.session, release: () => hold.release() };
        },
        onLog,
      });
      await isolator.start();
      return isolator;
    },
  };
}
