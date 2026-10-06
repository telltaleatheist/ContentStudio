/**
 * THE LANES: one GPU lane per Crucible server, and the queue's admission, the
 * server's line, the stall clock and the in-flight bookkeeping over them.
 *
 * Plan section 13, cut to LEDGER #205, moved onto Crucible 1.0.76's queue
 * sessions by LEDGER #255. What replaced what:
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
 *   a busy answer failed the job              the job's QUEUE SESSION waits in the server's own
 *                                            line (session.ts); the job's row says where it
 *                                            stands ("in line on mac, 2 of 3")
 *
 * TWO LEVELS ON A LANE, because two kinds of work share a server:
 *
 *   the JOB     a queue job admitted to the server (`runJob`). One at a time (Owen: one live
 *               job on the Mac's Crucible at a time), so two of our jobs never fight over one
 *               server, and the fast pin's job on the PC runs beside the Mac's. The job OWNS
 *               one queue session on its server, opened by its first piece of GPU work
 *               ({@link CrucibleLanes.sessionOn}) and closed in `runJob`'s finally.
 *   the SLOT    who may send a GPU model call on the server now (`aiCall`), taken by
 *               the admitted job's local calls AND by standalone calls (the editor's
 *               story title, the reports page's "more titles"), which interleave with a
 *               running job call by call. A standalone call on a server where a job's
 *               session is open JOINS that session (Crucible matches membership on our
 *               client name; a second session of ours would queue behind the first).
 *               ONE JOB'S OWN CALLS SHARE IT (LEDGER #270): every engine serves 16 chats
 *               side by side, so up to {@link JOB_CALLS_PER_SERVER} calls of the ONE
 *               admitted job ON ONE MODEL hold the slot together, sent by a fan-out
 *               (fan-out.ts) where the pipeline's calls are independent. Calls on another
 *               model (a different key) wait for them, so nothing a job sends at once ever
 *               evicts a model mid-answer; a standalone call, or another job's, takes the
 *               slot alone exactly as before, and once one waits no further call of the
 *               running group joins past it. Whether the CARD holds that many at once at
 *               the calls' size is the session's question (session.ts `admit`).
 *
 * WHERE A JOB GOES is venue-decision.ts's rule: the fast pin's server, else the
 * model routing's server (#222), else the selected one, never another (LEDGER
 * #205). A job whose venue cannot take work (nothing selected, paused, not
 * answering) PARKS on that venue and is re-decided at the next plan; that is the
 * only park left. Another client holding the server is not a park any more: the
 * job's session waits in the server's line, and `onQueue` puts its place on the
 * lane chip and the job's row.
 *
 * THE STRIP IS FOLLOWED, NOT POLLED (server-watch.ts): each server's `/v1/events`
 * stream while ContentStudio has work queued (readiness.ts `needsPolling`
 * switches it through `setPolling`, LEDGER #234); a one-shot `/v1/activity`
 * read when the renderer asks (`readAll`). It is display, never permission.
 *
 * TRANSPORT'S SEAM. This layer does not talk to a model. transport.ts runs
 * inside `aiCall` and reaches this layer through {@link crucibleStepHooks}: the
 * server the step must run on, the job's abort signal, the session it runs in,
 * the ledger writes it must make right after a submit, the stall clock's beat,
 * and the dropped-stream sweep (docs/crucible/P3.md).
 *
 * STAGE-MAJOR BATCHES (batch.ts, LEDGER #266). When the plan finds two or more startable rows
 * bound for one free server, it plans them as ONE BATCH: the lane is the batch's, every member
 * runs its own pipeline in its own `runJob`, the members share ONE queue session (a
 * {@link SessionShare}), and each member's pipeline awaits {@link enterJobStage} at its stage
 * boundaries, where batch.ts's turnstile lets one member at a time do one stage's GPU work and
 * opens a stage only when every member has finished the one before. One row runs as it always did.
 * After the chapters' boundaries the turn is the CALL turn (LEDGER #270): `aiCall` takes it for a
 * member's LOCAL call only (`StageBatch.takeCall`), so a member's cloud calls never wait for it
 * and never hold it, and a batch whose fields are all cloud-routed writes them side by side.
 * The boundary is the call itself rather than the needs a member states at its gate: a stated
 * need is an estimate for the load floor (a compilation states none and still loads the 27B),
 * while a GPU call through the lane is exactly the work that needs the card.
 *
 * THE STARTUP SWEEP GATES GPU ADMISSION. `setAdmissionGate` takes the startup
 * sweep's promise (main.ts); no job is admitted and no standalone GPU call
 * takes a slot until it settles (plan section 13.4). Cloud calls never wait
 * for it: they hold nothing on a server.
 */
import { AsyncLocalStorage } from 'async_hooks';
import type { CrucibleClient, QueuePosition } from '@crucible/client';
import * as log from 'electron-log';
import { catalogInventory, type CatalogInventory } from './catalog';
import { CrucibleRoutingError } from './errors';
import type { InFlightKind, InFlightLedger } from './in-flight-ledger';
import { JOB_SWEEP_DEADLINE_MS, QUIT_SWEEP_DEADLINE_MS, QUIT_UNWIND_MS, sweepCrucibleInFlight, type SweepReport } from './in-flight-sweep';
import { busyLineOfView, cardViewOf, holderOf, trackHolder, type CardView, type HolderTrack } from './card-holder';
import { FRESH_PROBE_MS } from './probe';
import { ServerWatch } from './server-watch';
import { SESSION_TOUCH_EVERY_MS, type CardSession, type SessionHold, type SessionRequest, type ServerSessions } from './session';
import { CRUCIBLE_STALL_MS, JobStallClock } from './stream-stall';
import { decideVenue, intendedServer, type VenueHost } from './venue-decision';
import { StageBatch, turnPerCall, type BatchStage, type LoadFloor, type StageNeed } from './batch';
import { JOB_CALLS_PER_SERVER } from './fan-out';
import type { CrucibleLanesView, LaneChip, ParkedJobResult, QueuePlan, QueuePlanCandidate, ResumeStage, RoutingView, ServerReach } from './wire';

/** A one-shot activity read's own clock (the renderer's ask, a Re-check): a sleeping server must not stall it. */
export const READ_TIMEOUT_MS = 3_000;
/** A lane reserved by `plan()` for a job the renderer has not started yet is freed after this. */
export const RESERVATION_MS = 30_000;
/**
 * How long a lane job's session may wait in the server's line before the server gives up on it
 * (`max_wait_s`, Crucible's maximum). A job the user queued waits its turn as long as it takes;
 * an hour (the server's default) would fail a job queued behind a long run of another app's.
 */
export const JOB_SESSION_MAX_WAIT_S = 86_400;

// ── the call's route ────────────────────────────────────────────────────────

/**
 * Which kind of call this is, from the model id the routing table resolved.
 * `gpu` takes the server's slot; `cloud` takes nothing (plan section 13.1).
 */
export type AiCallRoute = { lane: 'gpu'; model: string } | { lane: 'cloud'; model: string };

/** A local model call (a Crucible model id, as the chapter stage carries it). */
export function gpuCall(model: string): AiCallRoute {
  return { lane: 'gpu', model };
}

/**
 * The route of a model string as ai-manager's makeRequest and the routing table
 * spell them since P2 (plan 6.2): `claude-cli:<alias>` (outside Crucible) and an
 * upstream id `<upstream>/<model>` take no lane; a bare Crucible id is a model a
 * server holds, so it takes that server's slot (PHASE15-HOST 1: a local id never
 * contains `/`). The retired `ollama:`/`claude:`/`openai:` strings are refused by
 * name rather than guessed onto a lane (Law 1).
 */
export function routeOfModelId(model: string): AiCallRoute {
  if (model.startsWith('claude-cli:') || model.includes('/')) return { lane: 'cloud', model };
  if (/^(ollama|claude|openai):/.test(model) || model.trim() === '' || model.includes(':')) {
    throw new Error(
      `"${model}" names no model this app routes (a Crucible id such as qwen3.8-27b-4bit, an upstream id such as ` +
        `anthropic/claude-sonnet-5, or claude-cli:<alias>), so it has no lane.`,
    );
  }
  return { lane: 'gpu', model };
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
  /**
   * The routing's server the job was admitted with (LEDGER #222), or null outside a job or when
   * the routing names none. An upstream (cloud) step hands it to venue-decision.ts's
   * `upstreamServerFor`, so a job's cloud calls go to the server it chose, never another mid-job.
   */
  readonly routingServer: string | null;
  /** The ContentStudio job id, or '' for a standalone call. */
  readonly jobId: string;
  /** Aborted by Stop, a stall or quit. Hand it to every fetch. */
  readonly signal: AbortSignal | null;
  /**
   * The queue session the step's work runs in on its server: the lane job's own (held until the
   * job ends; `release` does nothing), else this install's open one joined, else a new one
   * (session.ts). A GPU step only; a cloud step holds nothing.
   */
  session(request: SessionRequest): Promise<SessionHold>;
  /** Call SYNCHRONOUSLY right after `submit()` returned an id, before the next await. */
  submitted(row: { server: string; id: string; jobType: string; model: string | null }): void;
  /** Call when a job settled: the row leaves the ledger. */
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
  /** The routing's server read at admission (null: the routing names none). Cloud steps go there. */
  readonly routingServer: string | null;
  /** Where the job is, for `resumeFrom` when it parks. */
  stage: ResumeStage;
  /** Aborted by Stop, a stall or quit. The pipeline hands it to the generator. */
  readonly controller: AbortController;
  /** A sign of life: the pipeline's own progress lines count, as SSE events and completed calls do. */
  beat(): void;
}

/**
 * The queue session a lane job runs in, and who shares it: one job's own, or a batch's (every
 * member's work is an item of it). Asked for by the first GPU work, closed when the last sharer ends.
 */
interface SessionShare {
  /** For the session's log lines: "j1 (…)" or "the batch of 3 on mac". */
  readonly what: string;
  /** The session, asked for by the first GPU work; null until then. */
  session: Promise<SessionHold> | null;
  /** The session once open, for the touch around cloud calls and the batch's load floors. */
  card: CardSession | null;
  /** The floors of the batch stage now open, set on the card when it opens (batch.ts). */
  floors: { stage: BatchStage; floors: ReadonlyMap<string, LoadFloor> } | null;
}

interface RunState extends LaneRun {
  clock: JobStallClock;
  stalled: string | null;
  done: Promise<void>;
  /** The session this job's GPU work runs in: its own, or its batch's. */
  share: SessionShare;
  /** The batch this job is a member of, or null when it runs alone. */
  batch: StageBatch | null;
  /** Cloud calls of this job running now, and the touch timer while there are any. */
  cloudCalls: number;
  touchTimer: NodeJS.Timeout | null;
}

const runStore = new AsyncLocalStorage<RunState>();

/** Mark the stage the current job is in (the generator calls this; outside a job it does nothing). */
export function setJobStage(stage: ResumeStage): void {
  const run = runStore.getStore();
  if (run !== undefined) run.stage = stage;
}

/** The resume stage a batch stage parks at: everything past the chapters' boundaries resumes at `fields`. */
function resumeStageOf(stage: BatchStage): ResumeStage {
  return stage === 'transcribe' || stage === 'chapters' ? stage : 'fields';
}

/** The lanes this run belongs to, for the stage gates below (set by `runJob`). */
const gateStore = new WeakMap<RunState, CrucibleLanes>();

/**
 * THE STAGE GATE (batch.ts). The pipeline awaits this at each stage boundary, stating what its
 * work there will need of each model's load. A single job only records the stage (as setJobStage);
 * a batch member waits until the stage is open and the turn is its own, its stall clock paused
 * meanwhile, and its row told where it stands. Outside a lane job it does nothing.
 */
export async function enterJobStage(stage: BatchStage, needs: readonly StageNeed[] = []): Promise<void> {
  const run = runStore.getStore();
  if (run === undefined) return;
  const lanes = gateStore.get(run);
  if (lanes === undefined || run.batch === null) {
    run.stage = resumeStageOf(stage);
    return;
  }
  await lanes.enterStage(run, stage, needs);
}

/**
 * The current batch member's GPU work for its stage is done (its next work is CPU until its next
 * gate), so the next member may take the turn. Nothing for a single job, or outside a lane job.
 */
export function finishJobStage(): void {
  const run = runStore.getStore();
  if (run?.batch) run.batch.finishTurn(run.jobId);
}

/** The batch the current job runs in, or null (a single job, or outside a lane job). */
export function jobBatch(): { id: string; size: number } | null {
  const batch = runStore.getStore()?.batch ?? null;
  return batch === null ? null : { id: batch.id, size: batch.size };
}

/** A sign of life for the current job (a progress line); outside a job it does nothing. */
export function beatJob(): void {
  runStore.getStore()?.beat();
}

/**
 * The current job's venue and id, or null outside a job. For a door that is not a lane step
 * (transcription, P5): its work goes where the job's model calls go, never elsewhere (#205).
 */
export function currentJobVenue(): { server: string; jobId: string } | null {
  const run = runStore.getStore();
  return run === undefined ? null : { server: run.server, jobId: run.jobId };
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

/**
 * A job waiting on its VENUE: nothing selected or pinned, the server paused, or not answering.
 * Re-decided by the venue rule at every `plan()`, never by reading the server.
 */
export interface VenuePark {
  readonly jobId: string;
  /** The server it is for; null when nothing is selected or pinned. */
  readonly server: string | null;
  readonly fast: boolean;
  readonly stage: ResumeStage;
  readonly code: 'no_server' | 'paused' | 'unreachable';
  /** The venue's sentence. Shown as `parked — <line>`. */
  readonly line: string;
  /** Epoch ms. */
  readonly at: number;
}

// ── the lanes ───────────────────────────────────────────────────────────────

/**
 * Who may send a GPU call on one server now, first come first served (LEDGER #270). A standalone
 * call holds it ALONE, as every call did before #269. One admitted job's calls on one model share
 * it: a call whose `group` key matches the holders' joins them while fewer than `cap` are in flight
 * and nobody else's call is waiting (a waiting standalone call or another job's is never jumped).
 * A call of the same job on ANOTHER model has another key, so it waits until the group drains:
 * concurrent calls never make a session load one model under another's answers.
 */
interface SlotGroup {
  /** `<job id>` + the model: the calls that may run together. */
  readonly key: string;
  /** At most this many of the group in flight (JOB_CALLS_PER_SERVER). */
  readonly cap: number;
  /** The job the call belongs to: a waiter of another owner stops later calls of this group joining. */
  readonly owner: string;
}

interface SlotWaiter {
  readonly group: SlotGroup | null;
  readonly admit: () => void;
}

class Slot {
  /** The calls sending now: one alone (`key` null), or up to `cap` of one group. */
  private holder: { key: string | null; active: number } | null = null;
  private readonly queue: SlotWaiter[] = [];
  /** Calls holding or waiting for the slot. */
  busy = 0;

  async run<T>(work: () => Promise<T>, group: SlotGroup | null = null): Promise<T> {
    this.busy += 1;
    try {
      await this.acquire(group);
      try {
        return await work();
      } finally {
        this.release();
      }
    } finally {
      this.busy -= 1;
    }
  }

  /** How many calls are sending now (a keeper reads it). */
  get active(): number {
    return this.holder?.active ?? 0;
  }

  private acquire(group: SlotGroup | null): Promise<void> {
    const holder = this.holder;
    if (holder === null && this.queue.length === 0) {
      this.holder = { key: group?.key ?? null, active: 1 };
      return Promise.resolve();
    }
    if (group !== null && holder !== null && holder.key === group.key && holder.active < group.cap
      && !this.queue.some((w) => w.group?.owner !== group.owner)) {
      holder.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((admit) => { this.queue.push({ group, admit }); });
  }

  private release(): void {
    const holder = this.holder;
    if (holder === null) throw new Error('the GPU slot was let go of by a call that did not hold it');
    holder.active -= 1;
    if (holder.active === 0) this.holder = null;
    this.pump();
  }

  /** Admit waiters in arrival order: the head alone, or the head's group up to its cap. */
  private pump(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0];
      const holder = this.holder;
      if (holder === null) {
        this.holder = { key: head.group?.key ?? null, active: 1 };
      } else if (head.group !== null && holder.key === head.group.key && holder.active < head.group.cap) {
        holder.active += 1;
      } else {
        return;
      }
      this.queue.shift();
      head.admit();
      if (head.group === null) return;
    }
  }
}

interface Lane {
  readonly server: string;
  /**
   * The admitted job, or a reservation `plan()` made for one the renderer is about to start. For a
   * batch, `jobId` is the batch's id and `batch` the batch: the lane is its until its last member ends.
   */
  holder: { jobId: string; reserved: boolean; at: number; batch?: StageBatch } | null;
  /** Jobs waiting for `holder` to leave (an "Analyze" press on a busy lane, a CLI's job). */
  waiters: Array<{ jobId: string; admit: () => void }>;
  readonly slot: Slot;
  /** When the strip last heard from this server (epoch ms), or null. */
  readAt: number | null;
  chip: { state: LaneChip['state']; resident: string | null; busyLine: string | null; unreadReason: string | null; holder: LaneChip['holder'] };
  /** Another client's hold as seen so far, for its time left (card-holder.ts). */
  holderTrack: HolderTrack | null;
  /** Our lane job's session waiting in the server's line, and where it stands; null otherwise. */
  inLine: LaneChip['inLine'];
}

/** The session registry, as the lanes use it (session.ts `ServerSessions`). */
export type LaneSessions = Pick<ServerSessions, 'use' | 'closeAll'>;

export interface LanesDeps {
  /** The registry and the choice (servers.ts). */
  servers: {
    names(): string[];
    routingView(): RoutingView;
    selected(): string;
    fastServer(): string;
    onChange(listener: (change: { server: string | null }) => void): () => void;
  };
  /**
   * The server the model routing names (`metadataRouting.server`, LEDGER #222), judged against
   * the registry, or null when it names none. Read live at every plan and admission, like the
   * selection, so a routing saved between runs takes effect on the next job. A job is admitted
   * to it (unless pinned fast) through venue-decision.ts; nothing else here reads it.
   */
  routingServer(): string | null;
  /** A client on the engine behind a registered server. */
  clientFor(server: string, options?: { timeoutMs?: number }): Promise<CrucibleClient>;
  /** The probe's answer, at most `maxAgeMs` (default 15 s) old (probe.ts `reach`). */
  reach(server: string, maxAgeMs?: number): Promise<{ reach: ServerReach; message: string | null }>;
  ledger: InFlightLedger;
  /** Every queue session this install holds (session.ts): one per server, joined, never doubled. */
  sessions: LaneSessions;
  /** Pushes the lanes strip to the renderer. */
  push?(view: CrucibleLanesView): void;
  /**
   * A lane job's session moved in the server's line (`position` of `of`), or opened (null): the
   * job's row says so (ipc wiring sends it as the job's progress line).
   */
  onInLine?(jobId: string, server: string, position: QueuePosition | null): void;
  /** The jobs running, parked or in line changed: readiness re-applies its polling rule (LEDGER #234). */
  onWorkChange?(): void;
  /**
   * Right before a job is admitted or a standalone call runs: readiness makes its answer fresh
   * (derived within a few seconds), so nothing is admitted on a view nobody has checked since
   * the queue went quiet (LEDGER #234). Null when the answer is already fresh (or this process
   * runs no readiness loop, a CLI): then admission does not wait at all. Never rejects.
   */
  beforeAdmit?(): Promise<unknown> | null;
  now?(): number;
  stallMs?: number;
  /** How long a server whose event stream could not be opened waits before it is followed again (a keeper shortens it). */
  watchRetryMs?: number;
  /** How often a lane job's open session is touched while its cloud calls run (a keeper shortens it). */
  touchEveryMs?: number;
  /**
   * A batch member's waiting line (batch.ts), or null once its turn came: the job's row says it
   * (ipc wiring sends it as the job's `waiting` progress line).
   */
  onBatchWait?(jobId: string, line: string | null): void;
}

/** The most queue jobs one stage-major batch takes (Owen, 2026-10-06); the rest wait for the next batch. */
export const MAX_BATCH = 4;

export class CrucibleLanes {
  private readonly lanes = new Map<string, Lane>();
  private readonly runs = new Map<string, RunState>();
  private readonly parks = new Map<string, VenuePark>();
  /** Batches planned or running, by id (a member is found by `batchOf`). */
  private readonly batches = new Map<string, StageBatch>();
  /** Each batch's closing (its session let go of, its lane freed), once. */
  private readonly batchClosings = new Map<StageBatch, Promise<void>>();
  private batchCount = 0;
  /** Each job's give-back in progress, so they run one after another (sweepJob). */
  private readonly jobSweeps = new Map<string, Promise<void>>();
  private gate: Promise<unknown> = Promise.resolve();
  private readonly watch: ServerWatch;
  private watching = false;
  private quitting = false;
  private offRegistry: (() => void) | null = null;
  private readonly now: () => number;
  readonly stallMs: number;
  private readonly touchEveryMs: number;

  constructor(private readonly deps: LanesDeps) {
    this.now = deps.now ?? Date.now;
    this.stallMs = deps.stallMs ?? CRUCIBLE_STALL_MS;
    this.touchEveryMs = deps.touchEveryMs ?? SESSION_TOUCH_EVERY_MS;
    this.watch = new ServerWatch({
      clientFor: (server) => deps.clientFor(server),
      onView: (server, view) => this.saw(server, view),
      onFailure: (server, reason) => this.unread(server, reason),
      ...(deps.watchRetryMs === undefined ? {} : { retryMs: deps.watchRetryMs }),
    });
  }

  // ── the gate ─────────────────────────────────────────────────────────────

  /** GPU admission waits for this (the startup sweep). Cloud calls never do. */
  setAdmissionGate(gate: Promise<unknown>): void {
    this.gate = gate.catch(() => undefined);
  }

  // ── the strip ────────────────────────────────────────────────────────────

  /** Follow the registry. The event streams start only when polling does (`setPolling`). */
  start(): void {
    if (this.offRegistry !== null) return;
    this.offRegistry = this.deps.servers.onChange(() => {
      if (this.watching) this.watch.follow(this.followable());
      this.publish();
    });
  }

  /**
   * Following the servers' event streams on or off, as readiness.ts `needsPolling` says (LEDGER
   * #234: only while work is queued). Off, nothing is followed; the renderer's ask reads once.
   */
  setPolling(on: boolean): void {
    if (on && !this.watching && !this.quitting) {
      this.watching = true;
      this.watch.follow(this.followable());
    } else if (!on && this.watching) {
      this.watching = false;
      this.watch.stop();
    }
  }

  /** Whether the event streams are being followed (a keeper reads it). */
  watchRunning(): boolean {
    return this.watching;
  }

  stop(): void {
    this.setPolling(false);
    this.offRegistry?.();
    this.offRegistry = null;
  }

  private followable(): string[] {
    return this.deps.servers.routingView().servers.filter((row) => !row.paused).map((row) => row.name);
  }

  /** Jobs running, parked or in line on a lane: work that keeps the streams followed (LEDGER #234). */
  workCount(): number {
    let waiting = 0;
    for (const lane of this.lanes.values()) waiting += lane.waiters.length;
    return this.runs.size + this.parks.size + waiting;
  }

  private workChanged(): void {
    try {
      this.deps.onWorkChange?.();
    } catch (err) {
      log.warn(`[crucible] The polling rule could not be re-applied: ${(err as Error).message}`);
    }
  }

  /**
   * One `/v1/activity` read of every running (not paused) server: the renderer's ask while nothing
   * is followed, a Re-check, a keeper. Display only.
   */
  async readAll(): Promise<void> {
    try {
      await Promise.all(this.followable().map(async (server) => {
        try {
          const client = await this.deps.clientFor(server, { timeoutMs: READ_TIMEOUT_MS });
          this.saw(server, cardViewOf(await client.activity()), false);
        } catch (err) {
          this.unread(server, err instanceof Error ? err.message : String(err), false);
        }
      }));
    } finally {
      this.publish();
    }
  }

  /** A server's view arrived (its stream, or a read): the chip follows it. */
  private saw(server: string, view: CardView, publish = true): void {
    const lane = this.lane(server);
    const at = this.now();
    lane.readAt = at;
    const ours = this.deps.ledger.idsOn(server);
    const held = trackHolder(lane.holderTrack, holderOf(view, ours), at);
    lane.holderTrack = held.track;
    const busyLine = held.holder === null ? null : busyLineOfView(view);
    lane.chip = {
      // `running` is the lane's own fact (view() reads the holder); this is the server's.
      state: busyLine !== null ? 'busy' : 'idle',
      resident: view.resident,
      busyLine,
      unreadReason: null,
      holder: held.holder,
    };
    if (publish) this.publish();
  }

  private unread(server: string, reason: string, publish = true): void {
    const lane = this.lane(server);
    lane.chip = { ...lane.chip, state: 'unreachable', unreadReason: reason, holder: null };
    lane.holderTrack = null;
    if (publish) this.publish();
  }

  // ── the queue's plan ─────────────────────────────────────────────────────

  /**
   * Which of these rows start now. Per free server: its one row, or — two or more bound for it — all
   * of them as ONE BATCH (batch.ts), in queue order; the lane is reserved for the row (or the batch)
   * until `runJob` claims it (or {@link RESERVATION_MS} passes). A row bound for a server whose lane
   * is held (a job, or a batch running) waits for it: a row added while a batch runs starts with the
   * NEXT batch (batch.ts "who joins"). A row parked on its venue is decided afresh each time.
   */
  async plan(candidates: readonly QueuePlanCandidate[]): Promise<QueuePlan> {
    await this.gate;
    const plan: QueuePlan = { start: [], waiting: [], failed: [] };
    // Refused by name, never an empty plan: a quit that did not finish leaves this process alive,
    // and a window reopened on it showed "1 job waiting" forever with both servers idle (2026-10-04).
    if (this.quitting) throw new Error('ContentStudio is quitting, so no job starts. If the app is still open, quit it fully (or force-quit it) and open it again.');
    this.expireReservations();
    const host = this.venueHost();
    /** The rows that may go, per server, in queue order. */
    const go = new Map<string, QueuePlanCandidate[]>();
    for (const candidate of candidates) {
      if (this.runs.has(candidate.jobId)) continue;
      // Already told to start as a member of a planned batch (the renderer is starting it).
      if (this.batchOf(candidate.jobId) !== null) continue;
      const park = this.parks.get(candidate.jobId);
      let intended: string | null;
      try {
        intended = intendedServer(candidate.fast, host);
      } catch {
        intended = null;
      }
      if (park !== undefined && (park.fast !== candidate.fast || (park.server !== null && park.server !== intended))) {
        // The user chose: a different server selected, the pin moved, or the row's Fast toggled.
        this.forgetPark(candidate.jobId, 'the user changed where it goes');
      }
      const venue = await decideVenue(candidate.fast, host);
      if (venue.kind === 'fail') {
        plan.failed.push({ jobId: candidate.jobId, reason: venue.reason });
        this.forgetPark(candidate.jobId, 'failed on a misconfiguration');
        continue;
      }
      if (venue.kind === 'wait') {
        const known = this.parks.has(candidate.jobId);
        this.parks.set(candidate.jobId, {
          jobId: candidate.jobId, server: venue.server, fast: candidate.fast, stage: this.parks.get(candidate.jobId)?.stage ?? 'transcribe',
          code: venue.wait, line: venue.line, at: this.now(),
        });
        if (!known) this.workChanged();
        plan.waiting.push({ jobId: candidate.jobId, server: venue.server, line: venue.line, parked: true });
        continue;
      }
      go.set(venue.server, [...(go.get(venue.server) ?? []), candidate]);
    }
    for (const [server, rows] of go) {
      const lane = this.lane(server);
      if (lane.holder !== null || lane.waiters.length > 0) {
        const batch = lane.holder?.batch;
        const ahead = lane.holder?.jobId ?? lane.waiters[0]!.jobId;
        for (const row of rows) {
          plan.waiting.push(batch === undefined
            ? { jobId: row.jobId, server, line: `waiting for ${server}: ${ahead} is on it`, parked: false }
            : { jobId: row.jobId, server, line: `waiting for ${server}: a batch of ${batch.size} is on it, and this job starts with the next batch`, parked: false, batchOf: batch.size });
        }
        continue;
      }
      if (rows.length === 1) {
        lane.holder = { jobId: rows[0]!.jobId, reserved: true, at: this.now() };
        plan.start.push({ jobId: rows[0]!.jobId, server });
        continue;
      }
      // At most MAX_BATCH jobs per batch, in queue order (Owen, 2026-10-06: "Cap at 4"): most of the
      // load savings, and a report every few videos instead of only at the end of a long queue.
      const members = rows.slice(0, MAX_BATCH);
      for (const row of rows.slice(MAX_BATCH)) {
        plan.waiting.push({ jobId: row.jobId, server, line: `waiting for ${server}: a batch of ${members.length} starts first, and this job starts with the next batch`, parked: false, batchOf: members.length });
      }
      const batch = this.makeBatch(server, members.map((row) => row.jobId));
      lane.holder = { jobId: batch.id, reserved: true, at: this.now(), batch };
      members.forEach((row, i) => plan.start.push({ jobId: row.jobId, server, batch: { id: batch.id, position: i + 1, of: members.length } }));
      log.info(`[crucible] ${batch.id}: ${members.length} jobs planned on "${server}", run stage by stage under one session (${batch.jobIds.join(', ')})`);
    }
    if (plan.start.length > 0) this.publish();
    return plan;
  }

  // ── batches ──────────────────────────────────────────────────────────────

  private makeBatch(server: string, jobIds: string[]): StageBatch {
    this.batchCount += 1;
    const id = `batch ${this.batchCount} on ${server}`;
    const batch: StageBatch = new StageBatch(id, server, jobIds, {
      onWait: (jobId, line) => this.tellBatchWait(jobId, line),
      onStageOpen: (stage, floors) => {
        const share = this.shareOfBatch(batch);
        share.floors = { stage, floors };
        log.info(`[crucible] ${id}: the ${stage} stage opens (${batch.view().filter((m) => m.state !== 'ended').map((m) => `${m.jobId} at ${m.stage ?? 'start'}`).join(', ')})`);
        share.card?.setLoadFloors(floors, stage);
      },
      onTurn: () => this.publish(),
      onDone: () => { void this.closeBatch(batch); },
    }, this.now());
    this.batches.set(id, batch);
    this.batchShares.set(batch, { what: `${id} (${jobIds.join(', ')})`, session: null, card: null, floors: null });
    // A member the renderer never starts would hold every later stage shut. The plan's reservation
    // expiry drops it at the next plan; this drops it even when no plan comes (every row started).
    const expiry = setTimeout(() => {
      const dropped = batch.dropUnarrived();
      if (dropped.length > 0) log.warn(`[crucible] ${id}: ${dropped.join(', ')} never started within ${RESERVATION_MS / 1000} s, so ${dropped.length === 1 ? 'it leaves' : 'they leave'} the batch`);
    }, RESERVATION_MS);
    expiry.unref?.();
    return batch;
  }

  private readonly batchShares = new Map<StageBatch, SessionShare>();

  private shareOfBatch(batch: StageBatch): SessionShare {
    const share = this.batchShares.get(batch);
    if (share === undefined) throw new Error(`${batch.id} has no session share; it was not made by plan()`);
    return share;
  }

  /** The planned or running batch `jobId` is a live member of, or null. */
  private batchOf(jobId: string): StageBatch | null {
    for (const batch of this.batches.values()) if (batch.has(jobId)) return batch;
    return null;
  }

  /** A member leaves without running to its end (parked, its venue moved, stopped before it started). */
  private leaveBatch(batch: StageBatch, jobId: string, why: string): void {
    if (!batch.has(jobId)) return;
    log.info(`[crucible] ${jobId} leaves ${batch.id}: ${why}`);
    batch.end(jobId);
  }

  /**
   * The batch is over (its last member ended, or nobody it planned ever started): its session is let
   * go of (closed: the card is settled) and its lane freed. Once, however many ask.
   */
  private closeBatch(batch: StageBatch): Promise<void> {
    let closing = this.batchClosings.get(batch);
    if (closing === undefined) {
      closing = (async () => {
        this.batches.delete(batch.id);
        const share = this.batchShares.get(batch);
        this.batchShares.delete(batch);
        if (share !== undefined) await this.releaseShare(share);
        log.info(`[crucible] ${batch.id} is done; its session was let go of and the lane on "${batch.server}" is free`);
        this.release(batch.server, batch.id);
        this.workChanged();
        this.publish();
      })();
      this.batchClosings.set(batch, closing);
      void closing.finally(() => { setTimeout(() => this.batchClosings.delete(batch), 0).unref?.(); });
    }
    return closing;
  }

  /** Called by {@link enterJobStage} for a batch member: wait at the gate, stall clock paused. */
  async enterStage(run: RunState, stage: BatchStage, needs: readonly StageNeed[]): Promise<void> {
    const batch = run.batch;
    if (batch === null) {
      run.stage = resumeStageOf(stage);
      return;
    }
    run.clock.pause();
    try {
      await batch.enter(run.jobId, stage, { signal: run.controller.signal, needs });
    } finally {
      run.clock.resume();
    }
    run.stage = resumeStageOf(stage);
    log.info(turnPerCall(stage)
      ? `[crucible] ${run.jobId} goes into ${batch.id}'s ${stage} stage; its local calls take the turn as they go (LEDGER #270)`
      : `[crucible] ${run.jobId} takes ${batch.id}'s turn for ${stage}`);
  }

  private tellBatchWait(jobId: string, line: string | null): void {
    if (line !== null) log.info(`[crucible] ${jobId}: ${line}`);
    try {
      this.deps.onBatchWait?.(jobId, line);
    } catch (err) {
      log.warn(`[crucible] Could not tell the renderer where ${jobId} stands in its batch: ${(err as Error).message}`);
    }
  }

  /** Where each batch stands, for a keeper and the quit log. */
  batchViews(): Array<{ id: string; server: string; members: ReturnType<StageBatch['view']> }> {
    return [...this.batches.values()].map((b) => ({ id: b.id, server: b.server, members: b.view() }));
  }

  // ── running a job ────────────────────────────────────────────────────────

  /**
   * Admit one queue job to its server's lane and run it. Answers `parked`
   * (never throws) when its venue cannot take work now, and throws for
   * everything else: a misconfiguration, the stall clock, the job's own failure
   * (a session the server ended under it among them).
   */
  async runJob<T>(
    options: { jobId: string; fast: boolean; stage: ResumeStage; controller?: AbortController },
    work: (run: LaneRun) => Promise<T>,
  ): Promise<RunJobOutcome<T>> {
    await this.gate;
    if (this.quitting) throw new Error(`ContentStudio is quitting; ${options.jobId} was not started.`);
    // A fresh answer right before admission (LEDGER #234): readiness's, for the banner, and the
    // venue's own reach below at most FRESH_PROBE_MS old, never the 15 s cache.
    const fresh = this.beforeAdmit();
    if (fresh !== null) await fresh;
    // Read ONCE for this admission: the venue and the job's cloud calls see the same answer. A
    // stored value that is not a server name at all throws here and fails the job by name.
    const routingServer = this.deps.routingServer();
    let batch = this.batchOf(options.jobId);
    let venue: Awaited<ReturnType<typeof decideVenue>>;
    try {
      venue = await decideVenue(options.fast, { ...this.venueHost(FRESH_PROBE_MS), routingServer: () => routingServer });
    } catch (err) {
      if (batch !== null) this.leaveBatch(batch, options.jobId, `its venue could not be decided (${(err as Error).message})`);
      throw err;
    }
    if (batch !== null && (venue.kind !== 'venue' || venue.server !== batch.server)) {
      this.leaveBatch(batch, options.jobId, venue.kind === 'venue' ? `it now goes to "${venue.server}"` : `its venue says ${venue.kind}`);
      batch = null;
    }
    if (venue.kind === 'fail') throw new CrucibleVenueRefused(venue.server, venue.reason);
    if (venue.kind === 'wait') {
      this.parks.set(options.jobId, {
        jobId: options.jobId, server: venue.server, fast: options.fast, stage: options.stage,
        code: venue.wait, line: venue.line, at: this.now(),
      });
      this.workChanged();
      this.publish();
      return { kind: 'parked', result: { status: 'parked', server: venue.server, holderLine: venue.line, stage: options.stage, code: venue.wait } };
    }
    const server = venue.server;
    const controller = options.controller ?? new AbortController();
    if (batch !== null) {
      this.claimForBatch(server, batch);
      batch.arrive(options.jobId);
    } else {
      await this.claim(server, options.jobId, controller.signal);
    }
    this.forgetPark(options.jobId, 'admitted');

    let settle!: () => void;
    const run: RunState = {
      jobId: options.jobId,
      server,
      fast: options.fast,
      routingServer,
      stage: options.stage,
      controller,
      stalled: null,
      done: new Promise<void>((resolve) => { settle = resolve; }),
      clock: new JobStallClock(`${options.jobId} on "${server}"`, (sentence) => { void this.stall(run, sentence); }, this.stallMs, this.now),
      beat: () => run.clock.beat(),
      share: batch !== null ? this.shareOfBatch(batch) : { what: options.jobId, session: null, card: null, floors: null },
      batch,
      cloudCalls: 0,
      touchTimer: null,
    };
    gateStore.set(run, this);
    this.runs.set(options.jobId, run);
    this.workChanged();
    run.clock.start();
    log.info(`[crucible] ${options.jobId} admitted to "${server}" (${venue.because}), from ${options.stage}${batch === null ? '' : `, as a member of ${batch.id}`}`);
    this.publish();
    try {
      let value: T | undefined;
      let failure: unknown = null;
      try {
        value = await runStore.run(run, async () => {
          // A batch member waits for its first stage like any other (a held job starts at `fields`).
          if (batch !== null) await this.enterStage(run, options.stage, []);
          return work(run);
        });
      } catch (err) {
        failure = err;
      }
      // A stall aborts the job, and the generator then ends it its own way (a cancelled result,
      // or a throw): what the lane recorded is the answer, not that.
      if (run.stalled !== null) throw new CrucibleJobStalled(run.jobId, run.stalled);
      if (failure !== null) throw failure;
      return { kind: 'done', server, value: value as T };
    } finally {
      run.clock.stop();
      this.stopTouching(run);
      if (run.batch !== null) {
        // A member leaves; the batch's session and lane go with its LAST member (closeBatch).
        if (run.batch.end(run.jobId)) await this.closeBatch(run.batch);
      } else {
        // The job's session goes with the job (closed unless a standalone action joined it).
        await this.releaseShare(run.share);
      }
      // What the job's own finally did not give back, the lane does, after any give-back already
      // under way (a stall's, a Stop's) has settled.
      await this.jobSweeps.get(run.jobId);
      if (this.deps.ledger.rowsOf(run.jobId).length > 0) {
        await this.sweepJob(run.jobId, `${run.jobId} ended with holds still recorded`);
      }
      this.runs.delete(run.jobId);
      if (run.batch === null) this.release(server, run.jobId);
      settle();
      this.workChanged();
      this.publish();
    }
  }

  /** Stop one job (the row's Stop): abort its fetch and its wait in the line, cancel its Crucible jobs. */
  async stopJob(jobId: string, reason: string): Promise<void> {
    const run = this.runs.get(jobId);
    this.forgetPark(jobId, reason);
    // A planned member that has not started leaves its batch; a running one leaves when its run ends.
    const planned = this.batchOf(jobId);
    if (planned !== null && run === undefined) {
      this.leaveBatch(planned, jobId, reason);
      if (planned.done) await this.closeBatch(planned);
    }
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
   * Give back one job's jobs. Chained per job: a stall's sweep, a Stop's and the job's own end
   * can all ask at once, and each must read the ledger AFTER the one before settled its rows.
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

  // ── the job's session ────────────────────────────────────────────────────

  /**
   * The queue session for work on `server` (session.ts). Inside a lane job on that server it is the
   * JOB's: asked for by its first GPU work (waiting in the server's line, its place on the chip and
   * the job's row), kept for every later piece of the job, and let go of when the job ends (the
   * hold handed out here releases nothing). Anywhere else it is this install's open session on
   * that server, joined, or a new one, held until the caller releases it.
   */
  async sessionOn(server: string, request: SessionRequest): Promise<SessionHold> {
    const run = runStore.getStore();
    if (run === undefined || run.server !== server) return this.deps.sessions.use(server, request);
    const share = run.share;
    if (share.session === null) {
      const lane = this.lane(server);
      const asking = this.deps.sessions.use(server, {
        act: request.act,
        what: `${share.what} (${request.what})`,
        signal: run.controller.signal,
        maxWaitS: JOB_SESSION_MAX_WAIT_S,
        onQueue: (position) => {
          lane.inLine = { jobId: run.jobId, position: position.position, of: position.of };
          log.info(`[crucible] ${run.jobId} is in line on "${server}": ${position.position} of ${position.of}`);
          run.beat();
          this.tellInLine(run.jobId, server, position);
          this.publish();
          request.onQueue?.(position);
        },
      });
      share.session = asking;
      void asking.then(
        (hold) => {
          share.card = hold.card;
          // A batch stage that opened before the session did (every transcript was saved): its floors now.
          if (share.floors !== null) hold.card.setLoadFloors(share.floors.floors, share.floors.stage);
        },
        () => { if (share.session === asking) share.session = null; },
      ).finally(() => {
        if (lane.inLine?.jobId === run.jobId) {
          lane.inLine = null;
          this.tellInLine(run.jobId, server, null);
          this.publish();
        }
      });
    }
    const hold = await share.session;
    return { card: hold.card, release: async () => undefined };
  }

  private tellInLine(jobId: string, server: string, position: QueuePosition | null): void {
    try {
      this.deps.onInLine?.(jobId, server, position);
    } catch (err) {
      log.warn(`[crucible] Could not tell the renderer where ${jobId} stands: ${(err as Error).message}`);
    }
  }

  private async releaseShare(share: SessionShare): Promise<void> {
    const asking = share.session;
    share.session = null;
    share.card = null;
    if (asking === null) return;
    const hold = await asking.catch(() => null);
    if (hold !== null) await hold.release();
  }

  /** A cloud call of `run` started: its open session is touched until the last one ends (session.ts's rule). */
  private startTouching(run: RunState): void {
    run.cloudCalls += 1;
    if (run.cloudCalls > 1 || run.share.card === null) return;
    const card = run.share.card;
    const touch = (): void => {
      if (card.ended !== null) return;
      card.touch().catch((err: unknown) => {
        // Not a failure of the cloud call: if the session is gone, the job's next GPU call says so by name.
        log.warn(`[crucible] ${run.jobId}: could not touch session ${card.id} on "${card.server}": ${err instanceof Error ? err.message : String(err)}`);
      });
    };
    touch();
    run.touchTimer = setInterval(touch, this.touchEveryMs);
    run.touchTimer.unref?.();
  }

  private stopTouching(run: RunState, one = false): void {
    if (one) run.cloudCalls = Math.max(0, run.cloudCalls - 1);
    else run.cloudCalls = 0;
    if (run.cloudCalls === 0 && run.touchTimer !== null) {
      clearInterval(run.touchTimer);
      run.touchTimer = null;
    }
  }

  // ── one model call ───────────────────────────────────────────────────────

  /**
   * Run one model call on its lane: a GPU call takes its server's slot (the
   * job's venue, or the selected server for a standalone call; a job's calls on
   * one model share it, LEDGER #270); a cloud call
   * takes nothing, and inside a job it keeps the job's open session touched
   * while it runs (work on this side is not activity on the server's).
   */
  async aiCall<T>(route: AiCallRoute, name: string, execute: () => Promise<T>): Promise<T> {
    const run = runStore.getStore();
    // A standalone upstream call goes through a Crucible server too (`claude-cli:` does not).
    if (route.lane === 'cloud' && run === undefined && !route.model.startsWith('claude-cli:')) {
      const fresh = this.beforeAdmit();
      if (fresh !== null) await fresh;
    }
    if (route.lane === 'cloud') {
      if (run !== undefined) this.startTouching(run);
      try {
        const value = await stepStore.run(this.hooks('cloud', null, run), execute);
        run?.beat();
        return value;
      } finally {
        if (run !== undefined) this.stopTouching(run, true);
      }
    }
    const server = run?.server ?? this.standaloneServer(name);
    if (run === undefined) {
      await this.gate;
      const fresh = this.beforeAdmit();
      if (fresh !== null) await fresh;
    }
    // A batch member's local call takes the batch's CALL TURN in the stages that have one
    // (batch.ts, LEDGER #270): its cloud calls never do. Its stall clock rests while it waits.
    let turnDone: () => void = () => undefined;
    if (run?.batch) {
      run.clock.pause();
      try {
        turnDone = await run.batch.takeCall(run.jobId, route.model, run.controller.signal);
      } finally {
        run.clock.resume();
      }
    }
    // A job's own calls on one model share the slot (LEDGER #270); a standalone call takes it alone.
    const group = run === undefined ? null : { key: `${run.jobId}\n${route.model}`, cap: JOB_CALLS_PER_SERVER, owner: run.jobId };
    try {
      return await this.lane(server).slot.run(async () => {
        const value = await stepStore.run(this.hooks('gpu', server, run), execute);
        run?.beat();
        return value;
      }, group);
    } finally {
      turnDone();
    }
  }

  /** How many GPU calls are sending on `server` now (a keeper reads it). */
  sendingOn(server: string): number {
    return this.lanes.get(server)?.slot.active ?? 0;
  }

  /**
   * The server a GPU step started now would run on: the current job's venue, else the selected
   * server; or null with the registry's own sentence when nothing is selected. Read by a caller
   * that must refuse by name BEFORE it starts work needing a GPU model its routing row does not
   * name (snap's 9B scorer under a claude -p chapters row, snap-chapters.ts). It chooses nothing.
   */
  gpuVenue(): { server: string } | { server: null; reason: string } {
    const run = runStore.getStore();
    if (run !== undefined) return { server: run.server };
    try {
      return { server: this.deps.servers.selected() };
    } catch (err) {
      return { server: null, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * What `server` offers, read fresh (catalog.ts): the catalog a job's routed options are resolved
   * against at its start (metadata-routing.ts RoutingModels, routing-models.ts). Takes no lane.
   */
  inventoryFor(server: string): Promise<CatalogInventory> {
    return catalogInventory({ clientFor: (name, options) => this.deps.clientFor(name, options) }, server);
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
      routingServer: run?.routingServer ?? null,
      jobId,
      signal: run?.controller.signal ?? null,
      session: (request) => {
        if (lane !== 'gpu' || server === null) {
          return Promise.reject(new Error(`${request.what} asked for a queue session from a ${lane} step; only a GPU step runs in one.`));
        }
        return this.sessionOn(server, request);
      },
      submitted: (row) => { ledger.record({ server: row.server, kind: 'job', id: row.id, jobType: row.jobType, model: row.model, jobId }); },
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
   * Quit: stop admitting, abort every running job, give them {@link QUIT_UNWIND_MS} to let go of
   * their sessions, close every session still open, then sweep the ledger, the whole thing under
   * `deadlineMs` (plan sections 0a, 13.4). Never throws.
   */
  async quit(sweep: (deadlineMs: number) => Promise<SweepReport>, deadlineMs: number = QUIT_SWEEP_DEADLINE_MS, unwindMs: number = QUIT_UNWIND_MS): Promise<SweepReport> {
    const started = this.now();
    this.quitting = true;
    this.stop();
    const running = [...this.runs.values()];
    for (const run of running) run.controller.abort(new Error('ContentStudio is quitting'));
    if (running.length > 0) await this.within(unwindMs, Promise.all(running.map((run) => run.done)));
    await this.within(Math.max(1, deadlineMs - (this.now() - started)), this.deps.sessions.closeAll('ContentStudio is quitting'));
    return sweep(Math.max(1, deadlineMs - (this.now() - started)));
  }

  private async within(ms: number, work: Promise<unknown>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      work.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  // ── the strip ────────────────────────────────────────────────────────────

  view(): CrucibleLanesView {
    const routing = this.deps.servers.routingView();
    return {
      lanes: routing.servers.map((row): LaneChip => {
        const lane = this.lane(row.name);
        const running = lane.holder === null || lane.holder.reserved ? null
          : lane.holder.batch !== undefined ? lane.holder.batch.runningJobId() ?? lane.holder.jobId : lane.holder.jobId;
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
          readAt: lane.readAt,
          // Another client's hold: what a parked job, or our job in the server's line, waits behind.
          holder: !row.paused && (running === null || lane.inLine !== null) ? lane.chip.holder : null,
          inLine: lane.inLine,
        };
      }),
    };
  }

  /** The job ids running now, for a keeper and the quit log. */
  running(): string[] {
    return [...this.runs.keys()];
  }

  /** The park recorded for a job, for a keeper. */
  parkOf(jobId: string): VenuePark | null {
    return this.parks.get(jobId) ?? null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private lane(server: string): Lane {
    let lane = this.lanes.get(server);
    if (lane === undefined) {
      lane = {
        server, holder: null, waiters: [], slot: new Slot(), readAt: null,
        chip: { state: 'unread', resident: null, busyLine: null, unreadReason: null, holder: null },
        holderTrack: null, inLine: null,
      };
      this.lanes.set(server, lane);
    }
    return lane;
  }

  private venueHost(maxAgeMs?: number): VenueHost {
    const servers = this.deps.servers;
    return {
      selected: () => servers.selected(),
      fastServer: () => servers.fastServer(),
      routingServer: () => this.deps.routingServer(),
      isPaused: (server) => servers.routingView().servers.some((row) => row.name === server && row.paused),
      reach: (server) => (maxAgeMs === undefined ? this.deps.reach(server) : this.deps.reach(server, maxAgeMs)),
    };
  }

  /** The fresh check before admission, or null when there is nothing to wait for. */
  private beforeAdmit(): Promise<void> | null {
    const check = this.deps.beforeAdmit?.() ?? null;
    if (check === null) return null;
    return check.then(() => undefined, (err: unknown) => {
      // readiness's freshWithin never rejects; were it to, admission goes on and the door decides.
      log.warn(`[crucible] Could not check Crucible before admitting work: ${(err as Error)?.message ?? err}`);
    });
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
      this.workChanged();
    });
    lane.holder = { jobId, reserved: false, at: this.now() };
  }

  /** A batch member's admission: the lane is its batch's (reserved by the plan, or already running). */
  private claimForBatch(server: string, batch: StageBatch): void {
    const lane = this.lane(server);
    if (lane.holder?.batch !== batch) {
      throw new Error(`${batch.id} does not hold the lane on "${server}" (it holds ${lane.holder?.jobId ?? 'nothing'}); its member cannot be admitted`);
    }
    lane.holder = { ...lane.holder, reserved: false };
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
    // A batch member the renderer never started leaves the batch, so the stages it would block open.
    for (const batch of [...this.batches.values()]) {
      if (this.now() - batch.createdAt <= RESERVATION_MS) continue;
      const dropped = batch.dropUnarrived();
      if (dropped.length > 0) log.warn(`[crucible] ${batch.id}: ${dropped.join(', ')} never started, so ${dropped.length === 1 ? 'it leaves' : 'they leave'} the batch`);
    }
    for (const lane of this.lanes.values()) {
      if (lane.holder?.batch !== undefined) continue;
      if (lane.holder?.reserved && this.now() - lane.holder.at > RESERVATION_MS && !this.runs.has(lane.holder.jobId)) {
        log.warn(`[crucible] the lane on "${lane.server}" was reserved for ${lane.holder.jobId}, which never started; freed`);
        this.release(lane.server, lane.holder.jobId);
      }
    }
  }

  private forgetPark(jobId: string, why: string): void {
    if (this.parks.delete(jobId)) {
      log.info(`[crucible] ${jobId} is no longer parked: ${why}`);
      this.workChanged();
    }
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
