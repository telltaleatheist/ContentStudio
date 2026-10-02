/**
 * GIVING BACK EVERY HOLD CONTENTSTUDIO STILL HAS ON A CRUCIBLE: at quit, at
 * startup after a quit that never ran, when one job stalls or is stopped, and
 * when a stream to one server drops.
 *
 * Ported from Briefcase's backend/src/crucible/in-flight-sweep.ts (BookForge's
 * before it; plan section 13.4). Every moment is the same sweep over the ledger
 * (in-flight-ledger.ts), narrowed by `server` or `jobId`:
 *
 *   START   the ledger is the only thing that knows what a kill left behind.
 *           The sweep runs as the app comes up and GPU admission waits for it
 *           (lanes.ts), bounded by STARTUP_SWEEP_DEADLINE_MS.
 *   QUIT    `before-quit`, after the running jobs are aborted and given
 *           QUIT_UNWIND_MS to let go of their sessions themselves and the
 *           sessions still open are closed (session.ts `closeAll`), then under
 *           QUIT_SWEEP_DEADLINE_MS in all.
 *   JOB     a stall (stream-stall.ts) or a Stop gives back that job's rows only.
 *   SERVER  a dropped stream sweeps that server (plan section 13.4).
 *
 * A JOB ROW IS CANCELLED (`DELETE /v1/jobs/{id}`); A SESSION ROW IS ENDED
 * (`DELETE /v1/queue/{id}`, the SDK's `removeFromQueue`: given an open session's
 * id it closes it). Ending the session IS the model kill since Crucible 1.0.76
 * (LEDGER #255): "when a session closes ... the card is settled: unloaded unless
 * something else holds it" (docs/QUEUE.md). So the pass that read `/v1/activity`
 * until our jobs left the lane and then asked for an `unload-model` itself is
 * gone: the server settles its own card.
 *
 * WHAT IT NEVER DOES
 *  - Touch a job or session this app did not record. A Crucible is shared; an
 *    id we wrote down is the only honest claim.
 *  - Retry a refusal.
 *  - Hang. The whole sweep is bounded by `deadlineMs`, and it never throws.
 *
 * A row whose server could not be reached STAYS in the ledger for the next
 * start: an asleep machine is a delay, forgetting its row is a server held
 * until its session idles out.
 */
import { CrucibleRefused, CrucibleUnreachable, type CrucibleClient } from '@crucible/client';
import * as log from 'electron-log';
import type { CrucibleInFlightEntry, InFlightLedger } from './in-flight-ledger';

/** The quit sweep's ceiling, unwind included (plan section 13.4: 30 s). */
export const QUIT_SWEEP_DEADLINE_MS = 30_000;
/**
 * Of that deadline, how long the quit first waits for the aborted runs to
 * unwind (each lets go of its session itself) before sweeping the ledger
 * (plan section 0a: ~2 s).
 */
export const QUIT_UNWIND_MS = 2_000;
/** The startup sweep's ceiling: GPU admission waits for it, nothing else does. */
export const STARTUP_SWEEP_DEADLINE_MS = 15_000;
/** One job's give-back (a stall, a Stop): short, because the job is already over. */
export const JOB_SWEEP_DEADLINE_MS = 10_000;

export interface SweepDeps {
  ledger: InFlightLedger;
  /** A client on the engine behind a registered server. Throws for an unknown name. */
  clientFor(server: string): Promise<CrucibleClient>;
  log?(line: string): void;
}

export interface SweptRow {
  readonly entry: CrucibleInFlightEntry;
  readonly outcome: 'cancelled' | 'closed' | 'gone' | 'unreachable' | 'refused';
  readonly detail: string;
}

export interface SweepReport {
  readonly rows: readonly SweptRow[];
  /** Rows still in the ledger afterwards (an unreachable server's work, or the deadline's). */
  readonly kept: readonly CrucibleInFlightEntry[];
  readonly timedOut: boolean;
}

async function giveBack(client: CrucibleClient, row: CrucibleInFlightEntry): Promise<Omit<SweptRow, 'entry'>> {
  try {
    if (row.kind === 'session') {
      const result = await client.removeFromQueue(row.id);
      return { outcome: 'closed', detail: `session ${row.id} is ${result.status}` };
    }
    const result = await client.cancel(row.id);
    return { outcome: 'cancelled', detail: `job ${row.id} is ${result.status}` };
  } catch (err) {
    if (err instanceof CrucibleUnreachable) return { outcome: 'unreachable', detail: `nothing answered at ${err.url}` };
    if (err instanceof CrucibleRefused
      && (err.status === 404 || ['unknown_queue_session', 'session_closed', 'unknown_job', 'not_found', 'job_not_cancellable'].includes(err.code))) {
      return { outcome: 'gone', detail: `the server no longer has ${row.kind} ${row.id} (${err.code})` };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/fetch failed|ECONNREFUSED|timed? ?out|aborted/i.test(message)) return { outcome: 'unreachable', detail: message };
    return { outcome: 'refused', detail: message };
  }
}

/**
 * Give back every row in the ledger (or only `server`'s, or only `jobId`'s): cancel each job, end
 * each session. Never throws.
 */
export async function sweepCrucibleInFlight(
  deps: SweepDeps,
  options: { reason: string; deadlineMs: number; server?: string; jobId?: string },
): Promise<SweepReport> {
  const say = deps.log ?? ((line: string) => log.info(`[crucible] ${line}`));
  const all = deps.ledger.read();
  const entries = all.filter((row) => (options.server === undefined || row.server === options.server)
    && (options.jobId === undefined || row.jobId === options.jobId));
  if (entries.length === 0) return { rows: [], kept: all, timedOut: false };

  const rows: SweptRow[] = [];
  const work = (async () => {
    say(`${entries.length} Crucible hold(s) recorded as in flight: ${options.reason}`);
    const byServer = new Map<string, CrucibleInFlightEntry[]>();
    for (const entry of entries) byServer.set(entry.server, [...(byServer.get(entry.server) ?? []), entry]);
    await Promise.all([...byServer].map(async ([server, list]) => {
      let client: CrucibleClient;
      try {
        client = await deps.clientFor(server);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        for (const entry of list) rows.push({ entry, outcome: 'refused', detail });
        say(`cannot reach "${server}" to give back ${list.length} hold(s): ${detail}; its rows stay for the next start`);
        return;
      }
      // Jobs first, sessions last: a job is cancelled while the session it ran in is still ours.
      const ordered = [...list.filter((row) => row.kind === 'job'), ...list.filter((row) => row.kind === 'session')];
      for (const entry of ordered) {
        const result = await giveBack(client, entry);
        rows.push({ entry, ...result });
        if (result.outcome === 'cancelled' || result.outcome === 'closed' || result.outcome === 'gone') {
          deps.ledger.settle(server, entry.kind, entry.id);
          say(`${entry.jobType} ${entry.id} (${entry.jobId || 'contentstudio'}) on "${server}": ${result.detail}`);
        } else {
          say(`could NOT give back ${entry.jobType} ${entry.id} on "${server}": ${result.detail}. It stays in the ledger for the next start.`);
        }
      }
    }));
  })();

  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    work.then(() => false, (err) => { say(`the Crucible sweep stopped early: ${(err as Error).message}`); return false; }),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), options.deadlineMs); timer.unref?.(); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (timedOut) say(`the Crucible sweep hit its ${options.deadlineMs} ms deadline (${options.reason}); what it did not finish stays in the ledger for the next start`);
  return { rows: [...rows], kept: deps.ledger.read(), timedOut };
}
