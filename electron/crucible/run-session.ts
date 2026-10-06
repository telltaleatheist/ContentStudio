/**
 * ONE QUEUE SESSION FOR ONE EDITOR PROCESSING RUN (LEDGER #264).
 *
 * The editor's process flow for a project is voice isolation (the workflow's `separation_request`s,
 * denoise.ts), then transcribing each track (transcribe.py's `asr_request`s, editor-asr.ts). Each of
 * those used to hold the server's session only while it worked, so the session closed after
 * isolation and again after every track. Closing a session settles the card (the server unloads
 * what nothing holds), so the next step opened a new session and loaded qwen3-asr-1.7b and
 * qwen3-aligner again, and between steps the card was free for another app to slip in.
 *
 * A {@link RunSession} is the run's turn on the server. It is a {@link SessionSource}: the steps ask
 * IT for their session, and it asks the app's source (lanes.ts `sessionOn`, so the ServerSessions
 * rule holds: an open session of ours on that server is joined, never a second one beside it) once
 * per server, on the run's first Crucible call there. Every later step gets the same session, and
 * its own release lets go of nothing. The run lets go once, in a `finally`, when it ends.
 *
 * THE GAPS ON THIS SIDE. Between steps the work is ours, not the server's: the rest of the workflow
 * after isolation (GCC-PHAT sync, video alignment, Dugan, every compound and the zip), the
 * renderer's bootstrap of the new session, and transcribe.py extracting and compacting each track.
 * On 2026-10-06 that was 593 s between isolation and the first track, and it grows with the length
 * of the stream, so it can pass `idle_s` (900 s). While the run holds a session it touches it every
 * {@link SESSION_TOUCH_EVERY_MS} (session.ts's rule: work on this side is not activity on the
 * server's), so a gap never idles it out.
 *
 * A session the server ends under the run (operator, max_hold, server_restart) is never replaced:
 * the run's next step fails `session_closed` naming the reason (NO FALLBACKS).
 *
 * THE HAND-OFF ({@link EditorRunSessions}). Processing and transcription are two IPC calls from the
 * renderer. A processing run started with "transcribe when processing finishes" is PARKED when the
 * workflow succeeds, keyed by the session zip it produced; the transcription of that zip adopts it.
 * Anything else lets go: a failed or cancelled workflow, a run that will not be transcribed, a new
 * processing run, a transcription of another zip, the window closing, or no transcription arriving
 * within {@link RUN_HANDOFF_MS} (said in the log by name).
 */
import * as path from 'path';
import * as log from 'electron-log';
import { SESSION_TOUCH_EVERY_MS, type CardSession, type SessionHold, type SessionRequest, type SessionSource } from './session';

/** How long a finished processing run waits, holding its session, for the renderer to start its transcription. */
export const RUN_HANDOFF_MS = 5 * 60_000;

/** One editor run's session on each server it uses (in practice one): asked for by its first step there. */
export class RunSession implements SessionSource {
  private readonly holds = new Map<string, Promise<SessionHold>>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private released = false;

  constructor(
    /** What the run is, for every log line: "the editor's processing run job_123". */
    readonly what: string,
    private readonly source: SessionSource,
    private readonly touchEveryMs: number = SESSION_TOUCH_EVERY_MS,
  ) {}

  /** True once the run let go. */
  get done(): boolean {
    return this.released;
  }

  /** The run's session on `server`: asked for by its first step there, then the same one for every step. */
  async sessionOn(server: string, request: SessionRequest): Promise<SessionHold> {
    const what = `${this.what} (${request.what})`;
    if (this.released) {
      // A step after the run's end is a wiring bug: it would open a session nobody lets go of.
      throw new Error(`${what} asked for a queue session on "${server}" after the run let go of its own.`);
    }
    let holding = this.holds.get(server);
    if (holding === undefined) {
      holding = this.source.sessionOn(server, { ...request, what });
      this.holds.set(server, holding);
      const asked = holding;
      asked.then(
        (hold) => this.startTouching(server, hold.card),
        // A wait that was abandoned (a cancel in the line) holds nothing: the next step asks again.
        () => { if (this.holds.get(server) === asked) this.holds.delete(server); },
      );
    }
    const hold = await holding;
    hold.card.assertOpen(what);
    // The run lets go of the session, once, at its end: a step's release is nothing.
    return { card: hold.card, release: async () => undefined };
  }

  /** Let go of every session the run holds, once. Never throws (it runs in a `finally`). */
  async release(why: string): Promise<void> {
    if (this.released) return;
    this.released = true;
    const holds = [...this.holds.entries()];
    this.holds.clear();
    for (const [server, holding] of holds) {
      const hold = await holding.catch(() => null);
      if (hold === null) continue;
      log.info(`[crucible] ${this.what} lets go of queue session ${hold.card.id} on "${server}" (${why})`);
      await hold.release();
    }
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  private startTouching(server: string, card: CardSession): void {
    if (this.released || this.timers.has(server)) return;
    const timer = setInterval(() => {
      if (card.ended !== null) {
        // Ended by the server: ServerSessions said so loudly, and the run's next step fails naming it.
        clearInterval(timer);
        this.timers.delete(server);
        return;
      }
      card.touch().catch((err: unknown) => {
        log.warn(`[crucible] ${this.what}: could not touch queue session ${card.id} on "${server}": ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.touchEveryMs);
    timer.unref?.();
    this.timers.set(server, timer);
  }
}

interface Parked {
  readonly zip: string;
  readonly run: RunSession;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * The editor's runs, and the one hand-off between them: a processing run parked for the
 * transcription of the zip it produced. One editor window, one processing run at a time.
 */
export class EditorRunSessions {
  private parked: Parked | null = null;

  constructor(
    private readonly source: SessionSource,
    private readonly options: { handoffMs?: number; touchEveryMs?: number } = {},
  ) {}

  /** A new processing run (`execute-workflow`). A run still parked for a transcription is let go of first. */
  startProcessing(jobId: string): RunSession {
    this.letGoOfParked('a new processing run started');
    return new RunSession(`the editor's processing run ${jobId}`, this.source, this.options.touchEveryMs);
  }

  /**
   * The workflow ended. `transcribeZip` is the zip the renderer will transcribe next (the run
   * succeeded and was started with "transcribe when processing finishes"); null lets go now.
   */
  async processingEnded(run: RunSession, transcribeZip: string | null, why: string): Promise<void> {
    if (transcribeZip === null) {
      await run.release(why);
      return;
    }
    this.letGoOfParked('another processing run finished');
    const zip = path.resolve(transcribeZip);
    const handoffMs = this.options.handoffMs ?? RUN_HANDOFF_MS;
    const timer = setTimeout(() => {
      if (this.parked?.run !== run) return;
      log.warn(
        `[crucible] ${run.what} finished ${Math.round(handoffMs / 1000)} s ago to be transcribed, and no transcription of ` +
          `${zip} has started; letting go of its queue session`,
      );
      this.letGoOfParked('its transcription never started');
    }, handoffMs);
    timer.unref?.();
    this.parked = { zip, run, timer };
    log.info(`[crucible] ${run.what} keeps its queue session for the transcription of ${zip}`);
  }

  /** The transcription of `zipPath`: the processing run parked for it, or a new run of its own. */
  startTranscription(jobId: string, zipPath: string): RunSession {
    const zip = path.resolve(zipPath);
    const parked = this.parked;
    if (parked !== null && parked.zip === zip) {
      clearTimeout(parked.timer);
      this.parked = null;
      log.info(`[crucible] the editor's transcription ${jobId} runs in ${parked.run.what}'s queue session`);
      return parked.run;
    }
    this.letGoOfParked(`a transcription of another session (${zip}) started`);
    return new RunSession(`the editor's transcription ${jobId}`, this.source, this.options.touchEveryMs);
  }

  /** Let go of a parked run, if there is one (the window that would transcribe it closed, …). */
  letGoOfParked(why: string): void {
    const parked = this.parked;
    if (parked === null) return;
    this.parked = null;
    clearTimeout(parked.timer);
    void parked.run.release(why);
  }
}
