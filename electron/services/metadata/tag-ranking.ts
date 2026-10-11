/**
 * TAG RANKING (LEDGER #296): which of a video's grounded names and phrases are worth a tag, and in
 * what order — read off a reranker against the video's title and summary, with near-duplicates
 * collapsed by embedding. No model writes a tag: every candidate is still a name or phrase the
 * chapter list or the summary carries AND the transcript says (`occursIn`), exactly the pools
 * tags-hashtags.ts assembles from. This only orders and thins them. The summary adds NAMES only.
 *
 * WHY. The pools came out in chapter order, so a weak phrase from chapter 1 ("stand against", a bare
 * book name) took budget from a central name in chapter 3. nomic-embed-text used to rank them; it
 * was retired 2026-09-25 (#205) and nothing replaced it. Crucible 1.0.133 serves `rerank` and
 * `embed` (Owen, 2026-10-10: "the embed and rerank verbs are available on crucible now").
 *
 * FIXED ROLES, not routing rows (Owen: "i dont think they should be routing choices… they cant
 * really replace a chat model. its a different step"): the two model ids below, like the re-roll
 * gate's scorer. A smaller reranker or embedder is a change to these two lines.
 */
import type { AIManagerService } from './ai-manager.service';
import { summaryParagraphs, type StretchSummary } from './stretch-summary';
import { chapterPools, ENTITY_POOL_SIZE, PHRASE_POOL_SIZE } from './tags-hashtags';

/**
 * The judge: the 9B through Crucible's rerank verb, which takes any decide model (LEDGER #297).
 *
 * NOT the dedicated qwen3-reranker-8b, measured against it on u4's 68 real candidates (2026-10-10):
 * a relevance reranker rewards whatever echoes the summary's wording, so "ridiculous nonsense" (0.73)
 * and "com slash godspeople" (0.71) outranked Hitler (0.22) and King Cyrus (0.10), under every
 * instruction tried. The 9B, asked whether each is a good search tag, put 12 of 14 hand-marked good
 * tags in its top 20 and no junk (good 0.87 average, junk 0.50). It is also the model the run already
 * holds for the summary and the gate, so nothing is swapped in for it.
 */
export const TAG_RERANK_MODEL = 'qwen3.5-9b';
/** The embedder (qwen3-embedding-8b, Crucible 1.0.133). */
export const TAG_EMBED_MODEL = 'qwen3-embedding-8b';

/** Below this a candidate is not a tag (the 9B's P(yes)). Set from u4-u6 (#297): above 0.7 they are subjects; below 0.5, filler, numbers and web addresses. */
export const TAG_MIN_RELEVANCE = 0.7;
/** Two candidates this similar (cosine of unit vectors) name the same thing; the better-ranked one stays. */
export const TAG_SAME_COSINE = 0.9;

/** What relevant means to the reranker. */
export const TAG_RERANK_INSTRUCTION =
  'The Query describes a YouTube video. Judge whether the Document is a good search tag for it: the name of a person, ' +
  'organization, place, book, event, doctrine or movement the video discusses, or a short topic phrase a viewer would ' +
  'type to find it. Opinions, insults, numbers, filler fragments and web addresses are not tags.';

export interface RankedCandidate {
  text: string;
  kind: 'name' | 'phrase';
  score: number;
  /** The better-ranked candidate this one duplicates, when it was folded into it. */
  sameAs?: string;
}

export interface TagRanking {
  /** The names to assemble from, most relevant first. */
  entities: string[];
  /** The phrases to assemble from, most relevant first. */
  phrases: string[];
  /** The most relevant candidate of either kind: the list's first tag (assembleTags' primary phrase). */
  primary: string | null;
  /** Every candidate, ranked, with its score; for the report. */
  ranked: RankedCandidate[];
  /** One line for the log and the report. */
  line: string;
}

/**
 * Rank one item's tag candidates. `entities`/`phrases` are the chapter pools; the summary's own
 * names and phrases join them, grounded in `contentText` the same way. Throws naming the call on a
 * failed rerank or embed (the item's tags are a field like any other).
 */
export async function rankTagPools(input: {
  aiManager: Pick<AIManagerService, 'rerank' | 'embed'>;
  entities: readonly string[];
  phrases: readonly string[];
  title: string;
  summary: StretchSummary;
  contentText: string;
  sourceLabel: string;
  /**
   * The channel's own names (brand terms, channel tags): never candidates. They are appended to the
   * tags as the channel's tags, and a hashtag of the creator's own name (#OwenMorgan, u5 2026-10-10)
   * is not a subject of the video (#297).
   */
  exclude: readonly string[];
}): Promise<TagRanking> {
  const fromSummary = chapterPools({
    subjects: input.summary.paragraphs.map((p) => p.text),
    details: input.summary.paragraphs.map(() => ''),
    contentText: input.contentText,
    entityLimit: ENTITY_POOL_SIZE,
    phraseLimit: PHRASE_POOL_SIZE,
  });
  const candidates: Array<{ text: string; kind: 'name' | 'phrase' }> = [];
  const seen = new Set<string>();
  const own = new Set(input.exclude.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const add = (text: string, kind: 'name' | 'phrase') => {
    const key = text.trim().toLowerCase();
    if (key === '' || seen.has(key) || own.has(key)) return;
    seen.add(key);
    candidates.push({ text: text.trim(), kind });
  };
  for (const e of input.entities) add(e, 'name');
  for (const e of fromSummary.entities) add(e, 'name');
  // Phrases from the chapter list only: the summary is prose, and its word runs were the fragments
  // ("governor liburn boggs issued", "prompt carson") that took tag slots on 2026-10-10 (#297).
  for (const p of input.phrases) add(p, 'phrase');
  if (candidates.length === 0) {
    return { entities: [], phrases: [], primary: null, ranked: [], line: 'no grounded name or phrase to rank' };
  }

  const query = `Title: ${input.title}\n\n${summaryParagraphs(input.summary)}`;
  const reranked = await input.aiManager.rerank(
    TAG_RERANK_MODEL, query, candidates.map((c) => c.text), TAG_RERANK_INSTRUCTION,
    `the tag ranking for ${input.sourceLabel} (${candidates.length} candidates)`);
  const scored = candidates
    .map((c, i) => ({ ...c, score: reranked.scores[i] }))
    .sort((a, b) => b.score - a.score);

  const relevant = scored.filter((c) => c.score >= TAG_MIN_RELEVANCE);
  const ranked: RankedCandidate[] = scored.filter((c) => c.score < TAG_MIN_RELEVANCE);
  const kept: Array<RankedCandidate & { vector: number[] }> = [];
  if (relevant.length > 0) {
    const embedded = await input.aiManager.embed(
      TAG_EMBED_MODEL, relevant.map((c) => c.text), 'document', `the tag duplicates for ${input.sourceLabel} (${relevant.length} tags)`);
    relevant.forEach((c, i) => {
      const vector = embedded.vectors[i];
      const twin = kept.find((k) => cosine(k.vector, vector) >= TAG_SAME_COSINE);
      if (twin) ranked.push({ ...c, sameAs: twin.text });
      else kept.push({ ...c, vector });
    });
  }
  const order = kept.map(({ vector, ...c }) => c);
  ranked.unshift(...order);
  ranked.sort((a, b) => b.score - a.score);
  const folded = ranked.filter((c) => c.sameAs !== undefined).length;
  return {
    primary: order.length > 0 ? order[0].text : null,
    entities: order.filter((c) => c.kind === 'name').map((c) => c.text),
    phrases: order.filter((c) => c.kind === 'phrase').map((c) => c.text),
    ranked,
    line:
      `${candidates.length} candidates ranked on ${reranked.model} (${reranked.ms} ms): ${order.length} kept at ` +
      `relevance >= ${TAG_MIN_RELEVANCE}, ${scored.length - relevant.length} below it, ${folded} folded as duplicates`,
  };
}

/** Cosine of two vectors (unit length from Crucible, so the dot product; computed in full anyway). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) throw new Error(`vectors of ${a.length} and ${b.length} floats cannot be compared`);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
