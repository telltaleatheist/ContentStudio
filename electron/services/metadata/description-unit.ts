/**
 * The description, as ONE plain-text call per candidate
 *
 * SINCE 2026-08-24 (operator's ruling: no JSON for these calls unless absolutely necessary)
 * each candidate is written by ONE call whose answer is the shape the composer publishes —
 * one paragraph whose first sentence is the hook — parsed by plain-call.ts. The hook/body split below is
 * unchanged as a CONTRACT (two fields, two judges, the same failure policies); what changed
 * is that no JSON string literal ever carries the prose, which is where the "..."-as-body
 * bail-out and the close-quote runaway both lived. The history in the rest of this header is
 * the two-call design's and is kept because every judge and policy in this file came out of
 * it.
 *
 * WHAT CHANGED AND WHY. The routed description used to be one field in a prompt-set group:
 * the channel's `## DESCRIPTION` section, the editorial preamble, the self-check and a JSON
 * output contract, all sent to one model that also wrote the tags. The metadata spec
 * (/Volumes/Callisto/Projects/Briefcase/docs/youtube-metadata-spec.md, §2 and §5) decomposes
 * it instead into the two pieces that are actually different jobs:
 *
 *   HOOK — one sentence, <=150 characters, the exact phrase a searcher would type,
 *          front-loaded. It is the search-results snippet and the above-the-fold line on
 *          mobile, and it is the only genuinely compositional piece in the whole layer.
 *   BODY — 150-300 words weaving the chapter summaries into one paragraph. A format
 *          transform over structured input: the judgment already happened upstream, in
 *          chapter summarization.
 *
 * Both are SCHEMA-CONSTRAINED (spec §5), which is the opposite of what the chapter
 * summarizer does and for a stated reason: constraining a MECHANICAL task suppresses
 * small-model over-reasoning that otherwise burns the entire output budget without
 * answering, while constraining a JUDGMENT task measurably destroys it. These two calls are
 * mechanical. Chapter summarization is not, and nothing here is copied there.
 *
 * WHAT THEY READ. The chapter titles and summaries, the entity pool, the key-phrase pool —
 * AND THE RAW TRANSCRIPT.
 *
 * The transcript is new, and it SUPERSEDES the summaries-only input contract §2 laid down. That
 * contract was a context-window concession dressed as a design: it said the description layer
 * runs on already-extracted inputs, which is what made it viable on a 4b. The operator's call
 * (2026-08-22) is that a description written from a précis of the video reads like one — the
 * specifics that make an opening line worth reading are exactly what a chapter summary drops.
 * The chapter block STAYS beside it: it is a measured table of contents that says what the
 * video spends its time on, which a transcript does not, and the entity scaffold still applies.
 *
 * The cost is stated rather than hidden: these two calls now carry a transcript-sized prompt,
 * so they share their model's one pinned num_ctx with every other call on it (metadata-tasks.ts
 * ModelRunContextBudget) instead of sizing themselves against a small private ceiling.
 *
 * AND WHERE THERE ARE NO CHAPTERS. This unit used to be planned only for chaptered items;
 * everything else took a whole-metadata call on whatever the Settings page named, and got its
 * description from the channel's `## DESCRIPTION` section there. That path is gone. A
 * chapterless item plans this unit like any other, and the `{coverage}` slot carries the
 * operator's text subject instead of the chapter list — the same two calls, the same schemas,
 * the same failure policy, over the only description of the video that exists.
 *
 * AND WHERE THE TRANSCRIPT IS TOO BIG (2026-08-23). Over the direct-pass ceiling the content
 * these calls read is the CHAPTER DIGEST (chapter-digest.ts), not a summary — the operator's
 * ruling is that a condensation is acceptable only in the form of chapters. `{coverage}` is
 * already that list, so `{transcript}` goes EMPTY, exactly as it does on a chapterless item and
 * for exactly the same reason: the coverage block IS the content, and nothing condensed is ever
 * rendered under a heading that calls it the transcript.
 *
 * WHAT THEY CARRY ABOUT THE CHANNEL, and why that is the opposite of what this comment used to
 * say. These two calls used to carry NO editorial brief at all: the channel's `## DESCRIPTION`
 * section was deliberately withheld — two paragraphs, the above-the-fold snippet rule, the
 * search-context paragraph, the soft CTA, the voice note and the banned-phrase list — on §5's
 * argument that fifteen editorial bullets over-specify a schema-constrained small model, and
 * the channel reached the prompts as the "channel NAME in the context line", which in fact was
 * the stored SLUG ("youtube-telltale").
 *
 * That arrangement produced exactly one description in production before the operator stopped
 * the run (job-1787440820706-wk0cej99g, 2026-08-22 19:30): 324 words, one paragraph, a
 * third-person synopsis of the narrator — "The episode opens with O. Morgan dissecting ... The
 * host then addresses ... Morgan questions" — with no second paragraph, no search context and
 * no CTA. `judgeBody` caught the register, re-asked once, and kept the second failure as
 * written, which is the stated policy and did nothing for the operator.
 *
 * The relevant part of the measurement is that IT IS NOT A SMALL-MODEL RESULT. These prompts go
 * to Claude Sonnet and Opus unchanged whenever the description is routed to the cloud — the
 * class below is one class for both transports — so an unbriefed call writes an unbriefed
 * description on any model. §5's over-specification argument is about JUDGMENT tasks; the brief
 * for a document is not over-specification, it is the specification.
 *
 * So both calls now take `{channel}` (the channel's real name and its own focus paragraph) and
 * `{rules}` (that same `## DESCRIPTION` section, whole), and each prompt states which part of
 * the section it writes: the hook writes sentence 1 of paragraph 1, the body writes the rest and
 * is shown the hook so it carries on from it instead of restating it. The section still runs, in
 * full, on the compilation call as well.
 *
 * THREE OF THEM, SINCE 2026-08-23. This unit used to write one description and that was the
 * item's description. Titles have always come back as a LIST the operator curates, and the
 * operator's ruling is that the description is the same kind of decision: he reads them, he
 * picks one, and a second opinion should not cost another run of the whole pipeline.
 *
 * The PRIMARY is unchanged in every respect — same prompts, same 0.4/0.2, same judging — and it
 * is still `description` + `description_hook`. Nothing downstream learned a new shape: the
 * composer, the publish pipeline, the carry-forward and every stored report read the fields they
 * always read. The alternatives are additive, in `description_options`, each a WHOLE pair: its
 * own hook, then a body written to continue that hook. Every draw runs at the provider's
 * default sampling (operator's ruling 2026-08-24), which is where the variety between
 * candidates comes from.
 *
 * An extra is also dropped when its body comes back the wrong LENGTH twice — measured on the
 * channel's own `body_words`. The primary keeps a wrong-length body because the operator needs
 * one; an option that is not description-length is not something he can choose, and the first
 * run of this feature produced exactly that (the model returned "..." as an option's whole body,
 * judged at 1 word against 60-200, and the report offered it as a choice). Register faults never
 * drop an option — taste is what the operator is there for.
 *
 * And an extra that FAILS is dropped with a warning rather than failing the item, which is a
 * stated exception to the no-fallbacks rule and the only one in this file. The rule exists
 * because a silently missing output cannot be told from a correct one; a missing OPTION can,
 * because the warning names it and the description it was an alternative to is right there,
 * complete and judged. Failing the item would throw away a correct description to punish a
 * missing choice.
 *
 * FAILURE POLICY. A hook over the 150-character cap or prose in the wrong register is asked
 * for ONE more time and then KEPT AS WRITTEN with a declared warning on the run. Nothing here
 * truncates a hook, rewrites a sentence or fails an item over style: the operator curates, and
 * a silently shortened hook is a hook he never got to see. A TRANSPORT failure still throws —
 * it means the model is not there, which is not a style question.
 */

import axios, { AxiosInstance } from 'axios';
import * as log from 'electron-log';
import { estimateTokens } from './ollama-json';
import { askOllamaPlain, parseLeadBody } from './plain-call';
import { JobModelLifecycle } from './model-lifecycle';
import { MetadataRoutingOption } from './metadata-routing';
import { queueAITask } from '../queue-manager.service';
import { JobCancelledError } from './cancellation';
import { describerClauses } from './chapter-title-quality';
import { promptAssets, ChannelData } from './prompt-assets';
import type { MetadataFieldId, MetadataRunContext, MetadataUnit } from './metadata-tasks';
import type { ModelRunContextBudget } from './metadata-tasks';
import type { AIManagerService } from './ai-manager.service';

/**
 * Spec §1.1 / §5: YouTube's search snippet stops here.
 *
 * Enforced in CODE, not only in the schema, and that is not belt-and-braces: Briefcase's live
 * run reports that Ollama's schema `maxLength` is UNTESTED — their hooks came in under the cap
 * on their own, so the constraint never had to fire. Until somebody has watched it truncate a
 * decode, the measurement below is the enforcement and the schema is a hint.
 */
export const HOOK_MAX_CHARS = 150;

/**
 * What the PROMPT asks for, under the hard cap.
 *
 * A model asked for "at most 150" writes 150 and stops mid-clause; asked for 140 it writes a
 * finished sentence with room to spare. The 150 stays the measured limit — this is the aim.
 */
const HOOK_TARGET_CHARS = 140;

/**
 * Spec §1.2's range, now READ FROM THE CHANNEL rather than fixed here.
 *
 * A TARGET, checked in code, because a big model ignores it in the prompt — Briefcase measured
 * a 27b writing 353 words against this exact instruction while a 4b hit 211 naturally. Over or
 * under is a DECLARED WARNING and the paragraph publishes as written; nothing here truncates a
 * body to fit a number.
 *
 * IT MOVED because these two calls now carry the channel's own `## DESCRIPTION` rules, and
 * those rules disagree about length by design: a YouTube description is two paragraphs, a
 * Spreaker episode note says 150-250 words in its own text, and a Shorts description is two or
 * three sentences. One constant here would have made the prompt and the rules contradict each
 * other on two channels out of three. The pair lives in shared/fields/description.yml
 * (`body_words`), the prompt substitutes both ends of it, and `judgeBody` measures against the
 * same pair — which is the invariant the old constants were here to hold.
 */
function bodyWordRange(channel: ChannelData): [number, number] {
  const range = promptAssets().field(channel, 'description').wordRange;
  if (!range) {
    throw new Error(
      `The description body for channel "${channel.id}" has no word range: shared/fields/description.yml ` +
        `declares no "body_words" for field variant "${channel.fieldVariant}". The prompt asks for that range ` +
        `and the run warns against it, so there is no number to fall back to.`
    );
  }
  return range;
}

/*
 * NO TEMPERATURES ARE SET HERE ANY MORE — operator's ruling 2026-08-24: no sampling
 * parameters anywhere, every model at its provider defaults, and a model that cannot
 * perform there is replaced rather than tuned. This superseded spec §5's per-call
 * temperatures (hook 0.4, body 0.2, option hooks 0.7). The one measurement that ruling
 * put at risk — option bodies at 0.7 on qwen3.8:27b came back "..." or cut mid-clause
 * (2 usable of 6) while 0.2 held (3 of 3) — is under re-test at defaults per the same
 * ruling; the drop rules below are what stand behind a bad draw either way.
 */

/**
 * How many descriptions the operator gets to choose from, the primary included.
 *
 * DATA, in the same spirit as the channel's `{titles_count}`: the number is stated once and the
 * loop reads it. It is a constant rather than channel YAML because unlike a title count it is
 * not an editorial property of a channel — every channel's operator curates the same way — and a
 * per-channel knob nobody would ever set differently is a knob to keep in step for nothing. If a
 * channel ever does want its own count, this is the line that moves into the YAML.
 */
const DESCRIPTION_CANDIDATES = 3;

/* Option draws use the same provider-default sampling as everything else — see the ruling above. */

/**
 * How the body judge opens its word-count complaint.
 *
 * A CONSTANT because two places depend on the same sentence: `judgeBody` writes it, and the
 * option rule reads it back to tell a wrong-length body from a wrong-register one. Matching on
 * the substring "word" would have done it until the day a register fault quoted a clause with
 * the word "word" in it and silently threw away a good option.
 */
const LENGTH_FAULT = 'it ran to ';

/**
 * The fewest words that can be the opening sentence of a description.
 *
 * FIVE, which is nowhere near any real hook — the ones measured on this channel run 20 to 25
 * words — because this is not a style floor. It catches the NON-ANSWER: on qwen3.8:27b, sampled
 * for an alternative, the hook call returned the three characters "..." as its whole answer, and
 * every other check passed it. It is under the character cap. It has no describer clause. It
 * even ends on a full stop. It is simply not a sentence, and it went into a published report as
 * an option's opening line.
 *
 * IT IS CHECKED FOR THE PRIMARY TOO, which is a change to the primary's judge and a deliberate
 * one. The same draw can happen on the primary, where "..." would become the item's search
 * snippet — the single most visible string this app produces — and nothing anywhere would have
 * said so. Unlike the register question this file leaves alone, "the model returned an ellipsis
 * instead of a sentence" is not a matter of taste, and the existing policy handles it correctly
 * without further help: re-ask once, and if it comes back the same, keep it and declare it.
 */
const HOOK_MIN_WORDS = 5;

/** How the hook judge opens its not-a-sentence complaint. Read back by the option rule. */
const SHORT_HOOK_FAULT = 'it came back as ';

/**
 * WHAT THE EXTRAS COST. Each candidate is a full pair — its own hook call, then its own body
 * call reading that hook — plus whatever judging re-asks. Two extras is therefore about four
 * more calls, ~80s on the 27b, against a job already measured at 163s. The operator's ruling
 * (2026-08-23) is that this is worth it: his loop is generate, read three, pick one, and a
 * second run to get a second opinion costs the whole pipeline again.
 */

/**
 * Output budget per call.
 *
 * A whole description is ~450 tokens, but these models reason first — the chapter work
 * measured 1,900-2,900 tokens of it — and `think: false` is not an option (ollama-json trap
 * 2). The ceiling is sized so that a model which reasons anyway still finishes.
 */
/**
 * Thinking is OFF for descriptions (operator, 2026-08-30 evening: "turn thinking off, pack
 * and ship") — the 4-5 minutes of reasoning per call was the whole cost of the 20-minute
 * runs, and what it bought (the hook / blank line / body layout) is no longer asked for:
 * the contract is now ONE paragraph whose first sentence is the hook, which thinking-off
 * produced in every measured run (~15-45s per call), parsed by parseLeadBody. 4096 is
 * answer-sized with a wide margin — there is no reasoning to carry any more.
 */
const NUM_PREDICT = 4096;

/**
 * 600s, not 300: with thinking ON and the 8192 budget, the arithmetic of a spilled or long
 * call is ~60s of prefill plus generation at ~30 tok/s — a full-budget answer needs ~330s,
 * so a 300s wall guarantees the timeout fires JUST before the budget can complete (measured
 * live on 2026-08-30: 4 - jehovahs witnesses died at exactly 300s). The detail calls have
 * used 600s all along for the same reason.
 */
const CALL_TIMEOUT_MS = 600_000;
const KEEP_ALIVE = '10m';

/**
 * The candidate prompt, from prompts/shared/pipeline/description.yml.
 *
 * A getter, so a missing file or key throws naming both at the moment the prompt is wanted,
 * and the character budget is substituted from THIS FILE'S constant — the number the prompt
 * asks for and the number the code measures cannot drift apart. (The body-revision prompt
 * died with the re-ask machinery, 2026-08-24: a judge fault is a warning now, not a second
 * call.)
 */
export const DESCRIPTION_PROMPTS = {
  get CANDIDATE(): string {
    return promptAssets()
      .pipeline(DESCRIPTION_FILE, 'candidate')
      .replace(/\{hookTargetChars\}/g, () => String(HOOK_TARGET_CHARS));
  },
};

const DESCRIPTION_FILE = 'description.yml';

/**
 * The fields this unit owns. `description` is the BODY; the hook is its own field.
 *
 * `description_options` is the third, and it is the only one that may legitimately come back
 * absent: the primary pair is the contract and the alternatives are additive, so a run whose
 * extras all failed still satisfies this unit's declaration with two fields and a warning.
 */
export const DESCRIPTION_FIELDS: MetadataFieldId[] = ['description_hook', 'description', 'description_options'];

/**
 * The description unit: one plain-text call per candidate, either transport.
 *
 * ONE class for local and cloud rather than two, which is the opposite of how the prompt-set
 * groups are built (CloudGroupUnit / LocalGroupUnit) — and deliberately, because the
 * difference here is four lines rather than a prompt shape. The prompts are identical, the
 * inputs are identical, and the only divergence is the transport: the local branch decodes
 * under a JSON Schema grammar and sizes its own context window; the cloud branch sends the
 * same schema as structured outputs and sizes nothing.
 */
export class DescriptionUnit implements MetadataUnit {
  readonly label: string;
  readonly fields = DESCRIPTION_FIELDS;
  /** These two calls read the coverage block, the pools and the transcript — no other field. */
  readonly inputFields: MetadataFieldId[] = [];

  private readonly client?: AxiosInstance;
  private readonly host?: string;

  constructor(
    private readonly aiManager: AIManagerService,
    private readonly option: MetadataRoutingOption,
    defaultHost: string,
    /**
     * The ONE context budget every call on this model shares, on the local path.
     *
     * These two calls used to size a private num_ctx against their own small ceiling, which was
     * safe while they read summaries and nothing else. They read the transcript now, and they
     * routinely share the 9B with the tags call — and Ollama fully reloads a model on any
     * num_ctx change, so a private value here would reload it between the description and the
     * tags. Absent on the cloud path, where there is no window to pin.
     */
    private readonly budget: ModelRunContextBudget | undefined,
    /**
     * Where this unit DECLARES the model it made resident. It never releases one: these two
     * calls share the 9B with the tags call, and unloading it here reloaded it for that call.
     */
    private readonly lifecycle: JobModelLifecycle,
    private readonly abortSignal?: AbortSignal
  ) {
    if (option.kind === 'local') {
      if (!budget) {
        throw new Error(
          `The description unit for local model "${option.model}" was constructed with no context budget. ` +
            `Every local call on a model shares one pinned num_ctx (metadata-tasks.ts) because changing it ` +
            `reloads the model; there is no per-unit sizing to fall back on.`
        );
      }
      this.host = defaultHost;
      this.client = axios.create({ baseURL: this.host });
      this.label = `description (local ${option.model} @ ${this.host})`;
      budget.register('description', (ctx) =>
        estimateTokens(this.buildPrompt(DESCRIPTION_PROMPTS.CANDIDATE, ctx, '').length) + NUM_PREDICT
      );
    } else {
      this.label = `description (cloud ${option.model})`;
    }
  }

  describePrompt(ctx: MetadataRunContext): string {
    return (
      `# ${DESCRIPTION_CANDIDATES} DESCRIPTIONS ARE WRITTEN FROM THIS ONE PROMPT.\n` +
      `# The primary and ${DESCRIPTION_CANDIDATES - 1} alternative(s), each one whole answer — the\n` +
      `# paragraph opening on its hook sentence. The prompt is identical for all of them — every\n` +
      `# draw runs at the provider's default sampling — so it is shown once.\n\n` +
      `# DESCRIPTION (${this.option.model}, plain text, provider default sampling)\n\n` +
      this.buildPrompt(DESCRIPTION_PROMPTS.CANDIDATE, ctx, '')
    );
  }

  async generate(ctx: MetadataRunContext): Promise<Record<string, unknown>> {
    // THE PRIMARY IS UNCHANGED IN CONTRACT. Same judging, same fields —
    // `description` and `description_hook` mean exactly what they meant before this unit could
    // produce more than one, so the composer, the publish pipeline, the carry-forward and every
    // stored report are untouched by what follows.
    const primary = await this.writePair(ctx, 'primary');
    // The primary publishes whatever it wrote, faults and all, exactly as it always has.

    const options = await this.writeOptions(ctx, primary);

    return {
      description_hook: primary.hook,
      description: primary.body,
      // Omitted entirely rather than sent as [] when there are none: an absent field reads as
      // "this build/run produced no alternatives", which is true, and the .txt writer's
      // `emptyToUndefined` would drop an empty array anyway.
      ...(options.length > 0 ? { description_options: options } : {}),
    };
  }

  /**
   * The alternatives, each a WHOLE description written from scratch.
   *
   * A candidate is a hook and then a body that continues THAT hook. Reusing the primary's hook
   * and re-rolling only the body would produce three descriptions that all open the same way,
   * which is the one thing an operator choosing between them cannot use — the opening line IS
   * the search snippet, and it is the part he is really picking.
   *
   * A FAILED EXTRA IS DROPPED, WITH A WARNING, AND THAT IS A DELIBERATE EXCEPTION to this
   * codebase's rule that a failed call fails the item. The rule exists because a silently
   * missing output is indistinguishable from a correct one; here it is not. The primary is the
   * contract and it has already been written and judged. An extra that fails costs the operator
   * one CHOICE, which the warning names, and failing the whole item over it would throw away a
   * description that is complete and correct. Cancellation still propagates — a cancelled job is
   * not a failed candidate.
   */
  private async writeOptions(
    ctx: MetadataRunContext,
    primary: DescriptionCandidate
  ): Promise<string[]> {
    if (DESCRIPTION_CANDIDATES <= 1) return [];

    const written: DescriptionCandidate[] = [primary];
    const options: string[] = [];

    for (let n = 2; n <= DESCRIPTION_CANDIDATES; n++) {
      try {
        let candidate = await this.writePair(ctx, `option ${n}`);

        // ONE RE-DRAW, for either reason a first draw disappoints: it is unusable, or it opens
        // the way something already written opens. Both get exactly one more go and no more — a
        // loop that re-rolled until it was happy would spend minutes chasing a model that has
        // settled, and two good options are worth more than three expensive ones.
        // No redraw (operator, 2026-08-24: no re-asks anywhere): an unusable option is
        // dropped below and a duplicate is kept and declared — both are curation, not
        // second calls.

        // The two reasons part company here. A DUPLICATE opening is kept if it comes back twice:
        // three descriptions that share a lead are still three descriptions, and the operator can
        // see the repetition for himself. An UNUSABLE one is never kept, however many times it is
        // drawn — offering it would be offering a choice that is not a description.
        const stillUnusable = unusableReason(candidate);
        if (stillUnusable) {
          ctx.warn(
            `description option ${n} of ${DESCRIPTION_CANDIDATES} was dropped: ${stillUnusable}. The ` +
              `description above is unaffected and ${options.length} alternative(s) were kept.`
          );
          continue;
        }
        const stillDuplicate = this.duplicateReason(candidate, written);
        if (stillDuplicate) {
          log.info(`[Description] ${ctx.sourceLabel}: option ${n} ${stillDuplicate} again, and is kept as drawn`);
        }

        written.push(candidate);
        // Flattened the way the composer publishes it — hook, blank line, body — so what the
        // operator reads in the report is what he would be pasting in.
        options.push(`${candidate.hook}\n\n${candidate.body}`);
      } catch (error) {
        if (error instanceof JobCancelledError) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        ctx.warn(
          `description option ${n} of ${DESCRIPTION_CANDIDATES} could not be written and was dropped ` +
            `(${reason}); the description above is unaffected and ${options.length} alternative(s) were kept`
        );
      }
    }

    log.info(
      `[Description] ${ctx.sourceLabel}: ${options.length + 1} description(s) — the primary and ` +
        `${options.length} alternative(s), all at provider default sampling`
    );
    return options;
  }

  /**
   * Does this candidate open the way one already written opens?
   *
   * DEDUPED BY OPENING SENTENCE, not by string equality: two bodies that differ in their third
   * paragraph and open identically are one option as far as the operator is concerned, because
   * he reads the first line and moves on.
   */
  private duplicateReason(candidate: DescriptionCandidate, written: DescriptionCandidate[]): string | null {
    return written.some((prior) => sameOpening(prior.body, candidate.body))
      ? 'it opened on the same sentence as an earlier one'
      : null;
  }

  /**
   * One complete description: ONE call, judged on both of its parts, NEVER re-asked.
   *
   * THE RE-ASK MACHINERY IS GONE (operator, 2026-08-24): "i dont think we should be
   * re-asking. i think we should let it fail. thats a band aid thats covering up real
   * failure points... the fact that it's re-asking is a programmed in bug." A judge fault is
   * a WARNING on the answer, kept exactly as written, for the operator and the prompt-tuning
   * loop to fix at the source; an answer that cannot be PARSED (no measurable opening sentence) throws, and
   * the caller's policy decides what that costs — the primary fails the item loudly, an
   * option is dropped with a warning. One call per candidate, always.
   */
  private async writePair(ctx: MetadataRunContext, tag: string): Promise<DescriptionCandidate> {
    const prompt = this.buildPrompt(DESCRIPTION_PROMPTS.CANDIDATE, ctx, '');
    const pair = await this.askCandidate(prompt, `${tag} description`, ctx);
    const hookFaults = this.judgeHook(pair.hook);
    const bodyFaults = this.judgeBody(pair.body, ctx);
    if (hookFaults.length > 0 || bodyFaults.length > 0) {
      ctx.warn(
        `the description ${tag} ${[...hookFaults, ...bodyFaults].join(' and ')}; it is kept exactly as the ` +
          `model wrote it and nothing was reworded — fix the prompt, not the answer`
      );
    }
    return { hook: pair.hook, hookFaults, body: pair.body, bodyFaults };
  }

  // ------------------------------------------------------------------------ the one call

  /**
   * One candidate draw: one paragraph, hook measured off its first sentence (parseLeadBody
   * says why the blank-line shape went). Throws when there is no sentence to measure.
   */
  private async askCandidate(
    prompt: string,
    what: string,
    ctx: MetadataRunContext
  ): Promise<{ hook: string; body: string }> {
    const text = await this.askPlain(prompt, what, ctx);
    return parseLeadBody(text, `the description ${what} for ${ctx.sourceLabel}`, HOOK_MAX_CHARS + 40);
  }

  private judgeHook(hook: string): string[] {
    const faults: string[] = [];
    const words = hook.split(/\s+/).filter(Boolean).length;
    if (words < HOOK_MIN_WORDS) {
      faults.push(
        `${SHORT_HOOK_FAULT}${words} word(s) ("${hook}"), which is not the complete sentence the ` +
          `search snippet has to be`
      );
    }
    if (hook.length > HOOK_MAX_CHARS) {
      faults.push(`it ran to ${hook.length} characters against the ${HOOK_MAX_CHARS}-character search snippet`);
    }
    const narrated = describerClauses(hook);
    if (narrated.length > 0) {
      faults.push(
        `it was written about someone covering the subject rather than about the subject ` +
          `(${narrated.map((clause) => `"${clause}"`).join('; ')})`
      );
    }
    return faults;
  }

  /**
   * Describer clauses everywhere EXCEPT the final sentence.
   *
   * The rules hand the final sentence to the channel by name — "Final sentence: Channel
   * positioning or soft CTA" — and the operator's own approved production description
   * closes "…feeding this channel's steady takedown of religious grifters". Measured
   * 2026-08-23 (job-1787520736309, and reproduced across three models in the subagent
   * harness): the judge flagged that exact closing register on ALL THREE bodies of the
   * run, spending three revision calls to churn sentences that were following the brief.
   * A describer clause in the closer is the brief being followed; one anywhere else is
   * still the failure this check exists for.
   */
  private judgeBody(body: string, ctx: MetadataRunContext): string[] {
    const faults: string[] = [];
    const [min, max] = bodyWordRange(this.channel(ctx));
    const words = body.split(/\s+/).filter(Boolean).length;
    if (words < min || words > max) {
      faults.push(`${LENGTH_FAULT}${words} words against the ${min}-${max} word body this channel asks for`);
    }
    const narrated = describerClauses(body);
    if (narrated.length > 0) {
      const shown = narrated.map((clause) => `"${clause.length > 60 ? `${clause.slice(0, 57)}...` : clause}"`);
      faults.push(`it wrote about someone covering the subject rather than about the subject (${shown.join('; ')})`);
    }
    return faults;
  }

  // --------------------------------------------------------------------------- transports

  /**
   * One plain-text call, either transport. Throws on a transport failure AND on an empty
   * answer: unlike the chapter pipeline, this unit has no per-chapter degradation to decline
   * into — a candidate with no text is not a candidate, and the caller's policies (the one
   * re-ask, the option drop) are built on exactly this throw.
   */
  private async askPlain(prompt: string, what: string, ctx: MetadataRunContext): Promise<string> {
    const fullWhat = `the description ${what} for ${ctx.sourceLabel}`;
    if (!this.client) {
      const text = await this.aiManager.runPlainRequest(prompt, this.option.model, fullWhat);
      if (!text) {
        throw new Error(`${fullWhat} on "${this.option.model}" came back empty`);
      }
      return text;
    }

    // One num_ctx for the whole MODEL for the whole RUN (ollama-json trap 4) — not one per
    // unit. Resolved by the first call on this model to run, from the largest prompt it will
    // send, and shared from there.
    const numCtx = this.budget!.resolve(ctx);

    const result = await queueAITask(
      `description-${this.option.model}-${ctx.sourceLabel}-${what}`,
      `Metadata: ${this.label} — ${what}`,
      async () => {
        if (this.abortSignal?.aborted) throw new JobCancelledError('cancelled before the description call ran');
        const answer = await askOllamaPlain(this.client!, {
          model: this.option.model,
          prompt,
          numCtx,
          numPredict: NUM_PREDICT,
          keepAlive: KEEP_ALIVE,
          // Thinking off (operator, 2026-08-30 evening). The old two-part layout needed the
          // reasoning pass; the one-paragraph contract does not — see NUM_PREDICT above.
          think: false,
          timeoutMs: CALL_TIMEOUT_MS,
          signal: this.abortSignal,
          what: fullWhat,
          logPrefix: `[Description] ${this.label}`,
        });
        this.lifecycle.holdOllamaModel(this.host!, this.option.model, 'the description calls');
        return answer;
      },
      undefined,
      CALL_TIMEOUT_MS + 60_000
    );

    if (!result.ok) {
      throw new Error(
        `${fullWhat} on "${this.option.model}" produced no usable answer (${result.reason}): ${result.detail}`
      );
    }
    return result.text;
  }

  // ----------------------------------------------------------------------------- prompting

  private buildPrompt(
    template: string,
    ctx: MetadataRunContext,
    hook: string,
    extra: Record<string, string> = {}
  ): string {
    const assets = promptAssets();
    const channel = this.channel(ctx);
    const [min, max] = bodyWordRange(channel);
    const pools = [
      ctx.entities.length > 0 ? `Names: ${ctx.entities.join(', ')}` : '',
      ctx.keyPhrases.length > 0 ? `Phrases: ${ctx.keyPhrases.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const slots: Record<string, string> = {
      // The channel's real name and its own focus paragraph, replacing the stored SLUG these
      // prompts used to be handed. "youtube-telltale" told a model nothing about the channel.
      channel: assets
        .pipeline(DESCRIPTION_FILE, 'channel_block')
        .replace(/\{name\}/g, () => channel.name)
        .replace(/\{focus\}/g, () => channel.channelFocus.trim()),
      video: ctx.videoTitle || ctx.sourceLabel,
      coverage: this.coverageBlock(ctx),
      transcript: this.transcriptBlock(ctx),
      speaker_tags: this.speakerTagsBlock(ctx),
      pools: pools || '(none)',
      // The channel's `## DESCRIPTION` section, whole. See the note at the top of this file and
      // the one in shared/pipeline/description.yml for what withholding it measured out at.
      rules: assets
        .pipeline(DESCRIPTION_FILE, 'rules_block')
        .replace(/\{items\}/g, () => this.descriptionRules(ctx, channel)),
      hook,
      hookTargetChars: String(HOOK_TARGET_CHARS),
      bodyMinWords: String(min),
      bodyMaxWords: String(max),
      // The revision call's two slots, empty everywhere else so the one-pass replace below
      // still fills every name it knows.
      body: extra.body ?? '',
      clauses: extra.clauses ?? '',
    };

    // ONE PASS over the whole template, so a slot's own free text can never be read as another
    // slot. A chained `.replace` cannot promise that: every link in the chain rescans the text
    // the previous links inserted, and a transcript that happens to contain "{pools}" would be
    // substituted into. The regex names the slots this file fills and nothing else, so an
    // unfilled brace in the asset survives to the prompt where it is visible rather than
    // silently blanked.
    return template.replace(
      /\{(channel|video|coverage|transcript|speaker_tags|pools|rules|hook|hookTargetChars|bodyMinWords|bodyMaxWords|body|clauses)\}/g,
      (_match, key: string) => slots[key]
    );
  }

  /**
   * What the tags on the transcript mean, or nothing at all.
   *
   * GATED ON THE MEASUREMENT, not on whether a voice enrollment exists: `contentSpeakerTagged`
   * is true exactly when `buildContentText` put the labels in the text. A run with tagging on
   * whose every caption came out HOST has an unlabelled transcript and gets no block, which is
   * correct — there is nothing on the page for the block to describe.
   *
   * The transcript slot is its precondition, and for the same reason. On a chapterless item
   * `transcriptBlock` renders nothing (the coverage block IS the operator's subject text), so
   * there are no tagged lines in this prompt however the video was transcribed.
   */
  private speakerTagsBlock(ctx: MetadataRunContext): string {
    if (!ctx.contentSpeakerTagged) return '';
    if (this.transcriptBlock(ctx).length === 0) return '';
    return promptAssets().pipeline(DESCRIPTION_FILE, 'speaker_tags_block');
  }

  /**
   * The channel's `## DESCRIPTION` section, plus the tagged addendum where it applies.
   *
   * The addendum is a rule about attribution, and attribution is only decidable on a tagged
   * transcript, so it is appended under the same condition the block above is rendered under.
   * A channel whose description rules declare no addendum while the transcript IS tagged is a
   * prompt asset that has lost a key rather than a channel with nothing to say — the tagged
   * transcript is in the prompt either way, and rules that do not mention it would leave the
   * register bullet telling the model to keep the speaker out of every sentence while the
   * speaker is labelled on every line. So it throws, naming the file, as every other missing
   * asset in this tree does.
   */
  private descriptionRules(ctx: MetadataRunContext, channel: ChannelData): string {
    const assets = promptAssets();
    const section = assets.fieldSection(channel, 'description');
    if (!ctx.contentSpeakerTagged || this.transcriptBlock(ctx).length === 0) return section;

    const addendum = assets.field(channel, 'description').taggedAddendum;
    if (!addendum || addendum.trim().length === 0) {
      throw new Error(
        `The transcript for ${ctx.sourceLabel} is speaker-tagged, and channel "${channel.id}"'s ` +
          `description rules declare no "tagged_addendum" for its field variant ` +
          `("${channel.fieldVariant}") in prompts/shared/fields/description.yml. The tagged ` +
          `transcript reaches the prompt either way; the rules that govern how it is attributed ` +
          `cannot be missing.`
      );
    }
    return `${section.replace(/\s+$/, '')}\n${addendum.replace(/\s+$/, '')}`;
  }

  /**
   * This run's channel, from the prompt assets.
   *
   * `ctx.promptSetName` is the stored prompt-set id, which in this app IS the channel id, so an
   * unknown one throws inside `channel()` naming the ids that exist. Nothing here defaults to a
   * channel: a description written to some other channel's rules is worse than no description.
   */
  private channel(ctx: MetadataRunContext): ChannelData {
    return promptAssets().channel(ctx.promptSetName);
  }

  /**
   * The video's own words, beside the chapter list rather than instead of it.
   *
   * ONLY ON THE CHAPTERED PATH, and that is not a condition to be defended against — it is the
   * two shapes `coverageBlock` already distinguishes. Where there ARE chapters, the coverage
   * block is a measured table of contents and this is the transcript it was measured from, so
   * both belong. Where there are NOT, the coverage block IS `ctx.content` — the operator's text
   * subject — and rendering it again under a second heading would hand the model the same
   * paragraph twice and call one of them a transcript.
   *
   * THE DIGEST MODE IS THE SAME CASE AS THE CHAPTERLESS ONE, for the same reason. Over the
   * direct-pass ceiling `ctx.content` is the chapter digest (chapter-digest.ts), and the
   * coverage block above is already that list of chapters with their details — so this slot goes
   * EMPTY. It is not that the transcript is missing and something has to stand in for it: the
   * coverage block IS the content on that path, exactly as it is on a text subject, and the one
   * thing this slot must never do is put a condensation under the heading "The transcript of the
   * video, in full". A description written from a digest labelled as the transcript is a
   * description whose model believes it has quotes it does not have.
   */
  private transcriptBlock(ctx: MetadataRunContext): string {
    if (ctx.chapterSubjects.length === 0) return '';
    if (ctx.contentMode === 'chapter-digest') return '';
    const content = (ctx.content || '').trim();
    if (content.length === 0) return '';
    return promptAssets().pipeline(DESCRIPTION_FILE, 'transcript_block').replace(/\{items\}/g, () => content);
  }

  /**
   * What the video covers, in whichever form this item actually has it.
   *
   * TWO SHAPES, both LABELLED, and the label is the point. The chapter list is a measured table
   * of contents — every line was written from its own span of the video — and the text subject
   * is one or two sentences the operator typed. A model told "chapter by chapter" about a
   * one-line subject would write as if it had detail it does not have; a model handed the
   * subject with no label at all would not know how much weight to give it.
   *
   * An item with NEITHER throws. The description has nothing to be written from, and producing
   * a paragraph anyway would be inventing the video.
   */
  private coverageBlock(ctx: MetadataRunContext): string {
    const assets = promptAssets();
    if (ctx.chapterSubjects.length > 0) {
      const items = ctx.chapterSubjects
        .map((subject, i) => {
          const detail = (ctx.chapterDetails[i] || '').trim();
          return detail ? `- ${subject}: ${detail}` : `- ${subject}`;
        })
        .join('\n');
      return assets
        .pipeline(DESCRIPTION_FILE, 'coverage_chapters')
        .replace(/\{items\}/g, () => items);
    }

    const subject = (ctx.content || '').trim();
    if (subject.length === 0) {
      throw new Error(
        `The description for ${ctx.sourceLabel} has nothing to write from: this item has no chapter ` +
          `list and no subject text. Nothing here invents one.`
      );
    }
    return assets.pipeline(DESCRIPTION_FILE, 'coverage_subject').replace(/\{items\}/g, () => subject);
  }
}

/** One whole description as this unit writes it: an opening line and the body that continues it. */
interface DescriptionCandidate {
  hook: string;
  /** What was still wrong with `hook` after the one re-ask — empty when the judge was satisfied. */
  hookFaults: string[];
  body: string;
  /** What was still wrong with `body` after the one re-ask — empty when the judge was satisfied. */
  bodyFaults: string[];
}

/** An answer and whatever its judge still had against it after the re-ask. */
interface JudgedText {
  text: string;
  faults: string[];
}

/**
 * Do two bodies start on the same sentence?
 *
 * BY MEANING RATHER THAN BY BYTES, to the extent that is cheap and honest: the comparison is on
 * the first sentence with case, punctuation and whitespace normalised away, so "The footage
 * brands Oliver a communist." and "the footage brands oliver a communist" are one opening. It
 * deliberately stops there. A real paraphrase check would need an embedding call per candidate
 * to catch two openings that say the same thing in different words, and the failure it would be
 * catching \u2014 a model that re-words its lead but keeps its angle \u2014 is one an operator can see for
 * himself in three descriptions he is already reading.
 */
function sameOpening(a: string, b: string): boolean {
  const normalize = (text: string) => {
    const match = text.match(/^[^.!?]+[.!?]?/);
    return (match ? match[0] : text)
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  };
  const left = normalize(a);
  return left.length > 0 && left === normalize(b);
}

/**
 * Why this candidate cannot be offered as a choice, or null because it can.
 *
 * AN OPTION MUST BE A DESCRIPTION, and that is the whole rule. The primary keeps a body its
 * judge still objects to, because the operator needs one and the alternative is none; an option
 * carries no such obligation, and a candidate that is not a description is strictly worse than
 * one fewer choice — he is picking between them, and one of them is not a thing he can pick.
 *
 * BOTH REASONS ARE MEASURED, AND BOTH WERE OBSERVED while building this, on qwen3.8:27b:
 *
 *   not description-length   the model returned "..." as an option's whole body, judged at 1
 *                            word against the channel's 60-200. Seen twice.
 *   stops mid-sentence       a 103-word body — comfortably inside the range, so the length judge
 *                            passed it — ending on "...primary win is framed as a battle against
 *                            a". Seen three times.
 *   opening line is not one  the hook call returned "..." as its entire answer, which is under
 *                            the character cap, has no describer clause and even ends on a full
 *                            stop. `judgeHook` now measures it (HOOK_MIN_WORDS) so the primary
 *                            re-asks rather than publishing it as a search snippet; an option
 *                            whose re-ask brings back the same thing is dropped here.
 *
 * The second is NOT the output ceiling being hit: ollama-json already fails a call outright on
 * `done_reason: "length"`, so these came back as completed answers that the model simply stopped
 * writing partway through a clause. Raising num_predict would not touch them, and a body that
 * does not end on a terminator is a fact about the answer rather than an opinion about it.
 *
 * WHAT DOES NOT DROP AN OPTION: register. That is a taste call, taste is exactly what the
 * operator is there for, and an option warned for register is still a description he can read
 * and choose.
 *
 * NEITHER CHECK LIVES IN `judgeBody`, deliberately. Putting them there would change what the
 * PRIMARY does — a new fault means a new re-ask on the call this app has measured most carefully
 * — and whether a truncated primary should warn is a real question for whoever owns that judge,
 * to be asked on its own evidence rather than as a side effect of adding options.
 */
function unusableReason(candidate: DescriptionCandidate): string | null {
  const shortHook = candidate.hookFaults.find((fault) => fault.startsWith(SHORT_HOOK_FAULT));
  if (shortHook) {
    return `its opening line ${shortHook}`;
  }
  const lengthFault = candidate.bodyFaults.find((fault) => fault.startsWith(LENGTH_FAULT));
  if (lengthFault) {
    return `${lengthFault}, and an alternative that is not the length of a description is not an alternative`;
  }
  if (!/[.!?]["\u2019\u201d')\]]?\s*$/.test(candidate.body)) {
    return `its body stops mid-sentence ("...${candidate.body.slice(-60).trim()}"), so the model did not finish writing it`;
  }
  return null;
}
