/**
 * TEMPORARY ALIAS (P10), deleted by the parent after P4 merges.
 *
 * The pipeline's transcriber is `TranscriptionService` in transcription.service.ts. Two files
 * owned by the P4 worktree (metadata-generator.service.ts and chapter-whole-transcript.service.ts)
 * still import it under the old name; P10 was not allowed to edit them. Once P4 merges, their
 * imports move to './transcription.service' (docs/crucible/P10.md lists the exact edits) and
 * this file goes. tools/check-legacy-runtime-gone.js names it as a known exception until then.
 */
export { TranscriptionService as WhisperService } from './transcription.service';
export type { SRTSegment } from './transcription.service';
