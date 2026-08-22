/**
 * IPC for the editor-transcript link (spec PHASE-1-2-SPEC.md §3.2, PR 4).
 *
 * Five channels, all of them ANSWERS — nothing here decides to link anything. The operator
 * confirms every link on the Inputs page; these calls only tell the page what is true:
 *
 *   transcript-find-candidates  which editor stories could this .mov be?
 *   transcript-probe-drift      how far apart are the final cut and the editor timeline?
 *   transcript-resolve-ref      is a stored link still pointing at the file it linked?
 *   transcript-list-stories     the picker's scopes (week / registered projects / browse)
 *   transcript-export-stories   "Export it now" for a story whose transcript was never written
 *
 * Envelope follows the publish/ precedent (`ok` / `fail`) rather than the editor/ one
 * (reject with the verbatim message): the Inputs page renders several of these per item as
 * inline row state, and a rejected promise per row is worse to render than a stated error.
 * A bad ARGUMENT still throws — that is a programming error in the renderer, not a
 * condition the page should paint.
 */

import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';

import type { TranscriptRef } from '../publish/publish-types';
import { PythonService } from '../editor/python-service';
import { EditorPaths } from '../editor/app-config';
import {
  findCandidates,
  isLinkable,
  listProjectStories,
  listWeekStories,
  probeDrift,
  refFromCandidate,
  resolveRef,
  whyNotLinkable,
  type CandidateScan,
  type DriftProbe,
  type TranscriptCandidate,
} from './editor-transcript-link';

/** Uniform envelope, mirroring publish-ipc's so the renderer branches the same way. */
type Result<T> = { success: true; data: T } | { success: false; error: string };

function ok<T>(data: T): Result<T> {
  return { success: true, data };
}
function fail(error: string): Result<never> {
  return { success: false, error };
}

/**
 * A candidate as the renderer sees it: the scan's candidate plus the ready-made ref.
 *
 * `ref` is null exactly when the story's transcript has not been exported yet — that is the
 * candidate the picker offers "Export it now" for, and it is the one thing the renderer
 * must not be able to link. Building the ref here rather than in the renderer keeps one
 * definition of what a ref is made of.
 */
export interface WireCandidate extends TranscriptCandidate {
  ref: TranscriptRef | null;
  /** Why `ref` is null, when it is. Stated so the row never shows an unexplained gap. */
  refUnavailableReason: string | null;
}

/** The scan, with wire candidates. */
export interface WireScan extends Omit<CandidateScan, 'candidates'> {
  candidates: WireCandidate[];
}

/**
 * resolveRef's answer minus the transcript document.
 *
 * The doc holds every word of a story — tens of thousands of objects. Sending it over IPC
 * so the renderer can paint a green tick would be absurd, so `ok` reports the two numbers
 * that prove the file is the one that was linked.
 */
export type WireRefResolution =
  | { state: 'ok'; wordCount: number; durationSeconds: number | null }
  | { state: 'missing'; reason: string }
  | { state: 'changed'; found: { sourceSession: string; storySlug: string; wordCount: number }; reason: string };

/** Where the picker is looking. Progressive scope, one dialog — spec §3.2. */
export type StoryScope =
  | { kind: 'week'; week: string }
  | { kind: 'registered-projects' }
  | { kind: 'project'; projectFolder: string };

let pythonServiceInstance: PythonService | null = null;
function pythonService(): PythonService {
  if (!pythonServiceInstance) pythonServiceInstance = new PythonService();
  return pythonServiceInstance;
}

/** Throw on anything that is not a usable absolute-ish path string. */
function requirePath(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Throw unless `value` is shaped like a TranscriptRef.
 *
 * A shape guard, not a validator: `resolveRef` is the thing that decides whether the ref is
 * still TRUE. This only refuses input that could not have come from this feature at all.
 */
function requireRef(value: unknown, name: string): TranscriptRef {
  const r = value as TranscriptRef;
  if (!r || typeof r !== 'object') {
    throw new Error(`${name} must be a TranscriptRef object, got ${JSON.stringify(value)}`);
  }
  if (r.kind !== 'acs-story') {
    throw new Error(`${name}.kind must be 'acs-story', got ${JSON.stringify(r.kind)}`);
  }
  requirePath(r.path, `${name}.path`);
  requirePath(r.sourceSession, `${name}.sourceSession`);
  requirePath(r.storySlug, `${name}.storySlug`);
  if (typeof r.wordCount !== 'number') {
    throw new Error(`${name}.wordCount must be a number, got ${JSON.stringify(r.wordCount)}`);
  }
  return r;
}

/**
 * Attach the ready-made ref (or the reason there is none) to a candidate.
 *
 * Asks `isLinkable` first rather than catching `refFromCandidate` throwing: "this story has
 * no usable transcript" is an ordinary, expected state of the world — a third of the
 * candidates on a fresh week are in it — and routing an expected state through an exception
 * hides which condition was hit behind whatever message the throw happened to carry.
 */
function toWire(candidate: TranscriptCandidate): WireCandidate {
  if (!isLinkable(candidate)) {
    return { ...candidate, ref: null, refUnavailableReason: whyNotLinkable(candidate) };
  }
  return { ...candidate, ref: refFromCandidate(candidate, candidate.via), refUnavailableReason: null };
}

/** Every editor project folder the registry knows about. Same file editor-ipc reads. */
function registeredProjectFolders(): { folders: string[]; problems: string[] } {
  const problems: string[] = [];
  const registryPath = path.join(EditorPaths.configDir, 'projects.json');
  if (!fs.existsSync(registryPath)) {
    problems.push(`${registryPath} does not exist — no projects have been registered yet`);
    return { folders: [], problems };
  }

  const raw = fs.readFileSync(registryPath, 'utf8');
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`projects registry ${registryPath} is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed?.projects)) {
    throw new Error(`projects registry ${registryPath} has no projects array ` +
      `(projects is ${typeof parsed?.projects})`);
  }

  const folders: string[] = [];
  for (const entry of parsed.projects) {
    if (typeof entry?.path !== 'string' || !entry.path) {
      problems.push(`projects registry holds an entry with no path (${JSON.stringify(entry)})`);
      continue;
    }
    folders.push(entry.path);
  }
  return { folders, problems };
}

/**
 * The cuts and stories `editor:export` needs, read from the project's own edit-state
 * sidecar — the identical file the editor window loads through `editor:load-edits`.
 *
 * This is what makes "Export it now" possible without opening the editor: the sidecar
 * already stores `cuts` as `{startFrame,endFrame}` and `stories` as
 * `{number,title,regions}`, which is exactly the export payload.
 */
function exportPayloadFromSidecar(projectFolder: string): {
  zipPath: string;
  cuts: Array<{ startFrame: number; endFrame: number }>;
  stories: Array<{ number: number; title: string; regions: Array<{ start: number; end: number }> }>;
} {
  const clean = projectFolder.replace(/[\\/]+$/, '');
  if (!fs.existsSync(clean)) {
    throw new Error(`editor project ${clean} does not exist`);
  }

  const zips = fs.readdirSync(clean).filter(n => n.endsWith('_compounds.zip')).sort();
  if (zips.length === 0) {
    throw new Error(`${clean} holds no <session>_compounds.zip — the session has not been ` +
      `processed by the editor, so there is nothing to export transcripts from`);
  }
  if (zips.length > 1) {
    throw new Error(`${clean} holds ${zips.length} compounds zips (${zips.join(', ')}) — ` +
      `which session to export from is ambiguous; open the project in the editor instead`);
  }
  const zipPath = path.join(clean, zips[0]);

  const session = path.basename(zips[0], '_compounds.zip');
  const editsPath = path.join(clean, `${session}_edits.json`);
  if (!fs.existsSync(editsPath)) {
    throw new Error(`${editsPath} does not exist — this session has no saved stories to export`);
  }

  const raw = fs.readFileSync(editsPath, 'utf8');
  let edits: any;
  try {
    edits = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`${editsPath} is not valid JSON: ${e.message}`);
  }

  if (!Array.isArray(edits?.cuts)) {
    throw new Error(`${editsPath} has no cuts array (cuts is ${typeof edits?.cuts})`);
  }
  if (!Array.isArray(edits?.stories) || edits.stories.length === 0) {
    throw new Error(`${editsPath} defines no stories — split the session into stories in the ` +
      `editor before exporting story transcripts`);
  }

  const stories = edits.stories.map((s: any) => {
    if (typeof s?.number !== 'number' || typeof s?.title !== 'string' || !Array.isArray(s?.regions)) {
      throw new Error(`${editsPath}: story ${JSON.stringify(s?.id ?? s)} is missing ` +
        `number/title/regions and cannot be exported`);
    }
    return { number: s.number, title: s.title, regions: s.regions };
  });

  return { zipPath, cuts: edits.cuts, stories };
}

/** Register every transcript-link channel. Called from setupIpcHandlers. */
export function setupTranscriptLinkIpc(): void {
  /**
   * Which editor stories could this final export be? Read-only, no side effects, safe to
   * call for every video item the moment it lands on the Inputs page.
   */
  ipcMain.handle('transcript-find-candidates', async (_e, videoPath: unknown): Promise<Result<WireScan>> => {
    const p = requirePath(videoPath, 'videoPath');
    try {
      const scan = findCandidates(p);
      log.info(`[transcript-link] ${path.basename(p)}: ${scan.classification} ` +
        `(${scan.candidates.length} candidate(s), ${scan.scannedSessions.length} session(s) scanned)`);
      return ok({ ...scan, candidates: scan.candidates.map(toWire) });
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /** ffprobe the final export and compare it to what the transcript claims. */
  ipcMain.handle(
    'transcript-probe-drift',
    async (_e, videoPath: unknown, ref: unknown): Promise<Result<DriftProbe>> => {
      const p = requirePath(videoPath, 'videoPath');
      const r = requireRef(ref, 'ref');
      try {
        return ok(await probeDrift(p, r));
      } catch (err: any) {
        return fail(err?.message || String(err));
      }
    },
  );

  /**
   * Is a stored link still pointing at the file it linked? Three states; `changed` is the
   * one that exists so a re-exported session can never be reused silently.
   */
  ipcMain.handle('transcript-resolve-ref', async (_e, ref: unknown): Promise<Result<WireRefResolution>> => {
    const r = requireRef(ref, 'ref');
    try {
      const resolution = resolveRef(r);
      if (resolution.state === 'ok') {
        return ok({
          state: 'ok',
          wordCount: resolution.doc.words.length,
          durationSeconds: typeof resolution.doc.durationSeconds === 'number'
            ? resolution.doc.durationSeconds
            : null,
        });
      }
      return ok(resolution);
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * The picker's stories, at whichever scope it has widened to. One channel for all three
   * scopes because they differ only in which folders get read — the dialog is one dialog.
   */
  ipcMain.handle(
    'transcript-list-stories',
    async (_e, scope: unknown): Promise<Result<{ candidates: WireCandidate[]; problems: string[] }>> => {
      const s = scope as StoryScope;
      // Argument validation stays OUTSIDE the try, like every other handler here: a bad
      // scope is a renderer bug, and a renderer bug must not be paintable as row state.
      if (!s || typeof s !== 'object' || typeof (s as any).kind !== 'string') {
        throw new Error(`scope must be a StoryScope object, got ${JSON.stringify(scope)}`);
      }
      if (s.kind === 'week') requirePath(s.week, 'scope.week');
      if (s.kind === 'project') requirePath(s.projectFolder, 'scope.projectFolder');
      if (!['week', 'project', 'registered-projects'].includes(s.kind)) {
        throw new Error(`unknown scope kind ${JSON.stringify((s as any).kind)}`);
      }

      try {
        if (s.kind === 'week') {
          const { candidates, problems } = listWeekStories(s.week);
          return ok({ candidates: candidates.map(toWire), problems });
        }
        if (s.kind === 'project') {
          const { candidates, problems } = listProjectStories(s.projectFolder);
          return ok({ candidates: candidates.map(toWire), problems });
        }
        {
          const { folders, problems } = registeredProjectFolders();
          const candidates: WireCandidate[] = [];
          for (const folder of folders) {
            const got = listProjectStories(folder);
            problems.push(...got.problems);
            candidates.push(...got.candidates.map(toWire));
          }
          return ok({ candidates, problems });
        }
      } catch (err: any) {
        return fail(err?.message || String(err));
      }
    },
  );

  /**
   * "Export it now": write the missing per-story transcripts for one editor project.
   *
   * Runs the SAME backend call the editor's export modal runs (`editorExport` with
   * output 'transcripts'), with the cuts and stories read from the project's own edit-state
   * sidecar. No editor window is involved — the sidecar is the editor's saved state, so
   * this exports exactly what the editor would have exported for that project right now.
   *
   * It writes every story in the session, not just the one the operator wanted. That is not
   * over-reach: the exporter's contract is per-session, and a session that keeps no content
   * in any story is an error it raises rather than a partial write.
   */
  ipcMain.handle(
    'transcript-export-stories',
    async (_e, projectFolder: unknown): Promise<Result<{ transcriptsDir: string; storiesEmitted: number }>> => {
      const folder = requirePath(projectFolder, 'projectFolder');
      try {
        const { zipPath, cuts, stories } = exportPayloadFromSidecar(folder);
        log.info(`[transcript-link] exporting story transcripts for ${zipPath} ` +
          `(${stories.length} stories, ${cuts.length} cuts)`);
        const result = await pythonService().editorExport(zipPath, cuts, stories, 'transcripts', false);
        if (!result?.transcriptsDir) {
          throw new Error(`the exporter returned no transcriptsDir: ${JSON.stringify(result)}`);
        }
        // The exporter ALWAYS states how many it wrote, and raises rather than writing
        // zero. Substituting 0 for a missing count would turn a broken response into a
        // success toast reading "Wrote 0 transcript(s)".
        if (typeof result.storiesEmitted !== 'number') {
          throw new Error(
            `the exporter returned storiesEmitted ${JSON.stringify(result.storiesEmitted)}, ` +
            `which is not a number — the export cannot be confirmed`);
        }
        return ok({ transcriptsDir: result.transcriptsDir, storiesEmitted: result.storiesEmitted });
      } catch (err: any) {
        return fail(err?.message || String(err));
      }
    },
  );

  log.info('[transcript-link] IPC handlers registered');
}
