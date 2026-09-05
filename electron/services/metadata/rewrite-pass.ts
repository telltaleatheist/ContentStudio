/**
 * A rewrite pass — finished metadata text sent back through a model with a narrow contract
 *
 * WHAT A REWRITE PASS IS. Text that already exists goes out, the same text comes back with one
 * named property changed and everything else — every fact, every name, every number, every
 * claim, the length, the order and the SHAPE — carried through. No transcript, no JSON, no
 * sampling parameters, no re-asks. Two passes are built on this shape:
 *
 *   soften.ts — the operator's monetization rewrite, run from the reports page on a finished
 *               item, writing a NEW SET (ledger #180).
 *   scrub.ts  — the narrator-framing rewrite, run INSIDE generation on the item being made
 *               (ledger #183).
 *
 * They differ in what they ask for and where they land. They do not differ in the machinery,
 * so the machinery lives here rather than in two copies that drift: the prompt is assembled the
 * same way out of a YAML asset with the same block names, the shapes are read back the same way,
 * and both transports — cloud through `runPlainRequest`, local through `askOllamaPlain` — are
 * reached the same way.
 *
 * THE LOCAL TRANSPORT DELIBERATELY DOES NOT GO THROUGH AIManagerService's Ollama route. That one
 * middle-truncates a prompt bigger than its fixed window, and a rewrite call whose data block
 * lost its middle would come back a different length than it went out.
 *
 * SHAPES FAIL LOUDLY. A line list that comes back with a different number of lines THROWS,
 * naming the field, the model, the count asked for and the count that arrived; nothing is
 * partially applied and nothing re-asks. N entries that come back as N-1 cannot be matched to
 * the N they were read off, and writing the N-1 that arrived would silently drop one and
 * renumber the rest.
 *
 * WHAT IS NOT SHARED, on purpose: which fields a pass reads, what it does with the answer, and
 * where the result is written. Those are the passes themselves.
 */

import axios from 'axios';

import { AIManagerService } from './ai-manager.service';
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
import { MetadataRoutingOption } from './metadata-routing';
import { promptAssets } from './prompt-assets';
import { queueAITask } from '../queue-manager.service';

/**
 * The output shapes a rewrite call can be asked for. One prompt block each, under `shapes:` in
 * the pass's YAML asset — a pass declares only the ones it uses.
 *
 *   lines       — N entries in, N lines out, same order. A mismatch throws.
 *   prose       — one block of text in, one block out. The whole answer is the text.
 *   one_line    — one line in, one line out. An answer that is not one line throws.
 *   comma_line  — one comma-separated line in, one out.
 *   space_line  — one space-separated hashtag line in, one out.
 */
export type RewriteShape = 'lines' | 'prose' | 'one_line' | 'comma_line' | 'space_line';

/** One field's call, planned before anything is sent. */
export interface RewritePlan {
  /** Reported to the operator and written into the trace, e.g. `titles`, `chapter titles`. */
  field: string;
  /** Which `labels:` entry in the pass's YAML names this text to the model. */
  labelKey: string;
  shape: RewriteShape;
  /** Exactly what goes in the data block. */
  text: string;
  /** Entries in, for the `lines` shape. null for every other shape. */
  count: number | null;
  /**
   * Where the answer goes back on the item being written. Given the rewritten value and that
   * item, it writes it — so the reattachment rules (chapter timestamps by position, one
   * alternate description by index) live beside the plan that produced them.
   */
  apply: (rewritten: string[] | string, item: any) => void;
}

/** A field that had nothing to rewrite. Reported, never silent. */
export interface RewriteSkip {
  field: string;
  reason: string;
}

/**
 * Everything one pass calls itself, in one place.
 *
 * These strings reach the operator: the queue's task list, the log, the trace entry's `what`,
 * and the message of every failure. Two passes running the same machinery must still say which
 * one of them is running, so the machinery asks rather than guesses.
 */
export interface RewritePassIdentity {
  /** The prompt asset under `shared/pipeline/`, operator-editable on the Instructions page. */
  promptFile: string;
  /**
   * Block keys placed between the shape block and the label, in this order — the DATA a pass
   * carries beneath its instructions (soften's vocabulary). Empty for a pass with none.
   */
  dataBlockKeys: string[];
  /** Short id, for the queue key: `soften`, `scrub`. */
  id: string;
  /** Display name, for the queue label and the log prefix: `Soften`, `Scrub`. */
  name: string;
  /** The `what` the transport logs and the trace records for one field's call. */
  callWhat(field: string, sourceLabel: string): string;
  /** The `what` the answer reader hands its parser. */
  readWhat(field: string, sourceLabel: string): string;
  /** How a failure names this call: `Softening "titles" for <label>`. */
  nameInError(field: string, sourceLabel: string): string;
}

export interface RewriteTransport {
  /** Built by the caller, which is where the API keys and the Ollama host live. */
  aiManager: AIManagerService;
  ollamaHost: string;
}

/** A non-empty string, or null. Tells "the item has no such field" from "it has one". */
export function textOf(value: unknown): string | null {
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
export function stringsOf(
  value: unknown,
  field: string,
  itemId: string,
  /** How the pass names what it does, for the message: `softened`, `scrubbed`. */
  donePast: string
): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.map((entry, index) => {
    const text = textOf(entry);
    if (text === null) {
      throw new Error(
        `Entry ${index + 1} of "${field}" on item ${itemId} is ${
          typeof entry
        }, not text, so this field cannot be ${donePast} as a list of ${value.length} entries.`
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
export function rewriteSourceLabel(item: any): string {
  const title = textOf(item?._title);
  if (title) return title;
  const sourcePath = textOf(item?.source_path);
  if (sourcePath) return sourcePath.split(/[\\/]/).pop() || sourcePath;
  const itemId = textOf(item?.item_id);
  if (itemId) return itemId;
  throw new Error(
    'A rewrite pass needs the item to name itself for its log and trace entries, and this ' +
      'one carries no _title, no source_path and no item_id.'
  );
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/**
 * One field's prompt: the register instruction, the shape it must come back in, whatever DATA
 * blocks the pass carries, and the text.
 *
 * Every string here comes out of the pass's YAML, so the operator changes what this asks for on
 * the Instructions page and no code file is a second copy of it. A missing key throws out of
 * `promptAssets().pipeline` naming the file and the key — the loader's standing contract.
 */
export function buildRewritePrompt(pass: RewritePassIdentity, plan: RewritePlan): string {
  const assets = promptAssets();
  const register = assets.pipeline(pass.promptFile, 'register');
  const shapeKey = `shapes.${plan.shape}`;
  let shape = assets.pipeline(pass.promptFile, shapeKey);
  if (shape.includes('{count}')) {
    if (plan.count === null) {
      throw new Error(
        `Prompt asset "shared/pipeline/${pass.promptFile}" key "${shapeKey}" carries a {count} ` +
          `slot, and the "${plan.field}" call has no entry count to fill it with — only the ` +
          `"lines" shape counts entries.`
      );
    }
    shape = shape.replace(/\{count\}/g, () => String(plan.count));
  }
  const dataBlocks = pass.dataBlockKeys.map((key) => assets.pipeline(pass.promptFile, key));
  const label = assets.pipeline(pass.promptFile, `labels.${plan.labelKey}`);

  // Blank line between the blocks; the label sits directly above the text it names.
  const blocks = [register, shape, ...dataBlocks, label].join('\n\n');
  return `${blocks}\n${plan.text}\n`;
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * Send one field's prompt on the chosen model and read the answer.
 *
 * TWO TRANSPORTS, the same two every generation call has, reached the same way:
 *   cloud — AIManagerService.runPlainRequest
 *   local — askOllamaPlain over /api/generate
 * See the header for why the local path does not go through AIManagerService's Ollama route.
 */
export async function askToRewrite(
  pass: RewritePassIdentity,
  plan: RewritePlan,
  option: MetadataRoutingOption,
  transport: RewriteTransport,
  sourceLabel: string,
  prompt: string
): Promise<string> {
  const what = pass.callWhat(plan.field, sourceLabel);

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
    `${pass.id}-${plan.field}-${option.model}-${sourceLabel}`,
    `${pass.name}: ${plan.field} on ${option.model}`,
    async () =>
      askOllamaPlain(client, {
        model: option.model,
        prompt,
        numCtx,
        numPredict: LOCAL_FIELD_NUM_PREDICT,
        keepAlive: LOCAL_FIELD_KEEP_ALIVE,
        timeoutMs: LOCAL_FIELD_TIMEOUT_MS,
        what,
        logPrefix: `[${pass.name}] ${option.model}`,
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
 * re-ask — see the header.
 */
export function readRewrittenAnswer(
  pass: RewritePassIdentity,
  plan: RewritePlan,
  text: string,
  model: string,
  sourceLabel: string
): { value: string[] | string; warning: string | null } {
  const what = pass.readWhat(plan.field, sourceLabel);
  const named = pass.nameInError(plan.field, sourceLabel);

  if (plan.shape === 'lines') {
    const lines = parseLines(text, what);
    if (lines.length !== plan.count) {
      throw new Error(
        `${named} on model "${model}" asked for ${plan.count} ` +
          `line(s) and got ${lines.length}. Nothing was applied — a list that does not line up ` +
          `cannot be matched back to the entries it was read from.`
      );
    }
    return { value: lines, warning: null };
  }

  if (plan.shape === 'prose') {
    const prose = text.trim();
    if (prose.length === 0) {
      throw new Error(`${named} on model "${model}" came back with no text at all.`);
    }
    return { value: prose, warning: null };
  }

  if (plan.shape === 'one_line') {
    const lines = parseLines(text, what);
    if (lines.length !== 1) {
      throw new Error(
        `${named} on model "${model}" asked for one line and got ${lines.length}.`
      );
    }
    return { value: lines[0], warning: null };
  }

  if (plan.shape === 'comma_line') {
    // The tags unit's own reader: newlines folded into commas, "#" stripped, an answer with no
    // usable tags in it throws carrying what arrived.
    const line = normalizeTagLine(text, `${pass.id} ${plan.field}`, model, sourceLabel);
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
    throw new Error(`${named} on model "${model}" asked for one line and got ${lines.length}.`);
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
