/**
 * ONE CALL FOR THE THUMBNAIL WORDS, on the `thumbnail_words` routing row.
 *
 * Through the same door every text field takes (AIManagerService.runPlainRequest: Crucible, or
 * `claude -p` for the subscription rungs), thinking off like the titles call, a local model loaded
 * at the smallest context step that holds this prompt and its answer. The answer is parsed by
 * prompts.ts `parseThumbnailWords`; nothing re-asks (Law 3).
 */
import type { AIManagerService } from '../metadata/ai-manager.service';
import type { JobSessions } from '../../crucible/session';
import { loadContextFor } from '../metadata/context-sizing';
import { LOCAL_FIELD_TIMEOUT_MS } from '../metadata/metadata-tasks';
import type { MetadataRoutingOption } from '../metadata/metadata-routing';
import { buildWordsPrompt, parseThumbnailWords, type WordOptions } from './prompts';

/** The answer's budget: fifteen short lines and three headers need a few hundred tokens. */
export const WORDS_MAX_TOKENS = 1024;

export interface WordsResult {
  options: WordOptions;
  model: string;
  prompt: string;
}

export async function writeThumbnailWords(input: {
  aiManager: Pick<AIManagerService, 'runPlainRequest'>;
  option: MetadataRoutingOption;
  channel: string;
  creator: string;
  title: string;
  transcript: readonly string[];
  sourceLabel: string;
  /** The window's held job for this local model; absent for cloud. */
  job?: JobSessions;
  /** Lines already written for this title, for "More options": the model is asked for others. */
  avoid?: readonly string[];
}): Promise<WordsResult> {
  const prompt = buildWordsPrompt({ channel: input.channel, creator: input.creator, title: input.title, transcript: input.transcript, avoid: input.avoid ?? [] });
  const what = `thumbnail text for ${input.sourceLabel}`;
  const answer = await input.aiManager.runPlainRequest(
    prompt,
    input.option.model,
    what,
    input.option.kind === 'local'
      ? { thinking: false, maxTokens: WORDS_MAX_TOKENS, loadContext: loadContextFor(prompt.length, WORDS_MAX_TOKENS), timeoutMs: LOCAL_FIELD_TIMEOUT_MS, ...(input.job === undefined ? {} : { job: input.job }) }
      : { thinking: false },
  );
  if (!answer) throw new Error(`The request for ${what} on "${input.option.model}" came back empty.`);
  return { options: parseThumbnailWords(answer, what), model: input.option.model, prompt };
}
