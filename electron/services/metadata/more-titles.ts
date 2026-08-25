/**
 * Ten more titles, on demand — the run's OWN titles prompt, replayed.
 *
 * WHY REPLAY RATHER THAN RE-ASSEMBLE. The prompt a titles call sent is a fact the run
 * recorded: `_prompt_trace` carries it verbatim (ai-manager.service.ts pushes every routed
 * call's exact text before it sends). Re-assembling it here would mean rebuilding the
 * editorial core, the chapter digest, the analytics insights block and the transcript from
 * whatever those sources say TODAY — a different prompt wearing the same name, and the
 * operator comparing the new ten against the old ten would be comparing two briefs. The
 * stored prompt is the brief this item was written to, so that is what goes back out.
 *
 * The consequence is stated rather than worked around: an item whose report predates stored
 * prompts CANNOT have more titles written for it here. There is no re-assembly path and no
 * partial prompt — the caller is told to regenerate the item, which is the thing that would
 * actually give it a recorded brief.
 *
 * APPEND-ONLY, NO DEDUPE. The answer goes onto the item's titles array exactly as the model
 * wrote it. A repeat of a title already on the record is the model's information about the
 * model, and the operator curates (the standing deliver-and-curate rule). Nothing here
 * filters, sorts or renumbers, and nothing touches the run's .txt artifact — the .txt is
 * what that run produced, and the json record is what the app reads.
 *
 * ONE CALL. A count other than ten is a warning carried back to the caller; an answer with
 * no lines in it throws, naming what came back. Nothing re-asks.
 */

import axios from 'axios';
import log from 'electron-log';

import { AIManagerService } from './ai-manager.service';
import { askOllamaPlain, parseLines } from './plain-call';
import { estimateTokens } from './ollama-json';
import {
  LOCAL_FIELD_CTX_MAX,
  LOCAL_FIELD_KEEP_ALIVE,
  LOCAL_FIELD_NUM_PREDICT,
  LOCAL_FIELD_TIMEOUT_MS,
  runNumCtx,
} from './metadata-tasks';
import { MetadataRoutingOption, resolveOperatorOption, taskOptionIds } from './metadata-routing';
import { queueAITask } from '../queue-manager.service';

/** How many titles one operator request asks for. Stated once; it is in the prompt too. */
export const MORE_TITLES_COUNT = 10;

/**
 * How a run names its titles call in `_prompt_trace`.
 *
 * Written by metadata-tasks as `the ${field} call for ${ctx.sourceLabel}`, so the source label
 * is everything after this prefix — which is where the label for the new entry comes from as
 * well. Reading it off the trace rather than off `item.source_path` keeps the two entries
 * naming the same video the same way even for a record whose source path was never stored.
 */
export const TITLES_TRACE_PREFIX = 'the titles call for ';

export interface PromptTraceEntry {
  what: string;
  model: string;
  chars: number;
  at: string;
  prompt: string;
}

/** The stored titles call, as the run recorded it. */
export interface StoredTitlesCall {
  /** The assembled prompt, byte for byte as it was sent. */
  prompt: string;
  /** The model that read it, provider-prefixed the way AIManagerService names models. */
  model: string;
  /** Everything after TITLES_TRACE_PREFIX — the video, named the way the run named it. */
  sourceLabel: string;
}

/**
 * The item's titles call, or null when this record predates stored prompts.
 *
 * The LAST matching entry wins: an item that has already had more titles written for it
 * still has exactly one `the titles call for …` entry (the extra rounds are named
 * differently), but a re-run that appended a second one would mean the later brief is the
 * live one.
 */
export function findStoredTitlesCall(item: unknown): StoredTitlesCall | null {
  const trace = (item as { _prompt_trace?: unknown })?._prompt_trace;
  if (!Array.isArray(trace)) return null;
  let found: StoredTitlesCall | null = null;
  for (const entry of trace as PromptTraceEntry[]) {
    if (!entry || typeof entry.what !== 'string' || !entry.what.startsWith(TITLES_TRACE_PREFIX)) continue;
    if (typeof entry.prompt !== 'string' || entry.prompt.length === 0) continue;
    if (typeof entry.model !== 'string' || entry.model.length === 0) continue;
    found = {
      prompt: entry.prompt,
      model: entry.model,
      sourceLabel: entry.what.slice(TITLES_TRACE_PREFIX.length),
    };
  }
  return found;
}

/**
 * The stored prompt plus the one thing it cannot already say: what has been written.
 *
 * Deliberately minimal. Every rule this call follows — the channel's voice, the length
 * ceiling, the A/B head-to-heads, the output shape — is already in the prompt above this
 * block, and restating any of it here would be a second brief competing with the first.
 * The block adds the titles on the record and asks for ten more angles.
 */
export function buildMoreTitlesPrompt(storedPrompt: string, existingTitles: string[]): string {
  return (
    storedPrompt +
    '\n\nAlready written for this video:\n' +
    existingTitles.join('\n') +
    `\n\nWrite ${MORE_TITLES_COUNT} new titles, each a genuinely different angle from every title above. ` +
    'Keep the rules and the output shape stated above: one title per line, and those ' +
    `${MORE_TITLES_COUNT} lines are the whole answer.\n`
  );
}

/** The option ids the TITLES task offers, in the order the routing modal lists them. */
export function titlesOptionIds(): string[] {
  return taskOptionIds('titles');
}

/**
 * One option id, checked against what the TITLES task actually offers.
 *
 * A thin wrapper over the shared operator-picker validator since 2026-08-25, when the soften
 * pass needed the same three checks against a different task. The name stays because the IPC
 * handler reads by it and it says which dropdown is being refused on behalf of.
 */
export function resolveTitlesOption(optionId: unknown): MetadataRoutingOption {
  return resolveOperatorOption('titles', optionId);
}

export interface MoreTitlesResult {
  titles: string[];
  /** The provider-prefixed model string the call actually went out on. */
  model: string;
  /** The exact prompt sent, for the trace entry the caller writes. */
  prompt: string;
  /** Said when the answer held a count other than ten. The titles are kept either way. */
  warning: string | null;
}

export interface MoreTitlesTransport {
  /** Built by the caller, which is where the API keys and the Ollama host live. */
  aiManager: AIManagerService;
  ollamaHost: string;
}

/**
 * Send the replayed prompt on the operator's chosen model and read the answer.
 *
 * TWO TRANSPORTS, the same two the titles unit itself has, reached the same way:
 *   cloud — AIManagerService.runPlainRequest (CloudFieldUnit's call)
 *   local — askOllamaPlain over /api/generate (LocalFieldUnit's call)
 * The local path does NOT go through AIManagerService's Ollama route on purpose: that one
 * middle-truncates a prompt bigger than its fixed window, and a replay that silently drops
 * the middle of the brief is not the brief.
 */
export async function askForMoreTitles(
  stored: StoredTitlesCall,
  existingTitles: string[],
  option: MetadataRoutingOption,
  transport: MoreTitlesTransport
): Promise<MoreTitlesResult> {
  const prompt = buildMoreTitlesPrompt(stored.prompt, existingTitles);
  const what = `${MORE_TITLES_COUNT} more titles for ${stored.sourceLabel} (operator request)`;

  let text: string;
  if (option.kind === 'cloud') {
    const answer = await transport.aiManager.runPlainRequest(prompt, option.model, what);
    if (!answer) {
      throw new Error(`The request for ${what} on "${option.model}" came back empty.`);
    }
    text = answer;
  } else {
    // One call on one model, so the window is sized for this prompt alone — there is no run
    // to share a pinned num_ctx with, and nothing else is resident on this account.
    const numCtx = runNumCtx({
      model: option.model,
      needs: [estimateTokens(prompt.length) + LOCAL_FIELD_NUM_PREDICT],
      max: LOCAL_FIELD_CTX_MAX,
      what,
    });
    const client = axios.create({ baseURL: transport.ollamaHost });
    const result = await queueAITask(
      `more-titles-${option.model}-${stored.sourceLabel}`,
      `Titles: ${MORE_TITLES_COUNT} more on ${option.model}`,
      async () =>
        askOllamaPlain(client, {
          model: option.model,
          prompt,
          numCtx,
          numPredict: LOCAL_FIELD_NUM_PREDICT,
          keepAlive: LOCAL_FIELD_KEEP_ALIVE,
          timeoutMs: LOCAL_FIELD_TIMEOUT_MS,
          what,
          logPrefix: `[MoreTitles] ${option.model}`,
        }),
      undefined,
      LOCAL_FIELD_TIMEOUT_MS + 60_000
    );
    if (!result.ok) {
      throw new Error(
        `The request for ${what} on "${option.model}" produced no usable answer ` +
          `(${result.reason}): ${result.detail}`
      );
    }
    text = result.text;
  }

  // The titles unit's own reader: one option per line, numbering and bullets tolerated and
  // stripped, an answer with no lines in it throws carrying what came back.
  const titles = parseLines(text, what);

  // Deliver-and-curate: a count other than ten is SAID and the answer is kept whole.
  const warning =
    titles.length === MORE_TITLES_COUNT
      ? null
      : `"${option.model}" returned ${titles.length} title(s) where ${MORE_TITLES_COUNT} were asked for; ` +
        `all ${titles.length} are kept exactly as written.`;
  if (warning) log.warn(`[MoreTitles] ${warning}`);

  return { titles, model: option.model, prompt, warning };
}

/** The trace entry the new call earns, in the same shape the run's own entries have. */
export function moreTitlesTraceEntry(stored: StoredTitlesCall, result: MoreTitlesResult): PromptTraceEntry {
  return {
    what: `${MORE_TITLES_COUNT} more titles for ${stored.sourceLabel} (operator request)`,
    model: result.model,
    chars: result.prompt.length,
    at: new Date().toISOString(),
    prompt: result.prompt,
  };
}
