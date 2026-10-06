/**
 * STAGE-MAJOR BATCHES: several queue jobs bound for one Crucible server, run stage by stage under
 * ONE queue session, so each model loads once per batch instead of once per job (LEDGER #266).
 *
 * THE WASTE THIS REMOVES (Owen's logs, 2026-10-03/04, six videos on the Mac). Every job opened a
 * session, loaded qwen3-asr-1.7b + the aligner (10-20 s), transcribed, loaded the 9B for the
 * chapter outline and assign (15-30 s), loaded the 27B for the chapter titles and the fields
 * (40 s - 3 min, at a context that grew 8K -> 32K job to job), closed the session (the card is
 * settled), and the next job ~10 s later loaded all three again: 18 loads for 6 videos. Keeping
 * the session open across jobs alone does not help, because every job alternates ASR -> 9B -> 27B.
 *
 * WHAT A STAGE IS. A stretch of a job's pipeline whose GPU work runs on ONE model (or, for the
 * gate's rewrites, on the field rows' own models), in pipeline order ({@link BATCH_STAGES}):
 *
 *   transcribe      the asr job (qwen3-asr + the aligner); a saved transcript is CPU only
 *   chapters        snap's BOUNDARIES on the scorer (the 9B): outline, assign, the ad checks,
 *                   level 2 (chaptering `summarize: false`; the titles are not written here)
 *   fields          everything on the routed writing models (the 27B by default): the channel
 *                   lessons, the chapter titles (chaptering/titles.ts over the stored boundaries),
 *                   the field calls, the scrub; a compilation's summaries and packaging; the
 *                   whole-transcript chapter engine, which runs on the chapters row
 *   gate-check-N    the re-roll gate's rule checks and the title ranking (the 9B scorer), round N
 *   gate-revise-N   the gate's rewrites of what failed, on each field's own routed model
 *   finish          the thumbnails' words (the titles row) and the save
 *
 * A job enters its stages in that order and may skip any (a held "Send to AI" job starts at
 * `fields`; a job whose gate passed everything skips every revise and later check; with the gate
 * off nobody enters a gate stage and the thumbnails are written inside `fields`). A stage is a
 * NAME, not a model: which models a stage loads is whatever the routing binds, and the load
 * floors below are keyed by the model each job STATES it will use there.
 *
 * HOW THE PIPELINE IS SPLIT: IT IS NOT. Every job still runs its own pipeline end to end in its
 * own `generate-metadata` (or `send-held-prompt`) call, in its own async context, with its own
 * progress events, result, report and Stop. The pipeline only ANNOUNCES where it is: at each
 * stage boundary it awaits `enterJobStage(stage, needs)` (lanes.ts), which for a batch member
 * waits at the TURNSTILE below and for a single job only records the stage (setJobStage, the
 * resume machinery the lanes already had). Everything a job carries from one stage to the next
 * (its transcript, its stored chapter boundaries, its half-written item) lives where it always
 * did: in that job's own call frame, between two awaits. Nothing is serialized, nothing is
 * resumed from disk, and the generator gained no second entry point.
 *
 * THE TURNSTILE (this class). One job holds the batch's TURN at a time (the server runs one job
 * at a time, as it always did: "one live job on the Mac's Crucible at a time"). Stage S OPENS when
 * every live member has reached S or a later stage (or ended): nobody is still doing an earlier
 * stage's GPU work. Inside an open stage the turn goes to the waiting member at the lowest stage,
 * in plan order. A member's turn lasts from the gate that admitted it to its next gate, or to
 * `finishJobStage()` (CPU work after a stage — the thumbnails' frame sampling after transcription
 * — runs outside any turn, beside the next member's GPU work), or to its end.
 *
 * ONE SESSION FOR THE BATCH (lanes.ts `SessionShare`). The batch's first GPU work asks for the
 * queue session, every member's later work runs inside it (Crucible matches membership on our
 * client name, LEDGER #255), and it closes when the last member ends. The cloud-call touch rule
 * is the member's own (lanes.ts `startTouching`), on the shared session.
 *
 * THE LOAD FLOORS (LEDGER #209 kept, at the batch's grain). Each member states, at each gate, the
 * load context its stage work needs per model (`StageNeed`: the scorer's largest decide or outline
 * state, computed exactly from the transcript; the writing model's largest title, field and scrub
 * call, estimated by stage-needs.ts with every constant's source stated). When a stage opens, the
 * largest need per model across the members is set as that model's FLOOR on the batch's session
 * (session.ts `CardSession.setLoadFloors`): the first load of the stage happens at the batch's
 * largest context, so a later job that needs more does not reload it. A call that still needs more
 * than its floor grows the load once, as before, and that growth is logged as a short floor.
 *
 * WHO JOINS (decided here, LEDGER #266). A batch is formed by the queue plan (lanes.ts `plan`)
 * from every startable row bound for a free server at that moment, in queue order, when there are
 * two or more; one row runs exactly as before (no batch, no turnstile, no floors). A row added
 * while a batch runs WAITS FOR THE NEXT BATCH: the lane is the batch's until its last member ends,
 * and the plan says so on the row. Joining at a stage boundary was not chosen: a late job would
 * have to transcribe while the others hold the 9B or the 27B, which is the alternation this
 * removes, and its arrival would move every later stage's floor after that stage had opened.
 *
 * FAILURE AND STOP. A member that fails or is stopped ENDS: it leaves the batch, its turn (if it
 * held one) passes on, and a stage that was waiting only for it opens. A Stop while it waits at a
 * gate rejects the wait with the Stop's reason (the job ends cancelled, the rest carry on). A
 * member the renderer never started within RESERVATION_MS is dropped by the plan's reservation
 * expiry, said in the log. A session the server ends under the batch fails each member's next
 * call by name (`session_closed`), as it failed a single job's: nothing reopens a session and
 * carries on (NO FALLBACKS).
 *
 * PURE: no Crucible, no electron. lanes.ts owns the batch's lane, session and stall clocks;
 * tools/test-crucible-batch.js drives the whole thing against the fake.
 */

/** The stages a batch runs, in order. A job enters a subset of them, in this order. */
export const BATCH_STAGES = [
  'transcribe',
  'chapters',
  'fields',
  'gate-check-0',
  'gate-revise-1',
  'gate-check-1',
  'gate-revise-2',
  'gate-check-2',
  'gate-revise-3',
  'gate-check-3',
  'finish',
] as const;

export type BatchStage = (typeof BATCH_STAGES)[number];

/** The re-roll gate's rounds the stage list has room for (reroll/settings.ts REROLL_CAP must not exceed it). */
export const GATE_ROUNDS = 3;

/** The batch stage of one gate phase (reroll/gate.ts `GatePhase`: `check-N` / `revise-N`). */
export function gateStage(phase: string): BatchStage {
  const stage = `gate-${phase}`;
  if (!(BATCH_STAGES as readonly string[]).includes(stage)) {
    throw new Error(`the re-roll gate announced the phase "${phase}", which no batch stage holds (gate-check-0..${GATE_ROUNDS}, gate-revise-1..${GATE_ROUNDS})`);
  }
  return stage as BatchStage;
}

export function stageIndex(stage: BatchStage): number {
  const i = BATCH_STAGES.indexOf(stage);
  if (i < 0) throw new Error(`"${String(stage)}" is not a batch stage (${BATCH_STAGES.join(', ')})`);
  return i;
}

/**
 * The stage in plain words, for a row and the log: what the job DOES in it, as a verb phrase
 * ("checking the titles, description and tags"). No pipeline names: Owen, 2026-10-06, of
 * "Waiting for the batch's the re-roll gate's checks …": "this doesnt really make sense".
 */
export function stageWords(stage: BatchStage): string {
  switch (stage) {
    case 'transcribe': return 'transcribing';
    case 'chapters': return 'finding chapters';
    case 'fields': return 'writing titles, description and tags';
    case 'finish': return 'writing thumbnail words and saving';
    default: {
      const [, kind, round] = /^gate-(check|revise)-(\d)$/.exec(stage)!;
      if (kind === 'check') return round === '0' ? 'checking the titles, description and tags' : `checking the rewrites (round ${round})`;
      return `rewriting the weak ones (round ${round})`;
    }
  }
}

/** What one job's work in one stage needs of one model's load (a load floor's input). */
export interface StageNeed {
  /** The Crucible model id the work will load (as the routing bound it on this server). */
  model: string;
  /** The load context, a multiple of the 8,192 step (context-check.ts `loadContextFor`). */
  tokens: number;
  /** Which call needs it, for the log: "the scorer's largest decide state (9,812 tokens)". */
  why: string;
}

/** One model's floor for a stage: the largest need across the members, and whose it was. */
export interface LoadFloor {
  tokens: number;
  jobId: string;
  why: string;
}

type MemberState = 'unarrived' | 'waiting' | 'turn' | 'between' | 'ended';

interface Member {
  readonly jobId: string;
  readonly order: number;
  /** The stage it is in or waiting for; -1 before it entered any. */
  at: number;
  state: MemberState;
  waiter: { resolve: () => void; reject: (err: unknown) => void; cleanup: () => void } | null;
  needs: Map<number, StageNeed[]>;
  line: string | null;
}

export interface StageBatchDeps {
  /** A member's waiting line (null once its turn came): its row says it (ipc: a `waiting` progress line). */
  onWait?(jobId: string, line: string | null): void;
  /** A stage opened: set its floors on the batch's session. */
  onStageOpen?(stage: BatchStage, floors: ReadonlyMap<string, LoadFloor>): void;
  /** The turn moved (or the batch ended): the lanes strip follows it. */
  onTurn?(): void;
  /** The last member ended. Called once. */
  onDone?(): void;
}

/** The turnstile of one batch on one server. */
export class StageBatch {
  private readonly members: Member[];
  private highestOpened = -1;
  private doneCalled = false;
  readonly createdAt: number;

  constructor(
    readonly id: string,
    readonly server: string,
    jobIds: readonly string[],
    private readonly deps: StageBatchDeps = {},
    now: number = Date.now(),
  ) {
    if (jobIds.length < 2) throw new Error(`a batch is two or more jobs; ${id} was given ${jobIds.length}`);
    if (new Set(jobIds).size !== jobIds.length) throw new Error(`${id} names a job twice: ${jobIds.join(', ')}`);
    this.members = jobIds.map((jobId, order) => ({ jobId, order, at: -1, state: 'unarrived', waiter: null, needs: new Map(), line: null }));
    this.createdAt = now;
  }

  /** Every job the batch was planned with, in plan order. */
  get jobIds(): string[] {
    return this.members.map((m) => m.jobId);
  }

  get size(): number {
    return this.members.length;
  }

  /** A member that has not ended. */
  has(jobId: string): boolean {
    const m = this.member(jobId);
    return m !== null && m.state !== 'ended';
  }

  get done(): boolean {
    return this.members.every((m) => m.state === 'ended');
  }

  /** The job holding the turn, else the first live member that has arrived, else null (for the lanes strip). */
  runningJobId(): string | null {
    const turn = this.members.find((m) => m.state === 'turn');
    if (turn) return turn.jobId;
    return this.members.find((m) => m.state !== 'ended' && m.state !== 'unarrived')?.jobId ?? null;
  }

  /** Where each member is, for a keeper and the log. */
  view(): Array<{ jobId: string; stage: BatchStage | null; state: MemberState }> {
    return this.members.map((m) => ({ jobId: m.jobId, stage: m.at < 0 ? null : BATCH_STAGES[m.at], state: m.state }));
  }

  /** The member's lane admission: it has arrived (its first `enter` follows). */
  arrive(jobId: string): void {
    const m = this.live(jobId, 'arrive');
    if (m.state === 'unarrived') m.state = 'between';
  }

  /**
   * The member is at `stage`'s gate: finish its current turn, state its needs there, and wait until
   * the stage is open and the turn is its own. A stage at or behind the member's own is a no-op (it
   * is already past that gate: a held job that starts at `fields` meets the pipeline's `chapters`
   * gate). Rejects with the signal's reason when the job is stopped while it waits.
   */
  enter(jobId: string, stage: BatchStage, options: { signal?: AbortSignal; needs?: readonly StageNeed[] } = {}): Promise<void> {
    const m = this.live(jobId, `enter ${stage}`);
    const target = stageIndex(stage);
    if (m.state === 'unarrived') m.state = 'between';
    if (target <= m.at) return Promise.resolve();
    if (m.state === 'waiting') throw new Error(`${jobId} entered ${stage} while already waiting at ${BATCH_STAGES[m.at]}`);
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal, jobId));
    m.at = target;
    m.needs.set(target, [...(options.needs ?? [])]);
    m.state = 'waiting';
    const waiting = new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        if (m.waiter === null) return;
        m.waiter = null;
        if (m.state === 'waiting') m.state = 'between';
        reject(abortReason(signal!, jobId));
        this.pump();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      m.waiter = { resolve, reject, cleanup: () => signal?.removeEventListener('abort', onAbort) };
    });
    this.pump();
    return waiting;
  }

  /** The member's GPU work for its current stage is done; its next work is CPU until its next gate. */
  finishTurn(jobId: string): void {
    const m = this.member(jobId);
    if (m === null || m.state !== 'turn') return;
    m.state = 'between';
    this.pump();
  }

  /**
   * The member ended (done, failed, stopped, parked, never started). Answers true when the batch is
   * now empty. A member that ends twice is a no-op.
   */
  end(jobId: string): boolean {
    const m = this.member(jobId);
    if (m === null || m.state === 'ended') return this.done;
    m.waiter?.cleanup();
    m.waiter = null;
    m.state = 'ended';
    this.say(m, null);
    this.pump();
    return this.done;
  }

  /** Members the renderer never started (the plan's reservation ran out): they leave. Answers who. */
  dropUnarrived(): string[] {
    const dropped = this.members.filter((m) => m.state === 'unarrived').map((m) => m.jobId);
    for (const jobId of dropped) this.end(jobId);
    return dropped;
  }

  // ── the turnstile ────────────────────────────────────────────────────────

  /** A live member's position for the open rule: the stage it is in or waits for, else 0 (it will enter at 0 or later). */
  private pos(m: Member): number {
    return m.at < 0 ? 0 : m.at;
  }

  private isOpen(stage: number): boolean {
    return this.members.every((m) => m.state === 'ended' || this.pos(m) >= stage);
  }

  private pump(): void {
    const live = this.members.filter((m) => m.state !== 'ended');
    if (live.length === 0) {
      if (!this.doneCalled) {
        this.doneCalled = true;
        this.deps.onTurn?.();
        this.deps.onDone?.();
      }
      return;
    }
    // Stages that just opened: their floors, from the needs the members stated at those gates.
    for (let s = this.highestOpened + 1; s < BATCH_STAGES.length && this.isOpen(s); s++) {
      this.highestOpened = s;
      if (live.some((m) => m.at === s)) this.deps.onStageOpen?.(BATCH_STAGES[s], this.floorsOf(s));
    }
    const holder = live.find((m) => m.state === 'turn');
    if (holder === undefined) {
      const next = live
        .filter((m) => m.state === 'waiting' && this.isOpen(m.at))
        .sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (next !== undefined) {
        const waiter = next.waiter!;
        next.waiter = null;
        next.state = 'turn';
        waiter.cleanup();
        this.say(next, null);
        waiter.resolve();
        this.deps.onTurn?.();
      }
    }
    for (const m of live) if (m.state === 'waiting') this.say(m, this.waitLine(m, live));
  }

  private floorsOf(stage: number): Map<string, LoadFloor> {
    const floors = new Map<string, LoadFloor>();
    for (const m of this.members) {
      if (m.state === 'ended') continue;
      for (const need of m.needs.get(stage) ?? []) {
        const known = floors.get(need.model);
        if (known === undefined || need.tokens > known.tokens) floors.set(need.model, { tokens: need.tokens, jobId: m.jobId, why: need.why });
      }
    }
    return floors;
  }

  private waitLine(m: Member, live: Member[]): string {
    const next = stageWords(BATCH_STAGES[m.at]);
    const videos = (n: number) => (n === 1 ? '1 other video' : `${n} other videos`);
    if (!this.isOpen(m.at)) {
      // This stage starts for the whole batch at once, when every video has caught up.
      const behind = live.filter((o) => o !== m && this.pos(o) < m.at);
      const lowest = Math.min(...behind.map((o) => this.pos(o)));
      const why = behind.every((o) => o.at < 0)
        ? `${videos(behind.length)} in this batch of ${this.members.length} ${behind.length === 1 ? 'has' : 'have'} not started yet`
        : `${videos(behind.length)} in this batch of ${this.members.length} ${behind.length === 1 ? 'is' : 'are'} still ${stageWords(BATCH_STAGES[lowest])}`;
      return `Next: ${next}. Waiting because ${why}.`;
    }
    const ahead = live.filter((o) => o !== m && (o.state === 'turn' || (o.state === 'waiting' && this.isOpen(o.at) && (o.at < m.at || (o.at === m.at && o.order < m.order))))).length;
    return `Next: ${next}. ${ahead === 1 ? '1 video is' : `${ahead} videos are`} ahead of it on ${this.server}.`;
  }


  private say(m: Member, line: string | null): void {
    if (m.line === line) return;
    m.line = line;
    this.deps.onWait?.(m.jobId, line);
  }

  private member(jobId: string): Member | null {
    return this.members.find((m) => m.jobId === jobId) ?? null;
  }

  private live(jobId: string, what: string): Member {
    const m = this.member(jobId);
    if (m === null) throw new Error(`${jobId} is not in ${this.id} (${what})`);
    if (m.state === 'ended') throw new Error(`${jobId} already left ${this.id} (${what})`);
    return m;
  }
}

function abortReason(signal: AbortSignal, jobId: string): unknown {
  return signal.reason instanceof Error ? signal.reason : new Error(`${jobId} was stopped while it waited for its batch's next stage`);
}
