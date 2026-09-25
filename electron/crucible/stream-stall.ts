/**
 * THE STALL CLOCK: ten minutes of silence ends a run, ten minutes of work does not.
 *
 * Ported from BookForge's electron/crucible/stream-stall.ts (plan section
 * 13.5). It replaces two wall clocks that measured the wrong thing:
 *
 *  - the AI pool's 30-minute watchdog (queue-manager.service.ts), which
 *    force-failed one request that ran long and left the provider call running;
 *  - the chapter stage's 4-hour cap (metadata-generator.service.ts), which a
 *    long livestream on slow hardware could legitimately outrun, and which a
 *    wedged server would hold for four hours before anybody was told.
 *
 * The question is not "how long has this taken" but "how long since the server
 * last said anything". The answer is reset by every sign of life: an SSE event
 * of any kind (P5's asr, P7's denoise), a completed chat, a decide answer, and
 * the job's own progress lines. An MLX warm-load is minutes of silence and is
 * healthy; ten minutes of it is not (BookForge, Owen's ruling 3, 2026-09-20).
 *
 * Two shapes, one window:
 *
 *   withStreamStallClock   one SSE loop (transport.ts, asr, denoise): the loop
 *                          calls `beat()` per frame; silence cancels the job
 *                          and throws {@link CrucibleStreamWentQuiet}.
 *   JobStallClock          one queue job (lanes.ts): `beat()` on every sign of
 *                          life above; silence calls `onStall`, which aborts
 *                          the open fetch, cancels the job's open Crucible jobs
 *                          and releases its lease (the job's ledger rows).
 *
 * Both are armed BEFORE the first sign of life: a server that accepts the
 * work and then says nothing at all is exactly the failure this exists for.
 */

/** The silence that means a server has stopped answering (plan section 13.5). */
export const CRUCIBLE_STALL_MS = 10 * 60 * 1000;

/**
 * How long a stream is given, after the DELETE, to deliver its terminal frame
 * before this gives up on it. Short on purpose: the server is already not
 * answering, and the caller is holding a lane and a queue row while it waits.
 */
export const CRUCIBLE_STREAM_STALL_GRACE_MS = 15_000;

/**
 * A run that went quiet for longer than the clock allows. Named, never a
 * silence and never a generic timeout.
 */
export class CrucibleStreamWentQuiet extends Error {
  readonly code = 'crucible_went_quiet';

  constructor(
    readonly server: string,
    /** The Crucible job that stopped talking, or null when there was none (a chat, a whole queue job). */
    readonly jobId: string | null,
    /** The clock that fired, in ms. */
    readonly stallMs: number,
    message: string,
  ) {
    super(message);
    this.name = 'CrucibleStreamWentQuiet';
  }
}

/** How long a stall of `stallMs` is worth saying out loud (a keeper's clock is sub-second). */
export function describeStallInterval(stallMs: number): string {
  if (stallMs < 1000) return `${stallMs} ms`;
  const minutes = stallMs / 60_000;
  if (minutes >= 1 && Number.isInteger(minutes)) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${Math.round(stallMs / 1000)} s`;
}

export interface StreamStallOptions<T> {
  /** For the refusal's sentence. A registry name, never a URL. */
  readonly server: string;
  /** The job being followed, when the caller already knows its id. */
  readonly jobId: string | null;
  readonly stallMs?: number;
  readonly graceMs?: number;
  /**
   * Send the DELETE. Called exactly once, when the clock fires, and BOUNDED by
   * `graceMs`: a cancel to the wedged server that caused the stall can hang
   * exactly as the stream did.
   */
  readonly onStall: () => Promise<void> | void;
  readonly onLog?: (line: string) => void;
  /** The loop over the stream. It MUST call `beat()` on every frame it sees. */
  readonly consume: (beat: () => void) => Promise<T>;
}

/**
 * Run one event-stream loop under the stall clock. Resolves with `consume`'s
 * value; throws {@link CrucibleStreamWentQuiet} when `beat()` went unsaid for
 * longer than the clock allows, and rethrows anything `consume` threw.
 */
export async function withStreamStallClock<T>(options: StreamStallOptions<T>): Promise<T> {
  const stallMs = options.stallMs ?? CRUCIBLE_STALL_MS;
  const graceMs = options.graceMs ?? CRUCIBLE_STREAM_STALL_GRACE_MS;
  const say = options.onLog ?? (() => undefined);

  let fired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let announceStall!: () => void;
  const stalled = new Promise<void>((resolve) => { announceStall = resolve; });
  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = (): void => {
    disarm();
    if (fired) return;
    timer = setTimeout(() => {
      fired = true;
      timer = null;
      announceStall();
    }, stallMs);
    timer.unref?.();
  };
  arm();

  const running = options.consume(() => { arm(); });
  // The race below may leave `running` pending; give it a sink so a late
  // rejection nobody awaits cannot take the process down.
  const settled = running.then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, err }),
  );
  const first = await Promise.race([settled, stalled.then(() => 'stalled' as const)]);
  if (first !== 'stalled') {
    disarm();
    if (first.ok) return first.value;
    throw first.err;
  }

  say(`crucible "${options.server}" has sent no frame for ${describeStallInterval(stallMs)}`
    + `${options.jobId === null ? '' : ` on job ${options.jobId}`}; cancelling it`);
  await Promise.race([
    Promise.resolve().then(options.onStall).catch((err: unknown) => {
      say(`the cancel of the silent crucible "${options.server}" job was not accepted: ${err instanceof Error ? err.message : String(err)}`);
    }),
    sleep(graceMs),
  ]);
  // The grace is not a second chance: the answer is `crucible_went_quiet`
  // whatever the stream does now; this only lets the socket close tidily.
  await Promise.race([settled, sleep(graceMs)]);
  disarm();
  throw new CrucibleStreamWentQuiet(
    options.server, options.jobId, stallMs,
    `crucible "${options.server}"${options.jobId === null ? '' : ` job ${options.jobId}`} sent no `
    + `event for ${describeStallInterval(stallMs)}. The connection was still open, which is what a `
    + 'server whose worker has wedged looks like, so the job was cancelled rather than waited on. '
    + 'Nothing here retried it.',
  );
}

/**
 * One queue job's stall clock. Armed at `start()`, reset by `beat()`, fired
 * ONCE by silence: `onStall` gets the sentence the job fails with. `stop()`
 * disarms it for good (the job ended). Never fires after `stop()`.
 */
export class JobStallClock {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fired = false;
  private stopped = false;
  /** When the last sign of life was seen (epoch ms), for the lanes strip and the log. */
  lastBeatAt: number | null = null;

  constructor(
    private readonly what: string,
    private readonly onStall: (sentence: string) => void,
    private readonly stallMs: number = CRUCIBLE_STALL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.beat();
  }

  /** A sign of life: an SSE event, a completed chat, a decide answer, a progress line. */
  beat(): void {
    if (this.stopped || this.fired) return;
    this.lastBeatAt = this.now();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      this.fired = true;
      this.onStall(
        `${this.what} heard nothing from its server for ${describeStallInterval(this.stallMs)}: no event, no `
        + 'completed chat and no decide answer. The open request was aborted and the job\'s Crucible holds '
        + 'were given back. Nothing retried it.',
      );
    }, this.stallMs);
    this.timer.unref?.();
  }

  get hasFired(): boolean {
    return this.fired;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
