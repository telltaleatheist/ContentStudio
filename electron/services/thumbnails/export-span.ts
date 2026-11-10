/**
 * WHICH PART OF THE STORY THE FINAL EXPORT IS (Owen, 2026-11-09: "take everything between where
 * the transcripts match up on each side"; LEDGER #346).
 *
 * The editor exports a story with 30 s shoulders (story-utils.ts STORY_EXPORT_PAD_SECONDS) and
 * Owen trims its head and tail, and small bits, in FCPX. The trimmed head of a story still shows
 * the PREVIOUS story on screen, so frames taken from the whole story included pictures that are
 * not in the video ("u6 - paxton": 4 of 6 grid frames from before the export starts). Frames now
 * come only from the stretch of the story between the FIRST and the LAST place the export's
 * transcript matches the story's. What Owen removed inside that stretch is not looked for (his
 * call: keep it simple).
 *
 * THE STORY'S TRANSCRIPT here is the session transcript's words (`<session>_transcript.json`, the
 * file the exporter builds every `_stories_transcripts/*.json` from) whose midpoint lies in the
 * story's kept timeline: the exporter's own rule (editor_export.py `_build_story_transcript`). Its
 * times are EDITOR TIMELINE seconds (`timelineStart`/`timelineEnd`, the same base as the story's
 * regions and cuts), so the span needs no conversion before it meets the kept timeline. The
 * `_stories_transcripts` file itself is not used for times: its `start`s are story-relative
 * collapsed seconds (0 = the first kept second of the PADDED story, the cuts closed up, the pieces
 * in the editor's playback order), and that order (`sequence`) is not saved on disk, so its times
 * cannot be turned back into timeline seconds for certain. Checked on 2026-11-05 "u2 - paxton":
 * its first word "was" at story 0.000 is the session word at timeline 10519.429, the padded story
 * start 10549.472 - 30.
 *
 * THE MATCH uses story-match.ts's normalising and SHINGLE-word n-grams. An n-gram of the export
 * counts (a HIT) only when it occurs exactly ONCE in the whole session's transcript and that one
 * place is inside the story: a phrase said twice, or one from a neighbouring story, places
 * nothing. A match END is a hit with at least ANCHOR_HITS - 1 more hits within ANCHOR_WINDOW_WORDS
 * export words that agree with it (the same distance apart in the story as in the export, give or
 * take ANCHOR_SLACK_WORDS), so one stray hit never moves an end. The first hit that starts such a
 * run is the head, the last hit that ends one is the tail. No head, no tail, or a head later in
 * the story than the tail is a stated refusal (Law 1), never the whole story.
 */
import { normalizedWords, shingles, SHINGLE } from './story-match';

/** A match end needs this many agreeing hits... */
export const ANCHOR_HITS = 3;
/** ...within this many words of the export... */
export const ANCHOR_WINDOW_WORDS = 20;
/** ...each the same distance from the first in the story as in the export, give or take this many words. */
export const ANCHOR_SLACK_WORDS = 4;

/** One word of the session transcript, in editor timeline seconds. */
export interface TimelineWord {
  text: string;
  start: number;
  end: number;
}

/** One end of the span: where it lies in the story and what was matched there. */
export interface SpanAnchor {
  /** Editor timeline seconds of the anchor's first (head) or last (tail) word. */
  seconds: number;
  /** The matched words, as the session transcript has them. */
  words: string;
  /** Agreeing hits in the run that makes it an end. */
  hits: number;
}

export interface ExportSpanEvidence {
  /** Words of the export's transcript after normalising. */
  exportWords: number;
  /** Export n-grams found exactly once in the session, inside the story. */
  uniqueHits: number;
}

export type ExportSpan =
  | { ok: true; start: number; end: number; head: SpanAnchor; tail: SpanAnchor; evidence: ExportSpanEvidence }
  | { ok: false; reason: string; evidence: ExportSpanEvidence };

interface Hit {
  /** Token index in the export. */
  j: number;
  /** Token index in the session. */
  p: number;
}

function agrees(a: Hit, b: Hit): boolean {
  const dj = b.j - a.j;
  return dj > 0 && dj <= ANCHOR_WINDOW_WORDS && Math.abs((b.p - a.p) - dj) <= ANCHOR_SLACK_WORDS;
}

/**
 * The timeline span of the story the export is, from its first to its last transcript match.
 * `sessionWords` is the whole session's transcript (any order; sorted here by start), `inStory`
 * says whether a timeline second lies in the story's kept timeline.
 */
export function findExportSpan(input: {
  exportText: string;
  sessionWords: readonly TimelineWord[];
  inStory: (timelineSeconds: number) => boolean;
}): ExportSpan {
  const exportTokens = normalizedWords(input.exportText);
  const words = [...input.sessionWords].sort((a, b) => a.start - b.start || a.end - b.end);
  // Tokens of the session and the word each came from ("A.K." is two tokens of one word).
  const tokens: string[] = [];
  const origin: number[] = [];
  words.forEach((w, i) => {
    for (const t of normalizedWords(w.text)) {
      tokens.push(t);
      origin.push(i);
    }
  });
  const wordIn = words.map((w) => input.inStory((w.start + w.end) / 2));
  const count = new Map<string, number>();
  const at = new Map<string, number>();
  shingles(tokens).forEach((s, p) => {
    count.set(s, (count.get(s) ?? 0) + 1);
    at.set(s, p);
  });
  const hits: Hit[] = [];
  shingles(exportTokens).forEach((s, j) => {
    if (count.get(s) !== 1) return;
    const p = at.get(s)!;
    if (wordIn[origin[p]] && wordIn[origin[p + SHINGLE - 1]]) hits.push({ j, p });
  });
  const evidence: ExportSpanEvidence = { exportWords: exportTokens.length, uniqueHits: hits.length };
  const rule = `an end needs ${ANCHOR_HITS} matches of ${SHINGLE} words, each found once in the session and inside the story, within ${ANCHOR_WINDOW_WORDS} words of each other`;

  let head: { hit: Hit; hits: number } | null = null;
  for (let i = 0; i < hits.length && head === null; i++) {
    const run = hits.slice(i + 1).filter((h) => agrees(hits[i], h)).length + 1;
    if (run >= ANCHOR_HITS) head = { hit: hits[i], hits: run };
  }
  let tail: { hit: Hit; hits: number } | null = null;
  for (let i = hits.length - 1; i >= 0 && tail === null; i--) {
    const run = hits.slice(0, i).filter((h) => agrees(h, hits[i])).length + 1;
    if (run >= ANCHOR_HITS) tail = { hit: hits[i], hits: run };
  }
  if (head === null || tail === null) {
    return {
      ok: false,
      reason:
        `The export's transcript does not match the story's transcript clearly at any place (${hits.length} ` +
        `${hits.length === 1 ? 'match' : 'matches'} of ${SHINGLE} words found once in the session and inside the story, of the export's ${exportTokens.length} words; ${rule}), ` +
        'so where the export starts and ends in the story cannot be told, and no frames are taken.',
      evidence,
    };
  }
  if (head.hit.p > tail.hit.p) {
    return {
      ok: false,
      reason:
        'The first place the export\'s transcript matches the story is later in the story than the last place it matches, ' +
        'so the export plays the story out of order and its first and last match do not bound one stretch; no frames are taken.',
      evidence,
    };
  }
  const wordsAt = (p: number): string => {
    const first = origin[p];
    const last = origin[p + SHINGLE - 1];
    return words.slice(first, last + 1).map((w) => w.text).join(' ');
  };
  const startWord = words[origin[head.hit.p]];
  const endWord = words[origin[tail.hit.p + SHINGLE - 1]];
  return {
    ok: true,
    start: startWord.start,
    end: endWord.end,
    head: { seconds: startWord.start, words: wordsAt(head.hit.p), hits: head.hits },
    tail: { seconds: endWord.end, words: wordsAt(tail.hit.p), hits: tail.hits },
    evidence,
  };
}
