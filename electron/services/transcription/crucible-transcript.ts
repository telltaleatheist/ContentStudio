/**
 * Crucible's `transcript.json` → the pipeline's `SRTSegment[]` and the editor's word list
 * (CRUCIBLE-MIGRATION-PLAN.md §8 "As shipped", P5; LEDGER #206).
 *
 * PORTED from Briefcase `backend/src/crucible/asr/crucible-transcript.ts` (cb7c45d) and its
 * tests, not re-derived. What a Qwen3-ASR transcript is, and why this file exists:
 *
 *  - A Qwen segment is one PIECE of up to 180 s, not a sentence. Cues built from segments
 *    would be 3-minute captions, which the chapter pipeline (cues are its sentence units,
 *    Law 6), speaker tagging (one verdict per caption) and the reports cannot use.
 *  - The segment `text` carries the punctuation; its `words` (the aligner's items) carry the
 *    times, with NO punctuation and not always split where the text is ("don't" may come back
 *    as `don` + `t`). `alignWordsToText` matches the two on their letters and digits and gives
 *    each punctuated text token to the word holding its last letter, so cues can be cut at
 *    sentence punctuation at the words' own times.
 *
 * Changed for ContentStudio: the output is `SRTSegment` (whisper.cpp's SRT fields, already
 * parsed — the pipeline never round-trips through an SRT file), and the ONE declared
 * alternate Briefcase has — a segment whose text does not line up with its words at all is
 * cued from the words' own unpunctuated text — is COUNTED and returned, so the caller logs it
 * (Law 8). It keeps every word at its time; it is not a guess.
 */

import type { SRTSegment } from '../metadata/transcription.service';

export interface TranscriptWord {
  readonly start: number;
  readonly end: number;
  readonly word: string;
}

export interface TranscriptSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly words?: readonly TranscriptWord[];
}

/** The document Crucible's `asr` job writes. */
export interface CrucibleTranscript {
  readonly model: string;
  readonly revision: string;
  readonly language: string;
  readonly durationS: number | null;
  /** Pieces the server decoded again because they looped or collapsed (`redecoded` rows). */
  readonly redecoded: number;
  readonly segments: readonly TranscriptSegment[];
}

export interface TranscriptCue {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Sentence-final punctuation (full-width too), with closing quotes/brackets after the mark. */
const SENTENCE_END_RE = /[.!?…。！？]["”’')\]」』]*$/u;
/** A cue that grew this long without punctuation is flushed (BookForge's `_MAX_CUE_CHARS`). */
const MAX_CUE_CHARS = 240;
/** Two cues overlapping by less than this are not an overlap (timestamps jitter). */
const OVERLAP_TOLERANCE_S = 0.1;
/** How far past the last matched character an aligner word may be found (letters and digits). */
const ALIGN_LOOKAHEAD_CHARS = 40;

export class CrucibleTranscriptError extends Error {
  readonly code = 'crucible_asr_transcript_unreadable';
  constructor(message: string) {
    super(`transcript.json from Crucible is unreadable: ${message}`);
    this.name = 'CrucibleTranscriptError';
  }
}

function num(obj: Record<string, unknown>, key: string, where: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CrucibleTranscriptError(`${where}.${key} is not a number`);
  return value;
}

function str(obj: Record<string, unknown>, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== 'string') throw new CrucibleTranscriptError(`${where}.${key} is not a string`);
  return value;
}

/**
 * Read `transcript.json` (already JSON-parsed). The segments are read STRICTLY — a segment
 * with no `end` is a server that changed, and cues built around it would be a transcript with
 * a hole — and the metadata past them leniently (a transcript is not lost over a missing
 * `revision`). A word's `probability` is not read at all: it is null on Qwen (the aligner
 * places words, it does not score them).
 */
export function readCrucibleTranscript(parsed: unknown): CrucibleTranscript {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CrucibleTranscriptError('it is not an object');
  const doc = parsed as Record<string, unknown>;
  const rawSegments = doc['segments'];
  if (!Array.isArray(rawSegments)) throw new CrucibleTranscriptError('it has no segments list');
  const segments: TranscriptSegment[] = rawSegments.map((raw, i) => {
    const where = `segments[${i}]`;
    if (typeof raw !== 'object' || raw === null) throw new CrucibleTranscriptError(`${where} is not an object`);
    const seg = raw as Record<string, unknown>;
    const row: { start: number; end: number; text: string; words?: TranscriptWord[] } = {
      start: num(seg, 'start', where),
      end: num(seg, 'end', where),
      text: str(seg, 'text', where),
    };
    if ('words' in seg && seg['words'] !== null && seg['words'] !== undefined) {
      const rawWords = seg['words'];
      if (!Array.isArray(rawWords)) throw new CrucibleTranscriptError(`${where}.words is not a list`);
      row.words = rawWords.map((w, j) => {
        const wwhere = `${where}.words[${j}]`;
        if (typeof w !== 'object' || w === null) throw new CrucibleTranscriptError(`${wwhere} is not an object`);
        const word = w as Record<string, unknown>;
        return { start: num(word, 'start', wwhere), end: num(word, 'end', wwhere), word: str(word, 'word', wwhere) };
      });
    }
    return row;
  });
  const duration = doc['duration_s'];
  const redecoded = doc['redecoded'];
  return {
    model: str(doc, 'model', 'transcript'),
    revision: typeof doc['revision'] === 'string' ? (doc['revision'] as string) : '',
    language: str(doc, 'language', 'transcript'),
    durationS: typeof duration === 'number' && Number.isFinite(duration) ? duration : null,
    redecoded: Array.isArray(redecoded) ? redecoded.length : 0,
    segments,
  };
}

/** Letters and digits only, lower-cased: the one spelling an aligner word and a text token are compared in. */
function bare(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** alignWordsToText, and whether the text lined up with the words (false = the declared alternate ran). */
function alignSegment(segment: TranscriptSegment): { words: TranscriptWord[]; aligned: boolean } {
  const words = segment.words ?? [];
  // Tokens: split on spaces, and after a full-width sentence end (a language written without spaces).
  const tokens = segment.text.split(/\s+|(?<=[。！？])/u).filter((t) => t !== '');
  let stream = '';
  const tokenLast: number[] = [];
  for (const token of tokens) {
    stream += bare(token);
    tokenLast.push(stream.length - 1);
  }
  const wordOfChar = new Array<number>(stream.length).fill(-1);
  let cursor = 0;
  let found = 0;
  words.forEach((w, j) => {
    const key = bare(w.word);
    if (key === '') return;
    const at = stream.indexOf(key, cursor);
    if (at < 0 || at - cursor > ALIGN_LOOKAHEAD_CHARS) return;
    for (let c = at; c < at + key.length; c++) wordOfChar[c] = j;
    cursor = at + key.length;
    found++;
  });
  if (words.length > 0 && found * 2 < words.length) {
    return { words: words.map((w) => ({ start: w.start, end: w.end, word: ` ${w.word.trim()}` })), aligned: false };
  }

  const texts: string[][] = words.map(() => []);
  let previous = 0;
  tokens.forEach((token, i) => {
    const last = tokenLast[i];
    // A token with letters goes to the word holding its last one; an unmatched stretch rides with the word before.
    const owner = last >= 0 && (i === 0 || last > tokenLast[i - 1]) ? wordOfChar[last] : -1;
    const j = owner >= 0 ? owner : previous;
    texts[j]?.push(token);
    previous = j;
  });
  return {
    words: words.map((w, j) => ({ start: w.start, end: w.end, word: texts[j].length > 0 ? ` ${texts[j].join(' ')}` : '' })),
    aligned: true,
  };
}

/**
 * A Qwen segment's aligner words, each given the PUNCTUATED text it covers (Briefcase's rule,
 * verbatim). Each word is found in the text's letter stream at or just past the last one, and
 * each text token goes to the word holding its last letter, so "don't." lands on "t" and ends
 * a sentence there. A token with no letters ("—") goes with the word before it. A word with no
 * token keeps its time and adds no text (''). When the text does not line up with the words at
 * all (fewer than half found), the words' own text is used, unpunctuated.
 */
export function alignWordsToText(segment: TranscriptSegment): TranscriptWord[] {
  return alignSegment(segment).words;
}

/**
 * A segment's words as the tokens a reader sees, each spanning EVERY aligner word that made it:
 * "don't" is one word from `don`'s start to `t`'s end, not a `t` that starts mid-word. The
 * editor cuts on these, so a token's start must be where its first sound starts. Words that
 * carry no text ('' from alignWordsToText) lend their start to the next token that has one; a
 * trailing run with no token after it is dropped (it has no text to show or cut).
 */
export function segmentTokens(segment: TranscriptSegment): { tokens: TranscriptWord[]; aligned: boolean } {
  const { words, aligned } = alignSegment(segment);
  const tokens: TranscriptWord[] = [];
  let pendingStart: number | null = null;
  for (const w of words) {
    const text = w.word.trim();
    if (text === '') {
      if (pendingStart === null) pendingStart = w.start;
      continue;
    }
    tokens.push({ start: pendingStart ?? w.start, end: w.end, word: text });
    pendingStart = null;
  }
  return { tokens, aligned };
}

/** One line of cue text: every run of whitespace (newlines included) folded to a space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Segments → cues. With word timings, words accumulate into a cue that ends at a word carrying
 * sentence-final punctuation or once the cue holds 240 characters. A segment with no words is
 * one cue of its own text. Empty text is never a cue. Then the cues are ordered by start and
 * overlaps resolved: a cue inside the kept one is a boundary duplicate and is dropped; one that
 * overlaps and runs on starts where the kept one ends.
 */
export function groupTranscriptCues(segments: readonly TranscriptSegment[]): { cues: TranscriptCue[]; unalignedSegments: number } {
  const cues: TranscriptCue[] = [];
  let unalignedSegments = 0;
  let words: string[] = [];
  let start: number | null = null;
  let end: number | null = null;
  const flush = (): void => {
    if (words.length > 0 && start !== null && end !== null) {
      const text = oneLine(words.join(''));
      if (text !== '') cues.push({ start, end: Math.max(start, end), text });
    }
    words = [];
    start = null;
    end = null;
  };
  for (const segment of segments) {
    if (segment.words !== undefined && segment.words.length > 0) {
      const { words: timed, aligned } = alignSegment(segment);
      if (!aligned) unalignedSegments += 1;
      for (const w of timed) {
        if (start === null) start = w.start;
        end = w.end;
        words.push(w.word);
        const chars = words.reduce((n, x) => n + x.length, 0);
        if ((w.word.trim() !== '' && SENTENCE_END_RE.test(w.word.trim())) || chars >= MAX_CUE_CHARS) flush();
      }
    } else {
      flush();
      const text = oneLine(segment.text);
      if (text !== '') cues.push({ start: segment.start, end: Math.max(segment.start, segment.end), text });
    }
  }
  flush();

  const ordered = cues
    .map((cue, index) => ({ cue, index }))
    .sort((a, b) => a.cue.start - b.cue.start || a.index - b.index)
    .map(({ cue }) => cue);
  const kept: TranscriptCue[] = [];
  for (const cue of ordered) {
    const last = kept[kept.length - 1];
    if (last === undefined || cue.start >= last.end - OVERLAP_TOLERANCE_S) {
      kept.push(cue);
      continue;
    }
    if (cue.end <= last.end + OVERLAP_TOLERANCE_S) continue; // inside the kept cue: a boundary duplicate
    kept.push({ start: last.end, end: cue.end, text: cue.text });
  }
  return { cues: kept, unalignedSegments };
}

/**
 * `HH:MM:SS,mmm`, rounded to the millisecond FIRST and then split, so 59.9996 s carries into
 * the minute rather than printing `00:00:60,000`. Hours are at least two digits and never wrap
 * (whisper.cpp's SRT shape, which every SRTSegment reader in this app parses).
 */
export function srtTimestamp(seconds: number): string {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** Cues → the pipeline's currency: 1-based index, SRT timestamps, one line of text. */
export function cuesToSegments(cues: readonly TranscriptCue[]): SRTSegment[] {
  return cues.map((cue, i) => ({ index: i + 1, start: srtTimestamp(cue.start), end: srtTimestamp(cue.end), text: cue.text }));
}

/** Every segment's tokens in order: the words the pipeline keeps beside its captions. */
export function transcriptTokens(transcript: CrucibleTranscript): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const segment of transcript.segments) {
    if (segment.words !== undefined && segment.words.length > 0) out.push(...segmentTokens(segment).tokens);
  }
  return out;
}

/**
 * `transcript.json` (parsed) → captions, words and the facts a log line needs.
 *
 * A transcript with no speech is an empty caption list, not a refusal HERE: whether "no
 * speech" fails an item is the pipeline's call (transcription.service.ts says it does).
 */
export function transcriptToSegments(parsed: unknown): {
  segments: SRTSegment[];
  words: TranscriptWord[];
  transcript: CrucibleTranscript;
  unalignedSegments: number;
} {
  const transcript = readCrucibleTranscript(parsed);
  const { cues, unalignedSegments } = groupTranscriptCues(transcript.segments);
  return { segments: cuesToSegments(cues), words: transcriptTokens(transcript), transcript, unalignedSegments };
}
