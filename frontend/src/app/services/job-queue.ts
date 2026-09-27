import { Injectable, signal, effect, inject } from '@angular/core';
import { CrucibleService } from './crucible';
import { InputItem } from './inputs-state';
import { ChapterPick, migrateChapterPick } from './chapter-pick';
import type { ResumeStage } from '../features/crucible/crucible.types';

export type ItemStatus = 'pending' | 'transcribing' | 'transcribed' | 'generating' | 'completed' | 'failed';

export interface ItemProgress {
  status: ItemStatus;
  progress: number;
}

export interface QueuedJob {
  id: string;
  name: string;
  inputs: InputItem[];
  promptSet: string; // ID of the prompt set to use
  mode: 'individual' | 'compilation';
  /** What the chapter pipeline detects for this job — stamped at queue time (LEDGER #213). */
  chapterGrain: ChapterPick;
  // 'held' = transcribed and the prompt is assembled, waiting for the user to send
  // it to the AI (the "Transcribe only" two-stage flow). The backend holds the
  // transcript so sending reuses it without re-transcribing.
  // 'parked' = its Crucible server is busy, paused or not there, and it WAITS for that
  // server (LEDGER #205: never moved to another). It starts again by itself when main's
  // preflight says the holder has gone (CRUCIBLE-MIGRATION-PLAN.md section 13.2).
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'held' | 'parked';
  /**
   * Pinned "fast": runs on the fast server (Settings › Crucible Servers), and only there.
   * The pin is the only way work reaches the PC (LEDGER #195, #205).
   */
  fast: boolean;
  /** The server this job ran on, or waits for; null before it was first placed. */
  venue?: string | null;
  /** Why it is parked, in the holder's words ("GPU busy: foundry, tts 62% done"). */
  parkedLine?: string;
  /** Where it picks up when it runs again: a parked job skips what it already did. */
  resumeFrom?: ResumeStage;
  /** Parked while being SENT from 'held': main still holds its transcript, so it resumes by sending. */
  resumeHeld?: boolean;
  /** Parked from a "Transcribe only" run: it resumes as one, stopping with the prompt held. */
  resumeShowPrompt?: boolean;
  createdAt: Date;
  completedAt?: Date;
  progress: number;
  currentlyProcessing: string;
  error?: string;
  outputFiles?: string[];
  processingTime?: number;
  heldPrompt?: string; // Assembled prompt captured when the job reaches 'held' (view-only)
  itemProgress: ItemProgress[]; // Track progress for each individual item
  currentItemIndex: number; // Index of the currently processing item
  /** When this run of the job started (ms), for the row's ticking clock. Set while it runs. */
  startedAt?: number;
  /** What the running job is doing now, in plain words (job-activity.ts `stageLine`). */
  activity?: string;
  /** Why a row that is not parked has not started yet (another job is on its server). */
  waitingLine?: string;
}

const STORAGE_KEY = 'contentstudio-jobs';
/** A job still in the queue: not finished. Only while one exists does ContentStudio poll Crucible (LEDGER #234). */
const UNFINISHED: ReadonlySet<QueuedJob['status']> = new Set(['pending', 'processing', 'held', 'parked']);
/** The queue run ({ started, target }), kept beside the jobs so a reloaded window keeps it. */
const RUN_STORAGE_KEY = 'contentstudio-queue-run';

@Injectable({
  providedIn: 'root'
})
export class JobQueueService {
  jobs = signal<QueuedJob[]>([]);
  isProcessing = signal(false);
  /**
   * The queue run is on: Start was pressed and not everything has finished. Held HERE, not on
   * the Inputs page, because the page is destroyed whenever Owen looks at another tab while
   * the queue keeps running. A page made again reads this and takes the run back over (its
   * 1 s tick), instead of showing no Start button and never starting what is waiting.
   */
  queueStarted = signal(false);
  /** The run's target, locked at the Start press: 'pending' jobs, or the 'held' ones to send. */
  runTargetSignal = signal<'pending' | 'held'>('pending');
  get runTarget(): 'pending' | 'held' { return this.runTargetSignal(); }
  set runTarget(target: 'pending' | 'held') { this.runTargetSignal.set(target); }
  /** A plan is being asked for. Shared, so two page instances can never start one job twice. */
  planning = false;
  private readonly crucible = inject(CrucibleService);
  /** The unfinished count main last heard from this window. */
  private reportedCount: number | null = null;

  constructor() {
    // Load persisted jobs from localStorage
    this.loadFromStorage();

    // Auto-save when jobs change
    effect(() => {
      const jobs = this.jobs();
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
    });
    // And the run: a window reloaded mid-run (⌘R) goes on running the queue it was running.
    effect(() => {
      sessionStorage.setItem(RUN_STORAGE_KEY, JSON.stringify({ started: this.queueStarted(), target: this.runTargetSignal() }));
    });
    // THE POLLING RULE's input (LEDGER #234; Owen, 2026-09-26: "it wont poll unless something is
    // in the queue"): main checks Crucible on a timer only while some window's queue holds an
    // unfinished job, so this window says how many it holds whenever that number changes.
    effect(() => {
      const count = this.jobs().filter(job => UNFINISHED.has(job.status)).length;
      if (count === this.reportedCount) return;
      this.reportedCount = count;
      this.crucible.queueCount(count).catch((err: unknown) => {
        this.reportedCount = null;
        console.warn('[JobQueue] Could not tell main how many jobs are queued, so its Crucible checks may not follow the queue:', (err as Error).message);
      });
    });
  }

  private loadFromStorage() {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const jobs = JSON.parse(stored) as QueuedJob[];
        // Convert date strings back to Date objects and reset processing jobs to pending
        const restoredJobs = jobs.map(job => ({
          ...job,
          createdAt: new Date(job.createdAt),
          completedAt: job.completedAt ? new Date(job.completedAt) : undefined,
          // Reset interrupted 'processing' jobs to pending. Also reset 'held' jobs:
          // their transcript lived only in the (now-restarted) main process, so the
          // prompt can't be sent anymore — they must be re-transcribed.
          // A row saved before the pick existed was the old default, broad: chapters (#213).
          chapterGrain: migrateChapterPick(job.chapterGrain ?? 'broad', `queued job "${job.name}"`),
          // A row saved before the fast pin existed was never pinned.
          fast: job.fast ?? false,
          status: (job.status === 'processing' || job.status === 'held') ? 'pending' as const : job.status,
          currentlyProcessing: (job.status === 'processing' || job.status === 'held') ? '' : job.currentlyProcessing,
          // A row that was running starts its items over: either it runs again from the top, or
          // main is still running it and the Inputs page takes it back (adoptRunningJobs), where
          // the next event sets each item. A half-run "Transcribed" left on a pending row is the
          // screen Owen read as "nothing is happening" (2026-09-26, LEDGER #225).
          itemProgress: job.status === 'processing'
            ? job.itemProgress.map(() => ({ status: 'pending' as const, progress: 0 }))
            : job.itemProgress,
          progress: job.status === 'processing' ? 0 : job.progress,
          activity: undefined,
          startedAt: undefined,
          waitingLine: undefined,
          heldPrompt: job.status === 'held' ? undefined : job.heldPrompt
        }));
        this.jobs.set(restoredJobs);
      }
      const run = sessionStorage.getItem(RUN_STORAGE_KEY);
      if (run) {
        const parsed = JSON.parse(run) as { started?: unknown; target?: unknown };
        if (parsed.started === true) this.queueStarted.set(true);
        if (parsed.target === 'pending' || parsed.target === 'held') this.runTargetSignal.set(parsed.target);
        // isProcessing follows the run; a job still running in main sets it again when adopted.
        if (parsed.started === true) this.isProcessing.set(true);
      }
    } catch (error) {
      console.error('Failed to load jobs from storage:', error);
    }
  }

  addJob(name: string, inputs: InputItem[], promptSet: string, mode: 'individual' | 'compilation', chapterGrain: ChapterPick, fast: boolean): string {
    const jobId = `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newJob: QueuedJob = {
      id: jobId,
      name,
      inputs: [...inputs], // Clone the inputs array
      promptSet,
      mode,
      chapterGrain,
      fast,
      status: 'pending',
      createdAt: new Date(),
      progress: 0,
      currentlyProcessing: '',
      itemProgress: inputs.map(() => ({ status: 'pending', progress: 0 })),
      currentItemIndex: -1
    };

    this.jobs.update(jobs => [...jobs, newJob]);
    return jobId;
  }

  removeJob(jobId: string) {
    this.jobs.update(jobs => jobs.filter(job => job.id !== jobId));
  }

  clearCompletedJobs() {
    this.jobs.update(jobs => jobs.filter(job =>
      job.status !== 'completed' && job.status !== 'failed'
    ));

    // If there are no jobs left or no processing jobs, reset the processing flag
    if (this.jobs().length === 0 || !this.hasProcessingJob()) {
      this.isProcessing.set(false);
    }
  }

  updateJob(jobId: string, updates: Partial<QueuedJob>) {
    this.jobs.update(jobs =>
      jobs.map(job => job.id === jobId ? { ...job, ...updates } : job)
    );
  }

  getJob(jobId: string): QueuedJob | undefined {
    return this.jobs().find(job => job.id === jobId);
  }

  getPendingJobs(): QueuedJob[] {
    return this.jobs().filter(job => job.status === 'pending');
  }

  getNextPendingJob(): QueuedJob | undefined {
    return this.jobs().find(job => job.status === 'pending');
  }

  getHeldJobs(): QueuedJob[] {
    return this.jobs().filter(job => job.status === 'held');
  }

  /** Rows the queue may start (in order): the run's target status, and every parked row. */
  getStartableJobs(target: 'pending' | 'held'): QueuedJob[] {
    return this.jobs().filter(job => job.status === target || job.status === 'parked');
  }

  hasParkedJob(): boolean {
    return this.jobs().some(job => job.status === 'parked');
  }

  getNextHeldJob(): QueuedJob | undefined {
    return this.jobs().find(job => job.status === 'held');
  }

  hasProcessingJob(): boolean {
    return this.jobs().some(job => job.status === 'processing');
  }

  updateItemProgress(jobId: string, itemIndex: number, progress: number, status: ItemStatus) {
    this.jobs.update(jobs =>
      jobs.map(job => {
        if (job.id === jobId && job.itemProgress[itemIndex]) {
          const newItemProgress = [...job.itemProgress];
          newItemProgress[itemIndex] = { status, progress };
          // Update currentItemIndex for any active processing status
          const isActiveStatus = status === 'transcribing' || status === 'generating';
          return {
            ...job,
            itemProgress: newItemProgress,
            currentItemIndex: isActiveStatus ? itemIndex : job.currentItemIndex
          };
        }
        return job;
      })
    );
  }
}
