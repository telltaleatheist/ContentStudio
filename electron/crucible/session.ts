/**
 * ONE QUEUE SESSION PER CONTENTSTUDIO JOB PER SERVER (Crucible 1.0.76, LEDGER #255), and the
 * residency that happens inside it.
 *
 * WHAT REPLACED WHAT. Until 1.0.55 a job took one LEASE per local model (lease.ts, plan 13.3): a
 * 120 s ttl renewed by a 40 s heartbeat, released in the job's `finally`, and a heartbeat answered
 * `unknown_lease` marked the hold `lease_lost`. Crucible 1.0.76 removed leases from the server and
 * the SDK (sdk/ts/MIGRATION.md, Owen's ruling: "no legacy compatibility"). A QUEUE SESSION is this
 * app's turn holding the whole server (docs/QUEUE.md): `crucible.session({act, idleS, onQueue,
 * signal})` waits in the server's first-come-first-served line and resolves once the session is
 * OPEN; while it is open nothing from any other client runs, and what its items leave on the card
 * stays there for the next item. One session is open at a time per server.
 *
 *   lease + heartbeat          ->  session({act, idleS: 900}); the server counts its own work as
 *                                  activity, and lanes.ts touches the session around cloud calls
 *   release                    ->  session.close(), when the last holder lets go
 *   loadModel({lease})         ->  loadModel inside the session (it holds what it loads)
 *   lease_lost                 ->  session_closed: the session's `closed` resolved, or an item
 *                                  was refused `409 session_closed`; the stage fails naming the
 *                                  reason (idle, operator, max_hold, server_restart). Nothing
 *                                  reopens a session and carries on: that would be a run that
 *                                  looks protected and was not (NO FALLBACKS).
 *   parking on 409 leased      ->  gone: session() waits in the line itself (onQueue says where)
 *
 * ONE SESSION PER SERVER FROM THIS CLIENT ({@link ServerSessions}). Crucible matches session
 * membership on the client name (`contentstudio@<host>`, client-factory.ts): every request this
 * install sends while its session is open is an item of it, header or not. A SECOND session asked
 * for from this client while the first is open would queue BEHIND the first, never merge with it
 * (Crucible's requirement, LEDGER #255). So this module never asks for a second: whoever needs a
 * server while a session of ours is open there joins it (the editor's story title beside the
 * metadata job, the Thumbnails window's words), and the session closes when the last holder lets
 * go. A lane job owns its session for its whole run (lanes.ts `sessionOn`); a standalone action
 * (no lane job) holds one only for as long as it works.
 *
 * WHAT COUNTS AS ACTIVITY (`idleS`, the one rule, LEDGER #255). Every session ContentStudio opens
 * says `idle_s` {@link JOB_SESSION_IDLE_S} (900 s). Work the server is doing for the session (a
 * job, a chat or decision being answered, a load) is activity by itself. Work on THIS side is not:
 * a `claude -p` call, an Anthropic field routed through a Crucible mid-job, ffmpeg, the editor's
 * own Python between denoise chunks. Around a cloud call inside a lane job the lanes touch the
 * job's open session every {@link SESSION_TOUCH_EVERY_MS} (lanes.ts `aiCall`), so a long cloud
 * stage never idles the job's session out. The editor's processing run holds ONE session from its
 * voice isolation to its last track's transcription and touches it on the same clock through the
 * gaps between (run-session.ts, LEDGER #264); any other gap on this side has the 900 s.
 *
 * NOTHING HERE UNLOADS A MODEL. Closing the session settles the card (the server unloads what
 * nothing else holds). Inside the session a later load evicts an earlier model on its own.
 */
import * as log from 'electron-log';
import {
  CrucibleBusy,
  CrucibleCardHeld,
  CrucibleProtocolError,
  CrucibleRefused,
  CrucibleServerError,
  CrucibleSessionClosed,
  CrucibleSessionHeld,
  type CapabilityRecord,
  type CrucibleClient,
  type CrucibleSession,
  type JobEvent,
  type ModelInfo,
  type QueuePosition,
  type QueueSessionEnd,
} from '@crucible/client';
import { CrucibleCallError } from './errors';
import type { LoadFloor } from './batch';
import type { InFlightLedger } from './in-flight-ledger';
import type { CrucibleStepHooks } from './lanes';
import { crucibleUnavailableCause } from './transport-failure';

/** `idle_s` on every session ContentStudio opens: the server closes it after this long with nothing in flight and no touch. */
export const JOB_SESSION_IDLE_S = 900;
/** How often a lane job touches its open session while one of its cloud calls runs (docs/QUEUE.md: "every 30 s is fine"). */
export const SESSION_TOUCH_EVERY_MS = 30_000;
/** Re-following a load's dropped event stream: first wait, cap, and budget from the drop (BookForge stream-reconnect). */
export const LOAD_STREAM_RETRY: Readonly<{ firstMs: number; maxMs: number; budgetMs: number }> = {
  firstMs: 5_000,
  maxMs: 30_000,
  budgetMs: 5 * 60_000,
};

/** The refusal codes that mean "the server is briefly someone else's", never "no". */
export const BUSY_REFUSAL_CODES: ReadonlySet<string> = new Set(['server_busy', 'session_open', 'engine_in_use']);

/** The holder's sentence for a busy refusal, or null when it is not one. */
export function busyLineOfRefusal(err: unknown): string | null {
  if (err instanceof CrucibleSessionHeld) return err.heldLine;
  if (err instanceof CrucibleBusy) return err.busyLine;
  if (err instanceof CrucibleCardHeld) return err.heldLine;
  if (err instanceof CrucibleRefused && BUSY_REFUSAL_CODES.has(err.code)) return err.serverMessage;
  return null;
}

/** The sentence a stage fails with when its session ended under it. */
export function sessionEndedError(server: string, sessionId: string, end: { reason: string; message: string }, what: string): CrucibleCallError {
  return new CrucibleCallError(
    'session_closed',
    `${what} ran in ContentStudio's queue session ${sessionId} on "${server}", and the server ended it ` +
      `(${end.reason}: ${end.message}). The stage stops here; no new session is opened to carry on.`,
    server,
    409,
    'session_closed',
  );
}

/**
 * One SDK failure as the door's named refusal. Anything already named passes
 * through; a cancel is the caller's to name (the transport maps it).
 */
export function callRefusalOf(err: unknown, server: string): unknown {
  if (err instanceof CrucibleCallError) return err;
  if (err instanceof CrucibleSessionClosed) {
    return new CrucibleCallError(
      'session_closed',
      `ContentStudio's queue session ${err.sessionId} on "${server}" ended (${err.reason}): ${err.serverMessage}. ` +
        'Nothing more runs in it, and no new session is opened to carry on.',
      server, err.status, err.code, null, err,
    );
  }
  const line = busyLineOfRefusal(err);
  if (line !== null) {
    const status = err instanceof CrucibleRefused ? err.status : null;
    const code = err instanceof CrucibleRefused ? err.code : null;
    return new CrucibleCallError('busy', `"${server}" is busy (${line}). Nothing was started there.`, server, status, code, line, err);
  }
  if (err instanceof CrucibleRefused) {
    if (err.code === 'context_over_limit') {
      return new CrucibleCallError('over_context', `"${server}" refused the load: ${err.serverMessage}`, server, err.status, err.code, null, err);
    }
    return new CrucibleCallError('refused', `"${server}" refused (${err.code}): ${err.serverMessage}`, server, err.status, err.code, null, err);
  }
  if (err instanceof CrucibleServerError) {
    return new CrucibleCallError('refused', `"${server}" failed (${err.code}, HTTP ${err.status}): ${err.serverMessage}`, server, err.status, err.code, null, err);
  }
  if (err instanceof CrucibleProtocolError) {
    return new CrucibleCallError('protocol_error', `"${server}" answered in a shape ContentStudio cannot read: ${err.message}`, server, null, null, null, err);
  }
  const wire = crucibleUnavailableCause(err);
  if (wire !== null) return new CrucibleCallError('unreachable', `"${server}" is not answering (${wire}).`, server, null, null, null, err);
  return err;
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

class LoadAborted extends Error {
  constructor() {
    super('the load was cancelled by the caller');
    this.name = 'AbortError';
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LoadAborted());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LoadAborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ── what a session is asked for ─────────────────────────────────────────────

/** What a session is opened (or joined) for. */
export interface SessionRequest {
  /** The capability class of the work that opens it (`generate`, `decide`, `asr`, `denoise`). */
  act: string;
  /** What the work is, for every log line: "the metadata job 1234", "story title suggestions". */
  what: string;
  /** Aborts a wait in the line (the session leaves it). Never ends an open session. */
  signal?: AbortSignal;
  /** How long it may wait in the line to open (`max_wait_s`); the server's default (an hour) when absent. */
  maxWaitS?: number;
  /** The session's place in the line, whenever it joins or moves. */
  onQueue?(position: QueuePosition): void;
}

/** A session held for one piece of work: let go of it once, when the work is done. */
export interface SessionHold {
  readonly card: CardSession;
  /** Never throws. The session closes when its last holder lets go. */
  release(): Promise<void>;
}

/** Who hands out sessions: lanes.ts (`sessionOn`), which keeps a lane job's for its whole run. */
export interface SessionSource {
  sessionOn(server: string, request: SessionRequest): Promise<SessionHold>;
}

// ── one open session, and the card inside it ────────────────────────────────

/** One model call's residency: make `model` resident in the session at a context that fits. */
export interface ResidencyRequest {
  /** The act of the call that needs it. */
  act: string;
  /** The step's lane hooks: the load job is written to the in-flight ledger the moment it is admitted. */
  hooks: Pick<CrucibleStepHooks, 'submitted' | 'settled' | 'streamed' | 'streamDropped'>;
  /** Tokens the calling request needs (prompt + output budget), or null when it cannot be stated. */
  need: number | null;
  /** The context to load at, when this session loads the model (today's num_ctx, LEDGER #111). */
  loadContext?: number;
  signal?: AbortSignal;
  /**
   * Set by {@link CardSession.ensure} when a batch's load floor raised `loadContext` (batch.ts): the
   * floor's reason, for the load's log line. A caller never sets it.
   */
  floor?: string;
}

export interface CardTimings {
  loadStreamRetry: { firstMs: number; maxMs: number; budgetMs: number };
}

/** What is resident in the session, as this side made it so. */
interface Resident {
  model: string;
  /** What `/v1/models` said the model is served at. */
  maxModelLen: number | null;
  /** The context the session loaded it at, when this side loaded it. */
  loadedAt: number | null;
}

/**
 * ONE OPEN QUEUE SESSION on one server, and what this side knows is resident in it. Every request
 * the work makes goes through {@link session} (the SDK's `CrucibleSession`, which sends
 * `X-Crucible-Session`) or names {@link id} on the raw chat door, so a session the server ended
 * answers `409 session_closed` instead of running the request as a plain one.
 */
export class CardSession {
  private resident: Resident | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  /**
   * A STAGE-MAJOR BATCH's load floors for the stage it is in (batch.ts, LEDGER #266), per model: a
   * load of that model in this session happens at least at the floor, so the batch's first load is
   * at the largest context any of its jobs stated for the stage, and a later job that needs more
   * finds it already there. Empty outside a batch (a single job loads at each call's own step, #209).
   */
  private floors: ReadonlyMap<string, LoadFloor> = new Map();

  constructor(
    readonly server: string,
    readonly session: CrucibleSession,
    private readonly timings: CardTimings = { loadStreamRetry: { ...LOAD_STREAM_RETRY } },
  ) {}

  get id(): string {
    return this.session.id;
  }

  /** How it ended, once this side knows; null while it is open. */
  get ended(): QueueSessionEnd | null {
    return this.session.ended;
  }

  /** Throw `session_closed` naming the reason when the server ended the session. The stage fails loudly. */
  assertOpen(what: string): void {
    const end = this.session.ended;
    if (end !== null) throw sessionEndedError(this.server, this.id, end, what);
  }

  /** `POST /v1/queue/sessions/{id}/touch`: work on this side is not activity on the server's. */
  touch(): Promise<void> {
    return this.session.touch();
  }

  /** The loaded-context facts for `model`, when it is the one resident. */
  contextFacts(model: string): { maxModelLen: number | null; loadedAt: number | null } {
    const resident = this.resident;
    if (resident === null || resident.model !== model) return { maxModelLen: null, loadedAt: null };
    return { maxModelLen: resident.maxModelLen, loadedAt: resident.loadedAt };
  }

  /**
   * The server said the model is not resident (another item of the session loaded something
   * else: a transcription between two chats, the editor's title on another model): the next
   * {@link ensure} makes it resident again. The one re-ensure plan 16 P2 names.
   */
  forget(model: string): void {
    if (this.resident?.model === model) this.resident = null;
  }

  /**
   * The batch's floors for the stage that just opened (lanes.ts, from batch.ts `onStageOpen`):
   * replaces the last stage's, so a model the stage does not state loads at its own call's step.
   */
  setLoadFloors(floors: ReadonlyMap<string, LoadFloor>, stage: string): void {
    this.floors = new Map(floors);
    const said = [...floors.entries()].map(([model, f]) => `${model} at ${f.tokens} (${f.jobId}: ${f.why})`);
    log.info(
      `[crucible] session ${this.id} on "${this.server}", the batch's ${stage} stage: ` +
        (said.length === 0 ? 'no load floor (no job stated a need there)' : `load floor${said.length === 1 ? '' : 's'} ${said.join('; ')}`),
    );
  }

  /** The request with the batch floor for `model` applied to its load context (a call that states none is left alone). */
  private floored(model: string, request: ResidencyRequest): ResidencyRequest {
    const floor = this.floors.get(model);
    if (floor === undefined || request.loadContext === undefined || floor.tokens <= request.loadContext) return request;
    return { ...request, loadContext: floor.tokens, floor: `the batch's floor for this stage, ${floor.tokens} tokens (${floor.jobId}: ${floor.why}); this call alone needs ${request.loadContext}` };
  }

  /** Make `model` resident in this session at a context that fits `request`, unless it already is. */
  async ensure(model: string, what: string, unfloored: ResidencyRequest): Promise<void> {
    const request = this.floored(model, unfloored);
    const run = this.lock.then(() => this.ensureUnlocked(model, what, request));
    this.lock = run.catch(() => undefined);
    await run;
  }

  private async ensureUnlocked(model: string, what: string, request: ResidencyRequest): Promise<void> {
    this.assertOpen(what);
    const known = this.resident;
    if (known !== null && known.model === model) {
      const window = known.maxModelLen ?? known.loadedAt;
      const grows = request.need !== null && window !== null && request.need > window
        && request.loadContext !== undefined && request.loadContext > window;
      if (!grows) return;
      const floor = this.floors.get(model);
      if (floor !== undefined) {
        // Said loudly: the batch loaded this model at what its jobs stated, and a call needs more.
        log.warn(
          `[crucible] ${what}: the batch's stated floor for ${model} (${floor.tokens}, ${floor.jobId}: ${floor.why}) was short ` +
            `of the ${request.need} tokens this call needs; the load grows once, as a single job's would`,
        );
      }
      // WITHIN A JOB the window only grows (LEDGER #209: a job loads at the step its largest
      // call needs, and a later smaller call runs in the window already open). A later call
      // that does not fit reloads the model at its own context. Shrinking happens between jobs.
      log.info(
        `[crucible] ${what}: ${model} on "${this.server}" is served at ${window} tokens and a call needs ` +
          `${request.need}; reloading it at ${request.loadContext}`,
      );
      this.resident = null;
      return this.load(model, what, request);
    }
    let rows: ModelInfo[];
    try {
      rows = await this.session.models();
    } catch (err) {
      throw callRefusalOf(err, this.server);
    }
    const row = rows.find((m) => m.id === model);
    if (row === undefined) {
      const offered = rows.filter((m) => m.modalities.includes('text')).map((m) => m.id);
      throw new CrucibleCallError(
        'unknown_model',
        `"${this.server}" has no model "${model}" (it offers: ${offered.join(', ') || 'none'}). The routing names it; ` +
          `pick a model this server offers in the routing dialog. Nothing was substituted.`,
        this.server,
      );
    }
    const window = row.maxModelLen;
    if (row.resident) {
      const tooSmall = request.need !== null && window !== null && request.need > window
        && request.loadContext !== undefined && request.loadContext > window;
      // A model left resident by an EARLIER job at a larger context than this one asks for is
      // reloaded at the smaller one (LEDGER #209, made unconditional by #220). Inside our session
      // the card is ours, so the reload disturbs nobody.
      const tooLarge = !tooSmall && window !== null && request.loadContext !== undefined && window > request.loadContext;
      if (!tooSmall && !tooLarge) {
        this.resident = { model, maxModelLen: window, loadedAt: null };
        log.info(`[crucible] ${what}: ${model} is resident on "${this.server}" in session ${this.id}`);
        return;
      }
      log.info(
        `[crucible] ${what}: ${model} is resident on "${this.server}" at ${window} tokens and this work needs ` +
          `${tooSmall ? `${request.need}` : `only ${request.loadContext}`}; reloading it at ${request.loadContext}` +
          (tooLarge ? ' (a declared cost: the smaller load is #209\'s rule)' : ''),
      );
    } else {
      // Refused here only on what the server STATED (false). Unstated (null, 1.0.25+) goes to the
      // load, and the server's own refusal names the cause.
      if (row.backendSupported === false) {
        throw new CrucibleCallError(
          'unsupported_model',
          `"${this.server}" cannot run ${model}${row.reason ? ` (${row.reason})` : ''}. Pick a model this server offers.`,
          this.server,
        );
      }
      if (row.installed === false) {
        throw new CrucibleCallError(
          'model_not_installed',
          `${model} is not downloaded on "${this.server}"${row.reason ? ` (${row.reason})` : ''}. Pull it on that ` +
            `server's catalog first; nothing was substituted.`,
          this.server,
        );
      }
    }
    return this.load(model, what, request);
  }

  /**
   * THE CAPABILITY QUESTION BEFORE A LOAD (plan 7.2; P4): `GET /v1/capability?class=generate&
   * context_tokens=<this load>&concurrency=1` asks whether the model fits the card at the size the
   * call needs, BEFORE the load evicts whatever is resident. A size the host cannot serve fails
   * `over_context` with the server's words and nothing is loaded or evicted (docs/crucible/P4.md).
   */
  private async fitsOnHost(model: string, what: string, request: ResidencyRequest): Promise<void> {
    if (request.loadContext === undefined) return;
    if (request.act === 'analysis') {
      log.info(
        `[crucible] ${what}: "${this.server}" predates the sized capability query (act analysis), so the ` +
          `${request.loadContext}-token load of ${model} is not asked about first; the load refuses by name if it cannot fit`,
      );
      return;
    }
    let record: CapabilityRecord;
    try {
      record = await this.session.capability({}, { class: 'generate', contextTokens: request.loadContext, concurrency: 1 });
    } catch (err) {
      if (err instanceof CrucibleRefused && err.code === 'context_over_limit') {
        throw new CrucibleCallError(
          'over_context',
          `"${this.server}" cannot serve ${model} at the ${request.loadContext} tokens ${what} needs, one request in ` +
            `flight: ${err.serverMessage}. Nothing was loaded and nothing was evicted.`,
          this.server, err.status, err.code, null, err,
        );
      }
      throw callRefusalOf(err, this.server);
    }
    const row = record.classes.find((c) => c.capability === 'generate')?.contextCeilings?.find((c) => c.model === model);
    if (row?.tokens !== null && row?.tokens !== undefined && row.tokens < request.loadContext) {
      throw new CrucibleCallError(
        'over_context',
        `"${this.server}" serves ${model} at most ${row.tokens} tokens at one request in flight` +
          `${row.boundBy ? ` (bound by ${row.boundBy})` : ''}, and ${what} needs a ${request.loadContext}-token ` +
          `load. Nothing was loaded and nothing was evicted.`,
        this.server,
      );
    }
    log.info(
      `[crucible] ${what}: "${this.server}" can serve ${model} at ${request.loadContext} tokens, one request in flight` +
        (row?.tokens != null ? ` (its ceiling there: ${row.tokens})` : ' (it states no ceiling row for this model; the load is the judge)'),
    );
  }

  private async load(model: string, what: string, request: ResidencyRequest): Promise<void> {
    await this.fitsOnHost(model, what, request);
    let jobId: string;
    try {
      jobId = await this.session.loadModel(model, request.loadContext === undefined ? {} : { context: request.loadContext });
    } catch (err) {
      throw callRefusalOf(err, this.server);
    }
    // Recorded before the next await (P3): a kill mid-load leaves the sweep a job to cancel.
    request.hooks.submitted({ server: this.server, id: jobId, jobType: 'load-model', model });
    log.info(
      `[crucible] ${what}: loading ${model} on "${this.server}" in session ${this.id}` +
        `${request.loadContext === undefined ? ' at its manifest context' : ` at ${request.loadContext} tokens`} (job ${jobId})` +
        (request.floor === undefined ? '' : `: ${request.floor}`),
    );
    const onAbort = (): void => {
      void this.session.cancel(jobId).catch(() => undefined);
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    let terminal: JobEvent;
    try {
      terminal = await this.followLoad(model, jobId, request);
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
    }
    request.hooks.settled(this.server, 'job', jobId);
    if (terminal.event === 'failed') {
      const error = (terminal.data as { error?: { code?: string; message?: string } }).error;
      throw new CrucibleCallError(
        'load_failed',
        `loading ${model} on "${this.server}" failed (${error?.code ?? 'no code'}): ${error?.message ?? 'no message'}`,
        this.server,
        null,
        error?.code ?? null,
      );
    }
    if (terminal.event === 'removed') {
      // A load that left the line without running: its session closed under it (`session_closed`),
      // or an operator took it out. Either way nothing was loaded, and the stage says which.
      const removal = terminal.data as { reason?: string; message?: string };
      const reason = removal.reason ?? 'no reason stated';
      throw new CrucibleCallError(
        reason === 'session_closed' ? 'session_closed' : 'load_failed',
        `loading ${model} on "${this.server}" never ran: it left session ${this.id}'s line (${reason}: ` +
          `${removal.message ?? 'no message'}). The stage stops here.`,
        this.server, null, reason,
      );
    }
    if (terminal.event === 'cancelled' || request.signal?.aborted) throw new LoadAborted();
    let after: ModelInfo | undefined;
    try {
      after = (await this.session.models()).find((m) => m.id === model);
    } catch (err) {
      throw callRefusalOf(err, this.server);
    }
    this.resident = { model, maxModelLen: after?.maxModelLen ?? null, loadedAt: request.loadContext ?? null };
  }

  /**
   * A load job's events to its terminal one. A stream that drops for weather is opened again
   * after the last event seen (Briefcase `followLoad`); lost past the budget, the call is
   * `unreachable`.
   */
  private async followLoad(model: string, jobId: string, request: ResidencyRequest): Promise<JobEvent> {
    const signal = request.signal;
    const { firstMs, maxMs, budgetMs } = this.timings.loadStreamRetry;
    let lastEventId = 0;
    let droppedAt: number | null = null;
    let wait = firstMs;
    for (;;) {
      try {
        for await (const event of this.session.events(jobId, lastEventId > 0 ? { lastEventId } : {})) {
          lastEventId = event.id;
          // The ledger's reconnect cursor, and the stall clock's beat (P3).
          request.hooks.streamed(this.server, jobId, String(event.id));
          droppedAt = null;
          wait = firstMs;
          if (event.event === 'failed' || event.event === 'cancelled' || event.event === 'done' || event.event === 'removed') return event;
        }
        throw Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } });
      } catch (err) {
        if (signal?.aborted || isAbort(err)) throw new LoadAborted();
        const wire = crucibleUnavailableCause(err);
        if (wire === null) throw callRefusalOf(err, this.server);
        const now = Date.now();
        droppedAt ??= now;
        if (now - droppedAt + wait > budgetMs) {
          const reason = `lost the load of ${model} for ${Math.round((now - droppedAt) / 1000)} s: ${wire}`;
          await request.hooks.streamDropped(this.server, reason).catch(() => undefined);
          throw new CrucibleCallError('unreachable', `"${this.server}" stopped answering while loading ${model} (${reason}).`, this.server);
        }
        log.warn(`[crucible] the event stream of load ${jobId} on "${this.server}" dropped (${wire}); following it again after event ${lastEventId}`);
        await sleep(wait, signal);
        wait = Math.min(wait * 2, maxMs);
      }
    }
  }
}

// ── the registry: one session per server from this client ───────────────────

export interface ServerSessionsHost {
  /** A work client bound to the ENGINE behind a registered server (the factory's `clientFor`). */
  client(server: string): Promise<CrucibleClient>;
  /** The in-flight ledger: a session is written down the moment it opens, settled when it closes. */
  ledger: Pick<InFlightLedger, 'record' | 'settle'>;
  timings?: Partial<CardTimings>;
  /** `idle_s` for every session (a keeper shortens it). Default {@link JOB_SESSION_IDLE_S}. */
  idleS?: number;
}

interface Entry {
  readonly card: CardSession;
  holders: number;
  closing: Promise<void> | null;
}

/**
 * EVERY QUEUE SESSION THIS INSTALL HAS OPEN, at most one per server. {@link use} joins the open
 * one, or asks for one when none is open (waiting in the server's line), or waits for one already
 * being asked for: never a second session beside an open one, which the server would queue
 * behind the first (LEDGER #255).
 */
export class ServerSessions {
  private readonly open = new Map<string, Entry>();
  private readonly opening = new Map<string, Promise<Entry>>();
  private readonly idleS: number;
  private readonly timings: CardTimings;

  constructor(private readonly host: ServerSessionsHost) {
    this.idleS = host.idleS ?? JOB_SESSION_IDLE_S;
    this.timings = { loadStreamRetry: { ...LOAD_STREAM_RETRY }, ...host.timings };
  }

  /** The open session on `server`, or null (for the lanes' touch and a keeper). */
  openOn(server: string): CardSession | null {
    const entry = this.open.get(server);
    return entry !== undefined && entry.card.ended === null ? entry.card : null;
  }

  /** Hold the session on `server` for `request.what`: the open one, joined, else a new one once the line lets it open. */
  async use(server: string, request: SessionRequest): Promise<SessionHold> {
    for (;;) {
      const entry = this.open.get(server);
      if (entry !== undefined && entry.closing !== null) {
        // The last holder is closing it: a new session opens only once that one has gone.
        await entry.closing;
        continue;
      }
      if (entry !== undefined && entry.card.ended === null) return this.holdOf(server, entry, request.what);
      if (entry !== undefined) this.open.delete(server);
      const pending = this.opening.get(server);
      if (pending !== undefined) {
        // Someone of ours is already in the line for this server: join theirs. If their wait is
        // abandoned (their Stop), this one asks for its own on the next turn.
        await pending.catch(() => undefined);
        continue;
      }
      const asking = this.ask(server, request);
      this.opening.set(server, asking);
      try {
        return this.holdOf(server, await asking, request.what);
      } finally {
        if (this.opening.get(server) === asking) this.opening.delete(server);
      }
    }
  }

  private holdOf(server: string, entry: Entry, what: string): SessionHold {
    entry.holders += 1;
    let released = false;
    return {
      card: entry.card,
      release: async () => {
        if (released) return;
        released = true;
        entry.holders -= 1;
        if (entry.holders > 0 || this.open.get(server) !== entry) return;
        entry.closing = this.close(server, entry, `${what} is done with it`).finally(() => {
          if (this.open.get(server) === entry) this.open.delete(server);
          entry.closing = null;
        });
        await entry.closing;
      },
    };
  }

  private async ask(server: string, request: SessionRequest): Promise<Entry> {
    const client = await this.host.client(server);
    // Feature detection, never a version compare (MIGRATION.md): a server without queue sessions
    // cannot hold ContentStudio's work at all since 1.0.76 removed leases.
    let sessions: boolean;
    try {
      sessions = await client.has('queue.sessions');
    } catch (err) {
      throw callRefusalOf(err, server);
    }
    if (!sessions) {
      throw new CrucibleCallError(
        'needs_update',
        `"${server}" does not list queue sessions among its features, and ContentStudio runs every local model call ` +
          `inside one (Crucible 1.0.76 or newer). Update Crucible there; nothing was sent.`,
        server,
      );
    }
    log.info(`[crucible] ${request.what}: asking "${server}" for a queue session (act ${request.act}, idle ${this.idleS} s)`);
    let session: CrucibleSession;
    try {
      session = await client.session({
        act: request.act,
        idleS: this.idleS,
        ...(request.maxWaitS === undefined ? {} : { maxWaitS: request.maxWaitS }),
        ...(request.onQueue === undefined ? {} : { onQueue: request.onQueue }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (err) {
      if (request.signal?.aborted || isAbort(err)) throw err;
      throw callRefusalOf(err, server);
    }
    // Written the moment it is open, before the next await (P3): a kill from here on leaves the
    // sweep a session to close. Not one job's row: holders come and go, the session is the server's.
    this.host.ledger.record({ server, kind: 'session', id: session.id, jobType: 'session', model: null, jobId: '' });
    log.info(`[crucible] ${request.what}: queue session ${session.id} is open on "${server}"`);
    const entry: Entry = { card: new CardSession(server, session, this.timings), holders: 0, closing: null };
    this.open.set(server, entry);
    void session.closed.then((end) => {
      this.host.ledger.settle(server, 'session', session.id);
      if (end.reason === 'client') return;
      // The server ended it: said loudly here, and the next item of every holder fails naming it.
      log.error(
        `[crucible] queue session ${session.id} on "${server}" was ended by the server (${end.reason}: ${end.message}); ` +
          `${entry.holders} holder(s) fail on their next call`,
      );
      if (this.open.get(server) === entry) this.open.delete(server);
    });
    return entry;
  }

  private async close(server: string, entry: Entry, why: string): Promise<void> {
    const card = entry.card;
    if (card.ended !== null) return;
    try {
      const end = await card.session.close();
      this.host.ledger.settle(server, 'session', card.id);
      log.info(`[crucible] closed queue session ${card.id} on "${server}" (${why}; ${end.itemsRun ?? 'unstated'} item(s), held ${end.heldS ?? 'unstated'} s)`);
    } catch (err) {
      // The ONE swallow, declared: the work is done and failing it over tidying would report a
      // loss that did not happen. The ledger keeps the row, so the next sweep closes it; the server
      // closes it itself after idle_s.
      log.warn(
        `[crucible] could not close queue session ${card.id} on "${server}" (${err instanceof Error ? err.message : String(err)}); ` +
          `it stays in the in-flight ledger for the next sweep, and the server ends it after ${this.idleS} s idle`,
      );
    }
  }

  /** Quit: close every session this install holds, whoever holds it. Never throws. */
  async closeAll(why: string): Promise<void> {
    const entries = [...this.open.entries()];
    this.open.clear();
    await Promise.all(entries.map(([server, entry]) => entry.closing ?? this.close(server, entry, why)));
  }
}

// ── one job's sessions ──────────────────────────────────────────────────────

/** What a call hands {@link JobSessions.hold}: its residency, and where its session comes from. */
export interface HoldRequest extends ResidencyRequest {
  hooks: ResidencyRequest['hooks'] & Pick<CrucibleStepHooks, 'session'>;
}

/**
 * ONE JOB'S SESSIONS, threaded the way `JobModelLifecycle` always was (model-lifecycle.ts): the
 * server the job runs on (fixed at its first call: work never moves mid-job, #205, Q14), the
 * session it holds there, and the residency calls inside it. Inside a lane job the session is the
 * lane run's (released by the lane when the run ends); a standalone action's is held from its
 * first call to {@link releaseAll}.
 */
export class JobSessions {
  /** The server this job was placed on. */
  server: string | null = null;
  private readonly holds = new Map<string, Promise<SessionHold>>();

  constructor(
    /** What the job is, for every log line: "the metadata job for 3 items", "Soften titles". */
    readonly what: string,
  ) {}

  /** How many servers the job holds a session on. */
  heldCount(): number {
    return this.holds.size;
  }

  /** The job's session on `server`: joined or opened on its first call there. */
  async session(server: string, request: { act: string; signal?: AbortSignal; hooks: Pick<CrucibleStepHooks, 'session'> }): Promise<CardSession> {
    let holding = this.holds.get(server);
    if (holding === undefined) {
      holding = request.hooks.session({ act: request.act, what: this.what, ...(request.signal === undefined ? {} : { signal: request.signal }) });
      this.holds.set(server, holding);
      // A wait that was abandoned (a Stop) holds nothing: the next call asks again.
      holding.catch(() => { if (this.holds.get(server) === holding) this.holds.delete(server); });
    }
    const card = (await holding).card;
    card.assertOpen(this.what);
    return card;
  }

  /** Make `model` resident in the job's session on `server`, and answer the session. */
  async hold(server: string, model: string, request: HoldRequest): Promise<CardSession> {
    if (this.server === null) this.server = server;
    const card = await this.session(server, { act: request.act, ...(request.signal === undefined ? {} : { signal: request.signal }), hooks: request.hooks });
    await card.ensure(model, this.what, request);
    return card;
  }

  /** Let go of every session this job holds, once, at its end. Never throws (it runs in a `finally`). */
  async releaseAll(): Promise<void> {
    const holds = [...this.holds.values()];
    this.holds.clear();
    for (const holding of holds) {
      const hold = await holding.catch(() => null);
      if (hold !== null) await hold.release();
    }
  }
}

/** Run `fn` under `job`, and let go of its sessions on every way out. */
export async function withJobSessions<T>(job: JobSessions, fn: (job: JobSessions) => Promise<T>): Promise<T> {
  try {
    return await fn(job);
  } finally {
    await job.releaseAll();
  }
}
