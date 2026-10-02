/**
 * WHO IS ON THE SERVER, AND ABOUT HOW LONG: the queue's "waiting its turn" row (LEDGER #234), and
 * the lanes strip's busy line.
 *
 * Owen, 2026-09-26: "if theres a job running on the crucible server and we cant run anything
 * until its finished, ill hit the start queue button and itll show the job that's currently
 * running on crucible and how long it has until it's done at the bottom of the queue ... if
 * something else takes the lease first, it fills in that slot with the new running job it's
 * waiting to finish".
 *
 * Pure. Since Crucible 1.0.76 (LEDGER #255) the lanes FOLLOW each server's event stream
 * (`GET /v1/events`, server-watch.ts) instead of reading `/v1/activity` every 15 s: the stream's
 * snapshot is read into a {@link CardView} ({@link cardViewOf}) and each later event moves it
 * ({@link applyServerEvent}). The lanes keep the track between views and put the answer on the
 * lane chip; the renderer words it (job-activity.ts `holderWaitLine`).
 *
 * WHAT HOLDS A SERVER NOW: another client's job on the lane, or another client's open QUEUE
 * SESSION (while it is open nothing else runs; a TTS stream runs inside one). Leases are gone from
 * Crucible. (The engine claim a one-shot read still reports is the probe's to say, probe.ts
 * `busyLineOf`; the stream does not move it, so the strip does not show it.)
 *
 * TIME LEFT. Crucible states no finish time for a job. So it is measured: the progress moved
 * between this app's first sight of the SAME hold and its latest, on this app's own clock. Until
 * two readings show it moving it is `measuring`; a hold with no progress at all (a session
 * between its items) is `no-progress`. Never a guessed number.
 */
import type { Activity, ServerEvent } from '@crucible/client';
import { CRUCIBLE_CLIENT_NAME, isOurClient } from './client-factory';
import type { CardHolder } from './wire';

/** One job on the server's lane, as the stream last said it. */
export interface CardJob {
  readonly jobId: string;
  readonly type: string;
  readonly model: string | null;
  readonly client: string | null;
  /** 0..1, or null before the server said any. */
  readonly progress: number | null;
}

/** What a server is doing, as far as the lanes strip shows it. */
export interface CardView {
  /** The resident model (or voice, or separator) id, or null. */
  readonly resident: string | null;
  /** The jobs on the lane. */
  readonly running: readonly CardJob[];
  /** The open queue session, or null. */
  readonly session: { readonly id: string; readonly client: string | null; readonly act: string; readonly model: string | null } | null;
}

/** A snapshot's `/v1/activity`, or a one-shot read of it, as a view. */
export function cardViewOf(activity: Activity): CardView {
  // `!= null`: a server before 1.0.76 sends no `session` at all.
  const open = activity.session != null && activity.session.status === 'open' ? activity.session : null;
  return {
    resident: activity.resident?.id ?? null,
    running: activity.running.map((job) => ({ jobId: job.jobId, type: job.type, model: job.model, client: job.client, progress: job.progress })),
    session: open === null ? null : { id: open.sessionId, client: open.client, act: open.act, model: open.model },
  };
}

/**
 * One event of the server's stream applied to the view: the same view when the event moves
 * nothing the strip shows. A snapshot (the first event of a connection, or a `gap` after a resume
 * the server could not serve) replaces it whole.
 */
export function applyServerEvent(view: CardView, event: ServerEvent): CardView {
  switch (event.event) {
    case 'snapshot':
      return cardViewOf(event.activity);
    case 'job.running':
      if (view.running.some((job) => job.jobId === event.jobId)) return view;
      return { ...view, running: [...view.running, { jobId: event.jobId, type: event.type, model: event.model, client: event.client, progress: null }] };
    case 'job.progress': {
      if (!view.running.some((job) => job.jobId === event.jobId)) return view;
      return { ...view, running: view.running.map((job) => (job.jobId === event.jobId ? { ...job, progress: event.fraction } : job)) };
    }
    case 'job.done':
    case 'job.failed':
    case 'job.cancelled':
    case 'job.interrupted':
    case 'job.removed':
      if (!view.running.some((job) => job.jobId === event.jobId)) return view;
      return { ...view, running: view.running.filter((job) => job.jobId !== event.jobId) };
    case 'card.loaded':
      return view.resident === event.subject ? view : { ...view, resident: event.subject };
    case 'card.unloaded':
      return view.resident === event.subject ? { ...view, resident: null } : view;
    case 'session.opened': {
      const model = typeof event.data['model'] === 'string' ? (event.data['model'] as string) : null;
      return { ...view, session: { id: event.sessionId, client: event.client, act: event.act, model } };
    }
    case 'session.closed':
    case 'session.removed':
      return view.session?.id === event.sessionId ? { ...view, session: null } : view;
    default:
      return view;
  }
}

/** A client as a line names it: this install's own name is "contentstudio" (its host is this computer). */
export function displayClient(client: string | null): string | null {
  if (client === null) return null;
  return client === CRUCIBLE_CLIENT_NAME ? 'contentstudio' : client;
}

/**
 * The busy line for a server ContentStudio's own lane is not running on ("busy: bookforge, tts 62%
 * done"; "held: foundry's session for translate"), or null when nothing holds it. This install's
 * own work is named "contentstudio" so readiness and the strip can say it is ours.
 */
export function busyLineOfView(view: CardView): string | null {
  const job = view.running[0];
  if (job !== undefined) {
    const done = job.progress === null ? '' : ` ${Math.round(job.progress * 100)}% done`;
    return `busy: ${displayClient(job.client) ?? 'another app'}, ${job.type}${done}`;
  }
  if (view.session !== null) return `held: ${displayClient(view.session.client) ?? 'another app'}'s session for ${view.session.act}`;
  return null;
}

/** What holds the server, minus the time left; null when it is free or ours. `ours` is the ledger's ids on this server. */
export function holderOf(view: CardView, ours: ReadonlySet<string>): Omit<CardHolder, 'secondsLeft' | 'leftUnknown'> | null {
  const mine = (id: string, client: string | null): boolean => ours.has(id) || isOurClient(client);
  // ContentStudio's own work on the server: that is the running row, not something to wait for.
  if (view.session !== null && mine(view.session.id, view.session.client)) return null;
  if (view.running.some((job) => mine(job.jobId, job.client))) return null;
  const job = view.running[0];
  if (job !== undefined) {
    return { kind: 'job', client: job.client, what: job.type, model: job.model, id: job.jobId, progress: job.progress };
  }
  if (view.session !== null) {
    return { kind: 'session', client: view.session.client, what: view.session.act, model: view.session.model ?? view.resident, id: view.session.id, progress: null };
  }
  return null;
}

/** The first and latest reading of one hold, on this app's clock. */
export interface HolderTrack {
  readonly key: string;
  readonly firstAt: number;
  readonly firstProgress: number | null;
  readonly lastAt: number;
  readonly lastProgress: number | null;
}

function keyOf(holder: Omit<CardHolder, 'secondsLeft' | 'leftUnknown'>): string {
  return `${holder.kind}|${holder.id ?? ''}|${holder.client ?? ''}|${holder.what ?? ''}`;
}

/**
 * Fold one reading into the track and answer the holder with its time left. A different hold (a
 * new id: someone else got the server first) starts a new track, so the row follows the new job.
 */
export function trackHolder(
  track: HolderTrack | null,
  holder: Omit<CardHolder, 'secondsLeft' | 'leftUnknown'> | null,
  at: number,
): { track: HolderTrack | null; holder: CardHolder | null } {
  if (holder === null) return { track: null, holder: null };
  const key = keyOf(holder);
  const progress = holder.progress;
  // Progress that went down is a restarted count: measure from here.
  const same = track !== null && track.key === key
    && !(progress !== null && track.lastProgress !== null && progress < track.lastProgress);
  const next: HolderTrack = same
    ? { ...track!, lastAt: at, lastProgress: progress }
    : { key, firstAt: at, firstProgress: progress, lastAt: at, lastProgress: progress };
  if (progress === null) return { track: next, holder: { ...holder, secondsLeft: null, leftUnknown: 'no-progress' } };
  return { track: next, holder: { ...holder, ...timeLeft(next) } };
}

/** Seconds left from the track's rate, or why there is none yet. */
export function timeLeft(track: HolderTrack): Pick<CardHolder, 'secondsLeft' | 'leftUnknown'> {
  const { firstAt, firstProgress, lastAt, lastProgress } = track;
  if (lastProgress === null) return { secondsLeft: null, leftUnknown: 'no-progress' };
  if (lastProgress >= 1) return { secondsLeft: 0, leftUnknown: null };
  if (firstProgress === null || lastAt <= firstAt || lastProgress <= firstProgress) return { secondsLeft: null, leftUnknown: 'measuring' };
  const perMs = (lastProgress - firstProgress) / (lastAt - firstAt);
  return { secondsLeft: Math.round((1 - lastProgress) / perMs / 1000), leftUnknown: null };
}
