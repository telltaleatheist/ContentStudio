/**
 * Key phrases — KeyBERT-style ranking over the transport the chapter pipeline already uses
 *
 * The metadata spec (§2 of /Volumes/Callisto/Projects/Briefcase/docs/youtube-metadata-spec.md)
 * asks for key phrases with ZERO generation: take candidate noun phrases out of the content
 * text, embed the candidates and the document with nomic-embed-text, and rank the candidates
 * by cosine against the document. That is the whole method. It costs one batched /api/embed
 * call — the same call and the same model the chapter pipeline scores its junctions with —
 * and it cannot invent a phrase, because every candidate came out of the text.
 *
 * The pool it produces feeds three consumers: the description hook and body (as the phrases
 * they are told to front-load), the code-assembled tags, and the code-derived hashtags. One
 * extraction, three consumers, so those three cannot disagree about what the video is about.
 *
 * DEGRADATION, DECLARED. If the embedding model is not installed or the host does not answer,
 * this returns the candidates ranked by FREQUENCY instead, and says so in the returned
 * `mode` and `notice`. The caller records that notice in the run's warnings exactly as the
 * chapter pipeline records its lexical-scorer notice. It is not a silent substitution: the
 * report says which ranking produced the phrases that produced the tags.
 */

import { AxiosInstance } from 'axios';
import * as log from 'electron-log';
import { candidateKeyPhrases, occursIn } from './entity-extraction';
import { OLLAMA_KEEP_ALIVE } from './ollama-json';
import { isAbortError } from './cancellation';

/** Matches the chapter pipeline's embed timeout: one batched call measured in seconds. */
const EMBED_TIMEOUT_MS = 60_000;

/**
 * How many candidates are embedded.
 *
 * The embedding call is batched, so the cost is close to flat in the number of candidates —
 * but the candidate generator returns thousands on an hour of transcript, most of them
 * two-occurrence noise. Ranking the 200 most frequent is the same answer for a fraction of
 * the payload.
 */
const MAX_CANDIDATES = 200;

export interface KeyPhraseResult {
  /** Ranked best-first. */
  phrases: string[];
  /** Which ranking produced them. */
  mode: 'embedding' | 'frequency';
  /** Why the embedding ranking did not run. Empty when it did. */
  notice: string;
}

export interface KeyPhraseOptions {
  client: AxiosInstance;
  model: string;
  /** How many phrases to return. */
  limit: number;
  signal?: AbortSignal;
  logPrefix: string;
}

/**
 * Rank the content text's candidate noun phrases against the whole document.
 *
 * The document vector is the text itself, truncated to a length nomic-embed-text will
 * actually read (8192 tokens of context; ~20k characters is comfortably inside it). Truncating
 * the DOCUMENT is safe in a way that truncating a prompt is not: the document is being used as
 * a centroid to rank against, not as a claim about what the video contains.
 */
export async function rankKeyPhrases(text: string, options: KeyPhraseOptions): Promise<KeyPhraseResult> {
  const candidates = candidateKeyPhrases(text).slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) {
    return { phrases: [], mode: 'frequency', notice: '' };
  }

  const document = text.length > 20_000 ? text.slice(0, 20_000) : text;

  try {
    const started = Date.now();
    const response = await options.client.post(
      '/api/embed',
      { model: options.model, input: [document, ...candidates], keep_alive: OLLAMA_KEEP_ALIVE },
      { timeout: EMBED_TIMEOUT_MS, signal: options.signal }
    );
    const embeddings = response.data?.embeddings;
    if (
      !Array.isArray(embeddings) ||
      embeddings.length !== candidates.length + 1 ||
      !embeddings.every((v: unknown) => Array.isArray(v) && v.length > 0)
    ) {
      throw new Error(
        `Ollama /api/embed returned ${Array.isArray(embeddings) ? embeddings.length : 'no'} usable vectors ` +
          `for ${candidates.length + 1} inputs`
      );
    }

    const documentVector = embeddings[0] as number[];
    const scored = candidates.map((phrase, i) => ({
      phrase,
      score: cosine(documentVector, embeddings[i + 1] as number[]),
    }));
    scored.sort((a, b) => b.score - a.score);

    log.info(
      `${options.logPrefix} ranked ${candidates.length} key-phrase candidates with ${options.model} in ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s`
    );
    return { phrases: dedupeOverlaps(scored.map((s) => s.phrase), options.limit), mode: 'embedding', notice: '' };
  } catch (error: any) {
    if (isAbortError(error) || options.signal?.aborted) {
      throw new Error('key-phrase ranking was cancelled by the user during the embedding call');
    }
    const status = error?.response?.status;
    const detail = error?.response?.data?.error || error?.message || 'unknown error';
    const because =
      status === 404
        ? `the embedding model "${options.model}" is not installed — pull it with: ollama pull ${options.model}`
        : detail;
    const notice =
      `key phrases were ranked by FREQUENCY rather than by embedding similarity (${because}), so the tags ` +
      `and hashtags derived from them favour what was said often over what the video is most about`;
    log.warn(`${options.logPrefix} ${notice}`);
    return { phrases: dedupeOverlaps(candidates, options.limit), mode: 'frequency', notice };
  }
}

/**
 * Drop a phrase that is contained in one already kept.
 *
 * "christian nationalist" and "christian nationalist action" are one phrase said two ways, and
 * a list that spends both slots on them has one fewer thing to say. The longer, more specific
 * one is kept because specificity is the whole point of the pool (spec §1.2).
 */
function dedupeOverlaps(phrases: string[], limit: number): string[] {
  const kept: string[] = [];
  for (const phrase of phrases) {
    if (kept.length >= limit) break;
    const overlapping = kept.findIndex((k) => occursIn(k, phrase));
    if (overlapping !== -1) continue;
    const containedIndex = kept.findIndex((k) => occursIn(phrase, k));
    if (containedIndex !== -1) {
      kept[containedIndex] = phrase;
      continue;
    }
    kept.push(phrase);
  }
  return kept;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
