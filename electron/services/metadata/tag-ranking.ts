/**
 * TAG RANKING (LEDGER #296): which of a video's grounded names and phrases are worth a tag, and in
 * what order — read off a reranker against the video's title and summary, with near-duplicates
 * collapsed by embedding. No model writes a tag: every candidate is still a name or phrase the
 * chapter list or the summary carries AND the transcript says (`occursIn`), exactly the pools
 * tags-hashtags.ts assembles from. This only orders and thins them.
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

/** The reranker (qwen3-reranker-8b, Crucible 1.0.133). */
export const TAG_RERANK_MODEL = 'qwen3-reranker-8b';
/** The embedder (qwen3-embedding-8b, Crucible 1.0.133). */
export const TAG_EMBED_MODEL = 'qwen3-embedding-8b';

/** Below this relevance a candidate is not a tag (P(yes) from the reranker). Set from the u4-u6 runs. */
export const TAG_MIN_RELEVANCE = 0.5;
/** Two candidates this similar (cosine of unit vectors) name the same thing; the better-ranked one stays. */
export const TAG_SAME_COSINE = 0.9;

/** What relevant means to the reranker. */
export const TAG_RERANK_INSTRUCTION =
  "Given a YouTube video's title and summary, judge whether this search tag names a person, group, place, work, event or subject the video is substantially about";

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
  const add = (text: string, kind: 'name' | 'phrase') => {
    const key = text.trim().toLowerCase();
    if (key === '' || seen.has(key)) return;
    seen.add(key);
    candidates.push({ text: text.trim(), kind });
  };
  for (const e of input.entities) add(e, 'name');
  for (const e of fromSummary.entities) add(e, 'name');
  for (const p of input.phrases) add(p, 'phrase');
  for (const p of fromSummary.phrases) add(p, 'phrase');
  if (candidates.length === 0) {
    return { entities: [], phrases: [], ranked: [], line: 'no grounded name or phrase to rank' };
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
