/**
 * THE PENDING-WORK WATCH: a batch member's awaited steps, so a stall names itself (LEDGER #279).
 *
 * WHY. On 2026-10-09 three members of a batch of 4 hung inside the re-roll gate's first checks:
 * each awaited a promise nothing would ever settle (batch.ts `takeCall` had lost it). Nothing was in
 * flight, no timer was armed, the stall clock was paused for the wait, and the rows kept an old
 * "1 video is ahead of it" line for half an hour. The process had to be opened with an inspector to
 * learn even roughly where they stood, and the exact await was never found.
 *
 * WHAT IT IS. Every awaited step of a batch member registers its start and end with a short label
 * ({@link pendingStep}): the stage gates and the call turn (lanes.ts), each model call and its GPU
 * slot (lanes.ts `aiCall`, which every `queueAITask` call goes through, cloud and `claude -p`
 * included), the session's admission (session.ts), the gate's phases, each field's checks and
 * rewrites and the title ranking (reroll/gate.ts), each decide and revise (reroll.service.ts).
 * Steps nest: a decide's own label sits inside its gate phase's.
 *
 * THE CHECK. A timer (unref'd: it never holds the app open) runs every {@link PENDING_CHECK_EVERY_MS}
 * while anything is registered. A member with steps pending and NOTHING MOVED (no step of it started
 * or ended) for longer than {@link PENDING_STALL_MS} is named ONCE per stall, in one warn line: the
 * job, its batch stage, and its pending steps, oldest first, with their ages; the lanes put the same
 * line on the job's row. Movement, not a step's own age, is the clock: an outer step (a gate phase)
 * is old by the time its last check ends, and that is work, not a stall. A member whose wait the
 * batch itself accounts for (it is waiting at a stage gate, or for the call turn, and its row
 * already says why) is not named: waiting for another video is not a stall. When a named member
 * moves again, its row gets its batch line back.
 *
 * IT ONLY WATCHES. Nothing here cancels, retries or times anything out (NO FALLBACKS: a stall is
 * said, by name, and the job's own failure paths stay what they were). Outside a batch member every
 * call here does nothing but run the step.
 *
 * PURE: no Crucible, no electron, no log. The lanes own the registry and say what it finds.
 */
import { AsyncLocalStorage } from 'async_hooks';

/** A member with steps pending and none started or ended this long is named (the live hang sat silent 30 minutes). */
export const PENDING_STALL_MS = 90_000;
/** How often the registry looks while anything is pending. */
export const PENDING_CHECK_EVERY_MS = 15_000;

/** What the registry says about one stalled member. */
export interface PendingStall {
  jobId: string;
  /** The batch stage it is in, or null before its first. */
  stage: string | null;
  /** Its pending steps, oldest first, with how long each has been pending. */
  steps: Array<{ label: string; ms: number }>;
  /** The sentence for the log and the row. */
  line: string;
}

export interface PendingWorkDeps {
  limitMs?: number;
  everyMs?: number;
  now?: () => number;
  /** A member found stalled (once per stall: it is named again only after it moved). */
  onStall(stall: PendingStall): void;
  /** A member that was named moved again: its row may say what it does now. */
  onClear?(jobId: string): void;
  /** True when the member's wait is one its batch accounts for (it is not named then). */
  explained?(jobId: string): boolean;
}

interface Step {
  readonly label: string;
  readonly since: number;
}

interface Watched {
  stage: string | null;
  readonly steps: Set<Step>;
  /** When a step of it last started or ended. */
  movedAt: number;
  /** Named since it last moved. */
  told: boolean;
}

/** One registry of pending steps per lanes instance (lanes.ts). */
export class PendingWork {
  private readonly jobs = new Map<string, Watched>();
  private timer: NodeJS.Timeout | null = null;
  private readonly limitMs: number;
  private readonly everyMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: PendingWorkDeps) {
    this.limitMs = deps.limitMs ?? PENDING_STALL_MS;
    this.everyMs = deps.everyMs ?? PENDING_CHECK_EVERY_MS;
    this.now = deps.now ?? Date.now;
  }

  /** A step of `jobId` began; the answer ends it (once; it never throws). */
  start(jobId: string, label: string): () => void {
    const watched = this.watched(jobId);
    const step: Step = { label, since: this.now() };
    watched.steps.add(step);
    this.moved(jobId, watched);
    this.arm();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      watched.steps.delete(step);
      if (this.jobs.get(jobId) === watched) this.moved(jobId, watched);
      if (this.size() === 0) this.disarm();
    };
  }

  /** The batch stage `jobId` is in now (named in its stall line). */
  setStage(jobId: string, stage: string): void {
    this.watched(jobId).stage = stage;
  }

  /** `jobId`'s pending steps, oldest first, with their ages (a keeper and the quit log read it). */
  pendingOf(jobId: string): Array<{ label: string; ms: number }> {
    const watched = this.jobs.get(jobId);
    if (watched === undefined) return [];
    const now = this.now();
    return [...watched.steps].sort((a, b) => a.since - b.since).map((s) => ({ label: s.label, ms: now - s.since }));
  }

  /** The member ended: whatever it left registered is dropped. */
  forget(jobId: string): void {
    this.jobs.delete(jobId);
    if (this.size() === 0) this.disarm();
  }

  /** Look now (the timer's tick; a keeper may call it). */
  check(): void {
    const now = this.now();
    for (const [jobId, watched] of this.jobs) {
      const still = now - watched.movedAt;
      if (watched.told || watched.steps.size === 0 || still <= this.limitMs || this.deps.explained?.(jobId) === true) continue;
      watched.told = true;
      const steps = this.pendingOf(jobId);
      this.deps.onStall({ jobId, stage: watched.stage, steps, line: stallLine(still, steps) });
    }
  }

  /** The timer goes (the lanes stop). */
  stop(): void {
    this.disarm();
    this.jobs.clear();
  }

  private watched(jobId: string): Watched {
    let watched = this.jobs.get(jobId);
    if (watched === undefined) {
      watched = { stage: null, steps: new Set(), movedAt: this.now(), told: false };
      this.jobs.set(jobId, watched);
    }
    return watched;
  }

  private moved(jobId: string, watched: Watched): void {
    watched.movedAt = this.now();
    if (!watched.told) return;
    watched.told = false;
    this.deps.onClear?.(jobId);
  }

  private size(): number {
    let n = 0;
    for (const w of this.jobs.values()) n += w.steps.size;
    return n;
  }

  private arm(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.check(), this.everyMs);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/** The row's and the log's sentence: the oldest steps (the outer ones) and the newest (where it sits). */
function stallLine(stillMs: number, steps: ReadonlyArray<{ label: string; ms: number }>): string {
  const said = (s: { label: string; ms: number }) => `${s.label} (${Math.round(s.ms / 1000)} s)`;
  const shown = steps.length <= 4 ? steps.map(said) : [...steps.slice(0, 2).map(said), `${steps.length - 4} more`, ...steps.slice(-2).map(said)];
  return `Nothing has moved for ${Math.round(stillMs / 1000)} s. Still waiting on: ${shown.join('; ')}.`;
}

// ── the current member's scope ──────────────────────────────────────────────

const scope = new AsyncLocalStorage<{ registry: PendingWork; jobId: string }>();

/** Run a batch member's work with its steps registered on `registry` (lanes.ts `runJob`). */
export function withPendingScope<T>(registry: PendingWork, jobId: string, fn: () => T): T {
  return scope.run({ registry, jobId }, fn);
}

/** Register one step of the current batch member (nothing outside one); the answer ends it. */
export function pendingStart(label: string): () => void {
  const current = scope.getStore();
  return current === undefined ? () => undefined : current.registry.start(current.jobId, label);
}

/** Await `fn` as one registered step of the current batch member (see the header). */
export async function pendingStep<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const end = pendingStart(label);
  try {
    return await fn();
  } finally {
    end();
  }
}
