/**
 * The content text of a FINISHED item — what its tags were checked against when it was made.
 *
 * The chapter re-roll (section-reroll.ts, LEDGER #223) rebuilds the tags and hashtags from the
 * new chapter titles, and every tag must occur in the item's content text (tags-hashtags.ts
 * `occursIn`). A report does not store that text, so it is read again from where the run read
 * it, by the same builders, on the branch the report records in `content_provenance`:
 *
 *   final-export-whisper     the saved transcript of the video (saved-transcript.service.ts),
 *                            which every run writes; its stamp check refuses a video that has
 *                            been re-rendered since, by name.
 *   editor-story-transcript  the linked editor story, checked by `resolveRef` exactly as a run
 *                            checks it (a moved or re-exported story is refused, by name).
 *
 * ONE DIFFERENCE, DECLARED: the operator's notes on the queue row ("Additional context") were
 * appended to the content text in the run and are not stored on the report, so the rebuilt text
 * is the transcript alone. A tag grounded only in those notes is not rebuilt. `note` says so on
 * every result, and the caller puts it in front of the operator.
 *
 * Everything else throws a sentence the page shows: the tags are then left as they were.
 */

import * as fs from 'fs';

import { resolveRef } from './editor-transcript-link';
import { inspectSavedTranscript } from './saved-transcript.service';
import { buildContentText, buildImportedContentItem, parseTranscriptImport } from './transcript-import.service';

export interface FinishedItemContent {
  text: string;
  /** Where it was read from, in plain words. */
  from: string;
  /** The declared difference from the run's text. */
  note: string;
}

export function contentTextOfFinishedItem(item: any, outputDir: string): FinishedItemContent {
  const note =
    'Notes typed on the queue row are not kept on the report, so tags that came only from those notes are not rebuilt.';
  const provenance = item?.content_provenance;
  const origin = provenance?.content_fields;
  if (origin === 'editor-story-transcript') {
    const ref = provenance.transcript_ref;
    if (!ref) {
      throw new Error('the report says its words came from an editor story, and it does not say which one.');
    }
    const resolution = resolveRef(ref);
    if (resolution.state !== 'ok') {
      throw new Error(`the linked editor story cannot be read now (${resolution.state}: ${resolution.reason}).`);
    }
    const parsed = parseTranscriptImport(fs.readFileSync(ref.path, 'utf-8'), ref.path);
    if (!parsed.ok) throw new Error(`the linked editor story cannot be read now (${parsed.error}).`);
    return { text: buildImportedContentItem(parsed.data, ref.path).content, from: `the editor story ${ref.path}`, note };
  }
  if (origin === 'final-export-whisper') {
    const source = item?.source_path;
    if (typeof source !== 'string' || source.length === 0) {
      throw new Error('the report does not record which video it was made from.');
    }
    // The same stamp check a reuse runs: a video re-rendered since is refused, with the reason.
    const lookup = inspectSavedTranscript(outputDir, source);
    if (!lookup.exists) {
      throw new Error(`the video's saved transcript cannot be used: ${lookup.reason} (${lookup.recordPath}).`);
    }
    return { text: buildContentText(lookup.record.segments), from: `the saved transcript ${lookup.recordPath}`, note };
  }
  throw new Error('the report does not record which transcript its words came from.');
}
