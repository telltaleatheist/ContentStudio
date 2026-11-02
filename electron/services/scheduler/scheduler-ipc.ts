/**
 * Visibility scheduler IPC
 *
 * The channels the Settings card and the Visibility changes panel use, registered in one
 * call the way setupSpreakerIpc is. Namespaced `scheduler-*`. Every route of the server's
 * API has one channel; each answers the uniform `{success, data | error}` envelope, and a
 * server refusal is its own `{error}` text, verbatim.
 *
 * NO KEY COMES BACK OUT. `scheduler-get-status` says whether one is stored; there is no
 * "get key" channel. Saving a key takes it in and writes it to scheduler.json (mode 600).
 *
 * Reads only when asked: the panel reads its video's list when it opens and the calendar
 * reads its range when it loads or moves. Nothing here polls.
 */

import { ipcMain } from 'electron';
import * as log from 'electron-log';
import type {
  SchedulerChannel,
  SchedulerClient,
  SchedulerHealth,
  SchedulerJobFilter,
  SchedulerJobPatch,
  NewSchedulerJob,
} from './scheduler-client';

type Result<T> = { success: true; data: T } | { success: false; error: string };
function ok<T>(data: T): Result<T> {
  return { success: true, data };
}
function fail(error: string): Result<never> {
  return { success: false, error };
}
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What "Test" reports: both answers, or the first refusal. */
export interface SchedulerTestResult {
  health: SchedulerHealth;
  channels: SchedulerChannel[];
}

export function setupSchedulerIpc(client: SchedulerClient): void {
  if (!client || typeof client.listJobs !== 'function') {
    throw new Error('setupSchedulerIpc requires a SchedulerClient.');
  }

  /** Is a key saved, and at what address? Read fresh: a key saved in Settings counts at once. */
  ipcMain.handle('scheduler-get-status', async () => {
    try {
      return ok(client.status());
    } catch (err) {
      return fail(message(err));
    }
  });

  /** Save or replace the device key. The key is never logged; the line says a save happened. */
  ipcMain.handle('scheduler-save-key', async (_e, key: unknown) => {
    try {
      const status = client.saveKey(key);
      log.info(`[Scheduler] device key saved for ${status.baseUrl}`);
      return ok(status);
    } catch (err) {
      return fail(message(err));
    }
  });

  /** Settings' "Test": /health and /channels, both, so the card can say what is connected. */
  ipcMain.handle('scheduler-test', async () => {
    try {
      const health = await client.health();
      const channels = await client.channels();
      return ok<SchedulerTestResult>({ health, channels });
    } catch (err) {
      return fail(message(err));
    }
  });

  ipcMain.handle('scheduler-health', async () => {
    try {
      return ok(await client.health());
    } catch (err) {
      return fail(message(err));
    }
  });

  ipcMain.handle('scheduler-channels', async () => {
    try {
      return ok(await client.channels());
    } catch (err) {
      return fail(message(err));
    }
  });

  /** The video's current visibility and YouTube publishAt, for the add form. */
  ipcMain.handle('scheduler-video', async (_e, videoId: string) => {
    try {
      return ok(await client.video(videoId));
    } catch (err) {
      return fail(message(err));
    }
  });

  ipcMain.handle('scheduler-list-jobs', async (_e, filter: SchedulerJobFilter) => {
    try {
      return ok(await client.listJobs(filter ?? {}));
    } catch (err) {
      return fail(message(err));
    }
  });

  ipcMain.handle('scheduler-create-job', async (_e, input: NewSchedulerJob) => {
    try {
      const out = await client.createJob(input);
      log.info(`[Scheduler] created ${out.job.id}: ${out.job.videoId} -> ${out.job.target} at ${out.job.runAt}`);
      return ok(out);
    } catch (err) {
      return fail(message(err));
    }
  });

  ipcMain.handle('scheduler-patch-job', async (_e, id: string, patch: SchedulerJobPatch) => {
    try {
      const out = await client.patchJob(id, patch ?? {});
      log.info(`[Scheduler] edited ${out.job.id}: ${out.job.target} at ${out.job.runAt}`);
      return ok(out);
    } catch (err) {
      return fail(message(err));
    }
  });

  ipcMain.handle('scheduler-cancel-job', async (_e, id: string) => {
    try {
      const job = await client.cancelJob(id);
      log.info(`[Scheduler] cancelled ${job.id}`);
      return ok(job);
    } catch (err) {
      return fail(message(err));
    }
  });
}
