/**
 * "Unlisted now, then public at…" — the publish flow's use of the visibility scheduler
 * (VISIBILITY-SCHEDULER-PLAN.md, "ContentStudio"; Owen, 2026-11-02).
 *
 * YouTube can only schedule private → public. The sponsor case needs the real video
 * UNLISTED first, so the sponsor can review it, and public at a set time. An item whose
 * releaseMode is 'unlisted-then-public' is therefore uploaded (or pushed) as unlisted with
 * NO publishAt, and then a change to public at the record's publishAt is created on the
 * scheduler on Triton, which is the only store of changes.
 *
 * ── The order, and what a failure leaves ─────────────────────────────────────────────
 *
 * YouTube first, then the scheduler. If creating the change fails, the video is already
 * unlisted and stays that way: the upload is not undone (plan: "if creating the change
 * fails, the panel says so plainly on the item"). The failure is written onto the record
 * (`releaseChange.error`), so the item says so on every open until a change is created,
 * and the action that made it throws with the same words. Nothing retries on its own and
 * nothing quietly goes public by another route: no fallbacks.
 *
 * Before anything irreversible, `requireReleaseReady` checks what can be checked offline —
 * a time to go public, still far enough ahead, a saved scheduler key — so a missing key
 * stops the upload instead of surfacing after a gigabyte went up.
 *
 * ── After the change exists ──────────────────────────────────────────────────────────
 *
 * Its time and visibility are the scheduler's from then on. publishAt and releaseMode are
 * refused on the record while it is linked to a change (edit or cancel it in Visibility
 * changes, which writes the record back through `releasePatchForJob`), and a later push
 * never creates a second one.
 */

import type { ChosenMetadata, ReleaseChange } from './publish-types';
import type { SchedulerJob, SchedulerJobWithWarnings, NewSchedulerJob } from '../scheduler/scheduler-client';

/** The slice of SchedulerClient the publish flow needs. Structural, so the checks can fake it. */
export interface ReleaseSchedulerApi {
  /** Throws (with the fix-it message) when no usable key is saved. */
  requireConfigured(): void;
  createJob(input: NewSchedulerJob): Promise<SchedulerJobWithWarnings>;
}

/** The server's own rule (rules.ts MIN_LEAD_MS) plus a minute for the upload/push to finish. */
const MIN_LEAD_MS = 2 * 60_000;

export function isUnlistedFirst(record: ChosenMetadata): boolean {
  return record.releaseMode === 'unlisted-then-public';
}

/** True when the record already holds a created change for its current video. */
export function hasReleaseChange(record: ChosenMetadata): boolean {
  const link = record.releaseChange;
  return link !== null && link.jobId !== null && link.videoId === record.videoId;
}

/**
 * Refuse, by name, an 'unlisted-then-public' item that cannot be released that way — BEFORE
 * any YouTube write. `api` is checked only for a saved key; nothing is sent.
 */
export function requireReleaseReady(record: ChosenMetadata, api: ReleaseSchedulerApi | undefined, now: Date, action: string): string {
  const item = record.itemId;
  if (!record.publishAt) {
    throw new Error(
      `Item ${item} is set to go unlisted now and public later, but has no time to go public. ` +
        `Give it a date on the calendar, or switch it back to YouTube's own schedule. Nothing was ${action}.`,
    );
  }
  const at = Date.parse(record.publishAt);
  if (Number.isNaN(at)) {
    throw new Error(`Item ${item}'s time to go public, ${JSON.stringify(record.publishAt)}, is not a date. Nothing was ${action}.`);
  }
  if (at < now.getTime() + MIN_LEAD_MS) {
    throw new Error(
      `Item ${item} is set to go public at ${record.publishAt}, which is ${at < now.getTime() ? 'already past' : 'less than two minutes away'}; ` +
        `the scheduler needs a time ahead. Move it on the calendar. Nothing was ${action}.`,
    );
  }
  if (!api) {
    throw new Error(`Item ${item} goes public through the visibility scheduler, and this action was given no scheduler. Nothing was ${action}.`);
  }
  try {
    api.requireConfigured();
  } catch (err) {
    throw new Error(`Item ${item} goes public through the visibility scheduler, which is not usable: ${errText(err)} Nothing was ${action}.`);
  }
  return record.publishAt;
}

export interface ReleaseCreateOutcome {
  link: ReleaseChange;
  /** The thrown message when it failed, also stored in link.error. */
  failure: string | null;
}

/**
 * Create the change to public for `videoId` at `runAt` and say what happened as a
 * ReleaseChange. Never throws for a scheduler refusal: the caller writes the outcome onto
 * the record FIRST and then throws, so the failure is on the item even if the renderer
 * that asked is gone.
 */
export async function createReleaseChange(
  api: ReleaseSchedulerApi,
  input: { itemId: string; videoId: string; runAt: string; title: string | null },
  now: Date,
): Promise<ReleaseCreateOutcome> {
  const attemptedAt = now.toISOString();
  try {
    const out = await api.createJob({
      videoId: input.videoId,
      target: 'public',
      runAt: input.runAt,
      note: releaseNote(input.title),
    });
    return {
      link: { videoId: input.videoId, runAt: input.runAt, attemptedAt, jobId: out.job.id, error: null, warnings: out.warnings },
      failure: null,
    };
  } catch (err) {
    const error = errText(err);
    return {
      link: { videoId: input.videoId, runAt: input.runAt, attemptedAt, jobId: null, error, warnings: [] },
      failure: error,
    };
  }
}

/** The note the scheduler shows beside the change: says where it came from. */
export function releaseNote(title: string | null): string {
  const base = 'ContentStudio: unlisted, then public';
  const full = title ? `${base} (${title})` : base;
  return full.length > 200 ? `${full.slice(0, 199)}…` : full;
}

/** The sentence an upload or push throws after the YouTube write when the change could not be created. */
export function releaseFailureMessage(videoId: string, runAt: string, done: 'uploaded' | 'made unlisted' | 'pushed', error: string): string {
  return (
    `Video ${videoId} was ${done} and is UNLISTED, but its change to public at ${runAt} could not be created ` +
    `on the visibility scheduler: ${error} It stays unlisted until a change is made: use "Create the change" ` +
    `in the Video row's Visibility changes, or add one there by hand.`
  );
}

/**
 * What the record should say after the operator edited or cancelled a change in Visibility
 * changes, or null when the change is not this record's link.
 *
 * Edited and still → public: the record's go-public time follows the change. Cancelled, or
 * edited to another visibility: the item no longer goes public at any time, so publishAt is
 * cleared (stamped like any other clear) and the link is dropped.
 */
export function releasePatchForJob(
  record: ChosenMetadata,
  job: SchedulerJob,
  now: Date,
): Pick<ChosenMetadata, 'publishAt' | 'publishAtSetAt' | 'releaseChange'> | null {
  const link = record.releaseChange;
  if (!link || link.jobId !== job.id) return null;
  const stamp = now.toISOString();
  if (job.state === 'pending' && job.target === 'public') {
    return { publishAt: job.runAt, publishAtSetAt: stamp, releaseChange: { ...link, runAt: job.runAt } };
  }
  if (job.state === 'cancelled' || (job.state === 'pending' && job.target !== 'public')) {
    return { publishAt: null, publishAtSetAt: stamp, releaseChange: null };
  }
  return null;
}

/**
 * Why a publish-set-fields write must be refused while the record is linked to a change, or
 * null. Only publishAt and releaseMode are the scheduler's once the change exists.
 */
export function releaseLockProblem(record: ChosenMetadata | null, fields: Record<string, unknown>): string | null {
  if (!record || !hasReleaseChange(record)) return null;
  const touched = ['publishAt', 'releaseMode'].filter((k) => k in fields);
  if (touched.length === 0) return null;
  return (
    `Item ${record.itemId}'s change to public is on the visibility scheduler (set for ${record.releaseChange!.runAt}), ` +
    `so ${touched.join(' and ')} cannot be changed here. Edit or cancel the change in the Video row's Visibility changes; ` +
    `the item follows it.`
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
