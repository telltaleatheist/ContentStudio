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
 * A FAILED FIELD NEVER COSTS THE ITEM (Owen, 2026-09-26, LEDGER #223; supersedes #183's "failure
 * is the item's failure"). The incident: a 60-minute run finished every field, the scrub sent 26
 * chapter titles to Opus, 27 lines came back, and the throw failed the whole item — twenty
 * minutes of finished output discarded over a cleanup pass. So each plan (the hook, the
 * description, each alternate, the chapter titles) is applied or not ON ITS OWN. A plan whose
 * call or read fails leaves that field exactly as generated; the plans that succeeded are
 * applied; nothing of the failed plan is applied (a miscounted list is still never matched back
 * partially); nothing re-asks. The item is delivered as usual carrying `scrubbed.failed` — one
 * plain sentence per field the cleanup did not correct ("Chapter titles were not cleaned up: the
 * model returned 27 lines for 26 titles.") plus the full error for the log — and every failure
 * is a warn line (law 8). The reports page shows it beside the section, with a button that runs
 * the cleanup again on just that part. Cancellation is not a failed field: it still stops the
 * run.
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

import { JobCancelledError, isAbortError } from './cancellation';
import { settleTogether } from '../../crucible/fan-out';
import { Chapter } from './chapter-generator.service';
import { linkBlockIndex } from './description-composer';
import { MetadataRoutingOption, resolveOperatorOption, RoutingModels } from './metadata-routing';
import {
  askToRewrite,
  buildRewritePrompt,
  readRewrittenAnswer,
  RewriteShapeError,
  REWRITE_NUM_PREDICT,
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
export function resolveScrubOption(optionId: unknown, models: RoutingModels): MetadataRoutingOption {
  return resolveOperatorOption(SCRUB_ROUTING_TASK, optionId, models);
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
export interface HeldBackLinks {
  /** The prose the model is given. */
  prose: string;
  /** Exactly what is re-appended, blank line and all. '' when there is no block. */
  suffix: string;
  /** Which rule found it, for the record and the log. Always a whole sentence. */
  how: string;
}

export function holdBackLinks(
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
 * One field the cleanup did NOT correct, and why (LEDGER #223).
 *
 * The field stays exactly as generated. `reason` is the sentence the operator reads on the
 * reports page, in plain words; `detail` is the whole error, for the log and for anyone who
 * opens the record.
 */
export interface ScrubFailure {
  /** The plan's field, as the operator reads it: `chapter titles`, `alternate description 1 of 2`. */
  field: string;
  /** The ITEM key this field lives under — what the reports page and a re-run select on. */
  item_key: string;
  /** e.g. "Chapter titles were not cleaned up: the model returned 27 lines for 26 titles." */
  reason: string;
  /** The error exactly as it was raised, numbered Sent/Returned lists included. */
  detail: string;
}

/** The item keys the scrub can correct — the only values a partial re-run may name. */
export const SCRUB_ITEM_KEYS = ['description_hook', 'description', 'description_options', 'chapters'] as const;
export type ScrubItemKey = (typeof SCRUB_ITEM_KEYS)[number];

/** The operator's words for one plan's field, capitalised, and whether it takes "were". */
function fieldNoun(field: string): { noun: string; plural: boolean } {
  if (field === 'chapter titles') return { noun: 'Chapter titles', plural: true };
  if (field === 'alternate descriptions') return { noun: 'The alternate descriptions', plural: true };
  if (field === 'description hook') return { noun: "The description's opening line", plural: false };
  if (field === 'description') return { noun: 'The description', plural: false };
  if (field.startsWith('alternate description')) return { noun: `The ${field}`, plural: false };
  return { noun: field.charAt(0).toUpperCase() + field.slice(1), plural: false };
}

/** What one entry of a lines plan is, in the operator's words: `titles`, `lines`. */
function entryNoun(field: string): string {
  return field === 'chapter titles' ? 'titles' : 'lines';
}

/**
 * The plain sentence for one field the cleanup did not correct.
 *
 * A shape error is read off its typed fields (Law 10), so the sentence says the counts in the
 * operator's words; anything else says what went wrong in the error's own first line, which is
 * already a sentence naming the call.
 */
export function scrubFailureSentence(field: string, error: unknown): string {
  const { noun, plural } = fieldNoun(field);
  const head = `${noun} ${plural ? 'were' : 'was'} not cleaned up: `;
  if (error instanceof RewriteShapeError) {
    if (error.shape === 'lines') {
      return `${head}the model returned ${error.got} line${error.got === 1 ? '' : 's'} for ${error.asked} ${entryNoun(field)}.`;
    }
    return `${head}the model returned ${error.got} lines where one was asked for.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split('\n')[0].trim();
  if (firstLine.length === 0) return `${head}the call failed and gave no reason.`;
  return `${head}${firstLine}${/[.!?]$/.test(firstLine) ? '' : '.'}`;
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
   * Fields the cleanup did NOT correct, each left exactly as generated (LEDGER #223). Empty when
   * every planned field was read back in its shape. Absent on records written before #223.
   */
  failed: ScrubFailure[];
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
  /** Fields left as generated because their call or read failed. The item carries them too. */
  failed: ScrubFailure[];
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
  /**
   * The item keys to correct, when only some of them are asked for — the reports page's "clean
   * up again" beside one section re-runs just that section, and a section re-roll cleans up
   * just the text it wrote. Absent means every field the item carries, which is what generation
   * and the "Scrub narration" button ask for.
   */
  only?: readonly ScrubItemKey[];
  /** The run's cancel signal. A cancelled call is NOT a failed field: it stops the pass. */
  signal?: AbortSignal;
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
  origin: ScrubOrigin = 'post-generation',
  /** The item keys asked for; absent means all of them. */
  only?: readonly ScrubItemKey[]
): { plans: RewritePlan[]; skipped: ScrubSkip[]; failed: ScrubFailure[]; linksHeldBack: string | null } {
  const itemId = typeof item?.item_id === 'string' ? item.item_id : '(no item_id)';
  const plans: RewritePlan[] = [];
  const skipped: ScrubSkip[] = [];
  const failed: ScrubFailure[] = [];
  let linksHeldBack: string | null = null;
  const wanted = (key: ScrubItemKey) => only === undefined || only.includes(key);

  // A field that cannot even be PLANNED (a description whose link block cannot be found, a
  // chapter with no title text) is a failed field like any other (LEDGER #223): it stays as
  // generated, it is recorded, and the other fields still go.
  const planning = (field: string, key: ScrubItemKey, build: () => void) => {
    try {
      build();
    } catch (error) {
      failed.push({
        field,
        item_key: key,
        reason: scrubFailureSentence(field, error),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const hook = wanted('description_hook') ? textOf(item?.description_hook) : undefined;
  if (hook === undefined) {
    // Not asked for on this run.
  } else if (hook === null) {
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

  const description = wanted('description') ? textOf(item?.description) : undefined;
  if (description === undefined) {
    // Not asked for on this run.
  } else if (description === null) {
    skipped.push({ field: 'description', reason: 'the item carries no description.' });
  } else {
    planning('description', 'description', () => {
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
    });
  }

  let options: string[] | null | undefined;
  if (wanted('description_options')) {
    planning('alternate descriptions', 'description_options', () => {
      options = stringsOf(item?.description_options, 'description_options', itemId, 'scrubbed');
    });
  }
  if (options === undefined) {
    // Not asked for on this run, or it could not be planned (recorded above).
  } else if (options === null) {
    skipped.push({
      field: 'alternate descriptions',
      reason: 'the item carries no alternate descriptions.',
    });
  } else {
    const alternates: string[] = options;
    alternates.forEach((text, index) => {
      plans.push({
        field: `alternate description ${index + 1} of ${alternates.length}`,
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
  const chapters: Chapter[] = wanted('chapters') && Array.isArray(item?.chapters) ? item.chapters : [];
  let chapterTitles: string[] | null = null;
  if (wanted('chapters')) {
    planning('chapter titles', 'chapters', () => {
      chapterTitles = chapters.map((chapter, index) => {
        const title = textOf(chapter?.title);
        if (title === null) {
          throw new Error(
            `Chapter ${index + 1} of ${chapters.length} on item ${itemId} has no title text, so the ` +
              `chapter list cannot be scrubbed as ${chapters.length} lines.`
          );
        }
        return title;
      });
    });
  }
  // Widened on purpose: TypeScript cannot see the assignment inside the closure above.
  const titlesIn = chapterTitles as string[] | null;
  if (titlesIn === null) {
    // Not asked for on this run, or it could not be planned (recorded above).
  } else if (titlesIn.length === 0) {
    skipped.push({ field: 'chapter titles', reason: 'the item carries no chapters.' });
  } else {
    plans.push({
      field: 'chapter titles',
      labelKey: 'chapters',
      shape: 'lines',
      text: titlesIn.join('\n'),
      count: titlesIn.length,
      apply: (scrubbed, target) => {
        const titles = scrubbed as string[];
        target.chapters = (target.chapters as Chapter[]).map((chapter, index) => ({
          ...chapter,
          title: titles[index],
        }));
      },
    });
  }

  return { plans, skipped, failed, linksHeldBack };
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
 * PLAN BY PLAN (LEDGER #223). Each plan's call and read are tried on their own: an answer in its
 * shape is applied at once, and a plan that throws leaves its field exactly as generated and is
 * recorded in `scrubbed.failed` with a plain sentence and the whole error, logged as a warn line.
 * A failed plan never stops the next one and never fails the item. What still throws out of
 * here: a cancelled run (a stopped job is not a failed field), and an item with no
 * `_prompt_trace` array, which is the caller's bug rather than the model's answer.
 *
 * TOGETHER, READ IN ORDER (LEDGER #270; it was sequential, "a cloud pass that fanned out would
 * report its failures out of the order the log reads them in"). The plans' calls go out at once
 * and their answers are read in plan order, so the failures, the log and the trace keep the order
 * the sequential pass gave them. A cancel stops the pass at the first plan that reads it.
 *
 * `_prompt_trace` MUST ALREADY BE ON THE ITEM when this runs: the generation loop slices it off
 * the AI manager's running trace, and these entries are appended to that slice. Appending them
 * before the slice would double-count every cloud call, which records its own entry on the
 * manager as it goes out.
 */
export async function scrubGeneratedItem(
  item: any,
  { option, transport, origin, only, signal }: ScrubOptions
): Promise<ScrubRunResult> {
  const pass = scrubPass(origin);
  const sourceLabel = rewriteSourceLabel(item);
  const at = new Date().toISOString();
  const { plans, skipped, failed, linksHeldBack } = planScrub(
    item,
    transport.aiManager.descriptionLinks(),
    origin,
    only
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

  // Item keys with at least one plan that was APPLIED. A key whose every plan failed is not
  // reported as "unchanged" — nobody read it back — it is reported in `failed` instead.
  const applied = new Set<string>();

  // THE PLANS GO OUT TOGETHER (LEDGER #270). Each reads only its own field's text, taken off the
  // item before anything was sent, and writes only its own key (the alternates by index, the
  // chapter titles by position), so no plan reads another's answer. The calls are sent at once;
  // the answers are read, applied, failed, logged and traced IN PLAN ORDER afterwards, exactly as
  // the one-at-a-time loop did them. A local model's calls share the job's slot on its server
  // (lanes.ts); a standalone run (the reports page's button) sends its local calls one at a time
  // through the slot, as every standalone call goes.
  const sent = plans.map((plan) => ({ plan, prompt: buildScrubPrompt(plan, origin), sentAt: '' }));
  const answers = await settleTogether(sent.map((call) => async () => {
    call.sentAt = new Date().toISOString();
    return askToRewrite(pass, call.plan, option, transport, sourceLabel, call.prompt);
  }));

  for (const [k, { plan, prompt, sentAt }] of sent.entries()) {
    const answer = answers[k];
    try {
      if (answer.status === 'rejected') throw answer.reason;
      const { value } = readRewrittenAnswer(pass, plan, answer.value, option.model, sourceLabel);
      plan.apply(value, item);
      applied.add(itemKeyOf(plan));
    } catch (error) {
      if (error instanceof JobCancelledError || isAbortError(error) || signal?.aborted) throw error;
      const failure: ScrubFailure = {
        field: plan.field,
        item_key: itemKeyOf(plan),
        reason: scrubFailureSentence(plan.field, error),
        detail: error instanceof Error ? error.message : String(error),
      };
      failed.push(failure);
      log.warn(`[Scrub] (${origin}) ${sourceLabel}: ${failure.reason} It is kept exactly as generated.\n${failure.detail}`);
    } finally {
      // A call that was sent is a call on the record, answered in shape or not.
      (item._prompt_trace as PromptTraceEntry[]).push({
        what: pass.callWhat(plan.field, sourceLabel),
        model: option.model,
        chars: prompt.length,
        at: sentAt,
        prompt,
        ...(option.kind === 'local' ? { maxTokens: REWRITE_NUM_PREDICT, act: 'generate' as const } : {}),
      });
    }
  }

  const record: ScrubRecord = { model: option.model, at, fields: {}, skipped, failed };
  if (linksHeldBack !== null) record.links_held_back = linksHeldBack;
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [key, was] of before) {
    if (!applied.has(key)) continue;
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
      (skipped.length ? `; not carried by this item: ${skipped.map((s) => s.field).join(', ')}` : '') +
      (failed.length ? `; NOT cleaned up, kept as generated: ${failed.map((f) => f.field).join(', ')}` : '')
  );
  // A field that could not even be planned never reached the loop above; say it here too.
  for (const failure of failed) {
    if (!plans.some((plan) => plan.field === failure.field)) {
      log.warn(`[Scrub] (${origin}) ${sourceLabel}: ${failure.reason} It is kept exactly as generated.\n${failure.detail}`);
    }
  }
  if (linksHeldBack !== null) log.info(`[Scrub] ${sourceLabel} held back ${linksHeldBack}`);

  return { model: option.model, changed, unchanged, skipped, failed };
}
