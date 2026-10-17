/**
 * The one move of the OLD saved-transcript store into sidecars beside the videos (LEDGER #313).
 *
 * Until #313 every record lived in `<output-dir>/.contentstudio/transcripts/<sourceKey>.json`.
 * Now a record lives beside its video (saved-transcript.service.ts `savedTranscriptPathFor`), and
 * nothing reads the old store. There is deliberately NO read-fallback to it: a reader that looked
 * in two places would be a reader whose answer depends on which one it tried first. Instead the
 * old records are MOVED, explicitly, at app start:
 *
 *   - a record whose video is still on disk with the size and mtime it was transcribed from, of
 *     the schema this build reads, with no sidecar already beside the video, is copied to its
 *     sidecar (written aside and renamed, then read back and compared), and only then deleted
 *     from the old store. Each move is logged with both paths.
 *   - every other record is LEFT UNTOUCHED, with one log line saying why (its video is gone or
 *     not mounted, the video changed since, another schema, unreadable, a sidecar already there).
 *     It is never deleted: it stays in the old folder, which nothing reads, for Owen to bin.
 *
 * ONCE. The store records when it ran (`savedTranscriptMigratedAt`) and a later start does not
 * run it again: on this install most old records name videos whose weeks have since been deleted
 * or moved to the NAS (134 of 143 on 2026-10-17), and they would otherwise be listed again in the
 * log at every start. The cost is stated: a video that was on an unmounted volume at that one
 * start keeps its record in the old store and is transcribed again when next queued. The inputs
 * page's probe and a run's input stage wait for the move (`savedTranscriptMigrationSettled`), so a
 * record being moved is never reported as missing.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';

import { SAVED_TRANSCRIPT_SCHEMA_VERSION, savedTranscriptPathFor } from './saved-transcript.service';

/** Where the old store kept its records: `<output-dir>/.contentstudio/transcripts`. Read only here. */
export function legacySavedTranscriptDir(outputDir: string): string {
  return path.join(outputDir, '.contentstudio', 'transcripts');
}

/** What the move does with one old record, and why. Pure: the facts are gathered by the caller. */
export type LegacyRecordDecision =
  | { action: 'move'; videoPath: string; sidecarPath: string }
  | { action: 'leave'; reason: string };

export interface LegacyRecordFacts {
  /** The parsed old record, or the parse error's message. */
  record: unknown;
  parseError: string | null;
  /** `fs.stat` of the record's `source_path`, or null when it could not be read (with why). */
  video: { size: number; mtimeMs: number } | null;
  videoError: string | null;
  /** Whether a sidecar already exists beside the video. */
  sidecarExists: boolean;
}

/**
 * Move it, or leave it and say why. As strict as the reader (saved-transcript.service.ts
 * `inspectSavedTranscript`): a record the reader would refuse is not moved, because a moved record
 * the reader then refuses is a checkbox that appears for nothing. A sidecar already beside the
 * video wins: it was written by a run of this build, so it is the newer word on that video.
 */
export function decideLegacyRecord(facts: LegacyRecordFacts): LegacyRecordDecision {
  if (facts.parseError !== null) return { action: 'leave', reason: `it cannot be read: ${facts.parseError}` };
  const record = facts.record as Record<string, any> | null;
  if (!record || typeof record !== 'object') return { action: 'leave', reason: 'it is not a record' };
  if (record.schema_version !== SAVED_TRANSCRIPT_SCHEMA_VERSION) {
    return {
      action: 'leave',
      reason: `it is schema_version ${JSON.stringify(record.schema_version)}, and this build reads ${SAVED_TRANSCRIPT_SCHEMA_VERSION}`,
    };
  }
  const videoPath = record.source_path;
  if (typeof videoPath !== 'string' || !path.isAbsolute(videoPath)) {
    return { action: 'leave', reason: `it names no absolute video path (source_path ${JSON.stringify(videoPath)})` };
  }
  if (!Array.isArray(record.segments) || record.segments.length === 0) {
    return { action: 'leave', reason: 'it has no segments' };
  }
  if (facts.video === null) {
    return { action: 'leave', reason: `its video ${videoPath} cannot be read (${facts.videoError ?? 'no reason given'}); it is left in the old store, which nothing reads` };
  }
  const saved = record.video;
  if (!saved || typeof saved.size !== 'number' || typeof saved.mtimeMs !== 'number') {
    return { action: 'leave', reason: 'it carries no video stamp to verify' };
  }
  if (saved.size !== facts.video.size || Math.round(saved.mtimeMs) !== Math.round(facts.video.mtimeMs)) {
    return {
      action: 'leave',
      reason: `its video ${videoPath} has changed since it was transcribed (${saved.size} bytes at ` +
        `${Math.round(saved.mtimeMs)} then, ${facts.video.size} bytes at ${Math.round(facts.video.mtimeMs)} now)`,
    };
  }
  const sidecarPath = savedTranscriptPathFor(videoPath);
  if (facts.sidecarExists) {
    return { action: 'leave', reason: `a saved transcript already sits beside the video (${sidecarPath}), written since` };
  }
  return { action: 'move', videoPath, sidecarPath };
}

/** Copy aside, rename into place, read back and compare, then delete the old record. */
async function moveRecord(from: string, to: string, bytes: Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  const temp = `${to}.writing`;
  await fs.promises.writeFile(temp, bytes);
  await fs.promises.rename(temp, to);
  const written = await fs.promises.readFile(to);
  if (!written.equals(bytes)) {
    throw new Error(`the copy at ${to} does not read back as the record that was written`);
  }
  await fs.promises.unlink(from);
}

export interface MigrationSummary {
  moved: number;
  left: number;
}

/** Move what can be moved out of each old store directory. Never throws: every outcome is logged. */
export async function migrateLegacySavedTranscripts(outputDirs: string[]): Promise<MigrationSummary> {
  const summary: MigrationSummary = { moved: 0, left: 0 };
  for (const outputDir of [...new Set(outputDirs.map((d) => path.resolve(d)))]) {
    const dir = legacySavedTranscriptDir(outputDir);
    let names: string[];
    try {
      names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    } catch (error: any) {
      if (error?.code === 'ENOENT') continue;
      log.error(`[SavedTranscriptMigration] The old store ${dir} cannot be listed (${error?.message ?? String(error)}); nothing in it was moved`);
      continue;
    }
    if (names.length === 0) continue;
    log.info(`[SavedTranscriptMigration] ${names.length} record(s) in the old store ${dir}; moving each beside its video (LEDGER #313)`);

    for (const name of names) {
      const from = path.join(dir, name);
      let bytes: Buffer | null = null;
      const facts: LegacyRecordFacts = { record: null, parseError: null, video: null, videoError: null, sidecarExists: false };
      try {
        bytes = await fs.promises.readFile(from);
        facts.record = JSON.parse(bytes.toString('utf-8'));
      } catch (error) {
        facts.parseError = error instanceof Error ? error.message : String(error);
      }
      const videoPath = (facts.record as any)?.source_path;
      if (facts.parseError === null && typeof videoPath === 'string' && path.isAbsolute(videoPath)) {
        try {
          const stats = await fs.promises.stat(videoPath);
          facts.video = { size: stats.size, mtimeMs: stats.mtimeMs };
          facts.sidecarExists = fs.existsSync(savedTranscriptPathFor(videoPath));
        } catch (error) {
          facts.videoError = error instanceof Error ? error.message : String(error);
        }
      }

      const decision = decideLegacyRecord(facts);
      if (decision.action === 'leave') {
        summary.left += 1;
        log.warn(`[SavedTranscriptMigration] Left ${from} where it is: ${decision.reason}`);
        continue;
      }
      try {
        await moveRecord(from, decision.sidecarPath, bytes as Buffer);
        summary.moved += 1;
        log.info(`[SavedTranscriptMigration] Moved ${from} -> ${decision.sidecarPath}`);
      } catch (error) {
        summary.left += 1;
        const reason = error instanceof Error ? error.message : String(error);
        log.error(
          `[SavedTranscriptMigration] Could not move ${from} beside its video (${decision.sidecarPath}): ${reason}. ` +
          `The old record is left where it is; nothing reads it there.`
        );
      }
    }

    // An emptied old store is removed, so a later start sees no folder rather than an empty one.
    try {
      if ((await fs.promises.readdir(dir)).length === 0) {
        await fs.promises.rmdir(dir);
        log.info(`[SavedTranscriptMigration] The old store ${dir} is empty and was removed`);
      }
    } catch (error) {
      log.warn(`[SavedTranscriptMigration] Could not remove the emptied old store ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (summary.moved + summary.left > 0) {
    log.info(`[SavedTranscriptMigration] Done: ${summary.moved} moved beside their videos, ${summary.left} left in the old store`);
  }
  return summary;
}

let settled: Promise<MigrationSummary | null> | null = null;

/** Where main keeps the one fact this needs between starts: when the move ran (ISO), if it has. */
export interface MigrationRecord {
  ranAt(): string | undefined;
  markRan(at: string): void;
}

/**
 * Started by main at boot with the output directories whose old stores to empty, and run only if
 * the store says it never ran. Marked as run once it has finished, whatever it left behind.
 */
export function startSavedTranscriptMigration(outputDirs: string[], record: MigrationRecord): Promise<MigrationSummary | null> {
  if (settled !== null) return settled;
  const ranAt = record.ranAt();
  if (ranAt) {
    log.info(`[SavedTranscriptMigration] The old output-directory store was moved beside the videos on ${ranAt}; not run again (LEDGER #313)`);
    settled = Promise.resolve(null);
    return settled;
  }
  settled = migrateLegacySavedTranscripts(outputDirs).then((summary) => {
    record.markRan(new Date().toISOString());
    return summary;
  });
  return settled;
}

/**
 * Resolves when the move has finished, so a probe or a run never reports a record as missing
 * while it is being moved. Resolves at once in a process that never started one (the CLI, the
 * checks): there the old store is simply not read.
 */
export async function savedTranscriptMigrationSettled(): Promise<void> {
  if (settled !== null) await settled;
}
