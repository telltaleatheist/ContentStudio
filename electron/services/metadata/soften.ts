/**
 * Soften for monetization — a whole metadata set, rewritten into a milder register
 *
 * WHAT THE OPERATOR IS DOING. He reads a generated report, sees wording that YouTube's
 * advertiser-friendly classifier will read as graphic ("raped", "child abuse"), picks a model
 * and clicks. Every text field on the item is rewritten so the words are milder and the
 * MEANING, the facts, the names, the claims and the shape are untouched.
 *
 * WHERE IT LANDS, AND WHY THAT IS THE WHOLE DESIGN. A softening pass produces a NEW METADATA
 * SET for the same video — a new job holding one new item, joined to the original by
 * `source_key` — and the operator picks between the two. It is NOT a set of edits on the
 * original item's publish record.
 *
 * That is not a new concept in this app; it is what REGENERATION already does. Two runs over
 * the same source are two items with two ids and one source_key (item-identity.ts), 15 of the
 * 86 sources on disk already carry 2-4 of them, carry-forward.ts is built entirely on that
 * join, and the reports page already groups by source_key with the newest run at the head and
 * the older ones collapsed beneath it. A softened set is that, with a different author. The
 * consequence worth stating: because the softened set is a FULL item rather than a set of
 * field overrides, it is not limited to the four fields that happen to have an override
 * surface on ChosenMetadata — every text field the item carries is softened.
 *
 * THE ORIGINAL IS NEVER TOUCHED. Not its job record, not its .txt, not its publish record.
 * A softened set that turns out worse is discarded by deleting one item.
 *
 * ONE PLAIN-TEXT CALL PER FIELD, sequential, none of them carrying the transcript — softening
 * reads the metadata text and nothing else. This is not a prompt replay: `_prompt_trace` is
 * not read as input anywhere here.
 *
 * WHY THE VOCABULARY IS DATA AND NOT INSTRUCTION. Naming a wrong form inside instruction text
 * collapses quality, which is why every prompt in this tree states what to do rather than what
 * to avoid. But "raped -> taken advantage of" IS the job here, and it can only be shown by
 * naming both forms. So it sits in the DATA block, beneath the instructions, where naming a
 * wrong form is safe — and that separation is the entire reason this is a separate pass rather
 * than a line added to titles.yml. Keep it strict: soften.yml's `register` describes the
 * register wanted; `vocabulary` shows the substitutions.
 *
 * SHAPES FAIL LOUDLY. A line list that comes back with a different number of lines THROWS,
 * naming the field, the model, the count asked for and the count that arrived; nothing is
 * partially applied and nothing re-asks. A field the item does not carry is SKIPPED and the
 * skip is reported — never silently dropped.
 *
 * CHAPTER TIMESTAMPS NEVER GO TO A MODEL and are never parsed back from one (standing law).
 * The titles go out alone, one per line, and the timestamps are reattached here by position.
 */

import axios from 'axios';
import log from 'electron-log';

import { AIManagerService } from './ai-manager.service';
import { Chapter } from './chapter-generator.service';
import { askOllamaPlain, parseLines } from './plain-call';
import { estimateTokens } from './ollama-json';
import {
  LOCAL_FIELD_CTX_MAX,
  LOCAL_FIELD_KEEP_ALIVE,
  LOCAL_FIELD_NUM_PREDICT,
  LOCAL_FIELD_TIMEOUT_MS,
  normalizeTagLine,
  runNumCtx,
} from './metadata-tasks';
import { MetadataRoutingOption, resolveOperatorOption } from './metadata-routing';
import { promptAssets } from './prompt-assets';
import { queueAITask } from '../queue-manager.service';
import type { PromptTraceEntry } from './more-titles';

/** The prompt asset this pass reads. Operator-editable on the Instructions page. */
export const SOFTEN_PROMPT_FILE = 'soften.yml';

/**
 * The routing task whose option list the operator's dropdown is built from, and which his
 * choice is validated against before anything is read.
 *
 * DESCRIPTION, and the reason is the option list rather than the field: `description` is the
 * one task that offers every rung this build ships (both local models, the 4B, all four cloud
 * rungs and both `claude -p` rungs), so it is the superset — softening is a prose rewrite that
 * any of them can perform, and sourcing from a narrower task would hide rungs for no reason.
 * Sourcing from a per-field task would be worse still: this pass spans nine fields routed to
 * four different tasks, and picking one of them would make the dropdown lie about which
 * field's models it was offering.
 */
export const SOFTEN_ROUTING_TASK = 'description' as const;

/** One option id from the operator's dropdown, checked against what that task offers. */
export function resolveSoftenOption(optionId: unknown): MetadataRoutingOption {
  return resolveOperatorOption(SOFTEN_ROUTING_TASK, optionId);
}

/**
 * The output shapes a softening call can be asked for. One prompt block each, in soften.yml.
 *
 *   lines       — N entries in, N lines out, same order. A mismatch throws.
 *   prose       — one block of text in, one block out. The whole answer is the text.
 *   comma_line  — one comma-separated line in, one out.
 *   space_line  — one space-separated hashtag line in, one out.
 */
export type SoftenShape = 'lines' | 'prose' | 'comma_line' | 'space_line';

/** One field's call, planned before anything is sent. */
export interface SoftenPlan {
  /** Reported to the operator and written into the trace, e.g. `titles`, `chapter titles`. */
  field: string;
  /** Which `labels:` entry in soften.yml names this text to the model. */
  labelKey: string;
  shape: SoftenShape;
  /** Exactly what goes in the data block. */
  text: string;
  /** Entries in, for the `lines` shape. null for every other shape. */
  count: number | null;
  /**
   * Where the answer goes back on the softened item. Given the softened value and the item
   * being built, it writes it — so the reattachment rules (chapter timestamps by position,
   * one alternate description by index) live beside the plan that produced them.
   */
  apply: (softened: string[] | string, item: any) => void;
}

/** A field that had nothing to soften. Reported, never silent. */
export interface SoftenSkip {
  field: string;
  reason: string;
}

/** What one field's call actually produced. */
export interface SoftenFieldResult {
  field: string;
  /** Non-fatal note carried to the operator with the value kept — deliver-and-curate. */
  warning: string | null;
}

export interface SoftenRunResult {
  /** The provider-prefixed model every call in this pass went out on. */
  model: string;
  /** Fields that were rewritten, in call order. */
  applied: SoftenFieldResult[];
  /** Fields the item did not carry. Not an error; still reported. */
  skipped: SoftenSkip[];
  /** One entry per call that happened, for the new item's `_prompt_trace`. */
  trace: PromptTraceEntry[];
  /** The softened metadata, ready to be written as a new item. */
  metadata: any;
}

export interface SoftenTransport {
  /** Built by the caller, which is where the API keys and the Ollama host live. */
  aiManager: AIManagerService;
  ollamaHost: string;
}

// ---------------------------------------------------------------------------
// Reading the item
// ---------------------------------------------------------------------------

/** A non-empty string, or null. Used to tell "the item has no such field" from "it has one". */
function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Every string in an array field, or a throw naming the entry that is not one.
 *
 * A non-string entry is NOT skipped past: the shape contract counts entries, and an array
 * that quietly lost one would come back with a count that no longer matches the array it has
 * to be written into.
 */
function stringsOf(value: unknown, field: string, itemId: string): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.map((entry, index) => {
    const text = textOf(entry);
    if (text === null) {
      throw new Error(
        `Entry ${index + 1} of "${field}" on item ${itemId} is ${
          typeof entry
        }, not text, so this field cannot be softened as a list of ${value.length} entries.`
      );
    }
    return text;
  });
}

/**
 * How this item names itself, for the log lines and the trace entries.
 *
 * `_title` first because it is the name the operator sees, then the source file's basename,
 * then the item id. All three are the item stating its own name — none of them is a value
 * substituted for a missing one, which is why this reaches for the next when one is absent.
 */
export function softenSourceLabel(item: any): string {
  const title = textOf(item?._title);
  if (title) return title;
  const sourcePath = textOf(item?.source_path);
  if (sourcePath) return sourcePath.split(/[\\/]/).pop() || sourcePath;
  const itemId = textOf(item?.item_id);
  if (itemId) return itemId;
  throw new Error(
    'A softening pass needs the item to name itself for its log and trace entries, and this ' +
      'one carries no _title, no source_path and no item_id.'
  );
}

/**
 * The calls this item earns, and the fields it has nothing to soften in.
 *
 * `target` is the metadata object being built — the plans write into it, so this is where the
 * shape of the softened item is decided. Nothing is sent until every plan exists.
 *
 * `description_options` gets ONE CALL PER ALTERNATE rather than one call for the array. Each
 * alternate is a multi-line block of prose, so a single call would need a separator line the
 * model had to reproduce exactly — a shape with a failure mode, invented here, for no gain.
 * One prose call each has no count to get wrong.
 */
export function planSoftening(source: any, target: any): { plans: SoftenPlan[]; skipped: SoftenSkip[] } {
  const itemId = typeof source?.item_id === 'string' ? source.item_id : '(no item_id)';
  const plans: SoftenPlan[] = [];
  const skipped: SoftenSkip[] = [];

  const listField = (field: string, labelKey: string, key: string): void => {
    const entries = stringsOf(source?.[key], field, itemId);
    if (entries === null) {
      skipped.push({ field, reason: `the item carries no ${field}.` });
      return;
    }
    plans.push({
      field,
      labelKey,
      shape: 'lines',
      text: entries.join('\n'),
      count: entries.length,
      apply: (softened, item) => {
        item[key] = softened as string[];
      },
    });
  };

  const proseField = (field: string, labelKey: string, key: string): void => {
    const text = textOf(source?.[key]);
    if (text === null) {
      skipped.push({ field, reason: `the item carries no ${field}.` });
      return;
    }
    plans.push({
      field,
      labelKey,
      shape: 'prose',
      text,
      count: null,
      apply: (softened, item) => {
        item[key] = softened as string;
      },
    });
  };

  listField('titles', 'titles', 'titles');
  listField('thumbnail text', 'thumbnail_text', 'thumbnail_text');
  listField('pinned comment options', 'pinned_comment', 'pinned_comment');
  proseField('the description hook', 'description_hook', 'description_hook');
  proseField('the description', 'description', 'description');

  // The alternates, one call each. See the note on this function.
  const options = stringsOf(source?.description_options, 'description_options', itemId);
  if (options === null) {
    skipped.push({ field: 'alternate descriptions', reason: 'the item carries no alternate descriptions.' });
  } else {
    options.forEach((text, index) => {
      plans.push({
        field: `alternate description ${index + 1} of ${options.length}`,
        labelKey: 'description_options',
        shape: 'prose',
        text,
        count: null,
        apply: (softened, item) => {
          if (!Array.isArray(item.description_options)) item.description_options = [];
          item.description_options[index] = softened as string;
        },
      });
    });
  }

  // Tags arrive as a comma string on every item this app writes; the array form exists on
  // older reports and composeTags reads both. Either way one comma line goes out and one
  // comes back, and it is written back in the form the item already used.
  const rawTags = source?.tags;
  const tagsWereArray = Array.isArray(rawTags);
  const tagLine = tagsWereArray
    ? (rawTags as unknown[]).map((t) => textOf(t)).filter((t): t is string => t !== null).join(', ')
    : textOf(rawTags);
  if (!tagLine) {
    skipped.push({ field: 'tags', reason: 'the item carries no tags.' });
  } else {
    plans.push({
      field: 'tags',
      labelKey: 'tags',
      shape: 'comma_line',
      text: tagLine,
      count: null,
      apply: (softened, item) => {
        const line = softened as string;
        item.tags = tagsWereArray ? line.split(',').map((t) => t.trim()).filter(Boolean) : line;
      },
    });
  }

  const hashtags = textOf(source?.hashtags);
  if (hashtags === null) {
    skipped.push({ field: 'hashtags', reason: 'the item carries no hashtags.' });
  } else {
    plans.push({
      field: 'hashtags',
      labelKey: 'hashtags',
      shape: 'space_line',
      text: hashtags,
      count: null,
      apply: (softened, item) => {
        item.hashtags = softened as string;
      },
    });
  }

  // CHAPTER TITLES ONLY. The timestamps do not go out and do not come back; the softened
  // titles are reattached to the chapters they were read off, by position, on the item's own
  // chapter objects — every other key on a chapter (timestamp, sequence, endTimestamp, detail,
  // startApprox, subChapters, isPromo) is left exactly as the run wrote it.
  const chapters: Chapter[] = Array.isArray(source?.chapters) ? source.chapters : [];
  const chapterTitles = chapters.map((chapter, index) => {
    const title = textOf(chapter?.title);
    if (title === null) {
      throw new Error(
        `Chapter ${index + 1} of ${chapters.length} on item ${itemId} has no title text, so the ` +
          `chapter list cannot be softened as ${chapters.length} lines.`
      );
    }
    return title;
  });
  if (chapterTitles.length === 0) {
    skipped.push({ field: 'chapter titles', reason: 'the item carries no chapters.' });
  } else {
    plans.push({
      field: 'chapter titles',
      labelKey: 'chapters',
      shape: 'lines',
      text: chapterTitles.join('\n'),
      count: chapterTitles.length,
      apply: (softened, item) => {
        const titles = softened as string[];
        item.chapters = (item.chapters as Chapter[]).map((chapter, index) => ({
          ...chapter,
          title: titles[index],
        }));
      },
    });
  }

  if (plans.length === 0) {
    throw new Error(
      `Item ${itemId} carries no text to soften — every field this pass reads is absent: ` +
        `${skipped.map((s) => s.field).join(', ')}.`
    );
  }
  return { plans, skipped };
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/**
 * One field's prompt: the register instruction, the shape it must come back in, the operator's
 * vocabulary as DATA, and the text.
 *
 * Every string here comes out of soften.yml, so the operator changes what this asks for on the
 * Instructions page and nothing in this file is a second copy of it. A missing key throws out
 * of `promptAssets().pipeline` naming the file and the key — the loader's standing contract.
 */
export function buildSoftenPrompt(plan: SoftenPlan): string {
  const assets = promptAssets();
  const register = assets.pipeline(SOFTEN_PROMPT_FILE, 'register');
  const shapeKey = `shapes.${plan.shape}`;
  let shape = assets.pipeline(SOFTEN_PROMPT_FILE, shapeKey);
  if (shape.includes('{count}')) {
    if (plan.count === null) {
      throw new Error(
        `Prompt asset "shared/pipeline/${SOFTEN_PROMPT_FILE}" key "${shapeKey}" carries a {count} ` +
          `slot, and the "${plan.field}" call has no entry count to fill it with — only the ` +
          `"lines" shape counts entries.`
      );
    }
    shape = shape.replace(/\{count\}/g, () => String(plan.count));
  }
  const intro = assets.pipeline(SOFTEN_PROMPT_FILE, 'vocabulary_intro');
  const vocabulary = assets.pipeline(SOFTEN_PROMPT_FILE, 'vocabulary');
  const label = assets.pipeline(SOFTEN_PROMPT_FILE, `labels.${plan.labelKey}`);

  return `${register}\n\n${shape}\n\n${intro}\n\n${vocabulary}\n\n${label}\n${plan.text}\n`;
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * Send one field's prompt on the operator's chosen model and read the answer.
 *
 * TWO TRANSPORTS, the same two every generation call has, reached the same way:
 *   cloud — AIManagerService.runPlainRequest
 *   local — askOllamaPlain over /api/generate
 * The local path deliberately does NOT go through AIManagerService's Ollama route: that one
 * middle-truncates a prompt bigger than its fixed window, and a softening call whose data
 * block lost its middle would come back a different length than it went out.
 */
async function askToSoften(
  plan: SoftenPlan,
  option: MetadataRoutingOption,
  transport: SoftenTransport,
  sourceLabel: string,
  prompt: string
): Promise<string> {
  const what = `softening ${plan.field} for ${sourceLabel} (operator request)`;

  if (option.kind === 'cloud') {
    const answer = await transport.aiManager.runPlainRequest(prompt, option.model, what);
    if (!answer) {
      throw new Error(`The request for ${what} on "${option.model}" came back empty.`);
    }
    return answer;
  }

  // One call on one model, so the window is sized for this prompt alone — there is no run to
  // share a pinned num_ctx with.
  const numCtx = runNumCtx({
    model: option.model,
    needs: [estimateTokens(prompt.length) + LOCAL_FIELD_NUM_PREDICT],
    max: LOCAL_FIELD_CTX_MAX,
    what,
  });
  const client = axios.create({ baseURL: transport.ollamaHost });
  const result = await queueAITask(
    `soften-${plan.field}-${option.model}-${sourceLabel}`,
    `Soften: ${plan.field} on ${option.model}`,
    async () =>
      askOllamaPlain(client, {
        model: option.model,
        prompt,
        numCtx,
        numPredict: LOCAL_FIELD_NUM_PREDICT,
        keepAlive: LOCAL_FIELD_KEEP_ALIVE,
        timeoutMs: LOCAL_FIELD_TIMEOUT_MS,
        what,
        logPrefix: `[Soften] ${option.model}`,
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
  return result.text;
}

/**
 * The answer, read in exactly the shape its prompt asked for.
 *
 * A `lines` answer whose count does not match THROWS. There is no partial application and no
 * re-ask: N titles that come back as N-1 cannot be matched to the N they were read off, and
 * writing the N-1 that arrived would silently drop one and renumber the rest.
 */
export function readSoftenedAnswer(
  plan: SoftenPlan,
  text: string,
  model: string,
  sourceLabel: string
): { value: string[] | string; warning: string | null } {
  const what = `softening ${plan.field} for ${sourceLabel}`;

  if (plan.shape === 'lines') {
    const lines = parseLines(text, what);
    if (lines.length !== plan.count) {
      throw new Error(
        `Softening "${plan.field}" for ${sourceLabel} on model "${model}" asked for ${plan.count} ` +
          `line(s) and got ${lines.length}. Nothing was applied — a list that does not line up ` +
          `cannot be matched back to the entries it was read from.`
      );
    }
    return { value: lines, warning: null };
  }

  if (plan.shape === 'prose') {
    const prose = text.trim();
    if (prose.length === 0) {
      throw new Error(
        `Softening "${plan.field}" for ${sourceLabel} on model "${model}" came back with no text ` +
          `at all.`
      );
    }
    return { value: prose, warning: null };
  }

  if (plan.shape === 'comma_line') {
    // The tags unit's own reader: newlines folded into commas, "#" stripped, an answer with no
    // usable tags in it throws carrying what arrived.
    const line = normalizeTagLine(text, `soften ${plan.field}`, model, sourceLabel);
    const before = plan.text.split(',').filter((t) => t.trim().length > 0).length;
    const after = line.split(',').length;
    return {
      value: line,
      warning:
        before === after
          ? null
          : `"${model}" returned ${after} tag(s) where ${before} went out; all ${after} are kept ` +
            `exactly as written.`,
    };
  }

  // space_line — one line of hashtags. One line is the contract; the count is a note.
  const lines = parseLines(text, what);
  if (lines.length !== 1) {
    throw new Error(
      `Softening "${plan.field}" for ${sourceLabel} on model "${model}" asked for one line and ` +
        `got ${lines.length}.`
    );
  }
  const line = lines[0];
  const before = plan.text.split(/\s+/).filter(Boolean).length;
  const after = line.split(/\s+/).filter(Boolean).length;
  return {
    value: line,
    warning:
      before === after
        ? null
        : `"${model}" returned ${after} hashtag(s) where ${before} went out; all ${after} are ` +
          `kept exactly as written.`,
  };
}

/**
 * The whole pass: every field this item carries, one call each, in order.
 *
 * SEQUENTIAL on purpose. The local transport serialises through queueAITask anyway (one slot,
 * for the Ollama OOM protection), and a cloud pass that fanned out would report its failures
 * out of the order the operator reads them in.
 *
 * FAILURE STOPS THE PASS. A shape that does not check out throws out of here, and the caller
 * writes nothing — a half-softened set whose description is milder and whose titles are not is
 * a set nobody asked for, and it would be indistinguishable on disk from a complete one.
 */
export async function runSoftenPass(
  source: any,
  option: MetadataRoutingOption,
  transport: SoftenTransport
): Promise<SoftenRunResult> {
  const sourceLabel = softenSourceLabel(source);

  // The softened set starts as a full copy of the original, so every structural key the item
  // carries — source paths, chapter timings, excluded chapters, provenance, the compilation
  // flag, anything a later build adds — survives by construction rather than by an allow-list
  // that would silently drop whatever it had not been told about.
  const metadata = structuredClone(source);

  const { plans, skipped } = planSoftening(source, metadata);
  const applied: SoftenFieldResult[] = [];
  const trace: PromptTraceEntry[] = [];

  for (const plan of plans) {
    const prompt = buildSoftenPrompt(plan);
    const at = new Date().toISOString();
    const text = await askToSoften(plan, option, transport, sourceLabel, prompt);
    const { value, warning } = readSoftenedAnswer(plan, text, option.model, sourceLabel);
    plan.apply(value, metadata);
    applied.push({ field: plan.field, warning });
    trace.push({
      what: `softening ${plan.field} for ${sourceLabel} (operator request)`,
      model: option.model,
      chars: prompt.length,
      at,
      prompt,
    });
    if (warning) log.warn(`[Soften] ${warning}`);
    log.info(`[Soften] ${plan.field} rewritten on "${option.model}" for ${sourceLabel}`);
  }

  return { model: option.model, applied, skipped, trace, metadata };
}
