/**
 * GIVING BACK EVERY CARD CONTENTSTUDIO STILL HOLDS: at quit, at startup after a
 * quit that never ran, when one job stalls or is stopped, and when a stream to
 * one server drops.
 *
 * Ported from Briefcase's backend/src/crucible/in-flight-sweep.ts (BookForge's
 * before it; plan section 13.4). Every moment is the same sweep over the ledger
 * (in-flight-ledger.ts), narrowed by `server` or `jobId`:
 *
 *   START   the ledger is the only thing that knows what a kill left behind.
 *           The sweep runs as the app comes up and GPU admission waits for it
 *           (lanes.ts), bounded by STARTUP_SWEEP_DEADLINE_MS.
 *   QUIT    `before-quit`, after the running jobs are aborted and given
 *           QUIT_UNWIND_MS to release their own holds (plan section 0a: a lease
 *           granted after quit began is in no ledger row this could read), then
 *           under QUIT_SWEEP_DEADLINE_MS in all.
 *   JOB     a stall (stream-stall.ts) or a Stop gives back that job's rows only.
 *   SERVER  a dropped stream sweeps that server (plan section 13.4).
 *
 * Releasing IS the model kill: Crucible unloads the resident model the moment
 * nothing holds it. The explicit `unload-model` is only for a card left
 * resident with nothing holding it, only when the resident is a model one of
 * OUR rows names (ContentStudio loaded it), and only when `cardHeldBy` says
 * nobody else is on it.
 *
 * WHAT IT NEVER DOES
 *  - Touch a job or lease this app did not record. A Crucible is shared, and
 *    two ContentStudio installs report the same client name; an id we wrote
 *    down is the only honest claim.
 *  - Unload anything another client is using (`cardHeldBy`).
 *  - Retry a refusal. `409 leased`/`server_busy` on an unload is somebody
 *    else's card.
 *  - Hang. Each server is bounded by {@link SweepTiming}, the whole sweep by
 *    `deadlineMs`, and it never throws.
 *
 * A row whose server could not be reached STAYS in the ledger for the next
 * start: an asleep machine is a delay, forgetting its row is a card held
 * forever.
 */
import { CrucibleRefused, CrucibleUnreachable, type Activity, type CrucibleClient } from '@crucible/client';
import * as log from 'electron-log';
import type { CrucibleInFlightEntry, InFlightLedger } from './in-flight-ledger';

export interface SweepTiming {
  /** Total time polling `/v1/activity` per server for our jobs to leave the lane. */
  readonly confirmForMs: number;
  readonly pollEveryMs: number;
}

export const SWEEP_TIMING: SweepTiming = { confirmForMs: 4_000, pollEveryMs: 400 };
/** The quit sweep's ceiling, unwind included (plan section 13.4: 30 s). */
export const QUIT_SWEEP_DEADLINE_MS = 30_000;
/**
 * Of that deadline, how long the quit first waits for the aborted runs to
 * unwind (each releases what it holds itself, a lease granted mid-quit
 * included) before sweeping the ledger (plan section 0a: ~2 s).
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
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export interface SweptRow {
  readonly entry: CrucibleInFlightEntry;
  readonly outcome: 'cancelled' | 'released' | 'gone' | 'unreachable' | 'refused';
  readonly detail: string;
}

export interface SweptServer {
  readonly server: string;
  readonly unloaded: string | null;
  readonly note: string;
}

export interface SweepReport {
  readonly rows: readonly SweptRow[];
  readonly servers: readonly SweptServer[];
  /** Rows still in the ledger afterwards (an unreachable server's work, or the deadline's). */
  readonly kept: readonly CrucibleInFlightEntry[];
  readonly timedOut: boolean;
}

/**
 * Chat completions open on the card, as `/v1/activity` states them: its
 * count, else the rows it listed; null when it states neither (informational
 * since 1.0.25).
 */
export function chatsInFlight(activity: Pick<Activity, 'chat'>): number | null {
  const chat = activity.chat;
  if (chat === null) return null;
  if (chat.inFlight !== null) return chat.inFlight;
  return chat.rows === null ? null : chat.rows.length;
}

/**
 * Who, other than something in `ours`, holds this card, or null when nobody
 * does. PURE, and the whole safety rule: an unload is asked for only on null.
 * Wider than the server's own `resident.heldBy` on purpose: a chat in flight
 * holds nothing on the server, but somebody is mid-answer on that card.
 */
export function cardHeldBy(activity: Activity, ours: ReadonlySet<string>): string | null {
  const running = activity.running.filter((job) => !ours.has(job.jobId));
  if (running.length > 0) return `a ${running[0]!.type} job from ${running[0]!.client ?? 'another app'}`;
  const queued = activity.queued.filter((job) => !ours.has(job.jobId));
  if (queued.length > 0) return `a queued ${queued[0]!.type} job from ${queued[0]!.client ?? 'another app'}`;
  if (activity.claim !== null) return `a claim held by ${activity.claim.heldBy}`;
  if (activity.lease !== null && !ours.has(activity.lease.leaseId)) return `a lease held by ${activity.lease.client ?? 'another app'} for ${activity.lease.act}`;
  if (activity.streaming !== null) return 'a streaming session';
  // Unstated is not free: the unload is asked for only when the server says no chat is open.
  const chats = chatsInFlight(activity);
  if (chats === null) return 'chat completions the server does not count (it states no chat activity)';
  if (chats > 0) return `${chats} chat completion(s) in flight`;
  if (activity.stopping !== null) return 'a stop already under way';
  return null;
}

async function giveBack(client: CrucibleClient, row: CrucibleInFlightEntry): Promise<Omit<SweptRow, 'entry'>> {
  try {
    if (row.kind === 'lease') {
      await client.release(row.id);
      return { outcome: 'released', detail: `released lease ${row.id}` };
    }
    const result = await client.cancel(row.id);
    return { outcome: 'cancelled', detail: `job ${row.id} is ${result.status}` };
  } catch (err) {
    if (err instanceof CrucibleUnreachable) return { outcome: 'unreachable', detail: `nothing answered at ${err.url}` };
    if (err instanceof CrucibleRefused
      && (err.status === 404 || ['unknown_lease', 'unknown_job', 'not_found', 'job_not_cancellable'].includes(err.code))) {
      return { outcome: 'gone', detail: `the server no longer has ${row.kind} ${row.id} (${err.code})` };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/fetch failed|ECONNREFUSED|timed? ?out|aborted/i.test(message)) return { outcome: 'unreachable', detail: message };
    return { outcome: 'refused', detail: message };
  }
}

/**
 * Give back every row in the ledger (or only `server`'s, or only `jobId`'s),
 * then clear each card if and only if nothing else holds it. Never throws.
 */
export async function sweepCrucibleInFlight(
  deps: SweepDeps,
  options: { reason: string; deadlineMs: number; server?: string; jobId?: string; timing?: SweepTiming },
): Promise<SweepReport> {
  const say = deps.log ?? ((line: string) => log.info(`[crucible] ${line}`));
  const all = deps.ledger.read();
  const entries = all.filter((row) => (options.server === undefined || row.server === options.server)
    && (options.jobId === undefined || row.jobId === options.jobId));
  if (entries.length === 0) return { rows: [], servers: [], kept: all, timedOut: false };

  const rows: SweptRow[] = [];
  const servers: SweptServer[] = [];
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
        servers.push({ server, unloaded: null, note: `cannot reach "${server}": ${detail}; its rows stay for the next start` });
        say(`cannot reach "${server}" to give back ${list.length} hold(s): ${detail}`);
        return;
      }
      const ours = new Set(list.map((row) => row.id));
      const ourModels = new Set(list.map((row) => row.model).filter((m): m is string => m !== null));
      let reachable = true;
      for (const entry of list) {
        const result = await giveBack(client, entry);
        rows.push({ entry, ...result });
        if (result.outcome === 'unreachable') reachable = false;
        if (result.outcome === 'cancelled' || result.outcome === 'released' || result.outcome === 'gone') {
          deps.ledger.settle(server, entry.kind, entry.id);
          say(`${entry.jobType} ${entry.id} (${entry.jobId || 'contentstudio'}) on "${server}": ${result.detail}`);
        } else {
          say(`could NOT give back ${entry.jobType} ${entry.id} on "${server}": ${result.detail}. It stays in the ledger for the next start.`);
        }
      }
      servers.push(reachable
        ? await clearTheCard(client, server, ours, ourModels, options.timing ?? SWEEP_TIMING, deps, say)
        : { server, unloaded: null, note: `"${server}" did not answer; nothing confirmed` });
    }));
  })();

  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    work.then(() => false, (err) => { say(`the Crucible sweep stopped early: ${(err as Error).message}`); return false; }),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), options.deadlineMs); timer.unref?.(); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (timedOut) say(`the Crucible sweep hit its ${options.deadlineMs} ms deadline (${options.reason}); what it did not finish stays in the ledger for the next start`);
  return { rows: [...rows], servers: [...servers], kept: deps.ledger.read(), timedOut };
}

async function clearTheCard(
  client: CrucibleClient,
  server: string,
  ours: ReadonlySet<string>,
  ourModels: ReadonlySet<string>,
  timing: SweepTiming,
  deps: SweepDeps,
  say: (line: string) => void,
): Promise<SweptServer> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }));
  const deadline = now() + timing.confirmForMs;
  let activity: Activity;
  for (;;) {
    try {
      activity = await client.activity();
    } catch (err) {
      const note = `"${server}" could not report its activity (${(err as Error).message}); the give-backs were sent, nothing confirmed them`;
      say(note);
      return { server, unloaded: null, note };
    }
    const lingering = [...activity.running, ...activity.queued].filter((job) => ours.has(job.jobId));
    if (lingering.length === 0 || now() >= deadline) break;
    await sleep(timing.pollEveryMs);
  }
  const resident = activity.resident;
  if (resident === null) return { server, unloaded: null, note: `"${server}" is clear` };
  if (!ourModels.has(resident.id)) {
    const note = `"${server}" holds ${resident.kind} "${resident.id}", which ContentStudio did not load; leaving it alone`;
    say(note);
    return { server, unloaded: null, note };
  }
  const holder = cardHeldBy(activity, ours);
  if (holder !== null) {
    const note = `"${server}" still holds "${resident.id}", but ${holder} is using it; leaving it alone`;
    say(note);
    return { server, unloaded: null, note };
  }
  if (resident.kind !== 'llm') {
    return { server, unloaded: null, note: `"${server}" holds a ${resident.kind}; Crucible unloads it itself once nothing holds it` };
  }
  try {
    const jobId = await client.unloadModel(resident.id);
    const note = `asked "${server}" to unload "${resident.id}" (job ${jobId})`;
    say(note);
    return { server, unloaded: resident.id, note };
  } catch (err) {
    // Refused (leased, server_busy, or the server's own settlement beat us): named once, never retried.
    const note = `"${server}" refused to unload "${resident.id}": ${(err as Error).message}`;
    say(note);
    return { server, unloaded: null, note };
  }
}
