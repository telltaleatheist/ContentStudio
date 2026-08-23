/**
 * The description, as two small schema-constrained calls
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
 * FAILURE POLICY. A hook over the 150-character cap or prose in the wrong register is asked
 * for ONE more time and then KEPT AS WRITTEN with a declared warning on the run. Nothing here
 * truncates a hook, rewrites a sentence or fails an item over style: the operator curates, and
 * a silently shortened hook is a hook he never got to see. A TRANSPORT failure still throws —
 * it means the model is not there, which is not a style question.
 */

import axios, { AxiosInstance } from 'axios';
import * as log from 'electron-log';
import { askOllamaJson, estimateTokens } from './ollama-json';
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

/**
 * Spec §5's temperatures. Local only — `askOllamaJson` sends them as Ollama options, and
 * NOTHING sends a sampling parameter to a cloud provider (newer Claude and OpenAI models 400
 * on them, and the cloud branch below has no options block at all).
 */
const HOOK_TEMPERATURE = 0.4;
const BODY_TEMPERATURE = 0.2;

/**
 * Output budget per call.
 *
 * A hook is ~40 tokens and a body ~400, but these models reason first — the chapter work
 * measured 1,900-2,900 tokens of it — and `think: false` is not an option (ollama-json trap 2).
 * The schema is what is expected to keep this well under the ceiling; the ceiling is sized so
 * that a model which reasons anyway still finishes.
 */
const NUM_PREDICT = 4096;

const CALL_TIMEOUT_MS = 300_000;
const KEEP_ALIVE = '10m';

/**
 * Ollama's `format`: a full JSON Schema, not the bare "json" grammar (spec §5).
 *
 * NO `maxLength`, and this is a MEASUREMENT, not a preference. The spec proposes
 * `{"hook": string(maxLength 150)}`; Briefcase's live run reported the constraint as untested
 * because their hooks came in under it. This build's live run on qwen3.5:9b and qwen3.5:4b hit
 * it, and what it does is TRUNCATE THE DECODE: both models returned exactly 150 characters
 * ending mid-word ("... — Flashpoint's 202"). That is the server silently rewriting the one
 * line YouTube shows first, which is the thing this app's rules forbid above all others.
 *
 * So the schema constrains the SHAPE and the cap is enforced in code, where going over is a
 * declared warning on a whole sentence the operator can trim — not a fragment he cannot.
 */
const HOOK_SCHEMA = {
  type: 'object',
  properties: { hook: { type: 'string' } },
  required: ['hook'],
} as const;

const BODY_SCHEMA = {
  type: 'object',
  properties: { body: { type: 'string' } },
  required: ['body'],
} as const;

/**
 * The two prompts, read from prompts/shared/pipeline/description.yml.
 *
 * THE BODIES MOVED but nothing about them changed except one slot: the block naming what the
 * video covers used to be hardcoded as "What the video covers, chapter by chapter:" followed by
 * the chapter list. It is now `{coverage}`, filled from the asset with whichever of two labelled
 * blocks fits the item — the chapter list where the pipeline produced one, the operator's text
 * subject where it did not. That is what lets a chapterless item write its description here
 * instead of taking a whole-metadata call on some other model.
 *
 * Getters, so a missing file or key throws naming both at the moment the prompt is wanted, and
 * the character and word budgets are substituted from THIS FILE'S constants — the number the
 * prompt asks for and the number the code measures cannot drift apart.
 */
export const DESCRIPTION_PROMPTS = {
  get HOOK(): string {
    return promptAssets()
      .pipeline(DESCRIPTION_FILE, 'hook')
      .replace(/\{hookTargetChars\}/g, () => String(HOOK_TARGET_CHARS));
  },
  get BODY(): string {
    return promptAssets().pipeline(DESCRIPTION_FILE, 'body');
  },
  get BODY_REVISION(): string {
    return promptAssets().pipeline(DESCRIPTION_FILE, 'body_revision');
  },
};

const DESCRIPTION_FILE = 'description.yml';

/** The two fields this unit owns. `description` is the BODY; the hook is its own field. */
const DESCRIPTION_FIELDS: MetadataFieldId[] = ['description_hook', 'description'];

/**
 * The description unit: two calls, one field pair, either transport.
 *
 * ONE class for local and cloud rather than two, which is the opposite of how the prompt-set
 * groups are built (CloudGroupUnit / LocalGroupUnit) — and deliberately, because the
 * difference here is four lines rather than a prompt shape. The prompts are identical, the
 * inputs are identical, and the only divergence is that the local branch sends a JSON Schema
 * and two temperatures while the cloud branch sends neither.
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
      this.host = option.host || defaultHost;
      this.client = axios.create({ baseURL: this.host });
      this.label = `description hook + body (local ${option.model} @ ${this.host})`;
      // The larger of the two prompts is what this unit needs of the window. They differ by a
      // few hundred characters — both carry the same transcript — so this is nearly the same
      // number twice, and taking the max means it cannot be the smaller one by accident.
      budget.register('description', (ctx) =>
        estimateTokens(
          Math.max(
            this.buildPrompt(DESCRIPTION_PROMPTS.HOOK, ctx, hookPending()).length,
            this.buildPrompt(DESCRIPTION_PROMPTS.BODY, ctx, hookPending()).length
          )
        ) + NUM_PREDICT
      );
    } else {
      this.label = `description hook + body (cloud ${option.model})`;
    }
  }

  describePrompt(ctx: MetadataRunContext): string {
    return (
      `# DESCRIPTION HOOK (${this.option.model}, ` +
      `${this.option.kind === 'local' ? `schema-constrained, temperature ${HOOK_TEMPERATURE}` : 'JSON, provider defaults'})\n\n` +
      this.buildPrompt(DESCRIPTION_PROMPTS.HOOK, ctx, hookPending()) +
      `\n\n# DESCRIPTION BODY (${this.option.model}, ` +
      `${this.option.kind === 'local' ? `schema-constrained, temperature ${BODY_TEMPERATURE}` : 'JSON, provider defaults'})\n\n` +
      this.buildPrompt(DESCRIPTION_PROMPTS.BODY, ctx, hookPending())
    );
  }

  async generate(ctx: MetadataRunContext): Promise<Record<string, unknown>> {
    const hook = await this.writeHook(ctx);
    const body = await this.writeBody(ctx, hook);
    return { description_hook: hook, description: body };
  }

  // ------------------------------------------------------------------------ the two calls

  /**
   * The hook, with the character cap enforced HERE as well as in the schema.
   *
   * §5 is explicit that a schema `maxLength` constrains decoding but must not be trusted as a
   * display limit — so the cap is measured on the answer. Over it, the call is made ONCE more;
   * still over, the long hook is KEPT and the run says so. Truncating it would produce a
   * sentence the model did not write, ending mid-clause, in the one line YouTube shows first.
   */
  private async writeHook(ctx: MetadataRunContext): Promise<string> {
    const prompt = this.buildPrompt(DESCRIPTION_PROMPTS.HOOK, ctx, hookPending());
    const first = await this.ask(prompt, 'hook', HOOK_SCHEMA, HOOK_TEMPERATURE, ctx);
    const faults = this.judgeHook(first);
    if (faults.length === 0) return first;

    const second = await this.ask(prompt, 'hook (second attempt)', HOOK_SCHEMA, HOOK_TEMPERATURE, ctx);
    if (this.judgeHook(second).length === 0) {
      log.info(`[Description] ${ctx.sourceLabel}: re-asked for the hook (${faults.join('; ')}); the second answer holds`);
      return second;
    }

    ctx.warn(
      `the description hook was asked for twice and both times ${faults.join(' and ')}; it is kept exactly as ` +
        `the model wrote it ("${first}") and nothing was shortened or reworded`
    );
    return first;
  }

  private judgeHook(hook: string): string[] {
    const faults: string[] = [];
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
   * The body. Same one-re-ask policy, measured on word count and register.
   *
   * The word count is a SPEC RANGE, not a hard limit — a 310-word body is a warning, not a
   * failure, and it publishes.
   */
  private async writeBody(ctx: MetadataRunContext, hook: string): Promise<string> {
    const prompt = this.buildPrompt(DESCRIPTION_PROMPTS.BODY, ctx, hook);
    const first = await this.ask(prompt, 'body', BODY_SCHEMA, BODY_TEMPERATURE, ctx);
    const firstFaults = this.judgeBody(first, ctx);
    if (firstFaults.length === 0) return first;

    // A register fault gets a REVISION, not a re-roll: the same prompt asked twice returned
    // the same register twice, on two measured runs. The revision call hands the model its own
    // draft and the judged clauses, which is an edit it can actually perform. A fault that is
    // only the word count keeps the plain re-ask, where fresh dice are the right tool.
    const narratedFirst = describerClauses(first);
    const secondPrompt =
      narratedFirst.length > 0
        ? this.buildPrompt(DESCRIPTION_PROMPTS.BODY_REVISION, ctx, hook, {
            body: first,
            clauses: narratedFirst.map((clause) => `- "${clause}"`).join('\n'),
          })
        : prompt;
    const what = narratedFirst.length > 0 ? 'body (revision)' : 'body (second attempt)';
    const second = await this.ask(secondPrompt, what, BODY_SCHEMA, BODY_TEMPERATURE, ctx);
    const secondFaults = this.judgeBody(second, ctx);
    if (secondFaults.length === 0) {
      log.info(`[Description] ${ctx.sourceLabel}: re-asked for the body (${firstFaults.join('; ')}); the second answer holds`);
      return second;
    }

    // Both faulty: the answer with fewer describer clauses is the closer one, and a tie keeps
    // the first, which is the answer the plain prompt produced.
    const keepSecond = describerClauses(second).length < narratedFirst.length;
    const kept = keepSecond ? second : first;
    const keptFaults = keepSecond ? secondFaults : firstFaults;
    ctx.warn(
      `the description body was asked for twice and both times ${keptFaults.join(' and ')}; the ` +
        `${keepSecond ? 'revised second' : 'first'} answer is kept exactly as the model wrote it and nothing was reworded`
    );
    return kept;
  }

  private judgeBody(body: string, ctx: MetadataRunContext): string[] {
    const faults: string[] = [];
    const [min, max] = bodyWordRange(this.channel(ctx));
    const words = body.split(/\s+/).filter(Boolean).length;
    if (words < min || words > max) {
      faults.push(`it ran to ${words} words against the ${min}-${max} word body this channel asks for`);
    }
    const narrated = describerClauses(body);
    if (narrated.length > 0) {
      const shown = narrated.map((clause) => `"${clause.length > 60 ? `${clause.slice(0, 57)}...` : clause}"`);
      faults.push(`it wrote about someone covering the subject rather than about the subject (${shown.join('; ')})`);
    }
    return faults;
  }

  // --------------------------------------------------------------------------- transports

  private async ask(
    prompt: string,
    what: string,
    schema: Record<string, unknown>,
    temperature: number,
    ctx: MetadataRunContext
  ): Promise<string> {
    const key = Object.keys(schema.properties as Record<string, unknown>)[0];
    const value = this.client
      ? await this.askLocal(prompt, what, schema, temperature, ctx)
      : await this.aiManager.runJsonRequest(prompt, this.option.model, `the description ${what} for ${ctx.sourceLabel}`);

    const answer = value[key];
    if (typeof answer !== 'string' || answer.trim().length === 0) {
      throw new Error(
        `The description ${what} for ${ctx.sourceLabel} on "${this.option.model}" came back with no "${key}" ` +
          `(got: ${JSON.stringify(value).slice(0, 200)})`
      );
    }
    return answer.trim();
  }

  private async askLocal(
    prompt: string,
    what: string,
    schema: Record<string, unknown>,
    temperature: number,
    ctx: MetadataRunContext
  ): Promise<Record<string, unknown>> {
    // One num_ctx for the whole MODEL for the whole RUN (ollama-json trap 4) — not one per
    // unit. Resolved by the first call on this model to run, from the largest prompt it will
    // send, and shared from there.
    const numCtx = this.budget!.resolve(ctx);

    const result = await queueAITask(
      `description-${this.option.model}-${ctx.sourceLabel}-${what}`,
      `Metadata: ${this.label} — ${what}`,
      async () => {
        if (this.abortSignal?.aborted) throw new JobCancelledError('cancelled before the description call ran');
        const answer = await askOllamaJson(this.client!, {
          model: this.option.model,
          prompt,
          numCtx,
          numPredict: NUM_PREDICT,
          temperature,
          schema,
          keepAlive: KEEP_ALIVE,
          timeoutMs: CALL_TIMEOUT_MS,
          signal: this.abortSignal,
          what: `the description ${what} for ${ctx.sourceLabel}`,
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
        `The description ${what} for ${ctx.sourceLabel} on "${this.option.model}" produced no usable answer ` +
          `(${result.reason}): ${result.detail}`
      );
    }
    return result.value;
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
      pools: pools || '(none)',
      // The channel's `## DESCRIPTION` section, whole. See the note at the top of this file and
      // the one in shared/pipeline/description.yml for what withholding it measured out at.
      rules: assets
        .pipeline(DESCRIPTION_FILE, 'rules_block')
        .replace(/\{items\}/g, () => assets.fieldSection(channel, 'description')),
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
      /\{(channel|video|coverage|transcript|pools|rules|hook|hookTargetChars|bodyMinWords|bodyMaxWords|body|clauses)\}/g,
      (_match, key: string) => slots[key]
    );
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
   */
  private transcriptBlock(ctx: MetadataRunContext): string {
    if (ctx.chapterSubjects.length === 0) return '';
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

/**
 * What the `{hook}` slot carries where the hook does not exist yet.
 *
 * TWO CALLERS, both of which assemble the body prompt before any call has run: the "Show
 * prompt" preview and the context-window estimate. Neither can be given the real hook, and
 * neither is a run — a real run writes the hook first and hands it to `writeBody`. The line
 * says so, in the assets, rather than leaving an empty pair of quotes that reads as a hook the
 * model was asked to continue from.
 */
function hookPending(): string {
  return promptAssets().pipeline(DESCRIPTION_FILE, 'hook_pending');
}


