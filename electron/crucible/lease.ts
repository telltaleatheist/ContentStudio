/**
 * ONE LEASE PER JOB PER LOCAL MODEL (plan 13.3), and the residency that comes
 * before it.
 *
 * Ported from two places, each for its half:
 *  - BookForge's electron/crucible/lease.ts: the numbers (ttl 120 s, a
 *    heartbeat at a third of it, a 10 s clock on each lease call, a 2 s grace
 *    on release), and the release that treats `unknown_lease` as the state it
 *    wanted. (Its give-back of every open lease on quit is P3's held quit sweep
 *    here: lanes.ts aborts the running jobs, whose `finally` releases, and then
 *    sweeps the in-flight ledger.) BookForge hand-rolls the
 *    three routes because its SDK predated them; the vendored 1.0.34 SDK has
 *    `lease`, `heartbeat` and `release`, so they are called through it.
 *  - Briefcase's llm/crucible-chat.service.ts: making a model resident with a
 *    `load-model` job that takes the lease on load, following its event stream
 *    (again after a drop, from the last event seen), chatting under another
 *    client's lease when it already pins OUR model, and handing back a lease a
 *    cancel orphaned.
 *
 * WHAT DIFFERS FROM BOTH, BY THE PLAN: a heartbeat answered `unknown_lease`
 * FAILS THE STAGE LOUDLY (plan 13.3: "the run is unprotected"). BookForge
 * re-leases and Briefcase re-takes on the next call; here the hold is marked
 * lost with the server's words, and the job's next call on that model, and the
 * job's end, throw `lease_lost` naming it. A run that carried on unleased would
 * look exactly like one that was protected until the model vanished under it.
 *
 * THE JOB IS EXPLICIT, NOT AMBIENT. Briefcase keeps its run in an
 * AsyncLocalStorage; ContentStudio's job spans many lane steps (each model call
 * is its own `queueAITask`) and ends in the generator's `finally`, outside any
 * step, so a {@link JobLeases} is threaded the way `JobModelLifecycle` always
 * was, and model-lifecycle.ts is now a thin face over one. What IS per step is
 * the ledger (P3): each hold keeps the hooks of the step that took it, and
 * settles its rows through them.
 *
 * NOTHING HERE UNLOADS A MODEL. Leases are released; the server settles the
 * card (Owen's Crucible ruling: a model nothing holds is unloaded). "Unload
 * nothing you did not load" is kept by never unloading at all, except the one
 * case Briefcase found: a load WE started, finished as the user cancelled,
 * with no lease to hand back (none is taken here without one, so it does not
 * arise).
 */
import * as log from 'electron-log';
import {
  CrucibleBusy,
  CrucibleCardHeld,
  CrucibleLeased,
  CrucibleProtocolError,
  CrucibleRefused,
  CrucibleServerError,
  type CrucibleClient,
  type JobEvent,
  type ModelInfo,
} from '@crucible/client';
import { CrucibleCallError } from './errors';
import type { CrucibleStepHooks } from './lanes';
import { crucibleUnavailableCause } from './transport-failure';
import { stated } from './unstated';

/** How long the server keeps believing in this app without hearing from it. Liveness, not duration (BookForge). */
export const CRUCIBLE_LEASE_TTL_SECONDS = 120;
/** A third of the ttl: two consecutive lost beats are survivable (BookForge `crucibleHeartbeatIntervalMs`). */
export const CRUCIBLE_HEARTBEAT_MS = 40_000;
/** One lease call may take this long before it is a failure (BookForge bug hunt C7). */
export const CRUCIBLE_LEASE_REQUEST_TIMEOUT_MS = 10_000;
/** How long a release waits for an in-flight heartbeat before giving the card back (BookForge). */
export const CRUCIBLE_LEASE_RELEASE_GRACE_MS = 2_000;
/** Re-following a load's dropped event stream: first wait, cap, and budget from the drop (BookForge stream-reconnect). */
export const LOAD_STREAM_RETRY: Readonly<{ firstMs: number; maxMs: number; budgetMs: number }> = {
  firstMs: 5_000,
  maxMs: 30_000,
  budgetMs: 5 * 60_000,
};

/** The refusal codes that mean "the card is briefly someone else's", never "no" (Briefcase BUSY_REFUSAL_CODES). */
export const BUSY_REFUSAL_CODES: ReadonlySet<string> = new Set(['server_busy', 'leased', 'engine_in_use']);

/** The holder's sentence for a busy refusal, or null when it is not one. */
export function busyLineOfRefusal(err: unknown): string | null {
  if (err instanceof CrucibleBusy) return err.busyLine;
  if (err instanceof CrucibleLeased) return err.leasedLine;
  if (err instanceof CrucibleCardHeld) return `held by ${stated(err.who)}: ${err.fact}`;
  if (err instanceof CrucibleRefused && BUSY_REFUSAL_CODES.has(err.code)) return err.serverMessage;
  return null;
}

/**
 * One SDK failure as the door's named refusal. Anything already named passes
 * through; a cancel is the caller's to name (the transport maps it).
 */
export function callRefusalOf(err: unknown, server: string): unknown {
  if (err instanceof CrucibleCallError) return err;
  const line = busyLineOfRefusal(err);
  if (line !== null) {
    const status = err instanceof CrucibleRefused ? err.status : null;
    const code = err instanceof CrucibleRefused ? err.code : null;
    // The SDK's own refusal rides as `cause`: P3's lanes park the job on it by type.
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

function isUnknownLease(err: unknown): boolean {
  return err instanceof CrucibleRefused && (err.code === 'unknown_lease' || err.status === 404);
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

/** The seams, so a keeper drives every branch against the fake with short clocks. */
export interface LeaseHost {
  /** A client bound to the ENGINE behind a registered server (the factory's `clientFor`). */
  client(server: string, options?: { timeoutMs?: number }): Promise<CrucibleClient>;
}

export interface LeaseTimings {
  heartbeatMs: number;
  requestTimeoutMs: number;
  releaseGraceMs: number;
  loadStreamRetry: { firstMs: number; maxMs: number; budgetMs: number };
}

const DEFAULT_TIMINGS: LeaseTimings = {
  heartbeatMs: CRUCIBLE_HEARTBEAT_MS,
  requestTimeoutMs: CRUCIBLE_LEASE_REQUEST_TIMEOUT_MS,
  releaseGraceMs: CRUCIBLE_LEASE_RELEASE_GRACE_MS,
  loadStreamRetry: { ...LOAD_STREAM_RETRY },
};

/** One model held on one server for a job. */
interface Hold {
  server: string;
  model: string;
  act: string;
  /** Null: the model is pinned by another client's lease on the same model, and we chat under it (declared). */
  leaseId: string | null;
  /** What `/v1/models` said the model is served at when it was taken. */
  maxModelLen: number | null;
  /** The context this job asked the load for, when this job loaded it. */
  loadedAt: number | null;
  /** Why the lease was lost (the server's words), or null while it holds. */
  lost: string | null;
  beat: NodeJS.Timeout | null;
  beating: Promise<void> | null;
  stopped: boolean;
  /**
   * The ledger hooks of the step that took the lease (P3). Kept with the hold because the
   * release usually happens outside any step (the job's `finally`), and the ledger row the
   * take wrote must be settled by the same ledger.
   */
  ledger: Pick<CrucibleStepHooks, 'settled'>;
}

export interface HoldRequest {
  /** The act the lease is taken for: the act of the call that opened it (BookForge's row-lease rule). */
  act: string;
  /**
   * The step's lane hooks (P3, docs/crucible/P3.md): a load job and a lease are written to the
   * in-flight ledger the moment the server admits them, before the next await; each SSE event
   * of a load moves the ledger's cursor and beats the stall clock; a load stream that cannot be
   * followed any more sweeps its server.
   */
  hooks: Pick<CrucibleStepHooks, 'submitted' | 'leased' | 'settled' | 'streamed' | 'streamDropped'>;
  /** Tokens the calling request needs (prompt + output budget), or null when it cannot be stated. */
  need: number | null;
  /** The context to load at, when this job loads the model (today's num_ctx, LEDGER #111). */
  loadContext?: number;
  signal?: AbortSignal;
}

/**
 * ONE JOB'S LEASES: at most one model per server (Crucible allows one lease per
 * client per server, and a lease pins the card to one model), taken on the
 * first call that needs it and released once, when the job ends.
 */
export class JobLeases {
  private readonly holds = new Map<string, Hold>();
  private lock: Promise<unknown> = Promise.resolve();
  /** The server this job was placed on. Fixed at its first call: work never moves mid-job (#205, Q14). */
  server: string | null = null;
  private readonly timings: LeaseTimings;

  constructor(
    private readonly host: LeaseHost,
    /** What the job is, for every log line: "the metadata job for 3 items", "Soften titles". */
    readonly what: string,
    timings: Partial<LeaseTimings> = {},
  ) {
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
  }

  heldCount(): number {
    return [...this.holds.values()].filter((h) => !h.stopped).length;
  }

  /** What the job holds, for a log line or a keeper. */
  held(): Array<{ server: string; model: string; leaseId: string | null; lost: string | null }> {
    return [...this.holds.values()].map(({ server, model, leaseId, lost }) => ({ server, model, leaseId, lost }));
  }

  /** The loaded-context facts for the model this job holds on `server`. */
  contextFacts(server: string, model: string): { maxModelLen: number | null; loadedAt: number | null } {
    const hold = this.holds.get(server);
    if (hold === undefined || hold.model !== model) return { maxModelLen: null, loadedAt: null };
    return { maxModelLen: hold.maxModelLen, loadedAt: hold.loadedAt };
  }

  /** Throw `lease_lost` when the job's lease on this model was lost. The stage fails loudly (plan 13.3). */
  assertHeld(server: string, model: string): void {
    const hold = this.holds.get(server);
    if (hold !== undefined && hold.model === model && hold.lost !== null) {
      throw new CrucibleCallError(
        'lease_lost',
        `${this.what} lost its lease on ${model} on "${server}" mid-job (${hold.lost}), so the model could be ` +
          `taken off the card under it. The stage stops here rather than carry on unprotected.`,
        server,
      );
    }
  }

  /**
   * The server said the model is not resident (someone else's load evicted it):
   * the hold is forgotten, so the next `hold` makes it resident again. The one
   * re-ensure plan 16 P2 names.
   */
  forget(server: string, model: string): void {
    const hold = this.holds.get(server);
    if (hold === undefined || hold.model !== model) return;
    this.stopBeat(hold);
    this.holds.delete(server);
  }

  /** Make `model` resident on `server` and lease it for this job, unless it already is. */
  async hold(server: string, model: string, request: HoldRequest): Promise<void> {
    const run = this.lock.then(() => this.holdUnlocked(server, model, request));
    this.lock = run.catch(() => undefined);
    await run;
  }

  private async holdUnlocked(server: string, model: string, request: HoldRequest): Promise<void> {
    if (this.server === null) this.server = server;
    const existing = this.holds.get(server);
    if (existing !== undefined && existing.model === model) {
      this.assertHeld(server, model);
      const window = existing.maxModelLen ?? existing.loadedAt;
      const grows = request.need !== null && window !== null && request.need > window
        && request.loadContext !== undefined && request.loadContext > window;
      if (!grows) return;
      // GROWTH IS LEGITIMATE, SHRINKAGE NEVER IS (LEDGER #111): a later call that
      // does not fit the window this job loaded reloads the model at its own
      // context. Our own lease is handed back first; the reload takes a new one.
      log.info(
        `[crucible] ${this.what}: ${model} on "${server}" is served at ${window} tokens and a call needs ` +
          `${request.need}; reloading it at ${request.loadContext}`,
      );
      await this.releaseHold(existing);
    } else if (existing !== undefined) {
      // A lease pins the card to one model: the job's previous model goes first.
      await this.releaseHold(existing);
    }
    const hold = await this.acquire(server, model, request);
    this.holds.set(server, hold);
    if (hold.leaseId !== null) this.startHeartbeat(hold);
  }

  private async acquire(server: string, model: string, request: HoldRequest): Promise<Hold> {
    const client = await this.host.client(server);
    let rows: ModelInfo[];
    try {
      rows = await client.models();
    } catch (err) {
      throw callRefusalOf(err, server);
    }
    const row = rows.find((m) => m.id === model);
    const hold = (fields: Partial<Hold>): Hold => ({
      server, model, act: request.act, leaseId: null, maxModelLen: null, loadedAt: null, lost: null,
      beat: null, beating: null, stopped: false, ledger: request.hooks, ...fields,
    });
    if (row === undefined) {
      const known = rows.filter((m) => m.modalities.includes('text')).map((m) => m.id);
      throw new CrucibleCallError(
        'unknown_model',
        `"${server}" has no model "${model}" (it offers: ${known.join(', ') || 'none'}). The routing names it; ` +
          `pick a model this server offers in the routing dialog. Nothing was substituted.`,
        server,
      );
    }
    const window = row.maxModelLen;
    if (row.resident) {
      const tooSmall = request.need !== null && window !== null && request.need > window
        && request.loadContext !== undefined && request.loadContext > window;
      if (!tooSmall) {
        try {
          const lease = await client.lease(model, { act: request.act, ttlSeconds: CRUCIBLE_LEASE_TTL_SECONDS });
          // Recorded before the next await (P3): a kill from here on leaves a row the sweep reads.
          request.hooks.leased({ server, id: lease.leaseId, model });
          log.info(`[crucible] ${this.what}: leased resident ${model} on "${server}" for ${request.act} (${lease.leaseId})`);
          return hold({ leaseId: lease.leaseId, maxModelLen: window });
        } catch (err) {
          // Another client already holds a lease on the card, and the card holds
          // OUR model: it is pinned where we need it. Declared, then chatted under
          // (Briefcase's rule); our own lease is not taken.
          if (err instanceof CrucibleLeased) {
            log.warn(
              `[crucible] ${this.what}: ${model} on "${server}" is resident and leased by ${stated(err.holder)} ` +
                `(${err.leasedLine}); running under their lease without one of our own`,
            );
            return hold({ maxModelLen: window });
          }
          // It left the card between the read and the lease: load it.
          if (!(err instanceof CrucibleRefused && err.code === 'not_resident')) throw callRefusalOf(err, server);
        }
      } else {
        log.info(
          `[crucible] ${this.what}: ${model} is resident on "${server}" at ${window} tokens and this job needs ` +
            `${request.need}; reloading it at ${request.loadContext}`,
        );
      }
    } else {
      // Refused here only on what the server STATED (false). Unstated (null,
      // 1.0.25+) goes to the load, and the server's own refusal names the cause.
      if (row.backendSupported === false) {
        throw new CrucibleCallError(
          'unsupported_model',
          `"${server}" cannot run ${model}${row.reason ? ` (${row.reason})` : ''}. Pick a model this server offers.`,
          server,
        );
      }
      if (row.installed === false) {
        throw new CrucibleCallError(
          'model_not_installed',
          `${model} is not downloaded on "${server}"${row.reason ? ` (${row.reason})` : ''}. Pull it on that ` +
            `server's catalog first; nothing was substituted.`,
          server,
        );
      }
    }
    return this.load(client, server, model, request, hold);
  }

  private async load(
    client: CrucibleClient,
    server: string,
    model: string,
    request: HoldRequest,
    hold: (fields: Partial<Hold>) => Hold,
  ): Promise<Hold> {
    let jobId: string;
    try {
      jobId = await client.loadModel(model, {
        lease: { act: request.act, ttlSeconds: CRUCIBLE_LEASE_TTL_SECONDS },
        ...(request.loadContext === undefined ? {} : { context: request.loadContext }),
      });
    } catch (err) {
      throw callRefusalOf(err, server);
    }
    // Recorded before the next await (P3): a kill mid-load leaves the sweep a job to cancel.
    request.hooks.submitted({ server, id: jobId, jobType: 'load-model', model });
    log.info(
      `[crucible] ${this.what}: loading ${model} on "${server}"` +
        `${request.loadContext === undefined ? ' at its manifest context' : ` at ${request.loadContext} tokens`} (job ${jobId})`,
    );
    const onAbort = (): void => {
      void client.cancel(jobId).catch(() => undefined);
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    let terminal: JobEvent;
    try {
      terminal = await this.followLoad(client, server, model, jobId, request);
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
    }
    request.hooks.settled(server, 'job', jobId);
    if (terminal.event === 'failed') {
      const error = (terminal.data as { error?: { code?: string; message?: string } }).error;
      throw new CrucibleCallError(
        'load_failed',
        `loading ${model} on "${server}" failed (${error?.code ?? 'no code'}): ${error?.message ?? 'no message'}`,
        server,
        null,
        error?.code ?? null,
      );
    }
    const status = await client.job(jobId);
    if (status.leaseId !== null) request.hooks.leased({ server, id: status.leaseId, model });
    if (terminal.event === 'cancelled' || request.signal?.aborted) {
      // A cancel that lands as the load finishes must still give back the lease
      // the load took: it is in no hold yet, so nothing else would (Briefcase).
      if (status.leaseId !== null) {
        const released = await client.release(status.leaseId).then(() => true, (err) => isUnknownLease(err));
        if (released) request.hooks.settled(server, 'lease', status.leaseId);
      }
      throw new LoadAborted();
    }
    if (status.leaseId === null) {
      throw new CrucibleCallError(
        'protocol_error',
        `"${server}" loaded ${model} without the lease the load asked for, so nothing protects it for this job. ` +
          `Nothing was sent on it.`,
        server,
      );
    }
    const after = (await client.models()).find((m) => m.id === model);
    return hold({ leaseId: status.leaseId, maxModelLen: after?.maxModelLen ?? null, loadedAt: request.loadContext ?? null });
  }

  /**
   * A load job's events to its terminal one. A stream that drops for weather
   * is opened again after the last event seen (Briefcase `followLoad`, itself
   * BookForge's stream-reconnect); lost past the budget, the load is cancelled
   * best-effort and the call is `unreachable`.
   */
  private async followLoad(client: CrucibleClient, server: string, model: string, jobId: string, request: HoldRequest): Promise<JobEvent> {
    const signal = request.signal;
    const { firstMs, maxMs, budgetMs } = this.timings.loadStreamRetry;
    let lastEventId = 0;
    let droppedAt: number | null = null;
    let wait = firstMs;
    for (;;) {
      try {
        for await (const event of client.events(jobId, lastEventId > 0 ? { lastEventId } : {})) {
          lastEventId = event.id;
          // The ledger's reconnect cursor, and the stall clock's beat (P3).
          request.hooks.streamed(server, jobId, String(event.id));
          droppedAt = null;
          wait = firstMs;
          if (event.event === 'failed' || event.event === 'cancelled' || event.event === 'done') return event;
        }
        throw Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } });
      } catch (err) {
        if (signal?.aborted || isAbort(err)) throw new LoadAborted();
        const wire = crucibleUnavailableCause(err);
        if (wire === null) throw callRefusalOf(err, server);
        const now = Date.now();
        droppedAt ??= now;
        if (now - droppedAt + wait > budgetMs) {
          const reason = `lost the load of ${model} for ${Math.round((now - droppedAt) / 1000)} s: ${wire}`;
          // The ladder ran out: give that server's holds back (P3's dropped-stream sweep), then fail.
          await request.hooks.streamDropped(server, reason).catch(() => undefined);
          throw new CrucibleCallError('unreachable', `"${server}" stopped answering while loading ${model} (${reason}).`, server);
        }
        log.warn(`[crucible] the event stream of load ${jobId} on "${server}" dropped (${wire}); following it again after event ${lastEventId}`);
        await sleep(wait, signal);
        wait = Math.min(wait * 2, maxMs);
      }
    }
  }

  /**
   * Renew the lease every heartbeat. A beat that fails for weather is a blip
   * (the ttl is three beats long). `unknown_lease` is the server saying it is
   * gone: the hold is marked lost, loudly, and the job's next call on it throws.
   */
  private startHeartbeat(hold: Hold): void {
    const schedule = (): void => {
      if (hold.stopped) return;
      hold.beat = setTimeout(tick, this.timings.heartbeatMs);
      hold.beat.unref?.();
    };
    const tick = (): void => {
      if (hold.stopped || hold.leaseId === null) return;
      hold.beating = (async () => {
        try {
          const client = await this.host.client(hold.server, { timeoutMs: this.timings.requestTimeoutMs });
          await client.heartbeat(hold.leaseId!);
        } catch (err) {
          if (hold.stopped) return;
          if (isUnknownLease(err)) {
            hold.lost = err instanceof CrucibleRefused ? `${err.code}: ${err.serverMessage}` : String(err);
            // The server holds nothing for us any more: nothing left for a sweep to release.
            hold.ledger.settled(hold.server, 'lease', hold.leaseId!);
            log.error(
              `[crucible] ${this.what}: the lease on ${hold.model} on "${hold.server}" is GONE (${hold.lost}); ` +
                `this job's next call on it fails rather than run unprotected`,
            );
            return;
          }
          log.warn(
            `[crucible] ${this.what}: the lease heartbeat for ${hold.model} on "${hold.server}" failed ` +
              `(${err instanceof Error ? err.message : String(err)}); the next beat goes out in ${this.timings.heartbeatMs} ms`,
          );
        } finally {
          hold.beating = null;
        }
        if (hold.lost === null) schedule();
      })();
    };
    schedule();
  }

  private stopBeat(hold: Hold): void {
    hold.stopped = true;
    if (hold.beat !== null) clearTimeout(hold.beat);
    hold.beat = null;
  }

  private async releaseHold(hold: Hold): Promise<void> {
    this.stopBeat(hold);
    this.holds.delete(hold.server);
    if (hold.leaseId === null) return;
    // Wait a moment for an in-flight beat, never for ever: release is on the quit path (BookForge C7).
    await Promise.race([
      hold.beating ?? Promise.resolve(),
      new Promise<void>((resolve) => {
        const grace = setTimeout(resolve, this.timings.releaseGraceMs);
        grace.unref?.();
      }),
    ]);
    try {
      const client = await this.host.client(hold.server, { timeoutMs: this.timings.requestTimeoutMs });
      await client.release(hold.leaseId);
      hold.ledger.settled(hold.server, 'lease', hold.leaseId);
      log.info(`[crucible] ${this.what}: released ${hold.model} on "${hold.server}" (${hold.leaseId})`);
    } catch (err) {
      // Already gone is the state a release wanted: nothing is held, so the row is settled.
      if (isUnknownLease(err)) {
        hold.ledger.settled(hold.server, 'lease', hold.leaseId);
        return;
      }
      // The ONE swallow (BookForge's): the work is done, the lease expires in at
      // most its ttl on its own, and failing a finished job over tidying would
      // report a loss that did not happen.
      log.warn(
        `[crucible] ${this.what}: the lease on ${hold.model} on "${hold.server}" could not be released ` +
          `(it expires within ${CRUCIBLE_LEASE_TTL_SECONDS} s): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Release every lease this job holds, once, at the end of the job. NEVER
   * THROWS: it runs in the job's `finally`, where a throw would replace the
   * job's own failure with a tidying one. A lease that was LOST is returned, so
   * the caller that finished its work can still refuse to call the run
   * protected ({@link withJobLeases} does).
   */
  async releaseAll(): Promise<string[]> {
    await this.lock.catch(() => undefined);
    const holds = [...this.holds.values()];
    const lost = holds
      .filter((h) => h.lost !== null)
      .map((h) => `${h.model} on "${h.server}" (${h.lost})`);
    for (const hold of holds) await this.releaseHold(hold);
    return lost;
  }
}

/**
 * Run `fn` under `job`, release every lease on every way out, and fail loudly
 * when a lease was lost while `fn` ran even though `fn` itself finished (plan
 * 13.3). The one place a finished job's lost lease becomes an error.
 */
export async function withJobLeases<T>(job: JobLeases, fn: (job: JobLeases) => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await fn(job);
  } catch (err) {
    await job.releaseAll();
    throw err;
  }
  const lost = await job.releaseAll();
  if (lost.length > 0) {
    throw new CrucibleCallError(
      'lease_lost',
      `${job.what} lost its lease on ${lost.join(', ')} before it finished; the run was not protected throughout.`,
      job.server,
    );
  }
  return result;
}
