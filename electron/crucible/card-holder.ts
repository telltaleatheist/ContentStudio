/**
 * WHO IS ON THE CARD, AND ABOUT HOW LONG: the queue's "waiting its turn" row (LEDGER #234).
 *
 * Owen, 2026-09-26: "if theres a job running on the crucible server and we cant run anything
 * until its finished, ill hit the start queue button and itll show the job that's currently
 * running on crucible and how long it has until it's done at the bottom of the queue ... if
 * something else takes the lease first, it fills in that slot with the new running job it's
 * waiting to finish".
 *
 * Pure. The lanes' preflight (lanes.ts `readOne`) hands each `/v1/activity` read here, keeps
 * the track between reads, and puts the answer on the lane chip; the renderer words it
 * (job-activity.ts `holderWaitLine`) under a parked job.
 *
 * TIME LEFT. Crucible states no finish time for a job (`ActivityJob` has progress, created,
 * started and nothing more). So it is measured: the progress moved between this app's first
 * read of the SAME hold and its latest read, on this app's own clock (the server's `started`
 * stamp is on another computer's clock and is not mixed in). Until two reads show it moving it
 * is `measuring`; a hold with no progress at all (a lease, a streaming session) is
 * `no-progress`. Never a guessed number.
 */
import type { Activity } from '@crucible/client';
import type { CardHolder } from './wire';

/** Is this client ContentStudio (its User-Agent starts with its name)? */
export function isContentStudio(client: string | null | undefined): boolean {
  return typeof client === 'string' && /^contentstudio\b/i.test(client.trim());
}

/** What holds the card, minus the time left; null when it is free or ours. `ours` is the ledger's ids on this server. */
export function holderOf(activity: Activity, ours: ReadonlySet<string>): Omit<CardHolder, 'secondsLeft' | 'leftUnknown'> | null {
  const mine = (id: string | null | undefined, client: string | null | undefined): boolean =>
    (typeof id === 'string' && ours.has(id)) || isContentStudio(client);
  // ContentStudio's own job on the lane: that is the running row, not something to wait for.
  if (activity.running.some((job) => mine(job.jobId, job.client))) return null;
  const job = activity.running[0];
  if (job !== undefined) {
    return { kind: 'job', client: job.client, what: job.type, model: job.model, id: job.jobId, progress: job.progress };
  }
  const lease = activity.lease;
  if (lease !== null && !mine(lease.leaseId, lease.client)) {
    return { kind: 'lease', client: lease.client, what: lease.act, model: activity.resident?.id ?? null, id: lease.leaseId, progress: null };
  }
  const claim = activity.claim?.heldBy?.trim();
  if (claim && !isContentStudio(claim)) {
    return { kind: 'claim', client: activity.streaming?.client ?? claim, what: null, model: null, id: activity.streaming?.sessionId ?? null, progress: null };
  }
  if (!activity.slots.accelerated.acceptsWork && !(claim && isContentStudio(claim)) && lease === null) {
    return { kind: 'card', client: null, what: null, model: null, id: null, progress: null };
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
 * Fold one read into the track and answer the holder with its time left. A different hold (a
 * new id: someone else got the card first) starts a new track, so the row follows the new job.
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
