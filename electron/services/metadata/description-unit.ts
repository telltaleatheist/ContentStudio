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
 * WHAT THEY READ, AND WHAT THEY DO NOT. Inputs are the chapter titles and summaries, the
 * entity pool and the key-phrase pool. NOT the raw transcript — the whole point of §2 is that
 * this layer runs on already-extracted inputs, which is what makes it viable on a 4b at all.
 *
 * WHAT THEY DO NOT CARRY, stated because it is a real editorial cost and a deliberate one:
 * the channel yml's `## DESCRIPTION` section. That section is written for the LEGACY
 * single-call path — two paragraphs, a soft CTA, a banned-phrase list, a voice note — and
 * loading fifteen editorial bullets onto a schema-constrained 4b is exactly the
 * over-specification §5 says these calls exist to avoid. The channel still reaches these
 * prompts, as the channel NAME in the context line. The legacy path's DESCRIPTION section is
 * untouched and still runs for items with no chapters.
 *
 * FAILURE POLICY. A hook over the 150-character cap or prose in the wrong register is asked
 * for ONE more time and then KEPT AS WRITTEN with a declared warning on the run. Nothing here
 * truncates a hook, rewrites a sentence or fails an item over style: the operator curates, and
 * a silently shortened hook is a hook he never got to see. A TRANSPORT failure still throws —
 * it means the model is not there, which is not a style question.
 */

import axios, { AxiosInstance } from 'axios';
import * as log from 'electron-log';
import { askOllamaJson, bucketNumCtx, estimateTokens, unloadOllamaModels } from './ollama-json';
import { MetadataRoutingOption } from './metadata-routing';
import { queueAITask } from '../queue-manager.service';
import { JobCancelledError } from './cancellation';
import { narratesAnActor } from './chapter-title-quality';
import type { MetadataFieldId, MetadataRunContext, MetadataUnit } from './metadata-tasks';
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
 * Spec §1.2: shorter than this is not a body, longer stops being read.
 *
 * A TARGET, checked in code, because a big model ignores it in the prompt — Briefcase measured
 * a 27b writing 353 words against this exact instruction while a 4b hit 211 naturally. Over or
 * under is a DECLARED WARNING and the paragraph publishes as written; nothing here truncates a
 * body to fit a number.
 */
export const BODY_MIN_WORDS = 150;
export const BODY_MAX_WORDS = 300;

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

/** Inputs are summaries, so the prompt is small; the ceiling is generous, not tight. */
const CTX_MAX = 16384;

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
 * The hook prompt.
 *
 * POSITIVE FORM ONLY, and correct examples only — the operator's standing ruling, for the
 * same measured reason it applies to the chapter prompts: a model shown a wrong form
 * reproduces it, and attaching the word "never" to it does not change that. The register this
 * wants is stated as what to write, and the example is the spec's own worked one (§6.4), which
 * is a real hook for a real video at 141 characters.
 */
export const DESCRIPTION_PROMPTS = {
  HOOK: `Write the opening line of a YouTube description. Output JSON only.

Channel: {channel}
Video: {video}

What the video covers, chapter by chapter:
{chapters}

Names and phrases from the video, to draw on where they fit:
{pools}

Write one complete sentence, ending in a full stop, of at most ${HOOK_TARGET_CHARS} characters. Name the two or three things above that would draw a viewer in — not all of them — and put the words somebody would type into search at the front. The names go in as parts of noun phrases, a possessive or an object, so the sentence is about the claim, the event or the argument itself.

Hooks in exactly the right form:
"Iran ceasefire collapse, Byron Donalds's projected win in Florida, and the 29-state lawsuit against Meta."
"Gene Bailey's misreading of Luke 19:13 and the David and Goliath framing behind his call to occupy territory."

Output exactly this shape and nothing else:
{"hook": "..."}`,

  BODY: `Write the body paragraph of a YouTube description. Output JSON only.

Channel: {channel}
Video: {video}

What the video covers, chapter by chapter:
{chapters}

Names and phrases from the video, to draw on where they fit:
{pools}

Write one paragraph of ${BODY_MIN_WORDS} to ${BODY_MAX_WORDS} words that walks through what the video covers in order. Every name you use comes from the chapter summaries above, and the names go in as parts of noun phrases — a possessive or an object, so the sentence is about the claim, the refusal or the argument itself. Where a summary describes somebody responding to something, write the claim and the response as content: "the bridge contract claim, rebutted", "Jack Hibbs's First Amendment argument and the constitutional answer to it".

Openings in exactly the right form:
"Debate about Trump's refusal to extend the Iran ceasefire MOU and rising tensions in the Strait of Hormuz, then the Florida results and Byron Donalds's projected win."
"Gene Bailey's misreading of Luke 19:13, his call to occupy territory, and the David and Goliath framing behind it."
"Paul Petit's report on the 29-state lawsuit against Meta, and the panel's disagreement over what it means for teenagers."

No links, no timestamps, no calls to subscribe: the chapter block and the standing links are assembled by code afterwards.

Output exactly this shape and nothing else:
{"body": "..."}`,
};

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

  private readonly client?: AxiosInstance;
  private readonly host?: string;
  private numCtx?: number;
  private loaded = false;

  constructor(
    private readonly aiManager: AIManagerService,
    private readonly option: MetadataRoutingOption,
    defaultHost: string,
    private readonly abortSignal?: AbortSignal
  ) {
    if (option.kind === 'local') {
      this.host = option.host || defaultHost;
      this.client = axios.create({ baseURL: this.host });
      this.label = `description hook + body (local ${option.model} @ ${this.host})`;
    } else {
      this.label = `description hook + body (cloud ${option.model})`;
    }
  }

  describePrompt(ctx: MetadataRunContext): string {
    return (
      `# DESCRIPTION HOOK (${this.option.model}, ` +
      `${this.option.kind === 'local' ? `schema-constrained, temperature ${HOOK_TEMPERATURE}` : 'JSON, provider defaults'})\n\n` +
      this.buildPrompt(DESCRIPTION_PROMPTS.HOOK, ctx) +
      `\n\n# DESCRIPTION BODY (${this.option.model}, ` +
      `${this.option.kind === 'local' ? `schema-constrained, temperature ${BODY_TEMPERATURE}` : 'JSON, provider defaults'})\n\n` +
      this.buildPrompt(DESCRIPTION_PROMPTS.BODY, ctx)
    );
  }

  async generate(ctx: MetadataRunContext): Promise<Record<string, unknown>> {
    const hook = await this.writeHook(ctx);
    const body = await this.writeBody(ctx);
    return { description_hook: hook, description: body };
  }

  async unload(): Promise<void> {
    if (!this.loaded || !this.client) return;
    await unloadOllamaModels(this.client, [this.option.model], `[Description] ${this.label}`);
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
    const prompt = this.buildPrompt(DESCRIPTION_PROMPTS.HOOK, ctx);
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
    if (narratesAnActor(hook).narrated) {
      faults.push('it was written about someone covering the subject rather than about the subject');
    }
    return faults;
  }

  /**
   * The body. Same one-re-ask policy, measured on word count and register.
   *
   * The word count is a SPEC RANGE, not a hard limit — a 310-word body is a warning, not a
   * failure, and it publishes.
   */
  private async writeBody(ctx: MetadataRunContext): Promise<string> {
    const prompt = this.buildPrompt(DESCRIPTION_PROMPTS.BODY, ctx);
    const first = await this.ask(prompt, 'body', BODY_SCHEMA, BODY_TEMPERATURE, ctx);
    const faults = this.judgeBody(first);
    if (faults.length === 0) return first;

    const second = await this.ask(prompt, 'body (second attempt)', BODY_SCHEMA, BODY_TEMPERATURE, ctx);
    if (this.judgeBody(second).length === 0) {
      log.info(`[Description] ${ctx.sourceLabel}: re-asked for the body (${faults.join('; ')}); the second answer holds`);
      return second;
    }

    ctx.warn(
      `the description body was asked for twice and both times ${faults.join(' and ')}; it is kept exactly as ` +
        `the model wrote it and nothing was reworded`
    );
    return first;
  }

  private judgeBody(body: string): string[] {
    const faults: string[] = [];
    const words = body.split(/\s+/).filter(Boolean).length;
    if (words < BODY_MIN_WORDS || words > BODY_MAX_WORDS) {
      faults.push(`it ran to ${words} words against the ${BODY_MIN_WORDS}-${BODY_MAX_WORDS} word body`);
    }
    if (narratesAnActor(firstSentence(body)).narrated) {
      faults.push('it opened by writing about someone covering the subject rather than about the subject');
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
    // One num_ctx for this unit's life (ollama-json trap 4). Both prompts are the same size
    // to within a few hundred characters, so the first one sizes both.
    if (this.numCtx === undefined) {
      this.numCtx = bucketNumCtx({
        promptTokens: estimateTokens(prompt.length),
        numPredict: NUM_PREDICT,
        max: CTX_MAX,
        logPrefix: `[Description] ${this.label}`,
        what: `the description calls for ${ctx.sourceLabel}`,
      });
    }

    const result = await queueAITask(
      `description-${this.option.model}-${ctx.sourceLabel}-${what}`,
      `Metadata: ${this.label} — ${what}`,
      async () => {
        if (this.abortSignal?.aborted) throw new JobCancelledError('cancelled before the description call ran');
        const answer = await askOllamaJson(this.client!, {
          model: this.option.model,
          prompt,
          numCtx: this.numCtx!,
          numPredict: NUM_PREDICT,
          temperature,
          schema,
          keepAlive: KEEP_ALIVE,
          timeoutMs: CALL_TIMEOUT_MS,
          signal: this.abortSignal,
          what: `the description ${what} for ${ctx.sourceLabel}`,
          logPrefix: `[Description] ${this.label}`,
        });
        this.loaded = true;
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

  private buildPrompt(template: string, ctx: MetadataRunContext): string {
    const chapters = ctx.chapterSubjects
      .map((subject, i) => {
        const detail = (ctx.chapterDetails[i] || '').trim();
        return detail ? `- ${subject}: ${detail}` : `- ${subject}`;
      })
      .join('\n');

    const pools = [
      ctx.entities.length > 0 ? `Names: ${ctx.entities.join(', ')}` : '',
      ctx.keyPhrases.length > 0 ? `Phrases: ${ctx.keyPhrases.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    // `chapters` and `pools` are substituted before the free text they contain can be read as
    // a placeholder, and nothing after them re-runs the substitution.
    return template
      .replace(/\{channel\}/g, () => ctx.promptSetName)
      .replace(/\{video\}/g, () => ctx.videoTitle || ctx.sourceLabel)
      .replace(/\{chapters\}/g, () => chapters || '(none)')
      .replace(/\{pools\}/g, () => pools || '(none)');
  }
}

function firstSentence(text: string): string {
  const match = text.match(/^[^.!?]+[.!?]?/);
  return (match ? match[0] : text).trim();
}
