// Everything one frame of the timeline needs, and nothing else.
//
// The shell builds this once per rAF tick (`buildScene()`); the renderer only reads it. No
// Angular, no DOM refs, no component methods — the one exception is `storyRibbonPieces`, a
// closure over the shell's edited-time map, which exists so the ribbon keeps calling
// `editedRangesForOriginal` once per region per frame exactly as it does today (pre-flattening
// would change the call count and the order).

import { EditorSegment } from '../host-data/editor-manifest';
import { MoveDrag, TrackRow } from '../model/editor-types';

/**
 * One story the stream-marks dialog WOULD create, already in EDITED seconds.
 *
 * `dim` is pre-computed by the shell rather than carried as an ImportRowState: the renderer's
 * only question is "will this one be created?", and three of the four states answer it the same
 * way. Keeping the judgement on the shell's side also keeps this file free of the import model.
 */
export interface StreamMarksSpanScene {
  title: string;
  /** EDITED seconds. `hi` can land BEFORE `lo` once footage has been reordered — see the shell. */
  lo: number;
  hi: number;
  dim: boolean;
}

/**
 * The stream-marks import, drawn before it exists. Null whenever that dialog is shut: this is an
 * overlay on a preview, never a record of anything the edit model holds.
 */
export interface StreamMarksPreviewScene {
  spans: StreamMarksSpanScene[];
  /** Every dividing line — each span's start plus the last span's end — in EDITED seconds. */
  boundaries: number[];
}

export interface TimelineScene {
  rows: TrackRow[];
  segsByTrack: ReadonlyMap<string, EditorSegment[]>;
  scrollOffset: number;
  pxPerSec: number;
  playheadTime: number;
  ribbonHeight: number;
  /** Blade boundaries already mapped through originalToEdited. */
  bladeEdited: number[];
  /** === allSelectionRanges() */
  selectionRanges: { lo: number; hi: number }[];
  /** selStart ?? selEnd, used only when `selectionRanges` is empty (the one-sided ruler flag). */
  pendingMark: number | null;
  marquee: { active: boolean; moved: boolean; start: number; end: number };
  moveDrag: MoveDrag | null;
  stories: { id: string; number: number; title: string; regions: { start: number; end: number }[] }[];
  storyRibbonPieces: (r: { start: number; end: number }) => { lo: number; hi: number }[];
  /** The story the user has SELECTED (storySelection), outlined white so the ribbon shows it. */
  selectedStoryId: string | null;
  /** Stories ticked for Join, outlined blue — the pending action. */
  pickedStoryIds: ReadonlySet<string>;
  hasStories: boolean;
  /** The stream-marks import as it would land, or null when that dialog is shut. */
  streamMarks: StreamMarksPreviewScene | null;
}
