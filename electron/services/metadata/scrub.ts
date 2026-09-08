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
 * site IN GENERATION so that deleting it is one line, which is the honest version of a toggle
 * nobody wants.
 *
 * THE SECOND CALLER IS A BUTTON, and it is deliberately not a second pass (ledger #184). Every
 * report generated before 2026-09-04 was written without this, and the operator asked to be able
 * to run it over one of them: "in case i want it to do it on existing reports that already
 * processed without this second pass". That button runs THIS function over the item on disk and
 * writes the corrected fields back ONTO IT — in place, not as a sibling set, because a scrub is a
 * correction of the same text rather than a different register to choose between (which is what
 * soften is, and why soften writes a new set instead). The only thing the origin changes is what
 * the trace entry says: `(post-generation)` for the run's own, `(operator request)` for the
 * button's. Nothing else about the pass differs, because nothing else about it should.
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
 * NEITHER DOES THE LINK BLOCK, for the same reason. Every description on disk ends with the
 * prompt set's `description_links` — a fixed block of fifteen URLs the set authored, appended in
 * code by `addDescriptionLinks` moments before the run finishes. It is held back here and
 * reattached verbatim, so what the model reads is the prose a model wrote. Sending URLs through
 * a rewrite call that has no reason to touch them is how one comes back mangled. The alternates
 * carry no link block (measured: 0 of 96) and are sent whole.
 *
 * WHICH BLOCK, THOUGH, depends on which caller is running, and holdBackLinks below is where that
 * is decided and why. The short version: at generation time the block was appended moments ago
 * and is matched EXACTLY; on the operator's button the report can be weeks old and the channel
 * file has been edited since (measured on this install: 49 of 168 descriptions end with the
 * block their channel holds today, 119 with an older one), so the block is located in the
 * description ITSELF by the same splitter the publish panel uses. Which of the two ran is
 * recorded on the item, in `scrubbed.links_held_back`.
 */

import log from 'electron-log';

import { Chapter } from './chapter-generator.service';
import { linkBlockIndex } from './description-composer';
import { MetadataRoutingOption, resolveOperatorOption } from './metadata-routing';
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

/**
 * Who asked for this run, which is the ONLY thing that differs between the two callers.
 *
 * It reaches the operator in one place — the `what` on every `_prompt_trace` entry — and that
 * is the point of carrying it: a trace holding eleven scrub calls has to say which of them the
 * run made and which of them a later click made, or the record cannot answer when the text on
 * disk was last corrected.
 */
export type ScrubOrigin = 'post-generation' | 'operator request';

/**
 * What this pass calls itself, everywhere the shared machinery has to say which one is running.
 *
 * Built per run rather than declared once, because `callWhat` names the origin. Everything else
 * is the same object it always was.
 */
function scrubPass(origin: ScrubOrigin): RewritePassIdentity {
  return {
    promptFile: SCRUB_PROMPT_FILE,
    // No DATA block. Soften carries one because "raped -> taken advantage of" can only be shown
    // by naming both forms; a scrub has no vocabulary — the wrong form is a sentence's subject,
    // and the register block states the wanted one in positive form (law 4).
    dataBlockKeys: [],
    id: 'scrub',
    name: 'Scrub',
    callWhat: (field) => `scrub: ${field} (${origin})`,
    readWhat: (field, sourceLabel) => `scrubbing ${field} for ${sourceLabel}`,
    nameInError: (field, sourceLabel) => `Scrubbing "${field}" for ${sourceLabel}`,
  };
}

/**
 * One option id the operator picked from the button's dropdown, checked against what the
 * description task offers before anything is read. Soften's `resolveSoftenOption` with a
 * different task constant — the shared validator is metadata-routing.ts's.
 */
export function resolveScrubOption(optionId: unknown): MetadataRoutingOption {
  return resolveOperatorOption(SCRUB_ROUTING_TASK, optionId);
}

/**
 * The link block held back from ONE description, and how it was found.
 *
 * TWO RULES, IN ORDER, AND THE ORDER IS THE POINT.
 *
 * THE EXACT ONE FIRST. `addDescriptionLinks` appends `'\n\n' + links` to the description the
 * moment it is composed, so at generation time the block on the end IS the prompt set's, byte
 * for byte, and matching it exactly is the strongest statement available. That is the rule
 * ledger #183 shipped and the only rule the generation call site accepts.
 *
 * THE ITEM'S OWN SECOND, and only for the operator's button. The block is the CHANNEL FILE's
 * text, and that file is edited: measured over the 168 items on this install, 49 descriptions
 * end with the block their channel holds today and 119 end with an older one. Refusing those
 * would refuse the button on exactly the reports it exists for — everything generated on or
 * before 2026-08-25 — so on that path the block is located in the description ITSELF, by
 * `linkBlockIndex`: the same splitter that decides where the link block starts on every item
 * the publish panel opens and in every description this app composes for YouTube. It is not a
 * second answer to the question; it is the app's existing one. If it were wrong about an item,
 * the description the operator publishes would already be wrong in the same place.
 *
 * NEITHER RULE EVER TRIMS. The suffix is sliced out of the description whole, blank line
 * included, and put back on the rewritten prose unchanged — the whole reason the pass holds it
 * back is that no byte of it should move.
 *
 * A description with NO link block goes whole, which is what `splitLinkBlock` answers for it
 * everywhere else in the app.
 */
interface HeldBackLinks {
  /** The prose the model is given. */
  prose: string;
  /** Exactly what is re-appended, blank line and all. '' when there is no block. */
  suffix: string;
  /** Which rule found it, for the record and the log. Always a whole sentence. */
  how: string;
}

function holdBackLinks(
  description: string,
  descriptionLinks: string,
  origin: ScrubOrigin,
  itemId: string
): HeldBackLinks {
  const exact = descriptionLinks === '' ? '' : `\n\n${descriptionLinks}`;
  if (exact !== '' && description.endsWith(exact)) {
    return {
      prose: description.slice(0, description.length - exact.length).trimEnd(),
      suffix: exact,
      how: `the prompt set's own description_links block (${descriptionLinks.length} chars), matched exactly on the end of the description.`,
    };
  }

  if (origin === 'post-generation') {
    throw new Error(
      `The description on item ${itemId} does not end with the prompt set's description_links ` +
        `block — the block addDescriptionLinks appended to it moments before this pass. The ` +
        `scrub holds that block back by matching it exactly, and it cannot say which part of ` +
        `this description is the block.`
    );
  }

  const at = linkBlockIndex(description);
  if (at === -1) {
    return {
      prose: description,
      suffix: '',
      how: 'no link block: the description carries none of the markers that start one, so the whole of it was sent.',
    };
  }
  const prose = description.slice(0, at).trimEnd();
  return {
    prose,
    // From the end of the prose to the end of the description — the separator and the block
    // together, exactly as they stand. Nothing here is trimmed or rebuilt.
    suffix: description.slice(prose.length),
    how:
      `the item's OWN link block (${description.length - at} chars from the first marker), located ` +
      `by the same splitter the publish panel uses — this report's block is not the one its ` +
      `channel file holds today.`,
  };
}

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
  /**
   * Which link block was held back out of the description, and how it was found (law 8).
   *
   * Recorded rather than only logged, because it is a decision this pass made about the
   * operator's text: it says which bytes of the description never went to a model. Absent when
   * the item carries no description.
   */
  links_held_back?: string;
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
  /**
   * Who asked. Required, and deliberately without a value of its own: the two callers are the
   * generation loop and the reports page's button, and a pass that could not say which one it
   * was would write a trace nobody can read back.
   */
  origin: ScrubOrigin;
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
  descriptionLinks: string,
  /** Which link-block rule applies — see holdBackLinks. */
  origin: ScrubOrigin = 'post-generation'
): { plans: RewritePlan[]; skipped: ScrubSkip[]; linksHeldBack: string | null } {
  const itemId = typeof item?.item_id === 'string' ? item.item_id : '(no item_id)';
  const plans: RewritePlan[] = [];
  const skipped: ScrubSkip[] = [];
  let linksHeldBack: string | null = null;

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
    // The link block, held back whole — see holdBackLinks for the two rules and why the
    // operator's button gets the second one.
    const held = holdBackLinks(description, descriptionLinks, origin, itemId);
    const { prose, suffix } = held;
    linksHeldBack = held.how;
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
  //
  // ALWAYS PLANNED when the item has chapters, on either caller. That is not an implementation
  // detail this function happens to have: chapter titles are where the measurement put most of
  // the narrator framing (46 of 1,124 against 13 of 159 descriptions), and the operator said it
  // in as many words when he asked for the button — "have the second pass always try to correct
  // chapters as well". There is no switch here and nothing conditional on the origin.
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

  return { plans, skipped, linksHeldBack };
}

/**
 * One field's prompt, assembled by the shared builder out of scrub.yml.
 *
 * The origin does not appear in the prompt — it names the CALLER, not the job, and a model told
 * who pressed which button would be told something that cannot change its answer. It is passed
 * only because the identity object carries both, and the identity is what the builder reads.
 */
export function buildScrubPrompt(plan: RewritePlan, origin: ScrubOrigin = 'post-generation'): string {
  return buildRewritePrompt(scrubPass(origin), plan);
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
  { option, transport, origin }: ScrubOptions
): Promise<ScrubRunResult> {
  const pass = scrubPass(origin);
  const sourceLabel = rewriteSourceLabel(item);
  const at = new Date().toISOString();
  const { plans, skipped, linksHeldBack } = planScrub(
    item,
    transport.aiManager.descriptionLinks(),
    origin
  );

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
    const prompt = buildScrubPrompt(plan, origin);
    const sentAt = new Date().toISOString();
    const text = await askToRewrite(pass, plan, option, transport, sourceLabel, prompt);
    const { value } = readRewrittenAnswer(pass, plan, text, option.model, sourceLabel);
    plan.apply(value, item);
    (item._prompt_trace as PromptTraceEntry[]).push({
      what: pass.callWhat(plan.field, sourceLabel),
      model: option.model,
      chars: prompt.length,
      at: sentAt,
      prompt,
    });
  }

  const record: ScrubRecord = { model: option.model, at, fields: {}, skipped };
  if (linksHeldBack !== null) record.links_held_back = linksHeldBack;
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
    `[Scrub] (${origin}) ${sourceLabel} on "${option.model}": ` +
      `${changed.length ? `rewrote ${changed.join(', ')}` : 'nothing rewritten'}; ` +
      `${unchanged.length ? `${unchanged.join(', ')} came back unchanged` : 'nothing unchanged'}` +
      (skipped.length ? `; not carried by this item: ${skipped.map((s) => s.field).join(', ')}` : '')
  );
  if (linksHeldBack !== null) log.info(`[Scrub] ${sourceLabel} held back ${linksHeldBack}`);

  return { model: option.model, changed, unchanged, skipped };
}
