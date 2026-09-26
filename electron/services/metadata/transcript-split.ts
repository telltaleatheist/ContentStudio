/**
 * The in-queue split of a stream into standalone videos (the inputs page's split feature): its
 * candidate menu is the `stories` grain of snap chaptering (LEDGER #199, #208; plan §0 #7, §6.5).
 *
 * Owen, 2026-09-25: "stories are stream-level splits that are completely different subjects, not
 * just small changes within the same subjects", and the in-queue split IS that grain, the same
 * one the editor's Stories use. The old splitter (EpisodeSplitterService: one call asked for
 * quoted start phrases, mapped by fuzzy match, a single "Full transcript" chapter when nothing
 * mapped) is deleted with everything only it called.
 *
 * BOUNDARIES ONLY, declared: the candidates are labelled with each story's opening line, quoted, and
 * no title call is made. The menu is for choosing cut points; each piece the operator commits
 * gets its own metadata run, titles and chapters included, and a thinking title per candidate
 * would cost minutes each for a label the operator renames anyway.
 *
 * The shape is the one the review dialog and `commit-transcript-split` already read: chapters that
 * tile 0..duration in order, 1-based, each with a clock mirror, a label and a verbal-cue flag
 * (always false: snap reads no verbal cue). Times come from sentence units (Law 6).
 */

import type { SRTSegment } from './whisper.service';
import { TimeUtils } from './chapter-generator.service';
import { chapter } from './chaptering/chaptering.service';
import type { ChapteringProgress, ChatFn, DecideFn } from './chaptering/types';
import type { StoryStats } from './chaptering/stories';

/** One candidate of the menu (frontend TranscriptChapter). */
export interface TranscriptSplitCandidate {
  /** 1-based, chronological. */
  index: number;
  /** Seconds from the transcript's start; the first is 0 and each ends where the next begins. */
  startSeconds: number;
  endSeconds: number;
  /** H:MM:SS mirror of startSeconds. */
  timestamp: string;
  /** The story's opening line, quoted (the stories grain names nothing without a title call). */
  label: string;
  /** Snap reads no verbal cue; kept for the dialog's shape. */
  verbalCue: boolean;
  /** Always false at the stories grain, which runs no ad check (a plug is a chapter of its piece's own run). */
  isAd: boolean;
}

export async function splitCandidates(
  srtSegments: SRTSegment[],
  totalDurationSeconds: number,
  options: { chat: ChatFn; decide: DecideFn; signal?: AbortSignal; onProgress?: (p: ChapteringProgress) => void },
): Promise<{ candidates: TranscriptSplitCandidate[]; warnings: string[]; stories: StoryStats | null }> {
  if (!srtSegments || srtSegments.length === 0) throw new Error('Transcript has no segments to analyze.');
  // The segment's speaker and label together: the string every engine reads a HOST/CLIP side from.
  const captions = srtSegments.map((seg) => {
    const speaker = `${seg.speaker || ''} ${seg.speakerLabel || ''}`.trim();
    return { start: seg.start, end: seg.end, text: seg.text, ...(speaker ? { speaker } : {}) };
  });
  const result = await chapter(captions, {
    granularity: 'stories',
    chat: options.chat,
    decide: options.decide,
    summarize: false,
    totalSeconds: totalDurationSeconds,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  const candidates = result.chapters.map((c, i) => ({
    index: i + 1,
    startSeconds: c.startSec,
    endSeconds: c.endSec,
    timestamp: TimeUtils.secondsToYoutubeTime(c.startSec),
    label: c.label,
    verbalCue: false,
    isAd: c.isAd,
  }));
  return { candidates, warnings: result.stats.warnings, stories: result.stats.stories };
}
