/**
 * Publish types — renderer-side mirror of electron/services/publish/publish-types.ts.
 *
 * Mirrored rather than imported because the renderer is a separate compilation unit
 * (same pattern as extension/src/types.ts mirroring analytics-types.ts). Keep the two
 * in sync when either changes.
 */

/** YouTube's native A/B test accepts at most 3 title variants. */
export const MAX_AB_VARIANTS = 3;

/** YouTube enforces a 100-character title limit. */
export const MAX_TITLE_LENGTH = 100;

export type PublishStatus = 'selecting' | 'ready' | 'linked' | 'filled' | 'published';

export interface ChosenMetadata {
  jobId: string;
  itemIndex: number;
  /** Ordered. Index 0 becomes the main title AND A/B variant 1. */
  chosenTitles: string[];
  descriptionOverride: string | null;
  tagsOverride: string | null;
  channelId: string | null;
  videoId: string | null;
  sourceFilename: string | null;
  sourceDurationSec: number | null;
  status: PublishStatus;
  updatedAt: string;
  filledAt: string | null;
}

export interface ResolvedMetadata {
  jobId: string;
  itemIndex: number;
  channelId: string | null;
  videoId: string | null;
  titles: string[];
  description: string;
  tags: string;
  sourceFilename: string | null;
  sourceDurationSec: number | null;
  status: PublishStatus;
}

/**
 * Uniform envelope returned by every publish-* IPC channel.
 *
 * Modelled with optional payload fields rather than a discriminated union to match the
 * convention used by every other IPC result type here — the renderer's tsconfig leaves
 * `strict` off, and without strictNullChecks a `success: true | false` union does not
 * narrow, so `res.error` after an `if (!res.success)` guard fails to compile.
 */
export interface PublishResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}
