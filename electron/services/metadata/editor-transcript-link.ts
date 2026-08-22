/**
 * Editor-transcript link: find, probe and resolve the AutoCutStudio story transcript that
 * corresponds to a final export .mov.
 *
 * This module is the FINDING half of Phase 2 (spec PHASE-1-2-SPEC.md §3.1/§3.2). It
 * answers three questions and nothing else:
 *
 *   findCandidates(videoPath)   which editor stories could this .mov be?
 *   probeDrift(videoPath, ref)  how far apart are the final cut and the editor timeline?
 *   resolveRef(ref)             is the linked transcript still the file we linked?
 *
 * It deliberately decides nothing. Measured over all 40 live final exports the hint rate is
 * 75% (17 files match on title, 13 on label, 10 not at all), so auto-linking would be wrong
 * about one time in four — the operator confirms every link, always.
 *
 * It lives in metadata/ rather than publish/ because the thing it finds is FUEL FOR
 * GENERATION, not a publishing field. The `TranscriptRef` it hands back happens to be
 * declared in publish-types because that is where the operator's durable choice is stored.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { TranscriptRef } from '../publish/publish-types';
import { getRuntimePaths, FfprobeBridge } from '../../lib/bridges';

/**
 * How a candidate was matched.
 *
 * `exact-title` — the .mov's basename IS the story title, slot prefix and all. Owen names
 *   most stories in the editor with the slot they will be exported to ("u3 - flashpoint").
 * `label-match` — they agree only after both sides lose their `<slot> - ` prefix. This is
 *   the renumbering case: story "u1 - killing america chapter 11" exported to slot u2.
 */
export type CandidateVia = 'exact-title' | 'label-match';

/**
 * What the scan concluded for one video.
 *
 * `exact` / `label` — exactly one candidate at that tier. Still a hint, not an answer: the
 *                     UI presents it first and never pre-selects it, because a hint the
 *                     operator can walk past is the silent auto-link this all exists to
 *                     prevent.
 * `ambiguous`       — more than one candidate at the winning tier. NEVER pre-selected:
 *                     two sessions in one week really can hold a story of the same name
 *                     (week 2026-08-09 holds "f1 - lindell" twice), and guessing which one
 *                     the export came from is exactly the guess this feature exists to
 *                     avoid.
 * `none`            — nothing matched. A legitimate and sometimes permanent answer: podcast
 *                     compilations have no story and never will (spec Q8).
 */
export type CandidateClassification = 'exact' | 'label' | 'ambiguous' | 'none';

/** One story that could be the source of a final export. */
export interface TranscriptCandidate {
  via: CandidateVia;
  /** The editor project folder (`<week>/files/<session>`) holding this story. */
  projectFolder: string;
  /** The session name, i.e. the `<session>` in `<session>_edits.json`. */
  sourceSession: string;
  storyNumber: number;
  storyTitle: string;
  /** Derived with the same rule editor_export.py `_slugify` uses — the filename key. */
  storySlug: string;
  /** Where the per-story transcript lives, or would live once exported. */
  transcriptPath: string;
  /** Has the story transcript actually been exported? Drives the "Export it now" offer. */
  transcriptExists: boolean;
  /**
   * Set when the transcript file EXISTS but cannot be used (bad JSON, no words array, no
   * duration). Distinct from `!transcriptExists` on purpose: re-running the export is the
   * remedy for one and not the other, so the two must never be shown the same way.
   */
  unreadableReason: string | null;
  /**
   * Read from the transcript file. Both null unless the file exists AND is usable — the
   * candidate is still a real candidate either way, it just cannot be linked yet.
   */
  durationSeconds: number | null;
  wordCount: number | null;
  /**
   * The compounds zip a story-transcript export would run against, or null when the
   * project has none. Reported so the UI can tell the operator which project to open.
   */
  compoundsZipPath: string | null;
}

/** Everything findCandidates knows, including what it could NOT do and why. */
export interface CandidateScan {
  videoPath: string;
  classification: CandidateClassification;
  candidates: TranscriptCandidate[];
  /**
   * The `<week>` folder the scan covered, or null when `videoPath` is not in the
   * `<week>/complete/<name>.mov` layout at all. Null is a FACT about the path, not an
   * error: a video from anywhere else simply has no week of stories to search.
   */
  scannedWeek: string | null;
  /** Session names whose `_edits.json` was read. */
  scannedSessions: string[];
  /**
   * Human-readable statements about anything that stopped the scan being complete — an
   * unreadable edits.json, a story with no title. Never swallowed: an empty candidate list
   * WITH a problem in it means something different from an empty list without one.
   */
  problems: string[];
  /** Stated verbatim in the UI when nothing matched, so "none" is auditable. */
  searchedDescription: string;
}

/** What probeDrift measured. */
export interface DriftProbe {
  /** ffprobe of the final export. */
  finalSec: number;
  /** What the transcript claims its story runs. */
  transcriptSec: number;
  /** finalSec - transcriptSec. Negative means the final cut is SHORTER. */
  driftSec: number;
  /** driftSec as a percentage of transcriptSec. */
  driftPct: number;
}

/** The identity fields a stored ref is checked against. */
export interface RefIdentity {
  sourceSession: string;
  storySlug: string;
  wordCount: number;
}

/** Three-state resolution of a stored ref. Spec §3.1: silent reuse is prohibited. */
export type RefResolution =
  | { state: 'ok'; doc: StoryTranscriptDoc }
  | { state: 'missing'; reason: string }
  | { state: 'changed'; found: RefIdentity; reason: string };

/**
 * The parts of the story transcript this module reads. The full contract is
 * electron/services/metadata/TRANSCRIPT-IMPORT-FORMAT.md; the parser that consumes it is
 * transcript-import.service.ts. Nothing here parses words — only counts them.
 */
export interface StoryTranscriptDoc {
  formatVersion?: number;
  producer?: string;
  sourceSession?: string;
  story?: { number?: number; title?: string; slug?: string; startSeconds?: number };
  language?: string;
  durationSeconds?: number;
  timebase?: string;
  speakers?: unknown[];
  words: unknown[];
  [key: string]: unknown;
}

/**
 * Kebab-case a story title exactly as `editor_export.py::_slugify` does, because the result
 * is a FILENAME we must predict, not a display string. Any divergence here means we look
 * for a transcript under a name the exporter never used, and then report — wrongly — that
 * it was never exported.
 *
 * The character test is `\p{L}\p{N}` rather than `[a-z0-9]` because Python's `str.isalnum()`
 * is Unicode-aware: it KEEPS the accented letters in "Beyoncé" or "Müller", where an
 * ASCII-only test would turn each of them into a separator and predict a different name.
 */
export function slugifyStoryTitle(title: string, storyNumber: number): string {
  const out: string[] = [];
  let prevDash = false;
  for (const ch of (title || '').toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      out.push(ch);
      prevDash = false;
    } else if (!prevDash) {
      out.push('-');
      prevDash = true;
    }
  }
  const slug = out.join('').replace(/^-+/, '').replace(/-+$/, '');
  return slug || `story-${storyNumber}`;
}

/**
 * Make `slug` unique against `seen` (which it mutates) by appending -2, -3, … — the mirror
 * of `editor_export.py::_dedup_slug`.
 *
 * The exporter runs every story in a session through this IN ORDER, so two stories sharing
 * a title are written as `NN-slug.json` and `MM-slug-2.json`. Predicting the bare slug for
 * both would point the second candidate at the FIRST story's transcript — the wrong words,
 * silently, in exactly the duplicate-title case that already makes a match ambiguous.
 */
function dedupSlug(slug: string, seen: Set<string>): string {
  let unique = slug;
  if (seen.has(unique)) {
    let n = 2;
    while (seen.has(`${slug}-${n}`)) n += 1;
    unique = `${slug}-${n}`;
  }
  seen.add(unique);
  return unique;
}

/**
 * Fold a name down to what two humans would call "the same title": lowercase, every run of
 * non-alphanumerics becomes one space. Punctuation and spacing are the only things that
 * differ between "killing america | ch 9" and "killing america ch 9", and neither carries
 * meaning in a filename.
 */
export function normalizeForMatch(value: string): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The `<slot> - ` prefix: an optional one-or-two-letter channel code plus a number
 * ("3 - ", "u12 - ", "f1 - "). Owen renumbers slots per channel between naming a story and
 * exporting it, so 13 of the 40 live exports agree with their story only once this is gone.
 */
const SLOT_PREFIX = /^[a-z]{0,2}\d+ - /i;

/** The title with its slot prefix removed, or unchanged when it has none. */
export function stripSlotPrefix(value: string): string {
  return (value || '').replace(SLOT_PREFIX, '');
}

/** Past this, the link row turns to warning styling and the confirm label says so. */
export const DRIFT_WARN_PCT = 10;

/** Is this drift big enough to warn about? Spec §3.0: warn, never auto-refuse. */
export function isDriftWarning(driftPct: number): boolean {
  return Math.abs(driftPct) > DRIFT_WARN_PCT;
}

/**
 * The `<week>` folder above a `<week>/complete/<name>.mov`, or null for any other layout.
 *
 * The rule is the literal `complete` parent directory — the mirror of editor-ipc's
 * `weekFolderOfProject`, which keys on the literal `files` parent. A date-shaped-name rule
 * would claim weeks the archive never created.
 */
function weekFolderOfExport(videoPath: string): string | null {
  const clean = videoPath.replace(/[\\/]+$/, '');
  const completeDir = path.dirname(clean);
  if (path.basename(completeDir) !== 'complete') return null;
  const week = path.dirname(completeDir);
  return path.basename(week) ? week : null;
}

/** Read and JSON-parse, or throw naming the file. Never returns a partial object. */
function readJson(file: string): any {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
}

/** A story as the edits file describes it, before we know whether it matches anything. */
interface WeekStory {
  projectFolder: string;
  /**
   * The session as a FILENAME COMPONENT: the `<session>` in `<session>_edits.json`, which
   * is also the `<session>` in `<session>_compounds.zip` and therefore in
   * `<session>_stories_transcripts/`. The exporter names that directory from the zip's
   * stem (`_session_name(zip_path)`), so this — not the JSON's `session` field — is the
   * only string that can be trusted to reconstruct the path.
   */
  sessionStem: string;
  /**
   * The session as an IDENTITY, for the ref. Seeded from the edits file and replaced with
   * the transcript's own `sourceSession` the moment that file is readable, because that is
   * the value `resolveRef` will compare against. Two different producers write these two
   * fields; taking the identity from the file it will be checked against makes them equal
   * by construction rather than by luck.
   */
  sourceSession: string;
  storyNumber: number;
  storyTitle: string;
  storySlug: string;
}

/**
 * Every story in every `<week>/files/<session>/<session>_edits.json`.
 *
 * An `_edits.json` that cannot be read becomes a `problems` entry and the scan continues —
 * the operator still deserves the stories from the sessions that DO read, and the problem
 * is stated rather than hidden. It is not a fallback: nothing is substituted for the
 * unreadable session, and the caller is told by name what it did not get.
 */
function collectWeekStories(week: string, problems: string[]): { sessions: string[]; stories: WeekStory[] } {
  const sessions: string[] = [];
  const stories: WeekStory[] = [];

  const filesDir = path.join(week, 'files');
  if (!fs.existsSync(filesDir)) {
    problems.push(`${filesDir} does not exist — this week holds no editor projects to search`);
    return { sessions, stories };
  }

  const sessionDirs = fs.readdirSync(filesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

  for (const sessionDir of sessionDirs) {
    const projectFolder = path.join(filesDir, sessionDir);
    const editsPath = path.join(projectFolder, `${sessionDir}_edits.json`);
    if (!fs.existsSync(editsPath)) continue;   // a project with no saved stories yet

    sessions.push(sessionDir);
    let edits: any;
    try {
      edits = readJson(editsPath);
    } catch (e: any) {
      problems.push(`could not read ${editsPath}: ${e.message}`);
      continue;
    }
    stories.push(...storiesOfEdits(edits, projectFolder, sessionDir, editsPath, problems));
  }

  return { sessions, stories };
}

/** The stories of one parsed edits document, with every unusable entry named in `problems`. */
function storiesOfEdits(
  edits: any,
  projectFolder: string,
  sessionDir: string,
  editsPath: string,
  problems: string[],
): WeekStory[] {
  if (!Array.isArray(edits?.stories)) {
    problems.push(`${editsPath} has no stories array (stories is ${typeof edits?.stories})`);
    return [];
  }
  const sourceSession = typeof edits.session === 'string' && edits.session ? edits.session : sessionDir;

  // Slug uniqueness is per SESSION and depends on story ORDER, exactly as the exporter's
  // `_story_kepts` computes it — including for stories we then skip, which still consume
  // their slug there. So the set is built here, over the whole session, in file order.
  const seenSlugs = new Set<string>();

  const out: WeekStory[] = [];
  for (const s of edits.stories) {
    const storyTitle = typeof s?.title === 'string' ? s.title : '';
    const storyNumber = typeof s?.number === 'number' ? s.number : NaN;
    if (!storyTitle || !Number.isFinite(storyNumber)) {
      problems.push(`${editsPath}: a story has no usable title/number (${JSON.stringify(s?.id ?? s)})`);
      continue;
    }
    out.push({
      projectFolder,
      sessionStem: sessionDir,
      sourceSession,
      storyNumber,
      storyTitle,
      storySlug: dedupSlug(slugifyStoryTitle(storyTitle, storyNumber), seenSlugs),
    });
  }
  return out;
}

/**
 * The compounds zip a story-transcript export would run against, or null.
 *
 * Null when the project holds no zip OR holds more than one: with two, which one the
 * transcript came from is a guess, and this module does not guess.
 */
function findCompoundsZip(projectFolder: string): string | null {
  if (!fs.existsSync(projectFolder)) return null;
  const zips = fs.readdirSync(projectFolder).filter(n => n.endsWith('_compounds.zip')).sort();
  if (zips.length !== 1) return null;
  return path.join(projectFolder, zips[0]);
}

/** Turn a story into a candidate, reading its transcript's numbers when the file is there. */
function toCandidate(story: WeekStory, via: CandidateVia, problems: string[]): TranscriptCandidate {
  const transcriptsDir = path.join(story.projectFolder, `${story.sessionStem}_stories_transcripts`);
  const transcriptPath = path.join(
    transcriptsDir,
    `${String(story.storyNumber).padStart(2, '0')}-${story.storySlug}.json`,
  );

  let sourceSession = story.sourceSession;
  let durationSeconds: number | null = null;
  let wordCount: number | null = null;
  let unreadableReason: string | null = null;

  const transcriptExists = fs.existsSync(transcriptPath);
  if (transcriptExists) {
    try {
      const doc = readJson(transcriptPath) as StoryTranscriptDoc;
      if (!Array.isArray(doc.words)) {
        throw new Error(`it has no words array (words is ${typeof doc.words})`);
      }
      // Identity from the file resolveRef will re-read, so a ref can never be born
      // disagreeing with the document it names.
      if (typeof doc.sourceSession === 'string' && doc.sourceSession) {
        sourceSession = doc.sourceSession;
      }
      durationSeconds = typeof doc.durationSeconds === 'number' ? doc.durationSeconds : null;
      wordCount = doc.words.length;
      if (durationSeconds === null) {
        throw new Error(`it declares durationSeconds ${JSON.stringify(doc.durationSeconds)}`);
      }
    } catch (e: any) {
      // The file is THERE and unusable, which is a different problem from "never exported"
      // and has a different remedy. Saying so keeps the UI from offering an export that
      // would not fix it.
      unreadableReason = `${transcriptPath} exists but cannot be used: ${e.message}`;
      durationSeconds = null;
      wordCount = null;
      problems.push(unreadableReason);
    }
  }

  return {
    via,
    projectFolder: story.projectFolder,
    sourceSession,
    storyNumber: story.storyNumber,
    storyTitle: story.storyTitle,
    storySlug: story.storySlug,
    transcriptPath,
    transcriptExists,
    unreadableReason,
    durationSeconds,
    wordCount,
    compoundsZipPath: findCompoundsZip(story.projectFolder),
  };
}

/**
 * Which editor stories could this final export be?
 *
 * Candidates come purely from the .mov's own path — the week it sits in, and every story in
 * every editor project in that week. Two tiers, tried in order:
 *
 *   1. exact-title: the whole basename equals the whole story title.
 *   2. label-match: they agree once both lose their `<slot> - ` prefix.
 *
 * The first tier that produces anything wins; more than one hit at that tier is `ambiguous`
 * and the UI must not pre-select. Measured over the 40 live exports: 17 files match at tier
 * 1 (one of them ambiguously, against two identically-named stories in different sessions),
 * 13 at tier 2, 10 not at all.
 *
 * A video outside the `<week>/complete/` layout gets an empty scan naming the path it could
 * not interpret. That is a fact about the input, not a failure — it is the correct and
 * complete answer for a video imported from anywhere else.
 */
export function findCandidates(videoPath: string): CandidateScan {
  const problems: string[] = [];
  const week = weekFolderOfExport(videoPath);

  if (!week) {
    return {
      videoPath,
      classification: 'none',
      candidates: [],
      scannedWeek: null,
      scannedSessions: [],
      problems,
      searchedDescription:
        `${videoPath} is not a <week>/complete/<name>.mov final export, so there is no week ` +
        `of editor projects to search`,
    };
  }

  const basename = path.basename(videoPath, path.extname(videoPath));
  const { sessions, stories } = collectWeekStories(week, problems);

  const wantTitle = normalizeForMatch(basename);
  const wantLabel = normalizeForMatch(stripSlotPrefix(basename));

  const exact = stories.filter(s => normalizeForMatch(s.storyTitle) === wantTitle);
  const label = exact.length > 0
    ? []
    : stories.filter(s => normalizeForMatch(stripSlotPrefix(s.storyTitle)) === wantLabel);

  const winners = exact.length > 0 ? exact : label;
  const via: CandidateVia = exact.length > 0 ? 'exact-title' : 'label-match';

  let classification: CandidateClassification;
  if (winners.length === 0) classification = 'none';
  else if (winners.length > 1) classification = 'ambiguous';
  else classification = via === 'exact-title' ? 'exact' : 'label';

  return {
    videoPath,
    classification,
    candidates: winners.map(s => toCandidate(s, via, problems)),
    scannedWeek: week,
    scannedSessions: sessions,
    problems,
    searchedDescription:
      `searched ${stories.length} ${stories.length === 1 ? 'story' : 'stories'} in ` +
      `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'} under ` +
      `${path.join(week, 'files')}`,
  };
}

/**
 * Is the file this ref names still the file that was linked?
 *
 * Three states, because "the file is there" and "the file is what we linked" are different
 * questions, and collapsing them is how a re-exported session silently feeds the wrong
 * words to a generation run:
 *
 *   ok      — present, and its identity matches.
 *   missing — not on disk, or on disk but unreadable / not a story transcript. Callisto is
 *             external and a week can be archived away, so this is expected, not exotic.
 *   changed — present, but sourceSession / story.slug / wordCount disagree. The session was
 *             re-exported. This BLOCKS the run and asks the operator to re-confirm; silently
 *             reusing the new file is prohibited (spec §3.1).
 */
export function resolveRef(ref: TranscriptRef): RefResolution {
  if (!ref || ref.kind !== 'acs-story') {
    throw new Error(`resolveRef: not an acs-story ref (kind=${JSON.stringify((ref as any)?.kind)})`);
  }
  if (!ref.path) {
    throw new Error(`resolveRef: the ref for story "${ref.storyTitle}" has no path`);
  }

  if (!fs.existsSync(ref.path)) {
    return {
      state: 'missing',
      reason:
        `${ref.path} is not on disk — the linked story was "${ref.storyTitle}" ` +
        `(#${ref.storyNumber} of session ${ref.sourceSession})`,
    };
  }

  let doc: StoryTranscriptDoc;
  try {
    doc = readJson(ref.path) as StoryTranscriptDoc;
  } catch (e: any) {
    return { state: 'missing', reason: `${ref.path} exists but cannot be read: ${e.message}` };
  }

  if (!Array.isArray(doc.words)) {
    return {
      state: 'missing',
      reason:
        `${ref.path} has no words array (words is ${typeof doc.words}) — it is not a story ` +
        `transcript`,
    };
  }

  const found: RefIdentity = {
    sourceSession: typeof doc.sourceSession === 'string' ? doc.sourceSession : '',
    storySlug: typeof doc.story?.slug === 'string' ? doc.story.slug : '',
    wordCount: doc.words.length,
  };

  const disagreements: string[] = [];
  if (found.sourceSession !== ref.sourceSession) {
    disagreements.push(
      `sourceSession ${JSON.stringify(found.sourceSession)} != ${JSON.stringify(ref.sourceSession)}`);
  }
  if (found.storySlug !== ref.storySlug) {
    disagreements.push(`story.slug ${JSON.stringify(found.storySlug)} != ${JSON.stringify(ref.storySlug)}`);
  }
  if (found.wordCount !== ref.wordCount) {
    disagreements.push(`wordCount ${found.wordCount} != ${ref.wordCount}`);
  }

  if (disagreements.length > 0) {
    return {
      state: 'changed',
      found,
      reason:
        `${ref.path} is no longer the file that was linked (${disagreements.join('; ')}) — the ` +
        `session was re-exported; re-confirm the link before generating`,
    };
  }

  return { state: 'ok', doc };
}

/**
 * How far apart are the final cut and the editor timeline the words describe?
 *
 * Measured across the one week holding both artifacts, drift runs from −10s to −220s
 * (−23%) and is dominated by FCPX TRIMMING, not ad inserts (spec §3.0). The number is
 * surfaced at link time and warned past ±10%; it is never used to refuse a link, because
 * the operator is the only one who knows whether what he trimmed mattered.
 *
 * Reuses the app's own ffprobe — `getRuntimePaths()` + `FfprobeBridge`, exactly as
 * whisper.service.ts does — so a packaged build probes the binary it ships.
 */
export async function probeDrift(videoPath: string, ref: TranscriptRef): Promise<DriftProbe> {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`cannot probe drift: the final export ${videoPath} does not exist`);
  }

  const resolution = resolveRef(ref);
  if (resolution.state !== 'ok') {
    throw new Error(
      `cannot probe drift: the linked transcript is ${resolution.state} — ${resolution.reason}`);
  }

  const transcriptSec = resolution.doc.durationSeconds;
  if (typeof transcriptSec !== 'number' || !Number.isFinite(transcriptSec) || transcriptSec <= 0) {
    throw new Error(
      `cannot probe drift: ${ref.path} declares durationSeconds ` +
      `${JSON.stringify(transcriptSec)}, which is not a positive number`);
  }

  const ffprobe = new FfprobeBridge(getRuntimePaths().ffprobe);
  const finalSec = await ffprobe.getDuration(videoPath);
  if (!Number.isFinite(finalSec) || finalSec <= 0) {
    throw new Error(`ffprobe reported duration ${finalSec} for ${videoPath}`);
  }

  const driftSec = finalSec - transcriptSec;
  return { finalSec, transcriptSec, driftSec, driftPct: (driftSec / transcriptSec) * 100 };
}

/**
 * Can this candidate be linked at all?
 *
 * A PREDICATE, so callers can disable the button instead of offering one that throws.
 * `refFromCandidate` throwing is the backstop, not the way anyone is meant to find out.
 */
export function isLinkable(candidate: TranscriptCandidate): candidate is LinkableCandidate {
  return candidate.transcriptExists
    && candidate.unreadableReason === null
    && candidate.durationSeconds !== null
    && candidate.wordCount !== null;
}

/** A candidate that has the two numbers a ref is identified by. */
export type LinkableCandidate = TranscriptCandidate & { durationSeconds: number; wordCount: number };

/** Why `isLinkable` said no — phrased so the UI can show it and name the right remedy. */
export function whyNotLinkable(candidate: TranscriptCandidate): string | null {
  if (isLinkable(candidate)) return null;
  if (!candidate.transcriptExists) {
    return `its transcript has never been exported (${candidate.transcriptPath}) — export ` +
      `story transcripts for session ${candidate.sourceSession} first`;
  }
  if (candidate.unreadableReason) return candidate.unreadableReason;
  return `${candidate.transcriptPath} is missing the duration or word count a link is identified by`;
}

/**
 * Build the durable `TranscriptRef` for a candidate the operator picked.
 *
 * Throws when the candidate has no exported transcript: a ref carries `durationSeconds` and
 * `wordCount` as the identity that lets `resolveRef` ever say "changed", and a ref without
 * them could only resolve to a shrug.
 */
export function refFromCandidate(candidate: TranscriptCandidate, via: TranscriptRef['via']): TranscriptRef {
  if (!isLinkable(candidate)) {
    throw new Error(`cannot link "${candidate.storyTitle}": ${whyNotLinkable(candidate)}`);
  }
  return {
    kind: 'acs-story',
    path: candidate.transcriptPath,
    sourceSession: candidate.sourceSession,
    projectFolder: candidate.projectFolder,
    storyNumber: candidate.storyNumber,
    storySlug: candidate.storySlug,
    storyTitle: candidate.storyTitle,
    durationSeconds: candidate.durationSeconds,
    wordCount: candidate.wordCount,
    linkedAt: new Date().toISOString(),
    via,
  };
}

/**
 * Every story in every editor project of one week — the picker's second scope.
 *
 * Same reader `findCandidates` uses, so the picker can never offer a story the finder would
 * have described differently. `via` is reported as 'label-match' because these are not
 * matches at all; whatever the operator picks here is recorded as 'manual'.
 */
export function listWeekStories(week: string): { candidates: TranscriptCandidate[]; problems: string[] } {
  const problems: string[] = [];
  const { stories } = collectWeekStories(week, problems);
  return { candidates: stories.map(s => toCandidate(s, 'label-match', problems)), problems };
}

/** Every story in one editor project folder — the picker's registered-projects and browse scopes. */
export function listProjectStories(projectFolder: string): { candidates: TranscriptCandidate[]; problems: string[] } {
  const problems: string[] = [];
  const clean = projectFolder.replace(/[\\/]+$/, '');
  const sessionDir = path.basename(clean);
  const editsPath = path.join(clean, `${sessionDir}_edits.json`);

  if (!fs.existsSync(editsPath)) {
    problems.push(`${editsPath} does not exist — ${clean} is not an editor project with saved stories`);
    return { candidates: [], problems };
  }

  let edits: any;
  try {
    edits = readJson(editsPath);
  } catch (e: any) {
    problems.push(`could not read ${editsPath}: ${e.message}`);
    return { candidates: [], problems };
  }

  const stories = storiesOfEdits(edits, clean, sessionDir, editsPath, problems);
  return { candidates: stories.map(s => toCandidate(s, 'label-match', problems)), problems };
}
