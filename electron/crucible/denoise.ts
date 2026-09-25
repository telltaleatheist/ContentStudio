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
 * {@link DenoiseClient} is the nine calls this door makes, typed as the vendored
 * SDK's own `CrucibleClient` spells them, so the SDK client satisfies it as it
 * is and a keeper or a tool can hand in anything else that does. The transport
 * and the lanes are another phase's (P3); this module never builds a client.
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
 * - **A busy lane parks** (LEDGER #195): `409 server_busy` or `409 leased` hands
 *   the holder's sentence to the injected `park`, which returns when the lane's
 *   owner says to ask again. Nothing here loops, retries on a timer, or sends
 *   the work anywhere else.
 * - **Cancel is a DELETE**, then the stream's own `cancelled` frame: hanging up
 *   would leave the job running on the lane.
 *
 * ── One lease for the pass ─────────────────────────────────────────────────
 *
 * The separator is resident between jobs (`KIND_DENOISE`, Crucible's ruling of
 * 2026-09-15), but the server clears the card the moment nothing holds it, so a
 * session's chunks would each pay the 913 MB checkpoint load. A lease is what
 * holds it for the rest of the pass. It is taken AFTER the first chunk (a lease
 * names what is already resident and never loads), heartbeated before each
 * later chunk, and released by {@link CrucibleVoiceIsolator.dispose}, which the
 * editor calls when a track is finished and again when the run ends. A lease
 * that cannot be taken is a DECLARED mode (Law 8), not a failure: the pass is
 * correct without it and only slower, and the log says which happened.
 * (BookForge's electron/crucible/denoise.ts, ported.)
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CrucibleBusy,
  CrucibleLeased,
  CrucibleRefused,
  type JobEvent,
  type JobRequest,
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
/** The act a lease on the separator names, which is what a bench shows. */
export const VOICE_ISOLATION_ACT = 'denoise';
/**
 * How long the pass's lease outlives silence. Heartbeated before every chunk,
 * and a 6-8 minute chunk separates in about a minute on the Mac, so five
 * minutes is several chunks of slack without holding a dead client's card long.
 */
export const VOICE_ISOLATION_LEASE_TTL_S = 300;
/** What places the manifest's two files on a host (PHASE4-AUDIO.md 4.2). */
export const VOICE_ISOLATION_PULL_COMMAND = `crucible denoise pull ${VOICE_ISOLATION_MODEL}`;
/** What builds the env `denoise` runs in: it has none of its own (plan section 3.4, section 19 N3). */
export const VOICE_ISOLATION_ENV_COMMAND = 'crucible install rvc';

/**
 * THE CALLS THIS DOOR MAKES, and nothing else. Spelled as the vendored SDK's
 * `CrucibleClient` spells them (@crucible/client 1.0.34), so that client is one
 * as it stands; anything else handed in must answer in the same shapes and
 * throw the SDK's error classes for a refusal (see docs/crucible/P7.md).
 */
export interface DenoiseClient {
  /** `GET /v1/info`: job types and each one's model rows, with `installed`. */
  info(): Promise<ServerInfo>;
  /** `POST /v1/uploads` (multipart, part `file`). */
  upload(data: Blob, options: { filename: string }): Promise<{ readonly blobId: string }>;
  /** `POST /v1/jobs`. A refusal throws `CrucibleRefused`; busy and leased are its `CrucibleBusy` and `CrucibleLeased`. */
  submit(request: JobRequest): Promise<string>;
  /** `GET /v1/jobs/{id}/events`, ending after the first terminal frame. */
  events(jobId: string): AsyncIterable<JobEvent>;
  /** `GET /v1/jobs/{id}/artifacts/{name}`: the bytes. */
  artifact(jobId: string, name: string): Promise<Uint8Array>;
  /** `DELETE /v1/jobs/{id}`. */
  cancel(jobId: string): Promise<unknown>;
  /** `POST /v1/models/{id}/lease`. */
  lease(subject: string, options: { act: string; ttlSeconds: number }): Promise<{ readonly leaseId: string }>;
  /** `POST /v1/leases/{id}/heartbeat`. */
  heartbeat(leaseId: string): Promise<unknown>;
  /** `DELETE /v1/leases/{id}`. */
  release(leaseId: string): Promise<void>;
}

/**
 * Wait out a busy lane. Called with the holder's sentence ("busy: bookforge,
 * tts 62% done"); resolves when the lane's owner says to ask again, rejects to
 * give up (an aborted `signal` is the run being cancelled). The lanes are P3's;
 * the editor's interim one is {@link parkOnProbe}.
 */
export type ParkOnBusyLane = (holderLine: string, signal?: AbortSignal) => Promise<void>;

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
    let fmt: { sampleRate: number; channels: number; blockAlign: number } | null = null;
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
        const body = Buffer.alloc(16);
        fs.readSync(fd, body, 0, 16, at + 8);
        fmt = { channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), blockAlign: body.readUInt16LE(12) };
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

/** What the stem check needs, whichever container the server chose. */
export interface AudioFormat {
  readonly sampleRate: number;
  readonly channels: number;
  readonly frames: number;
}

/**
 * A FLAC file's rate, channels and length, from its STREAMINFO block (the
 * first metadata block, which the format requires). A stream that does not
 * state its total samples (0) is refused: the length is the whole check.
 */
export function readFlacFormat(file: string): AudioFormat {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(42);
    if (fs.readSync(fd, head, 0, 42, 0) !== 42 || head.toString('latin1', 0, 4) !== 'fLaC') {
      throw new Error(`${file} is not a FLAC file`);
    }
    if ((head[4] & 0x7f) !== 0) throw new Error(`${file}'s first metadata block is not STREAMINFO`);
    const info = head.subarray(8);
    // Bytes 10..17 of STREAMINFO: rate (20 bits), channels-1 (3), bits-1 (5), total samples (36).
    const sampleRate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
    const channels = ((info[12] >> 1) & 0x07) + 1;
    const frames = (info[13] & 0x0f) * 2 ** 32 + info.readUInt32BE(14);
    if (frames === 0) throw new Error(`${file} does not state its length`);
    return { sampleRate, channels, frames };
  } finally {
    fs.closeSync(fd);
  }
}

/** A WAV (RIFF or RF64) or FLAC file's rate, channels and length, by its magic bytes. */
export function readAudioFormat(file: string): AudioFormat {
  const fd = fs.openSync(file, 'r');
  const magic = Buffer.alloc(4);
  try {
    fs.readSync(fd, magic, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  const kind = magic.toString('latin1');
  if (kind === 'fLaC') return readFlacFormat(file);
  if (kind === 'RIFF' || kind === 'RF64') return readWavFormat(file);
  throw new Error(`${file} starts "${kind}", which is neither WAV nor FLAC`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Refusals: the holder's line for a wait, the server's words for the rest
// ─────────────────────────────────────────────────────────────────────────────

/** The holder's sentence when the lane or the card is someone else's, else null. */
export function holderLineOf(err: unknown): string | null {
  if (err instanceof CrucibleBusy) return err.busyLine;
  if (err instanceof CrucibleLeased) return err.leasedLine;
  return null;
}

function describeRefusal(err: unknown, server: string, verb: string): Error {
  const at = `crucible "${server}"`;
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
  /** Waiting out a busy lane, with the holder's sentence. */
  | { readonly kind: 'parked'; readonly holderLine: string };

export interface VoiceIsolatorOptions {
  /** The registered name, for every sentence. Never a URL. */
  readonly server: string;
  readonly client: DenoiseClient;
  readonly park: ParkOnBusyLane;
  readonly onLog?: (line: string) => void;
}

export interface SeparateOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: VoiceIsolationProgress) => void;
}

export interface SeparatedChunk {
  /** Where the vocal stem was written: the caller's `out`, with the server's extension (`.wav`, `.flac`). */
  readonly stem: string;
  readonly jobId: string;
  /** `done.extra.load_seconds`: the load on the chunk that paid it, 0 on the rest while the lease holds. */
  readonly loadSeconds: number | null;
  readonly separateSeconds: number | null;
}

export class CrucibleVoiceIsolator {
  /** The registered name this pass runs on, for the operation row. */
  readonly server: string;
  private readonly client: DenoiseClient;
  private readonly park: ParkOnBusyLane;
  private readonly log: (line: string) => void;
  private offered = false;
  private leaseId: string | null = null;
  /** True once a lease has been asked for in this pass, so a refusal is logged once, not per chunk. */
  private leaseAsked = false;

  constructor(options: VoiceIsolatorOptions) {
    if (typeof options.server !== 'string' || options.server.trim() === '') {
      throw new VoiceIsolationRefused('crucible_server_not_named', String(options.server),
        'voice isolation needs the NAME of a registered Crucible server. There is no default server.');
    }
    this.server = options.server;
    this.client = options.client;
    this.park = options.park;
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

    // Keep the lease alive across the chunk about to run. A lease that has
    // lapsed is not a failure; it is re-taken after this chunk.
    await this.heartbeat();

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
    let jobId: string | null = null;
    while (jobId === null) {
      if (signal?.aborted) throw new VoiceIsolationCancelled(server, null, 'voice isolation was cancelled before the chunk was admitted');
      try {
        jobId = await this.client.submit(request);
      } catch (err) {
        const holder = holderLineOf(err);
        if (holder === null) throw describeRefusal(err, server, `the voice-isolation job for ${name}`);
        // A WAIT, NOT A FAILURE (LEDGER #195). The blob stays on the server: a
        // refused submission never materialises its inputs. The lane's owner
        // says when to ask again; nothing here counts or sleeps.
        this.log(`crucible "${server}" is busy (${holder}); ${name} waits for the lane`);
        progress({ kind: 'parked', holderLine: holder });
        try {
          await this.park(holder, signal);
        } catch (parkErr) {
          if (signal?.aborted) throw new VoiceIsolationCancelled(server, null, 'voice isolation was cancelled while it waited for the lane');
          throw parkErr;
        }
      }
    }
    this.log(`crucible "${server}" admitted voice isolation of ${name} as ${jobId}`);

    const done = await this.follow(jobId, name, signal, progress);

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
    let bytes: Uint8Array;
    try {
      bytes = await this.client.artifact(jobId, primary);
    } catch (err) {
      throw describeRefusal(err, server, `the stem of job ${jobId}`);
    }
    // THE CONTAINER IS THE SERVER'S. 1.0.34 published WAV stems; the 1.0.38 on
    // the Mac publishes FLAC (found live, 2026-09-25). The stem keeps the
    // server's extension beside the path Python asked for, and the answer
    // names the file actually written, so ffmpeg on the Python side reads it
    // by what it is.
    const target = path.join(path.dirname(out), `${path.basename(out, path.extname(out))}${path.extname(primary) || path.extname(out)}`);
    // Written beside, then renamed: a half-written stem must never be the one
    // voice_separation.py concatenates.
    const partial = `${target}.partial`;
    fs.writeFileSync(partial, bytes);
    let stem: AudioFormat;
    try {
      stem = readAudioFormat(partial);
    } catch (err) {
      fs.rmSync(partial, { force: true });
      throw new VoiceIsolationRefused('voice_isolation_stem_unreadable', server,
        `the stem of job ${jobId} is neither a WAV nor a FLAC this side can read: ${err instanceof Error ? err.message : String(err)}`);
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

    // AFTER the first chunk: a lease names what is already resident, and this
    // job is what made it so.
    await this.holdTheSeparator();

    const num = (key: string): number | null => (typeof done.extra[key] === 'number' ? done.extra[key] as number : null);
    return { stem: target, jobId, loadSeconds: num('load_seconds'), separateSeconds: num('separate_seconds') };
  }

  /** Give the card back. Idempotent and never throws, so it sits in a `finally`. */
  async dispose(): Promise<void> {
    const held = this.leaseId;
    this.leaseId = null;
    this.leaseAsked = false;
    if (held === null) return;
    try {
      await this.client.release(held);
      this.log(`released ${VOICE_ISOLATION_MODEL} on crucible "${this.server}" (lease ${held})`);
    } catch (err) {
      // Declared, not swallowed: the ttl frees it, and the log says it had to.
      this.log(`could not release lease ${held} on crucible "${this.server}" `
        + `(${err instanceof Error ? err.message : String(err)}); it lapses after ${VOICE_ISOLATION_LEASE_TTL_S} s`);
    }
  }

  /** Follow one job to its terminal frame. A DELETE on abort, then the stream's own `cancelled`. */
  private async follow(
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
      this.client.cancel(jobId).catch((err: unknown) => {
        // A job already past cancelling is the stream's news to deliver.
        this.log(`cancel of crucible "${server}" job ${jobId} was not accepted: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      for await (const event of this.client.events(jobId)) {
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

  private async holdTheSeparator(): Promise<void> {
    if (this.leaseAsked) return;
    this.leaseAsked = true;
    try {
      ({ leaseId: this.leaseId } = await this.client.lease(VOICE_ISOLATION_MODEL, {
        act: VOICE_ISOLATION_ACT, ttlSeconds: VOICE_ISOLATION_LEASE_TTL_S,
      }));
      this.log(`holding ${VOICE_ISOLATION_MODEL} on crucible "${this.server}" for the rest of the pass (lease ${this.leaseId})`);
    } catch (err) {
      this.leaseId = null;
      // DECLARED, NOT FATAL (Law 8): correct without it, only slower.
      this.log(`could not hold ${VOICE_ISOLATION_MODEL} on crucible "${this.server}" `
        + `(${err instanceof Error ? err.message : String(err)}); each later chunk may pay its own model load`);
    }
  }

  private async heartbeat(): Promise<void> {
    const held = this.leaseId;
    if (held === null) return;
    try {
      await this.client.heartbeat(held);
    } catch (err) {
      // The lease lapsed or was released: the run is unprotected, not broken.
      // Asked for again after the next chunk.
      this.leaseId = null;
      this.leaseAsked = false;
      this.log(`lease ${held} on crucible "${this.server}" is no longer open `
        + `(${err instanceof Error ? err.message : String(err)}); it is taken again after the next chunk`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The editor's door: the selected server, its capability, and an interim park
// ─────────────────────────────────────────────────────────────────────────────

/** What the editor's IPC needs, built by {@link crucibleVoiceIsolation} over the app's Crucible context. */
export interface VoiceIsolationDeps {
  /** Can the selected server isolate voice? A reason on every "no", for the Denoise row. */
  status(): Promise<{ available: boolean; reason: string }>;
  /** An isolator on the selected server, started (its /v1/info row checked). */
  open(onLog: (line: string) => void): Promise<CrucibleVoiceIsolator>;
}

/** The parts of the Crucible context this door reads (electron/crucible/context.ts). */
export interface VoiceIsolationContext {
  servers: { selected(): string };
  factory: { clientFor(name: string, options?: { timeoutMs?: number }): Promise<DenoiseClient> };
  probes: { reach(name: string): Promise<{ probe: { outcome: string; message?: string; facts?: { busyLine: string | null } } }> };
}

/** How often {@link parkOnProbe} re-reads the probe: its own cache window (probe.ts PROBE_CACHE_MS). */
export const PARK_REREAD_MS = 15_000;

/**
 * THE INTERIM PARK, until P3's lanes own admission: wait until the selected
 * server's probe reads a free lane, re-reading at the probe's own 15 s cache
 * window, then let the isolator ask the door again. The door is still what
 * decides (`/v1/activity` is a display, never admission), so a lane taken again
 * between the read and the submit parks again with the new holder's sentence.
 */
export function parkOnProbe(probes: VoiceIsolationContext['probes'], server: string, rereadMs = PARK_REREAD_MS): ParkOnBusyLane {
  return async (_holderLine, signal) => {
    for (;;) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, rereadMs);
        const stop = (): void => { clearTimeout(timer); reject(new Error('cancelled while waiting for the lane')); };
        if (signal?.aborted) { stop(); return; }
        signal?.addEventListener('abort', stop, { once: true });
      });
      const answer = await probes.reach(server);
      if (answer.probe.outcome === 'ok' && answer.probe.facts?.busyLine === null) return;
    }
  };
}

/** Voice isolation over the app's Crucible context: always the SELECTED server (LEDGER #205). */
export function crucibleVoiceIsolation(ctx: VoiceIsolationContext): VoiceIsolationDeps {
  return {
    async status() {
      let server: string;
      try {
        server = ctx.servers.selected();
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
    async open(onLog) {
      const server = ctx.servers.selected();
      // A work client: no deadline, which would cut off the event stream.
      const client = await ctx.factory.clientFor(server);
      const isolator = new CrucibleVoiceIsolator({ server, client, park: parkOnProbe(ctx.probes, server), onLog });
      await isolator.start();
      return isolator;
    },
  };
}
