// Message contract for the shelf's Visibility section: content script -> service worker ->
// the scheduler on Triton.
//
// Its own message family rather than more publish-* types, because it is a different
// server with a different failure story: these calls never touch the ContentStudio app,
// so a closed app must not read as a broken scheduler, and a missing device key must not
// read as a closed app. The transport (sendToWorker, its envelope, the stale-context
// handling) is shared with publish-messages.ts; only the types and the guard live here.

import { sendToWorker } from '../publish/publish-messages';
import type {
  NewSchedulerJob,
  SchedulerChannel,
  SchedulerHealth,
  SchedulerJob,
  SchedulerJobPatch,
  SchedulerJobWithWarnings,
  SchedulerVideo,
} from './scheduler-client';

export type SchedulerMessage =
  | { type: 'scheduler-health' }
  | { type: 'scheduler-channels' }
  | { type: 'scheduler-video'; videoId: string }
  | { type: 'scheduler-jobs'; videoId: string }
  | { type: 'scheduler-create'; job: NewSchedulerJob }
  | { type: 'scheduler-edit'; jobId: string; patch: SchedulerJobPatch }
  | { type: 'scheduler-cancel'; jobId: string }
  /** Opens the sign-in page that gives this browser its key. */
  | { type: 'scheduler-connect' }
  /** From the scheduler's page: store the key it just made, and close that tab. */
  | { type: 'scheduler-save-key'; key: string };

/** Listed explicitly, like PUBLISH_MESSAGE_TYPES, so a typo is refused rather than routed. */
const SCHEDULER_MESSAGE_TYPES: ReadonlySet<string> = new Set<SchedulerMessage['type']>([
  'scheduler-health',
  'scheduler-channels',
  'scheduler-video',
  'scheduler-jobs',
  'scheduler-create',
  'scheduler-edit',
  'scheduler-cancel',
  'scheduler-connect',
  'scheduler-save-key',
]);

export function isSchedulerMessage(message: unknown): message is SchedulerMessage {
  if (typeof message !== 'object' || message === null) return false;
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' && SCHEDULER_MESSAGE_TYPES.has(type);
}

export function requestSchedulerHealth(): Promise<SchedulerHealth> {
  return sendToWorker<SchedulerHealth>({ type: 'scheduler-health' });
}

export function requestSchedulerChannels(): Promise<SchedulerChannel[]> {
  return sendToWorker<SchedulerChannel[]>({ type: 'scheduler-channels' });
}

export function requestSchedulerVideo(videoId: string): Promise<SchedulerVideo> {
  return sendToWorker<SchedulerVideo>({ type: 'scheduler-video', videoId });
}

export function requestSchedulerJobs(videoId: string): Promise<SchedulerJob[]> {
  return sendToWorker<SchedulerJob[]>({ type: 'scheduler-jobs', videoId });
}

export function requestCreateSchedulerJob(job: NewSchedulerJob): Promise<SchedulerJobWithWarnings> {
  return sendToWorker<SchedulerJobWithWarnings>({ type: 'scheduler-create', job: { ...job } });
}

export function requestEditSchedulerJob(jobId: string, patch: SchedulerJobPatch): Promise<SchedulerJobWithWarnings> {
  return sendToWorker<SchedulerJobWithWarnings>({ type: 'scheduler-edit', jobId, patch: { ...patch } });
}

export function requestCancelSchedulerJob(jobId: string): Promise<SchedulerJob> {
  return sendToWorker<SchedulerJob>({ type: 'scheduler-cancel', jobId });
}

export function requestConnectScheduler(): Promise<null> {
  return sendToWorker<null>({ type: 'scheduler-connect' });
}

export function requestSaveSchedulerKey(key: string): Promise<null> {
  return sendToWorker<null>({ type: 'scheduler-save-key', key });
}
