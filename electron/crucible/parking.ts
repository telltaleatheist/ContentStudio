/**
 * PARKING: what a busy answer from a Crucible does to a queue job, and what
 * lets it start again.
 *
 * Plan section 13.2, cut to LEDGER #205. A busy server never fails a job and
 * never sends it anywhere else; it PARKS it: the row reads `parked` with the
 * holder's own sentence (the SDK's `CrucibleBusy.busyLine`, "GPU busy:
 * foundry, tts 62% done"), the lane is released, and the next job is tried.
 * It is never resubmitted in a loop.
 *
 * WHICH ANSWERS PARK. Only a refusal that is about what this server is doing
 * right now, and would be different later:
 *
 *   409 server_busy          another client's job has the lane
 *   409 leased               another client leased the resident model (a load of ours would evict it)
 *   409 engine_in_use        a streaming claim, or the server's own settlement
 *   409 accelerator_busy     a process Crucible does not own holds the card (Owen gaming on the PC)
 *   409 insufficient_memory  only when the server measured the card's FREE memory: the room may come back
 *
 * `insufficient_memory` with no free figure ("cannot load it on this host,
 * ever") or with the Mac's sized pool (`room_bytes`: memory less the desktop
 * allowance, which does not change) is a misconfiguration, and fails the job
 * by name (plan section 13.2, "Failure"). So does everything else.
 *
 * WHAT LETS IT START AGAIN: a preflight read (lanes.ts, every 15 s per
 * server; display and preflight, never permission) taken AFTER the park, that
 * shows the fact which refused it has gone. Each refusal names its own fact,
 * because they are different facts on the server (checked in crucible v1.0.34,
 * api.py `activity`):
 *
 *   server_busy, engine_in_use   `slots.accelerated.accepts_work` true
 *   leased                       `lease` null. NOT accepts_work: a lease does not
 *                                change it ("a lease is not a reservation"), so a
 *                                leased card reads accepting the whole time
 *   insufficient_memory          `/v1/accelerator` free bytes >= what the refusal said it needs
 *   accelerator_busy             none of the processes the refusal named still on the card, and
 *                                its unattributed figure (if it named one) back under the
 *                                server's own 1 GiB floor (crucible accelerator.py
 *                                FOREIGN_PROCESS_FLOOR_BYTES; open question for Crucible to
 *                                publish a "would admit a load" fact instead)
 *
 * NO LOOP. A re-admission needs a read taken after the park. And when the door
 * refused while the last read already said the fact was clear (the preflight
 * and the door disagreed, a race with another client), the next re-admission
 * needs an EDGE: a read after the park that shows the fact held, then one that
 * shows it cleared. At worst that is one resubmission per real change on the
 * server, never one per preflight tick.
 */
import { CrucibleBusy, CrucibleCardHeld, CrucibleLeased, CrucibleRefused, SERVER_BUSY, LEASED } from '@crucible/client';
import type { ResumeStage } from './wire';

/** The server's floor under which a foreign process is not "using the card" (crucible v1.0.34 accelerator.py). */
export const FOREIGN_PROCESS_FLOOR_BYTES = 1024 * 1024 * 1024;

/** The fact a parked job waits on. */
export type ParkWait =
  | { kind: 'accepts_work' }
  | { kind: 'lease_clear'; leaseId: string | null }
  | { kind: 'room'; neededBytes: number }
  | { kind: 'foreign_gone'; pids: number[]; unattributedBytes: number | null }
  /** Nothing selected/pinned, paused, or not answering: re-decided by the venue rule, not the preflight. */
  | { kind: 'venue' };

/** The codes a park carries. The door's are Crucible's own; the venue's are venue-decision.ts's. */
export type ParkCode =
  | 'server_busy' | 'leased' | 'engine_in_use' | 'accelerator_busy' | 'insufficient_memory'
  | 'no_server' | 'paused' | 'unreachable';

export interface ParkRecord {
  readonly jobId: string;
  /** The server that refused, or the one the item is for; null when nothing is selected or pinned. */
  readonly server: string | null;
  readonly fast: boolean;
  readonly stage: ResumeStage;
  readonly code: ParkCode;
  /** The holder's sentence, or the venue's. Shown as `parked — <line>`. */
  readonly line: string;
  readonly wait: ParkWait;
  /** Epoch ms. Only preflight reads taken after this count. */
  readonly at: number;
  /** The door refused while the last read said the fact was clear: the next re-admission needs an edge. */
  needsEdge: boolean;
  /** Under `needsEdge`: a read after the park has shown the fact held. */
  sawHeld: boolean;
}

/** A refusal read as a park, or null when it is not one. */
export interface ParkRefusal {
  readonly code: Exclude<ParkCode, 'no_server' | 'paused' | 'unreachable'>;
  readonly line: string;
  readonly wait: ParkWait;
}

/** One preflight read, reduced to the facts a park waits on. */
export interface PreflightRead {
  /** Epoch ms. */
  readonly at: number;
  /** `slots.accelerated.acceptsWork`; null when the server did not state it (read as not accepting). */
  readonly acceptsWork: boolean | null;
  /** The open lease's id, null when there is none. */
  readonly leaseId: string | null;
  /** Read only while a job is parked on the card's memory (`/v1/accelerator` costs an nvidia-smi). */
  readonly accelerator: { freeBytes: number | null; unattributedBytes: number | null; pids: number[] | null } | null;
}

function detailsOf(err: CrucibleRefused): Record<string, unknown> {
  return err.details !== null && typeof err.details === 'object' ? (err.details as Record<string, unknown>) : {};
}

const bytes = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The refusal this error is, if it is one that parks. Walks `cause` so a
 * refusal wrapped once on its way up is still read as the type it is (never
 * by its message: Law 10).
 */
export function parkRefusalOf(err: unknown): ParkRefusal | null {
  for (let at: unknown = err, depth = 0; at !== undefined && at !== null && depth < 5; at = (at as { cause?: unknown }).cause, depth += 1) {
    if (!(at instanceof CrucibleRefused)) continue;
    if (at instanceof CrucibleBusy || at.code === SERVER_BUSY) {
      return { code: 'server_busy', line: at instanceof CrucibleBusy ? at.busyLine : `GPU busy: ${at.serverMessage}`, wait: { kind: 'accepts_work' } };
    }
    if (at instanceof CrucibleLeased || at.code === LEASED) {
      return {
        code: 'leased',
        line: at instanceof CrucibleLeased ? at.leasedLine : `leased: ${at.serverMessage}`,
        wait: { kind: 'lease_clear', leaseId: at instanceof CrucibleLeased ? at.leaseId : null },
      };
    }
    if (at.code === 'engine_in_use') {
      return { code: 'engine_in_use', line: at instanceof CrucibleCardHeld ? at.heldLine : `busy: ${at.serverMessage}`, wait: { kind: 'accepts_work' } };
    }
    if (at.code === 'accelerator_busy') {
      const details = detailsOf(at);
      const pids = Array.isArray(details.processes)
        ? details.processes.map((row) => (row as { pid?: unknown }).pid).filter((pid): pid is number => typeof pid === 'number')
        : [];
      return { code: 'accelerator_busy', line: `busy: ${at.serverMessage}`, wait: { kind: 'foreign_gone', pids, unattributedBytes: bytes(details.unattributed_bytes) } };
    }
    if (at.code === 'insufficient_memory') {
      const details = detailsOf(at);
      const needed = bytes(details.needed_bytes);
      // Only a measured free figure can change; "ever" (free null) and the Mac's sized room cannot.
      if (needed === null || bytes(details.free_bytes) === null || details.room_bytes !== undefined) return null;
      return { code: 'insufficient_memory', line: `busy: ${at.serverMessage}`, wait: { kind: 'room', neededBytes: needed } };
    }
    return null;
  }
  return null;
}

/** Is the fact this park waits on clear in `read`? Null when the read says nothing about it. */
function factClear(wait: ParkWait, read: PreflightRead): boolean | null {
  switch (wait.kind) {
    case 'accepts_work':
      return read.acceptsWork === true;
    case 'lease_clear':
      return read.leaseId === null;
    case 'room':
      if (read.accelerator === null || read.accelerator.freeBytes === null) return null;
      return read.accelerator.freeBytes >= wait.neededBytes;
    case 'foreign_gone': {
      if (read.accelerator === null) return null;
      const listed = read.accelerator.pids ?? [];
      const gone = wait.pids.every((pid) => !listed.includes(pid));
      const quiet = wait.unattributedBytes === null
        || (read.accelerator.unattributedBytes !== null && read.accelerator.unattributedBytes <= FOREIGN_PROCESS_FLOOR_BYTES);
      return gone && quiet;
    }
    case 'venue':
      return null;
  }
}

/** Does this park need the accelerator read (an nvidia-smi on the server)? */
export function needsAcceleratorRead(park: ParkRecord): boolean {
  return park.wait.kind === 'room' || park.wait.kind === 'foreign_gone';
}

/**
 * Build the park for a refusal, given the last read the preflight had taken
 * before it (null when none): when that read already said the fact was clear,
 * the door and the preflight disagreed, and the next re-admission needs an edge.
 */
export function parkFor(
  refusal: ParkRefusal,
  job: { jobId: string; server: string; fast: boolean; stage: ResumeStage },
  lastRead: PreflightRead | null,
  now: number,
): ParkRecord {
  const clearBefore = lastRead === null ? false : factClear(refusal.wait, lastRead) === true;
  return { ...job, code: refusal.code, line: refusal.line, wait: refusal.wait, at: now, needsEdge: clearBefore, sawHeld: false };
}

/**
 * Feed one preflight read to a park on the same server. Returns true when the
 * job may be tried again. Mutates only the park's edge bookkeeping. PURE
 * otherwise, and the whole no-loop rule.
 */
export function observe(park: ParkRecord, read: PreflightRead): boolean {
  if (park.wait.kind === 'venue' || read.at <= park.at) return false;
  const clear = factClear(park.wait, read);
  if (clear === null) return false;
  if (!clear) {
    park.sawHeld = true;
    return false;
  }
  return !park.needsEdge || park.sawHeld;
}
