/**
 * Item identity — the primary key for a generated metadata item.
 *
 * Until now an item was identified by its POSITION in `items[]`, which is not an
 * identity at all: it changes when a sibling is deleted, it is shared by every other
 * array the job carries (`original_inputs`, `input_types`, the publish selections map),
 * and nothing validates it at any boundary. See ITEM-ID-PLAN.md §1-2.
 *
 * `item_id` is minted once, in the main process, at the single point where an item first
 * exists on disk (OutputHandlerService.writeItemToJob), and never changes afterwards.
 * It is NOT derived from content, title, filename or position, so none of those can
 * change it, and two runs over the same source produce two different ids — which is the
 * point: they are two different items. The thing that links them is `source_key`.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import { isItemId, normalizeForMatch } from '../publish/publish-types';
import type { TranscriptRef } from '../publish/publish-types';

/**
 * Exact shape check. Anything else crossing an IPC boundary is rejected, not coerced.
 *
 * DEFINED in publish-types.ts and re-exported here. The publish store, the publish IPC
 * layer and the extension's HTTP routes all have to reject a malformed id, and publish/
 * must not import from services/metadata (that is what keeps it liftable) — so the one
 * definition lives on the side that cannot import, and this side, which can, uses it.
 * Two regexes that merely look alike would eventually stop being alike.
 */
export { isItemId };

/**
 * Job files carrying identity are `schema_version: 2`. Files without the key are
 * version 1 (positional) and are migrated by report-migration.ts. There is no
 * dual-path reader: after migration, readers REQUIRE item_id.
 */
export const SCHEMA_VERSION = 2;

/** 8 base36 characters of randomness, matching the job id's shape. */
const RANDOM_CHARS = 8;

/**
 * `itm-<epochMs base36>-<8 base36>`.
 *
 * Filename-safe (passes the `^[A-Za-z0-9._-]+$` guard the publish store applies to ids
 * it turns into paths), time-sortable, and visually attributable to a run.
 */
export function mintItemId(now: number = Date.now()): string {
  if (!Number.isFinite(now) || now <= 0) {
    throw new Error(`mintItemId requires a positive epoch-ms timestamp; got ${now}`);
  }

  // crypto rather than Math.random: ids are the join key for publish state, and a
  // duplicate would silently merge two items' selections.
  let random = '';
  while (random.length < RANDOM_CHARS) {
    random += crypto.randomBytes(8).readBigUInt64BE().toString(36);
  }

  return `itm-${Math.floor(now).toString(36)}-${random.slice(0, RANDOM_CHARS)}`;
}

/**
 * The regeneration join key for a FILE input: the normalized basename.
 *
 * Deliberately the same normalization video-matcher already applies to YouTube titles
 * and source filenames, so "the same source" means one thing across the app.
 *
 * Text subjects have no source file and get an explicit null from the caller — never a
 * key derived from the subject text, which would join two unrelated topics that happen
 * to start with the same words.
 */
export function sourceKeyOf(sourcePath: string): string {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
    throw new Error('sourceKeyOf requires a non-empty source path');
  }
  const key = normalizeForMatch(path.basename(sourcePath.trim()));
  if (!key) {
    throw new Error(`Source path normalized to an empty key: ${sourcePath}`);
  }
  return key;
}

/**
 * The identity fields written onto every item in a schema_version 2 job file.
 *
 * `txt_path` is the absolute path of the .txt that was actually written, INCLUDING the
 * de-collision suffix — it is the only record of which file belongs to which item, and
 * without it deleting an item either orphans its text (P1) or deletes a sibling job's
 * text along with it (P2), both of which are live today.
 */
export interface ItemIdentity {
  item_id: string;
  txt_path: string | null;
  source_key: string | null;
  source_path: string | null;
}

/** What the generator knows about an item's source at write time. */
export interface ItemSource {
  /** normalizeForMatch(basename) for file inputs; null for text subjects. */
  source_key: string | null;
  /** The path as the user supplied it, for display; null for text subjects. */
  source_path: string | null;
}

/**
 * Where an item's WORDS came from. Two answers, because as of Phase 2 there are two
 * transcripts in play and they feed different fields (spec §3.3/§3.5).
 *
 * `final-export-whisper`      — the .mov's own Whisper transcript, ad reads and all.
 * `editor-story-transcript`   — the ad-free AutoCutStudio story transcript the operator
 *                               linked this input to.
 */
export type ContentOrigin = 'editor-story-transcript' | 'final-export-whisper';

/**
 * HOW the content branch was arrived at — the `why` beside `ContentOrigin`'s `which`.
 *
 * Linking an editor story is OPTIONAL: an item that was never linked runs on the final
 * export's own transcript and always could. That is a degradation of the words the model
 * sees (sponsor reads and all), so it is a DECLARED MODE and never a silent fallback —
 * this field is how the record says which of the three ways an unlinked run got there.
 *
 * `linked`                  — an editor story was linked and honored.
 * `final-only-declared`     — the operator picked "Final export only" on the row.
 * `final-only-default`      — the item could have been linked and was not. The default,
 *                             recorded explicitly so "he chose the final export" and "he
 *                             never touched the control" stay different facts.
 * `final-only-unlinkable`   — there was no link to make: a text subject, an imported
 *                             transcript, anything with no final export behind it.
 */
/**
 * Set on an item whose words and timings were NOT produced by this run: the operator
 * ticked "Use saved transcript" on the queue row and the pipeline read a stored Whisper
 * record instead of running Whisper (saved-transcript.service.ts).
 *
 * Recorded because the report otherwise reads exactly like a fresh transcription, and the
 * two are not the same claim: this one says the words were taken on `saved_at`, by
 * `whisper_model`, from a file whose size and mtime still matched at read time. A reader
 * who wants to know why a re-run produced byte-identical chapters has the answer here.
 */
export interface SavedTranscriptReuse {
  /** `sourceKeyOf(video)` — the record's name, and the cross-run join key. */
  source_key: string;
  /** ISO. When the transcript was written, i.e. when Whisper actually ran. */
  saved_at: string;
  /** The model that produced the segments, as the transcribing run resolved it. */
  whisper_model: string;
  /** Absolute path of the record that was read, so the operator can go and look at it. */
  record_path: string;
}

export type ContentDeclaration =
  | 'linked'
  | 'final-only-declared'
  | 'final-only-default'
  | 'final-only-unlinkable';

/**
 * What this item was GENERATED FROM, recorded on every item at write time.
 *
 * Sibling to `ItemSource` and written the same way: supplied by the generator, never
 * derived on read. `ItemSource` says which file the operator pointed at; this says which
 * TRANSCRIPT of it wrote the words — and it is the only record of the fact, because the
 * two-source split leaves no trace in the output itself.
 *
 * `content_fields` is ALWAYS present, on both branches. "Final export only" is a DECLARED
 * MODE, not an absence (spec §3.4): a report that simply omitted the field when nothing
 * was linked could not distinguish "the operator declared final-only" from "written by a
 * build that did not record it" — the `_is_compilation` lesson, again.
 *
 * `timed_fields` is always 'final-export-whisper' and is written anyway, because the
 * whole point of the split is that chapters DID NOT move. A reader should be able to see
 * that from the record rather than have to know it.
 */
export interface ItemProvenance {
  /** Which transcript fed titles / description / tags / thumbnail text. */
  content_fields: ContentOrigin;
  /**
   * How that branch was chosen. Present on every item this build writes, absent only on
   * items written before linking became optional — which is why it is optional here and
   * `content_fields` is not: an old record genuinely cannot answer this question, and an
   * absent field says that where a defaulted value would invent an answer.
   */
  content_declaration?: ContentDeclaration;
  /** The declaration in words, as the operator or the scan stated it. Null when linked. */
  content_declaration_reason?: string | null;
  /**
   * Which transcript fed chapters. Structurally constant: the chapter pipeline reads
   * `srtSegments`, which is the final export's Whisper output on every path, forever.
   */
  timed_fields: 'final-export-whisper';
  /** The link that was honored, or null for the declared final-export-only mode. */
  transcript_ref: TranscriptRef | null;
  /**
   * The final export's duration, as ffprobed by the transcription stage — the ONE source
   * of truth for this number on both branches.
   *
   * null means nothing measured it: a text subject or an imported transcript (no video),
   * a compilation (N inputs cannot answer with one duration, exactly as `source_key`
   * cannot), or an ffprobe the transcription stage could not complete.
   */
  final_duration_sec: number | null;
  /** What the linked story's transcript declares it runs; null when nothing is linked. */
  transcript_duration_sec: number | null;
  /** probeDrift: final_duration − transcript_duration. Negative = the final cut is shorter. */
  drift_sec: number | null;
  /** The same drift as a percentage of the transcript's duration. */
  drift_pct: number | null;
  /**
   * The saved transcript records this run REUSED instead of transcribing, one per input
   * that reused one. Absent (or empty) means every input was transcribed during this run.
   *
   * An array because a compilation is one item over N inputs and each of them answers the
   * question separately — the same reason `transcript_ref` is null there. A single item
   * that reused a record carries exactly one entry.
   */
  saved_transcripts?: SavedTranscriptReuse[];
  /** ISO. When this run recorded the decision. */
  declared_at: string;
}

/**
 * The one-line account of an item's two sources, for the reports pane and the TXT.
 *
 * Stated wherever the output is READ, because that is where the consequence lands: words
 * from the editor story describe material the final cut may not contain (drift runs to
 * −23%), and words from the final export include whatever sponsor read is in it. The
 * renderer mirrors this sentence in transcript-link.types.ts — keep the two in step.
 */
/**
 * The half-sentence that says WHY an item ran on the final export's own transcript.
 *
 * Empty for a linked item (the rest of the sentence already says it) and for a record
 * written before the declaration existed — an old item has no answer, and inventing the
 * likeliest one is exactly what the declared-mode rule exists to prevent.
 */
function describeDeclaration(p: ItemProvenance): string {
  switch (p.content_declaration) {
    case 'final-only-declared':
      return ' The operator declared final-export-only for this item.';
    case 'final-only-default':
      return ' No editor story was linked — the default for an unlinked item.';
    case 'final-only-unlinkable':
      return ' This input had no editor story to link.';
    default:
      return '';
  }
}

/**
 * The clause that stops a report from claiming a transcription that did not happen.
 *
 * Empty when this run transcribed, which is the ordinary case and needs no sentence — the
 * rest of the description already describes a fresh run. Present only when the operator
 * reused a saved record, because that is the fact a reader cannot recover from anything
 * else in the file.
 */
function describeReuse(p: ItemProvenance): string {
  const reused = p.saved_transcripts;
  if (!reused || reused.length === 0) return '';
  if (reused.length === 1) {
    const one = reused[0];
    return ` The transcript was not made on this run: it was reused from the saved record for ` +
      `${one.source_key}, transcribed ${one.saved_at} by Whisper ${one.whisper_model}.`;
  }
  return ` ${reused.length} of this item’s inputs reused saved transcripts rather than being ` +
    `transcribed on this run.`;
}

export function describeProvenance(p: ItemProvenance): string {
  if (!p || typeof p !== 'object' || !p.content_fields) {
    throw new Error('describeProvenance requires an ItemProvenance with content_fields');
  }

  if (p.content_fields === 'final-export-whisper') {
    return 'Content fields generated from the final export’s transcript — includes any ' +
      `sponsor reads. Chapters from the same transcript.${describeDeclaration(p)}${describeReuse(p)}`;
  }

  const ref = p.transcript_ref;
  const story = ref
    ? `${ref.sourceSession} · story ${ref.storyNumber} "${ref.storyTitle}"`
    // A compilation records the origin without a single ref, because a set of N inputs
    // has no one link — the same reason its source_key is null.
    : 'the linked editor stories';

  const drift = typeof p.drift_pct === 'number'
    // drift_pct is (final − transcript) / transcript: negative means the final cut is the
    // shorter of the two, so the STORY — the subject of this sentence — is the longer one.
    ? ` — ${Math.abs(p.drift_pct).toFixed(1)}% ${p.drift_pct < 0 ? 'longer' : 'shorter'} than the final export`
    : '';

  return `Content from editor transcript ${story}${drift}. Chapters from the final export.${describeReuse(p)}`;
}
