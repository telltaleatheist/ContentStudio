// The visibility scheduler: changes a YouTube video's visibility (any -> any) at a set time.
// See VISIBILITY-SCHEDULER-PLAN.md at the repo root.

import { pruneExpired } from './auth.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { dueJobs, runJob } from './jobs.js';
import { startServer, type Runtime } from './server.js';

const TICK_MS = 30_000;

const config = loadConfig();
const db = openDb(config.dataDir);
const runtime: Runtime = { lastTick: null };
const server = startServer(config, db, runtime);

let running: Promise<void> | null = null;
let stopping = false;

async function tick(): Promise<void> {
  const now = Date.now();
  pruneExpired(db, now);
  // One at a time, in order: a video's changes must never race each other.
  for (const job of dueJobs(db, now)) {
    if (stopping) break;
    await runJob(config, db, job);
  }
  runtime.lastTick = Date.now();
}

function schedule(): void {
  if (running || stopping) return;
  running = tick()
    .catch((err: unknown) => console.error('[loop] tick failed:', err))
    .finally(() => {
      running = null;
    });
}

schedule();
const timer = setInterval(schedule, TICK_MS);

async function shutdown(signal: string): Promise<void> {
  console.log(`[main] ${signal}: finishing the current change, then stopping`);
  stopping = true;
  clearInterval(timer);
  server.close();
  await running;
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
