// electron/services/editor/archive-ledger.ts
//
// WHICH FOLDERS THE OPERATOR HAS DELIBERATELY PUT IN THE ARCHIVE.
//
// The sidebar's green check has always been a claim about THIS session: a folder went up, or
// a dry run found nothing pending, and the mark was earned in front of the user. Quit the app
// and every mark was gone, so a week that had been backed up for a month reopened looking
// exactly like one that had never been touched — and a week that had since drifted by a few
// megabytes looked the same as both.
//
// This file is the missing half: a record of every folder a sync has actually completed on,
// so the next launch knows which rows are the operator's business to keep green. It is NOT
// the mark itself. Nothing here is rendered as a checkmark — the startup pass re-verifies
// each recorded folder against the share, and auto-syncs the ones that have drifted. What
// gets remembered is the INTENT ("this folder is meant to be in the archive"), which survives
// a restart honestly, rather than the VERDICT ("it is in the archive"), which does not.
//
// A folder that was never synced has no entry, is never checked for drift, and is never
// uploaded on its own — the automatic pass can only ever finish a job the operator started.
//
// Written by the main process because that is where completions actually happen: it outlives
// any one window, and the editor window is routinely closed while a multi-hour week upload is
// still running.

import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';

import { EditorPaths } from './app-config';

/** One folder the operator has synced, and when it last completed. */
export interface ArchiveLedgerEntry {
  /** Absolute local folder path — a week folder or a day folder, exactly as it was synced. */
  path: string;
  /** ISO timestamp of the most recent successful sync of that folder. */
  at: string;
}

export interface ArchiveLedger {
  version: number;
  synced: ArchiveLedgerEntry[];
}

/** Beside projects.json and the rest of the user config. */
function ledgerPath(): string {
  return path.join(EditorPaths.configDir, 'archive-synced.json');
}

/**
 * Read the ledger, or THROW naming exactly what is wrong with the file.
 *
 * Same contract as the projects registry it sits beside: a file that has never been written
 * is legitimately empty, and one that EXISTS but cannot be read as a version-1 ledger stops
 * the caller rather than being quietly reset. The record of what the operator has chosen to
 * back up is not something to silently discard and rebuild from nothing.
 */
export function readArchiveLedger(): ArchiveLedger {
  const p = ledgerPath();
  if (!fs.existsSync(p)) return { version: 1, synced: [] };

  const raw = fs.readFileSync(p, 'utf8');
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`archive ledger ${p} is not valid JSON: ${e.message} ` +
      `— fix or delete the file to continue; it will not be overwritten`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`archive ledger ${p} is not an object (got ${Array.isArray(parsed) ? 'an array' : typeof parsed}) ` +
      `— fix or delete the file to continue; it will not be overwritten`);
  }
  if (parsed.version !== 1) {
    throw new Error(`archive ledger ${p} has version ${JSON.stringify(parsed.version)}, expected 1 ` +
      `— fix or delete the file to continue; it will not be overwritten`);
  }
  if (!Array.isArray(parsed.synced)) {
    throw new Error(`archive ledger ${p} has no synced array (synced is ${typeof parsed.synced}) ` +
      `— fix or delete the file to continue; it will not be overwritten`);
  }
  parsed.synced.forEach((entry: any, i: number) => {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path.trim()) {
      throw new Error(`archive ledger ${p} entry ${i} has no non-empty path string ` +
        `— fix or delete the file to continue; it will not be overwritten`);
    }
  });

  return parsed;
}

/** Atomic write: tmp + rename, so a crash mid-write can never corrupt the ledger. */
function writeArchiveLedger(ledger: ArchiveLedger): void {
  const dir = EditorPaths.configDir;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log.info('Created config directory for the archive ledger:', dir);
  }
  const p = ledgerPath();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/** Trailing separators removed, so the same folder is never recorded under two spellings. */
function normalize(localPath: string): string {
  return localPath.replace(/[\\/]+$/, '');
}

/**
 * Record that a sync of this folder completed. Idempotent — a folder synced ten times has one
 * entry, whose timestamp moves.
 *
 * Never throws. The caller is the completion broadcast for a transfer that has ALREADY
 * succeeded, and a bookkeeping failure must not turn a good sync into a reported failure. It
 * is logged as an error rather than swallowed: what it costs is that this folder will not be
 * re-verified on the next launch, and that is worth finding in the log.
 */
export function recordArchived(localPath: string): void {
  const target = normalize(localPath);
  if (!target) return;
  try {
    const ledger = readArchiveLedger();
    const at = new Date().toISOString();
    const existing = ledger.synced.find(e => normalize(e.path) === target);
    if (existing) {
      existing.path = target;
      existing.at = at;
    } else {
      ledger.synced.push({ path: target, at });
    }
    writeArchiveLedger(ledger);
  } catch (err: any) {
    log.error(`[archive] ${target} synced, but the archive ledger could not be updated: ` +
      `${err?.message || String(err)}. It will not be re-verified automatically on the next launch.`);
  }
}

/**
 * Drop this folder and everything under it from the ledger. Called when a local week is
 * deleted: the folder is gone, so there is nothing left to keep in sync with the archive, and
 * an entry naming it would have the next launch check a path that no longer exists.
 *
 * THROWS on a write failure, unlike `recordArchived`. Its caller is the delete handler, which
 * already reports exactly this class of problem ("the folder is gone and the list still names
 * it") rather than leaving the user with a stale record they were never told about.
 */
export function forgetArchivedUnder(folderPath: string): number {
  const root = normalize(folderPath);
  if (!root) return 0;
  const ledger = readArchiveLedger();
  const keep = ledger.synced.filter(e => {
    const p = normalize(e.path);
    return p !== root && !p.startsWith(`${root}${path.sep}`);
  });
  if (keep.length === ledger.synced.length) return 0;
  const dropped = ledger.synced.length - keep.length;
  writeArchiveLedger({ version: 1, synced: keep });
  return dropped;
}
