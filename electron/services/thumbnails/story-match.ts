/**
 * WHICH EDITOR STORY AN ITEM'S THUMBNAIL FRAMES COME FROM, decided inside the metadata job
 * (thumbnails pipeline, phase 1, 2026-09-28; docs/thumbnails-pipeline.md).
 *
 * Three declared methods, tried in this order, and the method is recorded on the link:
 *
 *   manual      the operator linked the item on the Inputs page (the content link, a TranscriptRef
 *               on the item). Used as it is and never replaced by anything below.
 *   name        the export's file name finds exactly ONE story of its week (the finder's
 *               exact-title or label tier, editor-transcript-link.ts `findCandidates`), and its
 *               transcript has been exported. When the transcript match below finds a clear winner
 *               that is a DIFFERENT story, the two methods disagree and the item gets no story, with
 *               both named: "f2 - the rapture" is made from the story "f1 - the rapture", and a name
 *               can point at a story of the same name that is not the one exported.
 *   transcript  the name finds none (or several): the item's own transcript is matched against the
 *               exported story transcripts of every editor session in the item's week
 *               (`<week>/files/<session>/<session>_stories_transcripts/*.json`, the sessions the
 *               Thumbnails tab's picker lists). Distinctive text, not a guess: PROBE_COUNT windows of
 *               PROBE_WORDS words spread across the item's transcript, each cut into word SHINGLE-
 *               grams after normalising (lower case, apostrophes dropped, everything else not a
 *               letter or digit a space); a window HITS a story when at least PROBE_HIT_SHINGLES of
 *               its n-grams occur in that story. The story with the most hits wins only when it is a
 *               CLEAR winner: at least WIN_MIN_HITS hits and WIN_MIN_FRACTION of the windows, and at
 *               least WIN_RATIO times the runner-up's hits. Anything else is "no story", with the
 *               counts said.
 *
 * "No story" is a stated state with its reason, never a guess (Law 1); the thumbnail stages are then
 * skipped and the report says why. None of this touches the item's CONTENT link: the words of the
 * content fields still come from what the operator linked on the Inputs page (LEDGER #142, #144).
 * This link only says where the thumbnail frames are taken from, and it lives on the report.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { TranscriptRef } from '../publish/publish-types';
import {
  findCandidates,
  isLinkable,
  listWeekStories,
  refFromCandidate,
  weekFolderOfExport,
  type TranscriptCandidate,
} from '../metadata/editor-transcript-link';

/** How many windows of the item's transcript are matched. */
export const PROBE_COUNT = 24;
/** Words per window. */
export const PROBE_WORDS = 12;
/** Words per n-gram. */
export const SHINGLE = 5;
/** A window hits a story when at least this many of its n-grams occur in the story. */
export const PROBE_HIT_SHINGLES = 2;
/** A winner needs at least this many hits... */
export const WIN_MIN_HITS = 4;
/** ...and at least this fraction of the windows... */
export const WIN_MIN_FRACTION = 0.25;
/** ...and at least this many times the runner-up's hits. */
export const WIN_RATIO = 2;

export type StoryLinkMethod = 'manual' | 'name' | 'transcript';

/** What the transcript match measured, kept on the report so "no story" is auditable. */
export interface StoryMatchEvidence {
  /** Windows taken from the item's transcript. */
  probes: number;
  /** Story transcripts read. */
  searched: number;
  /** Stories of the week whose transcript was never exported (or cannot be read), so not searched. */
  notSearched: Array<{ session: string; number: number; title: string; why: string }>;
  /** The best three, most hits first. */
  top: Array<{ session: string; number: number; title: string; hits: number }>;
}

export type ThumbnailStoryLink =
  | { state: 'linked'; method: StoryLinkMethod; ref: TranscriptRef; line: string; evidence: StoryMatchEvidence | null }
  | { state: 'none'; reason: string; evidence: StoryMatchEvidence | null };

/** Lower case, apostrophes dropped ("don't" = "dont"), every other run of non-letters a space. */
export function normalizedWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0);
}

function shingles(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + SHINGLE <= words.length; i++) out.push(words.slice(i, i + SHINGLE).join(' '));
  return out;
}

/**
 * PROBE_COUNT windows of PROBE_WORDS words, evenly spaced across the transcript's words (the first
 * starting half a spacing in, so the opening and closing lines, where a channel's own intro and
 * sign-off sit, weigh no more than any other stretch). Fewer when the transcript is short; none
 * when it is shorter than one window.
 */
export function probesOf(words: readonly string[]): string[][] {
  if (words.length < PROBE_WORDS) return [];
  const room = words.length - PROBE_WORDS;
  const count = Math.min(PROBE_COUNT, Math.floor(words.length / PROBE_WORDS));
  const out: string[][] = [];
  const seen = new Set<number>();
  for (let k = 0; k < count; k++) {
    const start = Math.round(((k + 0.5) / count) * room);
    if (seen.has(start)) continue;
    seen.add(start);
    out.push(shingles(words.slice(start, start + PROBE_WORDS)));
  }
  return out;
}

/** The words of an exported story transcript (its `words[].text`), or a reason it cannot be read. */
function storyWords(file: string): string[] | { why: string } {
  let doc: any;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { why: `${file} cannot be read: ${(e as Error).message}` };
  }
  if (!Array.isArray(doc?.words)) return { why: `${file} has no words list` };
  return normalizedWords(doc.words.map((w: any) => (typeof w?.text === 'string' ? w.text : '')).join(' '));
}

function label(c: { sourceSession: string; storyNumber: number; storyTitle: string }): string {
  return `story ${c.storyNumber} "${c.storyTitle}" of session ${c.sourceSession}`;
}

export type TranscriptMatch =
  | { kind: 'winner'; candidate: TranscriptCandidate & { durationSeconds: number; wordCount: number }; hits: number; evidence: StoryMatchEvidence }
  | { kind: 'none'; reason: string; evidence: StoryMatchEvidence };

/**
 * Match an item's transcript against a week's stories. `candidates` is every story of the week
 * (listWeekStories); only those whose transcript was exported can be read, and the rest are named in
 * the evidence as not searched.
 */
export function matchByTranscript(itemText: string, candidates: readonly TranscriptCandidate[]): TranscriptMatch {
  const probes = probesOf(normalizedWords(itemText));
  const notSearched: StoryMatchEvidence['notSearched'] = [];
  const scores: Array<{ candidate: TranscriptCandidate; hits: number }> = [];
  for (const c of candidates) {
    if (!isLinkable(c)) {
      notSearched.push({ session: c.sourceSession, number: c.storyNumber, title: c.storyTitle, why: c.transcriptExists ? (c.unreadableReason ?? 'its transcript cannot be used') : 'its transcript was never exported' });
      continue;
    }
    const words = storyWords(c.transcriptPath);
    if (!Array.isArray(words)) {
      notSearched.push({ session: c.sourceSession, number: c.storyNumber, title: c.storyTitle, why: words.why });
      continue;
    }
    const set = new Set(shingles(words));
    const hits = probes.filter((p) => p.filter((s) => set.has(s)).length >= PROBE_HIT_SHINGLES).length;
    scores.push({ candidate: c, hits });
  }
  scores.sort((a, b) => b.hits - a.hits);
  const evidence: StoryMatchEvidence = {
    probes: probes.length,
    searched: scores.length,
    notSearched,
    top: scores.slice(0, 3).map((s) => ({ session: s.candidate.sourceSession, number: s.candidate.storyNumber, title: s.candidate.storyTitle, hits: s.hits })),
  };
  const unsearched = notSearched.length > 0 ? ` ${notSearched.length} ${notSearched.length === 1 ? 'story was' : 'stories were'} not searched (${notSearched.map((n) => `"${n.title}": ${n.why}`).join('; ')}).` : '';
  if (probes.length === 0) {
    return { kind: 'none', reason: `The item's transcript is shorter than ${PROBE_WORDS} words, so there is no text to match a story by.`, evidence };
  }
  if (scores.length === 0) {
    return { kind: 'none', reason: `No story of the week has an exported transcript to match against.${unsearched}`, evidence };
  }
  const [best, second] = scores;
  const needed = Math.max(WIN_MIN_HITS, Math.ceil(WIN_MIN_FRACTION * probes.length));
  const runnerUp = second === undefined ? 0 : second.hits;
  const said = `${best.hits} of ${probes.length} stretches of the item's transcript were found in ${label(best.candidate)}` +
    (second === undefined ? '' : `, ${runnerUp} in the next best, ${label(second.candidate)}`);
  if (best.hits < needed) {
    return { kind: 'none', reason: `No story matched the transcript clearly: ${said}; a match needs ${needed}.${unsearched}`, evidence };
  }
  if (best.hits < WIN_RATIO * runnerUp) {
    return { kind: 'none', reason: `Two stories match the transcript about equally (${said}), so neither is taken.${unsearched}`, evidence };
  }
  return { kind: 'winner', candidate: best.candidate as TranscriptCandidate & { durationSeconds: number; wordCount: number }, hits: best.hits, evidence };
}

function sameStory(a: { projectFolder: string; storyNumber: number; storySlug: string }, b: { projectFolder: string; storyNumber: number; storySlug: string }): boolean {
  return path.resolve(a.projectFolder) === path.resolve(b.projectFolder) && a.storyNumber === b.storyNumber && a.storySlug === b.storySlug;
}

/**
 * The item's thumbnail story, by the three methods in order (see the header). `operatorRef` is the
 * item's content link as the Inputs page sent it: a TranscriptRef the operator confirmed, `null` for
 * "final export only", `undefined` when the item was never offered one.
 */
export function resolveThumbnailStory(input: {
  videoPath: string | null;
  operatorRef: TranscriptRef | null | undefined;
  transcriptText: string;
}): ThumbnailStoryLink {
  const { operatorRef } = input;
  if (operatorRef) {
    return {
      state: 'linked',
      method: 'manual',
      ref: operatorRef,
      line: `Linked by hand on the Inputs page to ${label(operatorRef)}.`,
      evidence: null,
    };
  }
  if (input.videoPath === null) {
    return { state: 'none', reason: 'This item is not a video file, so there is no editor story to take frames from.', evidence: null };
  }
  const week = weekFolderOfExport(input.videoPath);
  if (week === null) {
    return {
      state: 'none',
      reason: `${input.videoPath} is not in a <week>/complete folder, so there is no week of editor sessions to look in.`,
      evidence: null,
    };
  }
  const scan = findCandidates(input.videoPath);
  const byName = (scan.classification === 'exact' || scan.classification === 'label') && isLinkable(scan.candidates[0])
    ? scan.candidates[0]
    : null;
  const { candidates } = listWeekStories(week);
  const match = matchByTranscript(input.transcriptText, candidates);

  if (byName !== null) {
    if (match.kind === 'winner' && !sameStory(match.candidate, byName)) {
      return {
        state: 'none',
        reason: `The file name points to ${label(byName)}, and the transcript points to ${label(match.candidate)} (${match.hits} of ${match.evidence.probes} stretches), so no story is linked. Link it by hand.`,
        evidence: match.evidence,
      };
    }
    const agreed = match.kind === 'winner' ? ` The transcript agrees (${match.hits} of ${match.evidence.probes} stretches found in it).` : '';
    return {
      state: 'linked',
      method: 'name',
      ref: refFromCandidate(byName, byName.via),
      line: `Linked by the file name (${byName.via === 'exact-title' ? 'the same title' : 'the same title without its slot'}) to ${label(byName)}.${agreed}`,
      evidence: match.evidence,
    };
  }

  const nameSaid = scan.classification === 'ambiguous'
    ? `The file name matches ${scan.candidates.length} stories (${scan.candidates.map((c) => `"${c.storyTitle}" of ${c.sourceSession}`).join(', ')}). `
    : scan.classification === 'none'
      ? 'The file name matches no story. '
      : `The file name matches ${label(scan.candidates[0])}, whose transcript was never exported. `;
  if (match.kind === 'winner') {
    return {
      state: 'linked',
      method: 'transcript',
      ref: refFromCandidate(match.candidate, 'transcript-match'),
      line: `${nameSaid}Linked by the transcript to ${label(match.candidate)}: ${match.hits} of ${match.evidence.probes} stretches of the item's transcript were found in it` +
        (match.evidence.top[1] ? `, ${match.evidence.top[1].hits} in the next best.` : '.'),
      evidence: match.evidence,
    };
  }
  return { state: 'none', reason: `${nameSaid}${match.reason}`, evidence: match.evidence };
}
