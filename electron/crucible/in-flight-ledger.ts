/**
 * WHAT CONTENTSTUDIO HOLDS ON A CRUCIBLE'S CARD, WRITTEN DOWN THE MOMENT IT HOLDS IT.
 *
 * Ported from Briefcase's backend/src/crucible/in-flight-ledger.ts (BookForge's
 * electron/crucible/in-flight-ledger.ts before it; plan section 13.4). A
 * Crucible job or lease is not a process: nothing this machine does to itself
 * reaches it. A hard kill (a crash, `kill -9`, a force-quit) loses the handle,
 * and the card stays held for an app that no longer exists. So:
 *
 *   one row per job this app submitted and per lease it took,
 *   written synchronously IMMEDIATELY AFTER the server admitted it,
 *   removed when it settles.
 *
 *   <userData>/crucible-in-flight.json
 *   { "rows": [{ server, kind: 'job'|'lease', id, jobType, model, jobId, lastEventId, at }] }
 *
 * `jobId` is ContentStudio's queue job id (the plan's field name), so a stall or
 * a Stop can give back exactly one job's holds, and a log line sits next to a
 * row a person can see. `lastEventId` is the SSE cursor a reconnect resumes
 * from (P5's asr, P7's denoise); null for a lease or a job not yet streamed.
 *
 * The quit sweep and the startup sweep (in-flight-sweep.ts) read it and give
 * back whatever is still listed. They touch ONLY what is listed here: a shared
 * Crucible carries BookForge's, Foundry's and Briefcase's work (and another
 * ContentStudio's, under the same client name), and the only thing this app can
 * honestly claim is an id it wrote down itself.
 *
 * After, not before (BookForge's rule, crucible docs/INTEGRATING-AN-APP.md
 * section 7.5): a row written before the submit names an id nobody has minted
 * yet. The window between the server's answer and this write is a few
 * microseconds of synchronous code, which is why transport.ts calls
 * `CrucibleStepHooks.submitted`/`leased` before its next `await`.
 *
 * Why synchronous: an async write racing a kill is the loss this exists to
 * prevent. Temp-and-rename, like every other record in userData.
 *
 * A missing file is an empty ledger. An unreadable one is read as empty WITH a
 * loud warning, never a throw: this is Briefcase's declared rule (a corrupt
 * record that stopped the app starting would be worse than the hole it fills),
 * and the warning names what it costs, so it is a declared mode, not a silent
 * one (Law 1, Law 8).
 */
import * as fs from 'fs';
import * as path from 'path';

export const CRUCIBLE_IN_FLIGHT_FILE = 'crucible-in-flight.json';

export type InFlightKind = 'job' | 'lease';

export interface CrucibleInFlightEntry {
  /** The registry NAME, never a URL: the sweep resolves it as the door did. */
  readonly server: string;
  /** `job` is cancelled with `DELETE /v1/jobs/{id}`; `lease` is released. */
  readonly kind: InFlightKind;
  /** Crucible's own id: the job id or the lease id. */
  readonly id: string;
  /** The job type (`load-model`, `asr`, …) or `lease`. */
  readonly jobType: string;
  /** The model the row is about, or null. An unload may only ever name one of these. */
  readonly model: string | null;
  /** ContentStudio's queue job id (or a CLI run's id). Empty for a standalone call. */
  readonly jobId: string;
  /** The last SSE event id acted on, for a reconnect; null when nothing has streamed. */
  readonly lastEventId: string | null;
  /** ISO 8601, when this side recorded it. */
  readonly at: string;
}

export function parseInFlightLedger(text: string, onWarn: (line: string) => void = () => undefined): CrucibleInFlightEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    onWarn(`the Crucible in-flight ledger does not parse (${(err as Error).message}); reading it as empty, so a hold a kill left behind cannot be given back until its ttl runs out`);
    return [];
  }
  const rows = (raw as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) {
    onWarn('the Crucible in-flight ledger has no "rows" array; reading it as empty');
    return [];
  }
  const kept: CrucibleInFlightEntry[] = [];
  for (const row of rows) {
    const entry = row as Partial<CrucibleInFlightEntry> | null;
    if (typeof entry?.server !== 'string' || entry.server === ''
      || (entry.kind !== 'job' && entry.kind !== 'lease')
      || typeof entry.id !== 'string' || entry.id === '') {
      onWarn(`dropping a Crucible in-flight row with no server/kind/id: ${JSON.stringify(row)}`);
      continue;
    }
    kept.push({
      server: entry.server,
      kind: entry.kind,
      id: entry.id,
      jobType: typeof entry.jobType === 'string' && entry.jobType !== '' ? entry.jobType : entry.kind,
      model: typeof entry.model === 'string' ? entry.model : null,
      jobId: typeof entry.jobId === 'string' ? entry.jobId : '',
      lastEventId: typeof entry.lastEventId === 'string' ? entry.lastEventId : null,
      at: typeof entry.at === 'string' ? entry.at : '',
    });
  }
  return kept;
}

export function serializeInFlightLedger(entries: readonly CrucibleInFlightEntry[]): string {
  return `${JSON.stringify({ rows: entries }, null, 2)}\n`;
}

function same(row: CrucibleInFlightEntry, server: string, kind: InFlightKind, id: string): boolean {
  return row.server === server && row.kind === kind && row.id === id;
}

/** `entries` with `entry`, replacing a row with the same server+kind+id. PURE. */
export function ledgerWith(entries: readonly CrucibleInFlightEntry[], entry: CrucibleInFlightEntry): CrucibleInFlightEntry[] {
  return [...entries.filter((row) => !same(row, entry.server, entry.kind, entry.id)), entry];
}

/** `entries` without that row. PURE. */
export function ledgerWithout(entries: readonly CrucibleInFlightEntry[], server: string, kind: InFlightKind, id: string): CrucibleInFlightEntry[] {
  return entries.filter((row) => !same(row, server, kind, id));
}

export type InFlightRecord = Omit<CrucibleInFlightEntry, 'at' | 'lastEventId'> & { at?: string; lastEventId?: string | null };

/** The ledger file, read and written synchronously. */
export class InFlightLedger {
  constructor(
    readonly file: string,
    private readonly warn: (line: string) => void = (line) => console.warn(`[crucible] ${line}`),
  ) {}

  static inDir(dir: string, warn?: (line: string) => void, file: string = CRUCIBLE_IN_FLIGHT_FILE): InFlightLedger {
    return new InFlightLedger(path.join(dir, file), warn);
  }

  read(): CrucibleInFlightEntry[] {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn(`could not read ${this.file} (${(err as Error).message}); reading it as empty`);
      }
      return [];
    }
    return parseInFlightLedger(text, this.warn);
  }

  /** Record a job or lease the server has just admitted. Synchronous; never throws. */
  record(entry: InFlightRecord): void {
    this.write(ledgerWith(this.read(), {
      ...entry,
      lastEventId: entry.lastEventId ?? null,
      at: entry.at ?? new Date().toISOString(),
    }));
  }

  /** Move a job row's SSE cursor forward. A row that is gone stays gone. */
  advance(server: string, id: string, lastEventId: string): void {
    const rows = this.read();
    const row = rows.find((candidate) => same(candidate, server, 'job', id));
    if (row === undefined || row.lastEventId === lastEventId) return;
    this.write(ledgerWith(rows, { ...row, lastEventId }));
  }

  /** Forget a row: it settled, was cancelled, or the server no longer has it. Idempotent. */
  settle(server: string, kind: InFlightKind, id: string): void {
    const before = this.read();
    const after = ledgerWithout(before, server, kind, id);
    if (after.length !== before.length) this.write(after);
  }

  /** The rows one ContentStudio job holds, on any server. */
  rowsOf(jobId: string): CrucibleInFlightEntry[] {
    return this.read().filter((row) => row.jobId === jobId);
  }

  /** Ids this app recorded on `server` (every kind): what the sweep and the preflight may call ours. */
  idsOn(server: string): Set<string> {
    return new Set(this.read().filter((row) => row.server === server).map((row) => row.id));
  }

  private write(entries: readonly CrucibleInFlightEntry[]): void {
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temp, serializeInFlightLedger(entries), 'utf-8');
      fs.renameSync(temp, this.file);
    } catch (err) {
      // Never fatal to the work being recorded; loud, because what it costs is
      // the next hard kill's cleanup.
      this.warn(`could not write ${this.file}: ${(err as Error).message}. A hard kill will leave this card held with nothing here to give it back.`);
    }
  }
}
