/**
 * Transcript-link types — renderer-side mirror of
 * electron/services/metadata/editor-transcript-link.ts + transcript-link-ipc.ts.
 *
 * Mirrored rather than imported because the renderer is a separate compilation unit, the
 * same rule publish.types.ts follows. Keep the two in sync when either changes.
 *
 * One deliberate divergence: the main process models `resolveRef`'s answer as a
 * discriminated union. The renderer's tsconfig leaves `strict` off, so a union does not
 * narrow on `state` and every field access after a guard fails to compile. The mirror
 * therefore carries all the payload fields as optionals, exactly as `PublishResult<T>`
 * does, for exactly the same reason.
 */

import type { TranscriptRef } from '../publish/publish.types';

/** How a candidate was matched. See the main-process module for what each means. */
export type CandidateVia = 'exact-title' | 'label-match';

/**
 * What the scan concluded.
 *
 * `ambiguous` is the one that changes behaviour: more than one story matched, so no
 * candidate may be pre-selected and the operator must say which.
 */
export type CandidateClassification = 'exact' | 'label' | 'ambiguous' | 'none';

/** One story that could be the source of a final export. */
export interface TranscriptCandidate {
  via: CandidateVia;
  projectFolder: string;
  sourceSession: string;
  storyNumber: number;
  storyTitle: string;
  storySlug: string;
  transcriptPath: string;
  transcriptExists: boolean;
  /**
   * Set when the file EXISTS but is unusable. Distinct from `!transcriptExists`, because
   * re-exporting fixes one and not the other — the UI must not offer "Export it now" here.
   */
  unreadableReason: string | null;
  durationSeconds: number | null;
  wordCount: number | null;
  compoundsZipPath: string | null;
  /**
   * Ready to store. Null whenever the story cannot be linked — never exported, or exported
   * and unusable. THE ONLY thing that decides whether a Link button may be enabled: check
   * this, not `transcriptExists`, or a malformed transcript yields a button that does
   * nothing when clicked.
   */
  ref: TranscriptRef | null;
  /** Why `ref` is null, when it is. Always set when `ref` is null. */
  refUnavailableReason: string | null;
}

/** Everything the scan knows, including what it could not do and why. */
export interface CandidateScan {
  videoPath: string;
  classification: CandidateClassification;
  candidates: TranscriptCandidate[];
  /** Null when the video is not a `<week>/complete/<name>.mov` final export. */
  scannedWeek: string | null;
  scannedSessions: string[];
  problems: string[];
  /** Shown verbatim on a self-resolved row, so "no candidates" is auditable. */
  searchedDescription: string;
}

/** How far apart the final cut and the editor timeline are. */
export interface DriftProbe {
  finalSec: number;
  transcriptSec: number;
  driftSec: number;
  driftPct: number;
}

/** resolveRef's three states, flattened for a non-strict compilation unit. */
export interface RefResolution {
  state: 'ok' | 'missing' | 'changed';
  /** state === 'ok' */
  wordCount?: number;
  durationSeconds?: number | null;
  /** state === 'missing' | 'changed' */
  reason?: string;
  /** state === 'changed' */
  found?: { sourceSession: string; storySlug: string; wordCount: number };
}

/** The picker's progressive scope: week, then every registered project, then one folder. */
export type StoryScope =
  | { kind: 'week'; week: string }
  | { kind: 'registered-projects' }
  | { kind: 'project'; projectFolder: string };

/** What `transcript-list-stories` returns. */
export interface StoryList {
  candidates: TranscriptCandidate[];
  problems: string[];
}

/** What "Export it now" produced. */
export interface StoryExportResult {
  transcriptsDir: string;
  storiesEmitted: number;
}

/**
 * The operator's decision for one input, stored on the InputItem so it rides the queued job.
 *
 * ABSENT means undecided — which is what Start Queue refuses on when the item has
 * candidates. It is never a synonym for either branch below.
 */
export type TranscriptChoice =
  | {
      mode: 'linked';
      ref: TranscriptRef;
      /** Measured at confirm time and shown on the queue row. Null if the probe failed. */
      driftSec: number | null;
      driftPct: number | null;
    }
  | {
      mode: 'final-only';
      /**
       * Why. Either "no candidate matched — <what was searched>" for a self-resolved row,
       * or the operator's explicit declaration. Recorded on both branches so the report can
       * always say which path a run took (spec §3.2).
       */
      reason: string;
    };

/** Past this, the row goes to warning styling and the confirm label says so. */
export const DRIFT_WARN_PCT = 10;

/** Is this drift big enough to warn about? Warn, never refuse — the operator knows what he cut. */
export function isDriftWarning(driftPct: number | null): boolean {
  return driftPct !== null && driftPct !== undefined && Math.abs(driftPct) > DRIFT_WARN_PCT;
}
