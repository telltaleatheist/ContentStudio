/**
 * Scrub — the finished text, sent back once so the video's subject matter is its subject
 *
 * WHAT IT FIXES, MEASURED. Generated descriptions and chapter titles sometimes narrate the
 * person who made the video instead of what the video is about: "The speaker condemns the
 * persecution of the Satanic Temple of Iowa", "Owen Morgan takes apart Jack Hibbs's sermon",
 * "the host", "the narrator", "the channel". Over three weeks of job records (180 jobs, 159
 * items) that framing survived in 46 of 1,124 chapter titles (4%) and 13 of 159 descriptions
 * (8%). It is residual, not systemic: the generation prompts already carry attribution clauses
 * (chapters.yml, fields/description.yml), and this is what gets through them anyway.
 *
 * THE DECISION: TWO CALLS INSTEAD OF ONE. Rather than pile a fifth clause onto a prompt whose
 * four are already working for 92-96% of the text, the finished text goes back through the model
 * a second time with one narrow contract — no sentence framed around a creator, a host, a
 * speaker, a narrator, a channel or a "we"/"I"; every fact, name, number, claim, judgement,
 * length, order and shape carried through; text that already reads that way returned unchanged.
 * A second call can be given the whole of its job because its job is one thing.
 *
 * WHERE IT RUNS, AND WHY THAT IS NOT WHERE SOFTEN RUNS. This is PART OF PRODUCING THE ITEM, not
 * a sibling of it: one call site inside the generation loop, after the item's fields are
 * assembled and before it is written to the job record and the .txt. Soften (#180) is the
 * opposite — an operator action on a finished item that writes a NEW SET. So there is no new
 * job here, no new item id, no `source_key` join and nothing for the operator to choose between:
 * the item that lands on disk is the scrubbed one, and what it was before lands beside it.
 *
 * DECLARED, NOT SILENT (law 8). The pre-scrub text is kept on the item under `scrubbed`, every
 * call earns a `_prompt_trace` entry, and a field whose text came back identical is recorded as
 * unchanged rather than left out. The `.txt` is NOT given the before-text: it is the artifact of
 * the run, and the json is what the app reads.
 *
 * TITLES ARE DELIBERATELY NOT SCRUBBED. The same measurement put narrator framing in 7 of 1,578
 * titles (under 1%), and the title judge already warns on it (`narratesAnActor`,
 * chapter-title-quality.ts). Sending 1,578 titles through a model to fix seven of them buys a
 * risk — an edited fact — for almost nothing. Tags and hashtags are out for the same reason plus
 * a stronger one: they are terms, not sentences, and have no narrator to frame.
 *
 * NO SETTING TURNS IT OFF (operator, 2026-09-04: always on). It is one function with one call
 * site so that deleting it is one line, which is the honest version of a toggle nobody wants.
 *
 * FAILURE IS THE ITEM'S FAILURE (laws 1 and 3). A chapter list that comes back with the wrong
 * number of lines throws naming the field, the model and both counts, and the item fails the way
 * any other field call failing fails it. Nothing continues unscrubbed, nothing re-asks, nothing
 * is partially applied — an item whose description was scrubbed and whose chapters were not is
 * indistinguishable on disk from one where both were.
 *
 * CHAPTER TIMESTAMPS NEVER GO TO A MODEL and are never parsed back from one (standing law). The
 * titles go out alone, one per line, and are reattached by position onto the item's own chapter
 * objects; every other key on a chapter is left exactly as the run wrote it.
 *
 * NEITHER DOES THE LINK BLOCK, for the same reason. Every one of the 159 descriptions on disk
 * ends with the prompt set's `description_links` — a fixed block of fifteen URLs the set
 * authored, appended in code by `addDescriptionLinks` moments before this runs. It is held back
 * here and reattached verbatim, so what the model reads is the prose a model wrote. Sending
 * URLs through a rewrite call that has no reason to touch them is how one comes back mangled.
 * The alternates carry no link block (measured: 0 of 96) and are sent whole.
 */

import log from 'electron-log';

import { Chapter } from './chapter-generator.service';
import { MetadataRoutingOption } from './metadata-routing';
import {
  askToRewrite,
  buildRewritePrompt,
  readRewrittenAnswer,
  rewriteSourceLabel,
  stringsOf,
  textOf,
  type RewritePassIdentity,
  type RewritePlan,
  type RewriteTransport,
} from './rewrite-pass';
import type { PromptTraceEntry } from './more-titles';

/** The prompt asset this pass reads. Operator-editable on the Instructions page. */
export const SCRUB_PROMPT_FILE = 'scrub.yml';

/**
 * The routing task whose model this pass borrows: DESCRIPTION.
 *
 * No new routing task, because there is no new choice to make. The scrub rewrites description
 * prose and chapter titles that were just written by the description and chapter models; the
 * description task is the one that offers every rung this build ships, and a task of its own
 * would put a second dropdown in the routing modal whose only sensible answer is the one already
 * given next to it. `SOFTEN_ROUTING_TASK` reads description for the same reason.
 */
export const SCRUB_ROUTING_TASK = 'description' as const;

/** What this pass calls itself, everywhere the shared machinery has to say which one is running. */
const SCRUB_PASS: RewritePassIdentity = {
  promptFile: SCRUB_PROMPT_FILE,
  // No DATA block. Soften carries one because "raped -> taken advantage of" can only be shown by
  // naming both forms; a scrub has no vocabulary — the wrong form is a sentence's subject, and
  // the register block states the wanted one in positive form (law 4).
  dataBlockKeys: [],
  id: 'scrub',
  name: 'Scrub',
  callWhat: (field) => `scrub: ${field} (post-generation)`,
  readWhat: (field, sourceLabel) => `scrubbing ${field} for ${sourceLabel}`,
  nameInError: (field, sourceLabel) => `Scrubbing "${field}" for ${sourceLabel}`,
};

/** A field the item did not carry. Not an error; still reported. */
export interface ScrubSkip {
  field: string;
  reason: string;
}

/**
 * What the pass wrote onto the item, under `scrubbed`.
 *
 * `before` is present only on the fields whose text actually changed — a field recorded with
 * `changed: false` says the model read it and returned it as it stood, which is a different fact
 * from a field nobody looked at, and both are different from a field the item does not have.
 */
export interface ScrubRecord {
  /** The provider-prefixed model every call in this pass went out on. */
  model: string;
  /** When the pass ran. */
  at: string;
  /** Keyed by the ITEM's own key: `description`, `description_hook`, … */
  fields: {
    [itemKey: string]: { changed: boolean; before?: string | string[] };
  };
  /** Fields this item does not carry. */
  skipped: ScrubSkip[];
}

/** What one pass produced, for the caller's log. The item itself carries the record. */
export interface ScrubRunResult {
  model: string;
  /** Item keys whose text the model changed. */
  changed: string[];
  /** Item keys the model returned unchanged. */
  unchanged: string[];
  skipped: ScrubSkip[];
}

export interface ScrubOptions {
  /** The model, resolved from the description routing by the caller. */
  option: MetadataRoutingOption;
  transport: RewriteTransport;
}

/**
 * The calls this item earns, and the fields it has nothing to scrub in.
 *
 * `plans` write straight onto the item — this pass edits the item it was handed rather than
 * building a copy, because the item is not finished until this has run.
 *
 * `description_options` gets ONE CALL PER ALTERNATE rather than one call for the array, for the
 * reason soften does: each alternate is a multi-line block of prose, so a single call would need
 * a separator line the model had to reproduce exactly — a shape with a failure mode, invented
 * here, for no gain. One prose call each has no count to get wrong.
 */
export function planScrub(
  item: any,
  /** The prompt set's `description_links`, trimmed. '' when the set declares none. */
  descriptionLinks: string
): { plans: RewritePlan[]; skipped: ScrubSkip[] } {
  const itemId = typeof item?.item_id === 'string' ? item.item_id : '(no item_id)';
  const plans: RewritePlan[] = [];
  const skipped: ScrubSkip[] = [];

  const hook = textOf(item?.description_hook);
  if (hook === null) {
    skipped.push({ field: 'description hook', reason: 'the item carries no description hook.' });
  } else {
    plans.push({
      field: 'description hook',
      labelKey: 'description_hook',
      shape: 'one_line',
      text: hook,
      count: null,
      apply: (scrubbed, target) => {
        target.description_hook = scrubbed as string;
      },
    });
  }

  const description = textOf(item?.description);
  if (description === null) {
    skipped.push({ field: 'description', reason: 'the item carries no description.' });
  } else {
    // The link block, split off by the exact string the composer appended — `'\n\n' + links`,
    // see addDescriptionLinks. A set that declares links whose block is NOT on the end of the
    // description it just wrote is an unexpected state and says so, rather than quietly sending
    // fifteen URLs to a model.
    const suffix = descriptionLinks === '' ? '' : `\n\n${descriptionLinks}`;
    if (suffix !== '' && !description.endsWith(suffix)) {
      throw new Error(
        `The description on item ${itemId} does not end with the prompt set's description_links ` +
          `block, which addDescriptionLinks appended to it moments before this pass. The scrub ` +
          `holds that block back by matching it exactly, and it cannot say which part of this ` +
          `description is the block.`
      );
    }
    const prose = suffix === '' ? description : description.slice(0, description.length - suffix.length).trimEnd();
    plans.push({
      field: 'description',
      labelKey: 'description',
      shape: 'prose',
      text: prose,
      count: null,
      apply: (scrubbed, target) => {
        target.description = `${scrubbed as string}${suffix}`;
      },
    });
  }

  const options = stringsOf(item?.description_options, 'description_options', itemId, 'scrubbed');
  if (options === null) {
    skipped.push({
      field: 'alternate descriptions',
      reason: 'the item carries no alternate descriptions.',
    });
  } else {
    options.forEach((text, index) => {
      plans.push({
        field: `alternate description ${index + 1} of ${options.length}`,
        labelKey: 'description_options',
        shape: 'prose',
        text,
        count: null,
        apply: (scrubbed, target) => {
          if (!Array.isArray(target.description_options)) target.description_options = [];
          target.description_options[index] = scrubbed as string;
        },
      });
    });
  }

  // CHAPTER TITLES ONLY — see the header. The timestamps do not go out and do not come back.
  const chapters: Chapter[] = Array.isArray(item?.chapters) ? item.chapters : [];
  const chapterTitles = chapters.map((chapter, index) => {
    const title = textOf(chapter?.title);
    if (title === null) {
      throw new Error(
        `Chapter ${index + 1} of ${chapters.length} on item ${itemId} has no title text, so the ` +
          `chapter list cannot be scrubbed as ${chapters.length} lines.`
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
      apply: (scrubbed, target) => {
        const titles = scrubbed as string[];
        target.chapters = (target.chapters as Chapter[]).map((chapter, index) => ({
          ...chapter,
          title: titles[index],
        }));
      },
    });
  }

  return { plans, skipped };
}

/** One field's prompt, assembled by the shared builder out of scrub.yml. */
export function buildScrubPrompt(plan: RewritePlan): string {
  return buildRewritePrompt(SCRUB_PASS, plan);
}

/**
 * Which ITEM key a plan writes into, for the `scrubbed` record.
 *
 * The plan's `field` is what the operator reads; this is what the item calls it, and the two
 * differ for the alternates (four plans, one key). Derived from `labelKey` rather than parsed
 * back out of `field`, because `labelKey` is already the item's own vocabulary.
 */
function itemKeyOf(plan: RewritePlan): string {
  return plan.labelKey === 'chapters' ? 'chapters' : plan.labelKey;
}

/** The pre-scrub value of one item key, for the record. */
function beforeValueOf(item: any, itemKey: string): string | string[] {
  if (itemKey === 'chapters') {
    return (item.chapters as Chapter[]).map((chapter) => chapter.title);
  }
  if (itemKey === 'description_options') {
    return (item.description_options as string[]).slice();
  }
  return item[itemKey] as string;
}

/** Two recorded values, compared the only way that matters: same text or not. */
function sameValue(a: string | string[], b: string | string[]): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => entry === b[index]);
  }
  return a === b;
}

/**
 * THE WHOLE PASS, and the one call site's one function.
 *
 * The item is edited in place; `scrubbed` and the trace entries are written onto it here, so the
 * generation loop's line is `await scrubGeneratedItem(metadata, …)` and removing the pass is
 * removing that line.
 *
 * SEQUENTIAL on purpose. The local transport serialises through queueAITask anyway (one slot,
 * for the Ollama OOM protection), and a cloud pass that fanned out would report its failures out
 * of the order the log reads them in.
 *
 * `_prompt_trace` MUST ALREADY BE ON THE ITEM when this runs: the generation loop slices it off
 * the AI manager's running trace, and these entries are appended to that slice. Appending them
 * before the slice would double-count every cloud call, which records its own entry on the
 * manager as it goes out.
 */
export async function scrubGeneratedItem(
  item: any,
  { option, transport }: ScrubOptions
): Promise<ScrubRunResult> {
  const sourceLabel = rewriteSourceLabel(item);
  const at = new Date().toISOString();
  const { plans, skipped } = planScrub(item, transport.aiManager.descriptionLinks());

  if (!Array.isArray(item._prompt_trace)) {
    throw new Error(
      `The scrub pass appends its calls to the item's _prompt_trace, and ${sourceLabel} has ` +
        `${item._prompt_trace === undefined ? 'none' : typeof item._prompt_trace} instead of an ` +
        `array. The generation loop writes it from the AI manager's trace before this runs.`
    );
  }

  // Read before anything is sent: the record is what the run produced, and a plan's `apply` has
  // already overwritten it by the time the answer is in hand.
  const before = new Map<string, string | string[]>();
  for (const plan of plans) {
    const key = itemKeyOf(plan);
    if (!before.has(key)) before.set(key, beforeValueOf(item, key));
  }

  for (const plan of plans) {
    const prompt = buildScrubPrompt(plan);
    const sentAt = new Date().toISOString();
    const text = await askToRewrite(SCRUB_PASS, plan, option, transport, sourceLabel, prompt);
    const { value } = readRewrittenAnswer(SCRUB_PASS, plan, text, option.model, sourceLabel);
    plan.apply(value, item);
    (item._prompt_trace as PromptTraceEntry[]).push({
      what: SCRUB_PASS.callWhat(plan.field, sourceLabel),
      model: option.model,
      chars: prompt.length,
      at: sentAt,
      prompt,
    });
  }

  const record: ScrubRecord = { model: option.model, at, fields: {}, skipped };
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [key, was] of before) {
    if (sameValue(was, beforeValueOf(item, key))) {
      record.fields[key] = { changed: false };
      unchanged.push(key);
    } else {
      record.fields[key] = { changed: true, before: was };
      changed.push(key);
    }
  }
  item.scrubbed = record;

  log.info(
    `[Scrub] ${sourceLabel} on "${option.model}": ` +
      `${changed.length ? `rewrote ${changed.join(', ')}` : 'nothing rewritten'}; ` +
      `${unchanged.length ? `${unchanged.join(', ')} came back unchanged` : 'nothing unchanged'}` +
      (skipped.length ? `; not carried by this item: ${skipped.map((s) => s.field).join(', ')}` : '')
  );

  return { model: option.model, changed, unchanged, skipped };
}
