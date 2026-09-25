/**
 * THE LANES: one GPU lane per Crucible server, and the queue's admission,
 * parking, stall clock and in-flight bookkeeping over them.
 *
 * Plan section 13, cut to LEDGER #205. What replaced what:
 *
 *   before (queue-manager.service.ts)        now
 *   ─────────────────────────────────────    ──────────────────────────────────────────────
 *   one global 1-slot AI pool for EVERY      one GPU lane per registered server (BookForge's
 *   model call, cloud included               SERVER_GPU_SLOTS = 1); cloud (`claude:`,
 *                                            `anthropic/…`) and `claude -p` take NO lane and
 *                                            run while a GPU lane is busy (plan section 13.1)
 *   one global AI generation queue            one running job PER SERVER: the Mac and the PC
 *   (ipc-handlers.ts), one job at a time      run a job each in parallel (P3b, folded in)
 *   a 30-minute wall-clock watchdog and a    a 10-minute STALL clock per job (stream-stall.ts):
 *   4-hour chapter cap                       silence ends a run, work does not
 *   a busy answer failed the job              it PARKS (parking.ts), and starts again by itself
 *                                            when the preflight says the holder has gone
 *
 * TWO LEVELS ON A LANE, because two kinds of work share a server:
 *
 *   the JOB     a queue job admitted to the server (`runJob`). One at a time, so
 *               two of our jobs never fight over one card, and the fast pin's job
 *               on the PC runs beside the Mac's.
 *   the SLOT    one GPU model call at a time (`aiCall`), taken by the admitted
 *               job's local calls AND by standalone calls (the editor's story
 *               title, the reports page's "more titles"), which interleave with a
 *               running job call by call exactly as they did with the old pool.
 *               The chapter stage holds it for its whole run, as it held the pool.
 *
 * WHERE A JOB GOES is venue-decision.ts's rule: the fast pin's server or the
 * selected one, never another (LEDGER #205). WHAT A BUSY ANSWER DOES is
 * parking.ts's. The preflight (`activity()` every 15 s per running server) is
 * display and preflight, NEVER permission: a job is always submitted, and the
 * door's 409 is what parks it. The preflight only says when a PARKED job may be
 * tried again.
 *
 * TRANSPORT'S SEAM. This layer does not talk to a model. transport.ts (P2's
 * chat/decide/withJobLease) runs inside `aiCall` and reaches this layer through
 * {@link crucibleStepHooks}: the server the step must run on, the job's abort
 * signal, the ledger writes it must make right after a submit or a lease, the
 * stall clock's beat, and the dropped-stream sweep. Its refusals come up as the
 * SDK's own types (CrucibleBusy, CrucibleLeased, CrucibleRefused), unwrapped,
 * and `aiCall` reads them (docs/crucible/P3.md, "what transport.ts must call").
 *
 * THE STARTUP SWEEP GATES GPU ADMISSION. `setAdmissionGate` takes the startup
 * sweep's promise (main.ts); no job is admitted and no standalone GPU call
 * takes a slot until it settles (plan section 13.4). Cloud calls never wait
 * for it: they hold nothing on a card.
 */
import { AsyncLocalStorage } from 'async_hooks';
import type { Activity, AcceleratorState, CrucibleClient } from '@crucible/client';
import * as log from 'electron-log';
import { CrucibleRoutingError } from './errors';
import type { InFlightKind, InFlightLedger } from './in-flight-ledger';
import { JOB_SWEEP_DEADLINE_MS, QUIT_SWEEP_DEADLINE_MS, QUIT_UNWIND_MS, sweepCrucibleInFlight, type SweepReport } from './in-flight-sweep';
import { needsAcceleratorRead, observe, parkFor, parkRefusalOf, type ParkRecord, type PreflightRead } from './parking';
import { busyLineOf } from './probe';
import { CRUCIBLE_STALL_MS, JobStallClock } from './stream-stall';
import { decideVenue, intendedServer, type VenueHost } from './venue-decision';
import type { CrucibleLanesView, LaneChip, ParkedJobResult, QueuePlan, QueuePlanCandidate, ResumeStage, RoutingView, ServerReach } from './wire';

/** How often each running server's activity is read (plan section 13.2). */
export const PREFLIGHT_EVERY_MS = 15_000;
/** The preflight read's own clock: a sleeping server must not stall the loop. */
export const PREFLIGHT_TIMEOUT_MS = 3_000;
/** A lane reserved by `plan()` for a job the renderer has not started yet is freed after this. */
export const RESERVATION_MS = 30_000;

// ── the call's route ────────────────────────────────────────────────────────

/**
 * Which kind of call this is, from the model id the routing table resolved.
 * `gpu` takes the server's slot; `cloud` takes nothing (plan section 13.1).
 */
export type AiCallRoute = { lane: 'gpu'; model: string } | { lane: 'cloud'; model: string };

/** A local model call (a bare Ollama/Crucible model id, as the field units carry it). */
export function gpuCall(model: string): AiCallRoute {
  return { lane: 'gpu', model };
}

/**
 * The route of a provider-prefixed id, as ai-manager's makeRequest and the
 * routing table spell them. An id with no known prefix is refused by name, not
 * guessed onto a lane (Law 1).
 */
export function routeOfModelId(model: string): AiCallRoute {
  if (model.startsWith('claude-cli:') || model.startsWith('claude:') || model.startsWith('openai:') || model.startsWith('anthropic/')) {
    return { lane: 'cloud', model };
  }
  if (model.startsWith('ollama:')) return { lane: 'gpu', model };
  throw new Error(`"${model}" names no provider this app routes (claude-cli:, claude:, anthropic/, ollama:), so it has no lane.`);
}

// ── transport's seam ────────────────────────────────────────────────────────

/**
 * What a step running inside `aiCall` may ask of this layer. transport.ts
 * reads it with {@link crucibleStepHooks}; see docs/crucible/P3.md.
 */
export interface CrucibleStepHooks {
  /** `gpu`: the step runs on `server`. `cloud`: no lane; transport picks the key-holding server (plan section 0 #20). */
  readonly lane: 'gpu' | 'cloud';
  /** The server a GPU step must run on (the job's venue, or the selected server for a standalone call); null for cloud. */
  readonly server: string | null;
  /** The ContentStudio job id, or '' for a standalone call. */
  readonly jobId: string;
  /** Aborted by Stop, a park, a stall or quit. Hand it to every fetch. */
  readonly signal: AbortSignal | null;
  /** Call SYNCHRONOUSLY right after `submit()` returned an id, before the next await. */
  submitted(row: { server: string; id: string; jobType: string; model: string | null }): void;
  /** Call SYNCHRONOUSLY right after `lease()` answered (or a load's `done` carried a lease id). */
  leased(row: { server: string; id: string; model: string }): void;
  /** Call when a job settled or a lease was released: the row leaves the ledger. */
  settled(server: string, kind: InFlightKind, id: string): void;
  /** Call per SSE event acted on: the ledger's reconnect cursor, and the stall clock's beat. */
  streamed(server: string, id: string, lastEventId: string): void;
  /** A sign of life with no event id: a completed chat, a decide answer. */
  beat(): void;
  /** A stream to `server` dropped and its reconnect ladder ran out: give that server's holds back. */
  streamDropped(server: string, reason: string): Promise<SweepReport>;
}

const stepStore = new AsyncLocalStorage<CrucibleStepHooks>();

/**
 * The hooks for the step running now. Throws by name outside `aiCall`: a GPU
 * step that did not come through a lane would be work nobody admitted.
 */
export function crucibleStepHooks(): CrucibleStepHooks {
  const hooks = stepStore.getStore();
  if (hooks === undefined) {
    throw new Error('A Crucible step ran outside queueAITask: nothing admitted it to a lane, so nothing would record or give back what it holds.');
  }
  return hooks;
}

// ── a running job ───────────────────────────────────────────────────────────

/** One admitted queue job, as the pipeline sees it (ipc-handlers.ts). */
export interface LaneRun {
  readonly jobId: string;
  readonly server: string;
  readonly fast: boolean;
  /** Where the job is, for `resumeFrom` when it parks. */
  stage: ResumeStage;
  /** Aborted by Stop, a park, a stall or quit. The pipeline hands it to the generator. */
  readonly controller: AbortController;
  /** A sign of life: the pipeline's own progress lines count, as SSE events and completed calls do. */
  beat(): void;
}

interface RunState extends LaneRun {
  clock: JobStallClock;
  park: ParkRecord | null;
  stalled: string | null;
  done: Promise<void>;
}

const runStore = new AsyncLocalStorage<RunState>();

/** Mark the stage the current job is in (the generator calls this; outside a job it does nothing). */
export function setJobStage(stage: ResumeStage): void {
  const run = runStore.getStore();
  if (run !== undefined) run.stage = stage;
}

/** A sign of life for the current job (a progress line); outside a job it does nothing. */
export function beatJob(): void {
  runStore.getStore()?.beat();
}

/** How `runJob` ended. */
export type RunJobOutcome<T> =
  | { kind: 'done'; server: string; value: T }
  | { kind: 'parked'; result: ParkedJobResult };

/** A job that failed on a misconfiguration the venue rule found (a bad token): fails, never waits. */
export class CrucibleVenueRefused extends Error {
  readonly code = 'venue_refused';
  constructor(readonly server: string, message: string) {
    super(message);
    this.name = 'CrucibleVenueRefused';
  }
}

/** A job the stall clock ended. Its message is the sentence the row shows. */
export class CrucibleJobStalled extends Error {
  readonly code = 'crucible_went_quiet';
  constructor(readonly jobId: string, message: string) {
    super(message);
    this.name = 'CrucibleJobStalled';
  }
}

// ── the lanes ───────────────────────────────────────────────────────────────

/** A FIFO mutex: one GPU model call at a time on one server. */
class Slot {
  private tail: Promise<void> = Promise.resolve();
  busy = 0;

  async run<T>(work: () => Promise<T>): Promise<T> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    this.busy += 1;
    try {
      await before;
      return await work();
    } finally {
      this.busy -= 1;
      release();
    }
  }
}

interface Lane {
  readonly server: string;
  /** The admitted job, or a reservation `plan()` made for one the renderer is about to start. */
  holder: { jobId: string; reserved: boolean; at: number } | null;
  /** Jobs waiting for `holder` to leave (an "Analyze" press on a busy lane, a CLI's job). */
  waiters: Array<{ jobId: string; admit: () => void }>;
  readonly slot: Slot;
  read: PreflightRead | null;
  chip: { state: LaneChip['state']; resident: string | null; busyLine: string | null; unreadReason: string | null };
}

export interface LanesDeps {
  /** The registry and the choice (servers.ts). */
  servers: {
    names(): string[];
    routingView(): RoutingView;
    selected(): string;
    fastServer(): string;
    onChange(listener: (change: { server: string | null }) => void): () => void;
  };
  /** A client on the engine behind a registered server. */
  clientFor(server: string, options?: { timeoutMs?: number }): Promise<CrucibleClient>;
  /** The probe's answer, at most 15 s old (probe.ts `reach`). */
  reach(server: string): Promise<{ reach: ServerReach; message: string | null }>;
  ledger: InFlightLedger;
  /** Pushes the lanes strip to the renderer. */
  push?(view: CrucibleLanesView): void;
  now?(): number;
  stallMs?: number;
  preflightEveryMs?: number;
}

export class CrucibleLanes {
  private readonly lanes = new Map<string, Lane>();
  private readonly runs = new Map<string, RunState>();
  private readonly parks = new Map<string, ParkRecord>();
  /** Parks the preflight has cleared: `plan()` starts them. */
  private readonly cleared = new Set<string>();
  /** Each job's give-back in progress, so they run one after another (sweepJob). */
  private readonly jobSweeps = new Map<string, Promise<void>>();
  private gate: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private reading = false;
  private quitting = false;
  private offRegistry: (() => void) | null = null;
  private readonly now: () => number;
  readonly stallMs: number;
  readonly preflightEveryMs: number;

  constructor(private readonly deps: LanesDeps) {
    this.now = deps.now ?? Date.now;
    this.stallMs = deps.stallMs ?? CRUCIBLE_STALL_MS;
    this.preflightEveryMs = deps.preflightEveryMs ?? PREFLIGHT_EVERY_MS;
  }

  // ── the gate ─────────────────────────────────────────────────────────────

  /** GPU admission waits for this (the startup sweep). Cloud calls never do. */
  setAdmissionGate(gate: Promise<unknown>): void {
    this.gate = gate.catch(() => undefined);
  }

  // ── the preflight ────────────────────────────────────────────────────────

  /** Begin the 15 s preflight. Its timer is unref'd, so it never holds the app open. */
  start(): void {
    if (this.timer !== null) return;
    this.offRegistry = this.deps.servers.onChange(() => this.publish());
    const tick = (): void => { void this.readAll(); };
    this.timer = setInterval(tick, this.preflightEveryMs);
    this.timer.unref?.();
    tick();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.offRegistry?.();
    this.offRegistry = null;
  }

  /** One preflight pass over every running (not paused) server. Exposed for keepers and a Re-check. */
  async readAll(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const routing = this.deps.servers.routingView();
      await Promise.all(routing.servers.filter((row) => !row.paused).map((row) => this.readOne(row.name)));
    } finally {
      this.reading = false;
      this.publish();
    }
  }

  private async readOne(server: string): Promise<void> {
    const lane = this.lane(server);
    let activity: Activity;
    let accelerator: AcceleratorState | null = null;
    const at = this.now();
    try {
      const client = await this.deps.clientFor(server, { timeoutMs: PREFLIGHT_TIMEOUT_MS });
      activity = await client.activity();
      // The accelerator read costs an nvidia-smi on the server: only while a job waits on the card's memory.
      if ([...this.parks.values()].some((park) => park.server === server && needsAcceleratorRead(park))) {
        accelerator = await client.accelerator();
      }
    } catch (err) {
      lane.chip = { ...lane.chip, state: 'unreachable', unreadReason: err instanceof Error ? err.message : String(err) };
      return;
    }
    const read: PreflightRead = {
      at,
      acceptsWork: activity.slots.accelerated.acceptsWork ?? null,
      leaseId: activity.lease?.leaseId ?? null,
      accelerator: accelerator === null ? null : {
        freeBytes: accelerator.freeBytes,
        unattributedBytes: accelerator.unattributedBytes,
        pids: accelerator.holders === null ? null : accelerator.holders.map((holder) => holder.pid),
      },
    };
    lane.read = read;
    const ours = this.deps.ledger.idsOn(server);
    const leaseOurs = activity.lease !== null && ours.has(activity.lease.leaseId);
    const busyLine = busyLineOf(activity)
      ?? (activity.lease !== null && !leaseOurs ? `leased: ${activity.lease.client ?? 'another app'}, ${activity.lease.act ?? 'a run'}` : null);
    lane.chip = {
      // `running` is the lane's own fact (view() reads the holder); this is the card's.
      state: busyLine !== null ? 'busy' : 'idle',
      resident: activity.resident?.id ?? null,
      busyLine,
      unreadReason: null,
    };
    for (const park of this.parks.values()) {
      if (park.server !== server || this.cleared.has(park.jobId)) continue;
      if (observe(park, read)) {
        this.cleared.add(park.jobId);
        log.info(`[crucible] ${park.jobId} may start again on "${server}": what parked it (${park.code}) has gone`);
      }
    }
  }

  // ── the queue's plan ─────────────────────────────────────────────────────

  /**
   * Which of these rows start now. At most one per server, and its lane is
   * reserved for it until `runJob` claims it (or {@link RESERVATION_MS}
   * passes). A parked row starts only once the preflight cleared it, or its
   * venue changed because the user chose (a switch, a pin, the Fast toggle).
   */
  async plan(candidates: readonly QueuePlanCandidate[]): Promise<QueuePlan> {
    await this.gate;
    const plan: QueuePlan = { start: [], waiting: [], failed: [] };
    if (this.quitting) return plan;
    this.expireReservations();
    const host = this.venueHost();
    for (const candidate of candidates) {
      if (this.runs.has(candidate.jobId)) continue;
      const park = this.parks.get(candidate.jobId);
      let intended: string | null;
      try {
        intended = intendedServer(candidate.fast, host);
      } catch {
        intended = null;
      }
      if (park !== undefined && (park.fast !== candidate.fast || (park.server !== null && park.server !== intended))) {
        // The user chose: a different server selected, the pin moved, or the row's Fast toggled.
        // Work not yet started goes where the user now says (Briefcase's switch rule), decided afresh.
        this.forgetPark(candidate.jobId, 'the user changed where it goes');
      } else if (park !== undefined && park.wait.kind !== 'venue' && !this.cleared.has(candidate.jobId)) {
        plan.waiting.push({ jobId: candidate.jobId, server: park.server, line: park.line, parked: true });
        continue;
      }
      const venue = await decideVenue(candidate.fast, host);
      if (venue.kind === 'fail') {
        plan.failed.push({ jobId: candidate.jobId, reason: venue.reason });
        this.forgetPark(candidate.jobId, 'failed on a misconfiguration');
        continue;
      }
      if (venue.kind === 'wait') {
        this.parks.set(candidate.jobId, {
          jobId: candidate.jobId, server: venue.server, fast: candidate.fast, stage: this.parks.get(candidate.jobId)?.stage ?? 'transcribe',
          code: venue.wait, line: venue.line, wait: { kind: 'venue' }, at: this.now(), needsEdge: false, sawHeld: false,
        });
        plan.waiting.push({ jobId: candidate.jobId, server: venue.server, line: venue.line, parked: true });
        continue;
      }
      const lane = this.lane(venue.server);
      if (lane.holder !== null || lane.waiters.length > 0) {
        const ahead = lane.holder?.jobId ?? lane.waiters[0]!.jobId;
        plan.waiting.push({ jobId: candidate.jobId, server: venue.server, line: `waiting for ${venue.server}: ${ahead} is on it`, parked: false });
        continue;
      }
      lane.holder = { jobId: candidate.jobId, reserved: true, at: this.now() };
      plan.start.push({ jobId: candidate.jobId, server: venue.server });
    }
    if (plan.start.length > 0) this.publish();
    return plan;
  }

  // ── running a job ────────────────────────────────────────────────────────

  /**
   * Admit one queue job to its server's lane and run it. Answers `parked`
   * (never throws) when it cannot run now for a reason that is the server's,
   * and throws for everything else: a misconfiguration, the stall clock, the
   * job's own failure.
   */
  async runJob<T>(
    options: { jobId: string; fast: boolean; stage: ResumeStage; controller?: AbortController },
    work: (run: LaneRun) => Promise<T>,
  ): Promise<RunJobOutcome<T>> {
    await this.gate;
    if (this.quitting) throw new Error(`ContentStudio is quitting; ${options.jobId} was not started.`);
    const venue = await decideVenue(options.fast, this.venueHost());
    if (venue.kind === 'fail') throw new CrucibleVenueRefused(venue.server, venue.reason);
    if (venue.kind === 'wait') {
      this.parks.set(options.jobId, {
        jobId: options.jobId, server: venue.server, fast: options.fast, stage: options.stage,
        code: venue.wait, line: venue.line, wait: { kind: 'venue' }, at: this.now(), needsEdge: false, sawHeld: false,
      });
      this.publish();
      return { kind: 'parked', result: { status: 'parked', server: venue.server, holderLine: venue.line, stage: options.stage, code: venue.wait } };
    }
    const server = venue.server;
    const controller = options.controller ?? new AbortController();
    await this.claim(server, options.jobId, controller.signal);
    this.forgetPark(options.jobId, 'admitted');

    let settle!: () => void;
    const run: RunState = {
      jobId: options.jobId,
      server,
      fast: options.fast,
      stage: options.stage,
      controller,
      park: null,
      stalled: null,
      done: new Promise<void>((resolve) => { settle = resolve; }),
      clock: new JobStallClock(`${options.jobId} on "${server}"`, (sentence) => { void this.stall(run, sentence); }, this.stallMs, this.now),
      beat: () => run.clock.beat(),
    };
    this.runs.set(options.jobId, run);
    run.clock.start();
    log.info(`[crucible] ${options.jobId} admitted to "${server}" (${venue.because}), from ${options.stage}`);
    this.publish();
    try {
      let value: T | undefined;
      let failure: unknown = null;
      try {
        value = await runStore.run(run, () => work(run));
      } catch (err) {
        failure = err;
      }
      // A park or a stall aborts the job, and the generator then ends it its own way (a
      // cancelled result, or a throw): what the lane recorded is the answer, not that.
      if (run.stalled !== null) throw new CrucibleJobStalled(run.jobId, run.stalled);
      const refusal = run.park === null && failure !== null ? parkRefusalOf(failure) : null;
      if (refusal !== null) run.park = parkFor(refusal, { jobId: run.jobId, server, fast: run.fast, stage: run.stage }, this.lane(server).read, this.now());
      if (run.park !== null) {
        this.parks.set(run.jobId, run.park);
        log.info(`[crucible] ${run.jobId} parked on "${server}" at ${run.park.stage}: ${run.park.line}`);
        return { kind: 'parked', result: { status: 'parked', server, holderLine: run.park.line, stage: run.park.stage, code: run.park.code } };
      }
      if (failure !== null) throw failure;
      return { kind: 'done', server, value: value as T };
    } finally {
      run.clock.stop();
      // What the job's own finally did not give back (transport releases its lease there), the
      // lane does, after any give-back already under way (a stall's, a Stop's) has settled.
      await this.jobSweeps.get(run.jobId);
      if (this.deps.ledger.rowsOf(run.jobId).length > 0) {
        await this.sweepJob(run.jobId, `${run.jobId} ended with holds still recorded`);
      }
      this.runs.delete(run.jobId);
      this.release(server, run.jobId);
      settle();
      this.publish();
    }
  }

  /** Stop one job (the row's Stop): abort its fetch, cancel its Crucible jobs, release its lease. */
  async stopJob(jobId: string, reason: string): Promise<void> {
    const run = this.runs.get(jobId);
    this.forgetPark(jobId, reason);
    this.cleared.delete(jobId);
    const lane = [...this.lanes.values()].find((candidate) => candidate.holder?.jobId === jobId && candidate.holder.reserved);
    if (lane !== undefined) this.release(lane.server, jobId);
    if (run === undefined) return;
    run.controller.abort(new Error(reason));
    await this.sweepJob(jobId, reason);
  }

  private async stall(run: RunState, sentence: string): Promise<void> {
    run.stalled = sentence;
    log.warn(`[crucible] ${sentence}`);
    run.controller.abort(new CrucibleJobStalled(run.jobId, sentence));
    await this.sweepJob(run.jobId, `${run.jobId} went quiet`);
  }

  /**
   * Give back one job's holds. Chained per job: a stall's sweep, a Stop's and the job's own
   * end can all ask at once, and each must read the ledger AFTER the one before settled its
   * rows, or two of them release one lease twice.
   */
  private sweepJob(jobId: string, reason: string): Promise<SweepReport> {
    const before = this.jobSweeps.get(jobId) ?? Promise.resolve();
    const next = before.then(() => sweepCrucibleInFlight(
      { ledger: this.deps.ledger, clientFor: (server) => this.deps.clientFor(server) },
      { reason, deadlineMs: JOB_SWEEP_DEADLINE_MS, jobId },
    ));
    const settled = next.then(() => undefined, () => undefined);
    this.jobSweeps.set(jobId, settled);
    void settled.then(() => { if (this.jobSweeps.get(jobId) === settled) this.jobSweeps.delete(jobId); });
    return next;
  }

  // ── one model call ───────────────────────────────────────────────────────

  /**
   * Run one model call on its lane: a GPU call takes its server's slot (the
   * job's venue, or the selected server for a standalone call); a cloud call
   * takes nothing. A busy refusal inside a job parks the job (and aborts the
   * rest of it); outside a job it is thrown as the SDK raised it.
   */
  async aiCall<T>(route: AiCallRoute, name: string, execute: () => Promise<T>): Promise<T> {
    const run = runStore.getStore();
    if (route.lane === 'cloud') {
      const value = await stepStore.run(this.hooks('cloud', null, run), execute);
      run?.beat();
      return value;
    }
    const server = run?.server ?? this.standaloneServer(name);
    if (run === undefined) await this.gate;
    return this.lane(server).slot.run(async () => {
      try {
        const value = await stepStore.run(this.hooks('gpu', server, run), execute);
        run?.beat();
        return value;
      } catch (err) {
        const refusal = parkRefusalOf(err);
        if (run !== undefined && refusal !== null && run.park === null) {
          run.park = parkFor(refusal, { jobId: run.jobId, server, fast: run.fast, stage: run.stage }, this.lane(server).read, this.now());
          run.controller.abort(new Error(`parked: ${refusal.line}`));
        }
        throw err;
      }
    });
  }

  private standaloneServer(name: string): string {
    // Throws routing's own sentence when nothing is selected.
    const server = this.deps.servers.selected();
    if (this.deps.servers.routingView().servers.some((row) => row.name === server && row.paused)) {
      throw new CrucibleRoutingError('server_paused', `${name} needs Crucible on ${server}, which is paused. Set it to Running in Settings › Crucible Servers.`);
    }
    return server;
  }

  private hooks(lane: 'gpu' | 'cloud', server: string | null, run: RunState | undefined): CrucibleStepHooks {
    const ledger = this.deps.ledger;
    const jobId = run?.jobId ?? '';
    return {
      lane,
      server,
      jobId,
      signal: run?.controller.signal ?? null,
      submitted: (row) => { ledger.record({ server: row.server, kind: 'job', id: row.id, jobType: row.jobType, model: row.model, jobId }); },
      leased: (row) => { ledger.record({ server: row.server, kind: 'lease', id: row.id, jobType: 'lease', model: row.model, jobId }); },
      settled: (at, kind, id) => { ledger.settle(at, kind, id); },
      streamed: (at, id, lastEventId) => { ledger.advance(at, id, lastEventId); run?.beat(); },
      beat: () => { run?.beat(); },
      streamDropped: (at, reason) => sweepCrucibleInFlight(
        { ledger, clientFor: (name) => this.deps.clientFor(name) },
        { reason: `a stream to "${at}" dropped: ${reason}`, deadlineMs: JOB_SWEEP_DEADLINE_MS, server: at },
      ),
    };
  }

  // ── quit ─────────────────────────────────────────────────────────────────

  /**
   * Quit: stop admitting, abort every running job, give them
   * {@link QUIT_UNWIND_MS} to release their own holds, then sweep the ledger,
   * the whole thing under `deadlineMs` (plan sections 0a, 13.4). Never throws.
   */
  async quit(sweep: (deadlineMs: number) => Promise<SweepReport>, deadlineMs: number = QUIT_SWEEP_DEADLINE_MS, unwindMs: number = QUIT_UNWIND_MS): Promise<SweepReport> {
    const started = this.now();
    this.quitting = true;
    this.stop();
    const running = [...this.runs.values()];
    for (const run of running) run.controller.abort(new Error('ContentStudio is quitting'));
    if (running.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(running.map((run) => run.done)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, unwindMs); timer.unref?.(); }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    }
    return sweep(Math.max(1, deadlineMs - (this.now() - started)));
  }

  // ── the strip ────────────────────────────────────────────────────────────

  view(): CrucibleLanesView {
    const routing = this.deps.servers.routingView();
    return {
      lanes: routing.servers.map((row): LaneChip => {
        const lane = this.lane(row.name);
        const running = lane.holder !== null && !lane.holder.reserved ? lane.holder.jobId : null;
        const state: LaneChip['state'] = row.paused && running === null ? 'unread'
          : running !== null ? 'running'
            : lane.chip.state === 'running' ? 'idle' : lane.chip.state;
        return {
          server: row.name,
          selected: row.selected,
          fast: row.fast,
          paused: row.paused,
          state,
          resident: lane.chip.resident,
          busyLine: state === 'busy' ? lane.chip.busyLine : null,
          runningJobId: running,
          parked: [...this.parks.values()].filter((park) => park.server === row.name).length,
          unreadReason: state === 'unreachable' ? lane.chip.unreadReason : null,
          readAt: lane.read?.at ?? null,
        };
      }),
    };
  }

  /** The job ids running now, for a keeper and the quit log. */
  running(): string[] {
    return [...this.runs.keys()];
  }

  /** The park recorded for a job, for a keeper. */
  parkOf(jobId: string): ParkRecord | null {
    return this.parks.get(jobId) ?? null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private lane(server: string): Lane {
    let lane = this.lanes.get(server);
    if (lane === undefined) {
      lane = { server, holder: null, waiters: [], slot: new Slot(), read: null, chip: { state: 'unread', resident: null, busyLine: null, unreadReason: null } };
      this.lanes.set(server, lane);
    }
    return lane;
  }

  private venueHost(): VenueHost {
    const servers = this.deps.servers;
    return {
      selected: () => servers.selected(),
      fastServer: () => servers.fastServer(),
      isPaused: (server) => servers.routingView().servers.some((row) => row.name === server && row.paused),
      reach: (server) => this.deps.reach(server),
    };
  }

  /** Take the lane for `jobId`: at once when free or reserved for it, else in turn. */
  private async claim(server: string, jobId: string, signal: AbortSignal): Promise<void> {
    const lane = this.lane(server);
    this.expireReservations();
    if (lane.holder === null || lane.holder.jobId === jobId) {
      lane.holder = { jobId, reserved: false, at: this.now() };
      return;
    }
    log.info(`[crucible] ${jobId} waits for "${server}": ${lane.holder.jobId} is on it`);
    await new Promise<void>((resolve, reject) => {
      const waiter = { jobId, admit: () => { signal.removeEventListener('abort', onAbort); resolve(); } };
      const onAbort = (): void => {
        lane.waiters = lane.waiters.filter((entry) => entry !== waiter);
        reject(signal.reason instanceof Error ? signal.reason : new Error(`${jobId} was stopped while waiting for "${server}"`));
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      lane.waiters.push(waiter);
    });
    lane.holder = { jobId, reserved: false, at: this.now() };
  }

  private release(server: string, jobId: string): void {
    const lane = this.lane(server);
    if (lane.holder?.jobId !== jobId) return;
    lane.holder = null;
    const next = lane.waiters.shift();
    if (next !== undefined) {
      lane.holder = { jobId: next.jobId, reserved: true, at: this.now() };
      next.admit();
    }
  }

  private expireReservations(): void {
    for (const lane of this.lanes.values()) {
      if (lane.holder?.reserved && this.now() - lane.holder.at > RESERVATION_MS && !this.runs.has(lane.holder.jobId)) {
        log.warn(`[crucible] the lane on "${lane.server}" was reserved for ${lane.holder.jobId}, which never started; freed`);
        this.release(lane.server, lane.holder.jobId);
      }
    }
  }

  private forgetPark(jobId: string, why: string): void {
    if (this.parks.delete(jobId)) log.info(`[crucible] ${jobId} is no longer parked: ${why}`);
    this.cleared.delete(jobId);
  }

  private publish(): void {
    if (this.deps.push === undefined) return;
    try {
      this.deps.push(this.view());
    } catch (err) {
      log.warn(`[crucible] Could not push the lanes view: ${(err as Error).message}`);
    }
  }
}

// ── the process's lanes, for queueAITask ─────────────────────────────────────

let installed: CrucibleLanes | null = null;

/** main.ts (and each CLI) installs the process's lanes once. */
export function installLanes(lanes: CrucibleLanes | null): void {
  installed = lanes;
}

/** The installed lanes. Throws by name when a GPU call is made in a process that never installed them. */
export function installedLanes(): CrucibleLanes {
  if (installed === null) {
    throw new Error('No Crucible lanes are installed in this process, so a local model call has no lane to run on (main.ts and each CLI install them at start).');
  }
  return installed;
}

/** For a cloud call in a process with no lanes (a CLI that only calls Claude): no lane is needed. */
export function lanesIfInstalled(): CrucibleLanes | null {
  return installed;
}
