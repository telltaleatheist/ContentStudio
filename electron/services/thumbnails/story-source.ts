/**
 * WHERE A STORY'S THUMBNAIL FRAMES COME FROM (Owen, 2026-09-28): the clean SCREEN RECORDING,
 * and only over the stretches that made it into this story.
 *
 * The report's own video is the finished export, a layout of Owen's camera and the screen
 * together, so a frame from it is never a clean background. The editor knows which stretches of
 * the night a story is made of; this module turns that into times in the screen recording's own
 * clock, in four steps, each of them the editor's own rule rather than a new one:
 *
 *   1. The story's regions minus the session's cuts, on the editor's timeline
 *      (editor_export.py `subtract_cuts`: cuts are half-open frame ranges x the manifest's
 *      frameSeconds). The regions are the story as drawn, NOT the export's padded shoulders
 *      (story-utils.ts STORY_EXPORT_PAD_SECONDS): the shoulders are trimmed in FCPX.
 *   2. Timeline -> master file, through the timeline's segment table (the editor's manifest,
 *      built by the editor's own builder), with the shared map (electron/shared/
 *      master-timeline-map.ts `timelineRangeToMaster`). The timeline is NOT the recording: the
 *      processing step removed the dead air, so one story is dozens of pieces of the master.
 *   3. Master -> screen recording, through the session's alignment record
 *      (`<session>_alignment.json`, the video/screen entry): `masterToSource`, offset and rate.
 *   4. Cut to the screen recording's own length (a stretch before it started or after it ended
 *      has no picture), and the seconds left out are said.
 *
 * Before step 2 the kept timeline is cut to the part of the story the FINAL EXPORT is (Owen,
 * 2026-11-09, LEDGER #346): from the first to the last place the export's transcript matches the
 * story's (export-span.ts). He trims each story's head and tail in FCPX, and a trimmed head still
 * shows the previous story on screen. The span is found in editor TIMELINE seconds (the session
 * transcript's timelineStart/End, the base of the regions and cuts), so it is intersected with the
 * kept timeline as it is, and everything after that (segment table, alignment) is unchanged. No
 * span found is a refusal on the record's source lines (StorySpanRefused), never the whole story.
 *
 * Every missing or doubtful input is refused by name (Law 1): no alignment record, an untrusted
 * screen alignment, no screen recording, a recording in parts, a manifest whose picture is not
 * the master the alignment was measured against.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  masterToSource,
  orderSegmentsBySource,
  timelineRangeToMaster,
  type SourcePlacement,
  type TimelineSegment,
} from '../../shared/master-timeline-map';
import { storyEditsOf } from '../metadata/editor-transcript-link';
import { sessionOfMaster, sessionVideoPatterns } from '../editor/session-sources';
import type { TranscriptRef } from '../publish/publish-types';
import { clock } from './frame-sampler';
import { findExportSpan, type ExportSpan, type TimelineWord } from './export-span';

export interface Span {
  start: number;
  end: number;
}

const EPS = 1e-6;

function merged(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.end - s.start > EPS).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end + EPS) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

export function totalSeconds(spans: readonly Span[]): number {
  return spans.reduce((sum, s) => sum + (s.end - s.start), 0);
}

/**
 * A story's regions minus the cuts, merged, in timeline seconds. The mirror of the editor's export
 * (`_story_kepts`: each region minus every cut, `subtract_cuts` half-open), with the cut frames
 * turned into seconds by the manifest's frame length, as `_validate_cuts` does.
 */
export function keptTimeline(regions: readonly Span[], cuts: ReadonlyArray<{ startFrame: number; endFrame: number }>, frameSeconds: number): Span[] {
  if (!(frameSeconds > 0)) throw new Error(`The timeline's frame length is ${frameSeconds}, so its cuts cannot be placed.`);
  const cutSpans = merged(cuts.map((c) => ({ start: c.startFrame * frameSeconds, end: c.endFrame * frameSeconds })));
  const kept: Span[] = [];
  for (const region of merged(regions.map((r) => ({ ...r })))) {
    let cur = region.start;
    for (const cut of cutSpans) {
      if (cut.end <= cur || cut.start >= region.end) continue;
      if (cut.start > cur) kept.push({ start: cur, end: cut.start });
      cur = Math.max(cur, cut.end);
      if (cur >= region.end) break;
    }
    if (cur < region.end) kept.push({ start: cur, end: region.end });
  }
  return merged(kept);
}

/** The manifest facts the mapping needs: the frame length and the picture's segment table. */
export interface ManifestFacts {
  frameSeconds: number;
  timelineDuration: number;
  /** The one file every picture segment plays (the session master). */
  masterFile: string;
  /** The video track's segments, ordered by orderSegmentsBySource. */
  segments: TimelineSegment[];
}

/** Read the editor manifest (editor_manifest.py's shape) for the mapping, refusing anything unusable. */
export function manifestFacts(manifest: unknown, zipPath: string): ManifestFacts {
  const m = manifest as { frameSeconds?: unknown; timelineDuration?: unknown; segments?: unknown };
  if (!m || typeof m !== 'object') throw new Error(`The editor manifest for ${zipPath} is not an object.`);
  const frameSeconds = Number(m.frameSeconds);
  const timelineDuration = Number(m.timelineDuration);
  if (!(frameSeconds > 0)) throw new Error(`The editor manifest for ${zipPath} gives no frame length (frameSeconds ${JSON.stringify(m.frameSeconds)}).`);
  if (!(timelineDuration > 0)) throw new Error(`The editor manifest for ${zipPath} gives no timeline length.`);
  if (!Array.isArray(m.segments)) throw new Error(`The editor manifest for ${zipPath} has no segments.`);
  const video = (m.segments as Array<Record<string, unknown>>).filter((s) => s && s.trackId === 'video');
  if (video.length === 0) throw new Error(`The editor manifest for ${zipPath} has no picture (video track) segments.`);
  const files = [...new Set(video.map((s) => s.file))];
  if (files.length !== 1 || typeof files[0] !== 'string') {
    throw new Error(`The editor timeline for ${zipPath} plays its picture from ${files.length} files (${files.join(', ')}), not one master, so there is no one master clock to map through.`);
  }
  const segments = orderSegmentsBySource(video.map((s) => ({ sourceStart: Number(s.sourceStart), timelineStart: Number(s.timelineStart), duration: Number(s.duration) })));
  return { frameSeconds, timelineDuration, masterFile: files[0], segments };
}

/** The screen recording's entry in the alignment record, checked. */
export interface ScreenAlignment {
  masterVideo: string;
  offsetSeconds: number;
  /** The recorded drift factor, or null when the record holds none. */
  driftFactor: number | null;
  method: string;
  confidence: number | null;
}

/**
 * The video/screen entry of `<session>_alignment.json` (electron_workflow.py
 * `_write_alignment_sidecar`). Refused when absent, duplicated, malformed or not trusted.
 */
export function screenAlignment(record: unknown, alignmentPath: string): ScreenAlignment {
  const r = record as { masterVideo?: unknown; sources?: unknown };
  if (!r || typeof r !== 'object' || typeof r.masterVideo !== 'string' || !Array.isArray(r.sources)) {
    throw new Error(`${alignmentPath} is not an alignment record (it needs masterVideo and sources).`);
  }
  const screens = (r.sources as Array<Record<string, unknown>>).filter((s) => s && s.kind === 'video' && s.type === 'screen');
  if (screens.length === 0) {
    throw new Error(`${alignmentPath} holds no alignment for a screen recording, so this session has no screen recording placed against its master.`);
  }
  if (screens.length > 1) throw new Error(`${alignmentPath} holds ${screens.length} screen recording alignments; which one to use is not stated.`);
  const s = screens[0];
  const method = typeof s.method === 'string' ? s.method : 'unstated';
  if (s.trusted !== true) {
    throw new Error(
      `The screen recording's alignment in ${alignmentPath} is ${s.trusted === false ? 'marked untrusted' : 'not marked trusted'} ` +
        `(${method}${typeof s.confidence === 'number' ? `, confidence ${s.confidence.toFixed(2)}` : ''}), so its times cannot be relied on. ` +
        'Check the alignment in the editor and process the session again.',
    );
  }
  const offsetSeconds = Number(s.offsetSeconds);
  if (typeof s.offsetSeconds !== 'number' || !Number.isFinite(offsetSeconds)) {
    throw new Error(`The screen recording's offset in ${alignmentPath} is not a number (${JSON.stringify(s.offsetSeconds)}).`);
  }
  if (s.driftFactor !== null && s.driftFactor !== undefined && !(typeof s.driftFactor === 'number' && s.driftFactor > 0)) {
    throw new Error(`The screen recording's drift factor in ${alignmentPath} is not a positive number (${JSON.stringify(s.driftFactor)}).`);
  }
  return {
    masterVideo: r.masterVideo,
    offsetSeconds,
    driftFactor: typeof s.driftFactor === 'number' ? s.driftFactor : null,
    method,
    confidence: typeof s.confidence === 'number' ? s.confidence : null,
  };
}

/**
 * The placement masterToSource uses. A recorded drift factor is the rate. With none recorded
 * (driftFactor null: no manual override was set), the record states no retime, and the screen
 * recording is read at the master's rate; the caller declares that in the run's lines (Law 8).
 */
export function placementOf(a: ScreenAlignment): SourcePlacement {
  return { offsetSeconds: a.offsetSeconds, rate: a.driftFactor ?? 1 };
}

/** What a story maps to, before any file is read: the pure core, pinned by the checks. */
export interface StoryPlan {
  /** Regions minus cuts, cut to the export's span, timeline seconds. */
  timeline: Span[];
  /** Seconds of the kept story before the export's span starts, and after it ends (left out). */
  beforeSeconds: number;
  afterSeconds: number;
  /** The master-file pieces those are made of, merged where they touch. */
  master: Span[];
  /** The same stretches in the screen recording's own seconds, cut to its length. */
  screen: Span[];
  /** Seconds of the story that fall outside the screen recording (before it began or after it ended). */
  outsideSeconds: number;
  /** Seconds of the story's kept timeline the segment table does not cover (past its end). */
  unmappedSeconds: number;
}

/** The kept timeline cut to [within.start, within.end], with the seconds left out before and after. */
export function withinSpan(kept: readonly Span[], within: Span): { timeline: Span[]; beforeSeconds: number; afterSeconds: number } {
  const timeline: Span[] = [];
  let beforeSeconds = 0;
  let afterSeconds = 0;
  for (const s of kept) {
    beforeSeconds += Math.max(0, Math.min(s.end, within.start) - s.start);
    afterSeconds += Math.max(0, s.end - Math.max(s.start, within.end));
    const lo = Math.max(s.start, within.start);
    const hi = Math.min(s.end, within.end);
    if (hi - lo > EPS) timeline.push({ start: lo, end: hi });
  }
  return { timeline, beforeSeconds, afterSeconds };
}

export function planStory(input: {
  regions: readonly Span[];
  cuts: ReadonlyArray<{ startFrame: number; endFrame: number }>;
  manifest: ManifestFacts;
  placement: SourcePlacement;
  screenDuration: number;
  /** The part of the story in the final export (findExportSpan), editor timeline seconds. */
  within: Span;
}): StoryPlan {
  const kept = keptTimeline(input.regions, input.cuts, input.manifest.frameSeconds);
  if (kept.length === 0) throw new Error('Every second of this story is cut, so there is nothing to take frames from.');
  const { timeline, beforeSeconds, afterSeconds } = withinSpan(kept, input.within);
  if (timeline.length === 0) throw new Error('No kept second of this story lies between the export\'s first and last transcript match.');
  const pieces = timeline.flatMap((span) => timelineRangeToMaster(input.manifest.segments, span.start, span.end));
  const master = merged(pieces.map((p) => ({ start: p.masterStart, end: p.masterStart + p.duration })));
  const unmappedSeconds = Math.max(0, totalSeconds(timeline) - pieces.reduce((sum, p) => sum + p.duration, 0));
  const screen: Span[] = [];
  let outsideSeconds = 0;
  for (const span of master) {
    const a = masterToSource(input.placement, span.start);
    const b = masterToSource(input.placement, span.end);
    const lo = Math.max(0, a);
    const hi = Math.min(input.screenDuration, b);
    outsideSeconds += (b - a) - Math.max(0, hi - lo);
    if (hi - lo > EPS) screen.push({ start: lo, end: hi });
  }
  if (screen.length === 0) throw new Error('No second of this story falls inside the screen recording.');
  return { timeline, beforeSeconds, afterSeconds, master, screen: merged(screen), outsideSeconds, unmappedSeconds };
}

/** Everything the tab states about where a run's frames come from. */
export interface StorySource {
  storyTitle: string;
  storyNumber: number;
  session: string;
  projectFolder: string;
  screenFile: string;
  alignment: ScreenAlignment;
  /** The export's span in the story (found: ok true). */
  span: Extract<ExportSpan, { ok: true }>;
  plan: StoryPlan;
  lines: string[];
}

/**
 * No span of the story could be matched to the export: no frames are taken. `lines` are the source
 * lines the record keeps, the last one the refusal itself.
 */
export class StorySpanRefused extends Error {
  constructor(readonly screenFile: string, readonly lines: string[], reason: string) {
    super(reason);
    this.name = 'StorySpanRefused';
  }
}

export interface StorySourceDeps {
  /** The editor's manifest for a compounds zip (PythonService.editorManifest, the editor's own builder). */
  manifest: (zipPath: string) => Promise<unknown>;
  /** A video's length in seconds (ffprobe). */
  duration: (video: string) => Promise<number>;
}

function readJsonFile(file: string, what: string): unknown {
  if (!fs.existsSync(file)) throw new Error(`${what} is not on disk: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
}

/**
 * The session transcript's words (`<session>_transcript.json`, cli/transcribe.py), editor timeline
 * seconds. Its frame length must be the timeline's, as the exporter requires before it builds the
 * story transcripts from it (`_load_transcript_sidecar`).
 */
export function sessionTranscriptWords(doc: unknown, file: string, frameSeconds: number): TimelineWord[] {
  const d = doc as { frameSeconds?: unknown; words?: unknown };
  if (!d || typeof d !== 'object' || !Array.isArray(d.words)) throw new Error(`${file} has no words list, so the story's transcript cannot be read.`);
  if (typeof d.frameSeconds !== 'number' || Math.abs(d.frameSeconds - frameSeconds) > 1e-9) {
    throw new Error(`${file} gives the frame length ${JSON.stringify(d.frameSeconds)}, the editor timeline ${frameSeconds}, so the transcript is not of this timeline.`);
  }
  return (d.words as Array<Record<string, unknown>>).map((w, i) => {
    if (!w || typeof w.text !== 'string' || !Number.isFinite(w.timelineStart) || !Number.isFinite(w.timelineEnd)) {
      throw new Error(`${file}: word ${i + 1} has no text or timeline times (${JSON.stringify(w)}).`);
    }
    return { text: w.text, start: Number(w.timelineStart), end: Number(w.timelineEnd) };
  });
}

/** The one `<session>_compounds.zip` of a project folder (the editor's session file). */
export function compoundsZipOf(projectFolder: string): string {
  if (!fs.existsSync(projectFolder)) throw new Error(`The editor project folder is not on disk (is the drive plugged in?): ${projectFolder}`);
  const zips = fs.readdirSync(projectFolder).filter((n) => n.endsWith('_compounds.zip')).sort();
  if (zips.length === 0) throw new Error(`${projectFolder} holds no <session>_compounds.zip, so the session was never processed by the editor.`);
  if (zips.length > 1) throw new Error(`${projectFolder} holds ${zips.length} compounds zips (${zips.join(', ')}); which session the story belongs to is not stated.`);
  return path.join(projectFolder, zips[0]);
}

/** The session's screen recording beside its master, by the editor's own naming rule. */
export function screenRecordingOf(masterVideo: string): string {
  const dir = path.dirname(masterVideo);
  if (!fs.existsSync(dir)) throw new Error(`The session folder is not on disk (is the drive plugged in?): ${dir}`);
  const { session } = sessionOfMaster(masterVideo);
  const patterns = sessionVideoPatterns(session);
  const names = fs.readdirSync(dir);
  const firsts = names.filter((n) => patterns.screenVideo.test(n));
  const parts = names.filter((n) => patterns.screenVideo2.test(n) || patterns.screenVideo3.test(n));
  if (firsts.length === 0) throw new Error(`There is no screen recording ("${session} screen capture.mp4") beside the master in ${dir}.`);
  if (firsts.length > 1) throw new Error(`${dir} holds ${firsts.length} first-part screen recordings (${firsts.join(', ')}); which one was used is not stated.`);
  if (parts.length > 0) {
    throw new Error(
      `The screen recording of this session is in parts (${[...firsts, ...parts].join(', ')}). The processing step joins the parts before it ` +
        'aligns them, and the alignment record does not say where each part starts, so frames cannot be placed in them.',
    );
  }
  return path.join(dir, firsts[0]);
}

/**
 * From an item's story link to the screen recording's stretches, with the lines the tab shows.
 * `exportText` is the final export's own transcript (the item's segments, as the story match reads
 * them); the stretches are only the part of the story between its first and last match.
 */
export async function resolveStorySource(ref: TranscriptRef, exportText: string, deps: StorySourceDeps): Promise<StorySource> {
  const edits = storyEditsOf(ref.projectFolder, ref.storyNumber, ref.storySlug);
  const zipPath = compoundsZipOf(ref.projectFolder);
  const zipStem = path.basename(zipPath, '_compounds.zip');
  const alignmentPath = path.join(ref.projectFolder, `${zipStem}_alignment.json`);
  const alignment = screenAlignment(readJsonFile(alignmentPath, `The session's alignment record (${zipStem}_alignment.json)`), alignmentPath);
  const manifest = manifestFacts(await deps.manifest(zipPath), zipPath);
  if (path.resolve(manifest.masterFile) !== path.resolve(alignment.masterVideo)) {
    throw new Error(`The editor timeline plays ${manifest.masterFile}, but the alignment was measured against ${alignment.masterVideo}, so the two clocks are not the same recording.`);
  }
  const screenFile = screenRecordingOf(alignment.masterVideo);
  const screenDuration = await deps.duration(screenFile);
  const kept = keptTimeline(edits.story.regions, edits.cuts, manifest.frameSeconds);
  const transcriptPath = path.join(ref.projectFolder, `${zipStem}_transcript.json`);
  const sessionWords = sessionTranscriptWords(readJsonFile(transcriptPath, `The session's transcript (${zipStem}_transcript.json)`), transcriptPath, manifest.frameSeconds);
  const inStory = (t: number) => kept.some((s) => t >= s.start && t <= s.end);
  const span = findExportSpan({ exportText, sessionWords, inStory });
  const storyLine = `Story "${edits.story.title}" (story ${edits.story.number} of session ${edits.sessionStem}): ${clock(totalSeconds(kept))} after cuts.`;
  if (!span.ok) {
    throw new StorySpanRefused(screenFile, [storyLine, `No frames: ${span.reason}`], span.reason);
  }
  const plan = planStory({ regions: edits.story.regions, cuts: edits.cuts, manifest, placement: placementOf(alignment), screenDuration, within: { start: span.start, end: span.end } });

  const lines = [
    storyLine,
    `Frames limited to the part of the story in the export: ${clock(plan.master[0].start)}–${clock(plan.master[plan.master.length - 1].end)} of the recording ` +
      `(first and last transcript match: "${span.head.words}" … "${span.tail.words}"; ${span.evidence.uniqueHits} matches in all). ` +
      `${clock(plan.beforeSeconds)} of the story before it and ${clock(plan.afterSeconds)} after it are left out; what was removed inside it is not looked for.`,
    `${clock(totalSeconds(plan.timeline))} of the story in ${plan.master.length} ${plan.master.length === 1 ? 'stretch' : 'stretches'} of the recording (the removed dead air between them is left out).`,
    `Frames come from ${path.basename(screenFile)}, placed ${alignment.offsetSeconds >= 0 ? '+' : ''}${alignment.offsetSeconds.toFixed(3)} s against the master ` +
      `(${alignment.method}${alignment.confidence !== null ? `, confidence ${alignment.confidence.toFixed(2)}` : ''}, trusted).`,
    alignment.driftFactor === null
      ? 'The alignment records no drift factor for the screen recording, so it is read at the master\'s rate.'
      : `The screen recording runs at the recorded drift factor ${alignment.driftFactor}.`,
  ];
  if (plan.outsideSeconds > 0.05) lines.push(`${plan.outsideSeconds.toFixed(1)} s of the story fall outside the screen recording and are left out.`);
  if (plan.unmappedSeconds > 0.05) lines.push(`${plan.unmappedSeconds.toFixed(1)} s of the story lie past the end of the editor timeline and are left out.`);
  return {
    storyTitle: edits.story.title,
    storyNumber: edits.story.number,
    session: edits.sessionStem,
    projectFolder: ref.projectFolder,
    screenFile,
    alignment,
    span,
    plan,
    lines,
  };
}
