/**
 * Per-field metadata generation
 *
 * ONE CALL PER FIELD. The metadata request was one call returning every field; then it was one
 * call per MODEL, grouping whatever the routing pointed at the same place; it is now one call
 * per FIELD, and each call returns ONE key.
 *
 * WHY THE GROUPING WENT (measured, not theorised — prompt-artifacts/README.md):
 *
 *   - The 4-field group call on qwen3.8:27b DROPPED A KEY in 1 of 6 runs. The unit correctly
 *     refused the answer, which means one run in six produced no metadata at all. A single-key
 *     schema has nowhere for that failure to happen: the grammar itself requires the key.
 *   - The older 7-field call wrote a TITLE IN THUMBNAIL VOICE — run 3's tenth "title" came back
 *     as `FOURTH JET`, ten characters, all caps, because the same object was carrying the
 *     thumbnail options. A call asked for seven fields at once writes some of them in another
 *     field's voice.
 *
 * What grouping bought was cross-field coherence: a model that wrote both the titles and the
 * thumbnail text could be told "the thumbnail must not repeat a core word from your top 3
 * titles". That is preserved WITHOUT the grouping, by ORDERING and INPUT DATA — titles run
 * first, and the thumbnail call is handed the ten titles as input. The rule is followable
 * because the model can read the titles, not because it happened to write them.
 *
 * WHAT EACH CALL CARRIES: the editorial core with the channel's focus, THAT FIELD'S instruction
 * section and no other, the self-check lines that field can actually perform, the measured
 * chapter subjects and their detail, the RAW TRANSCRIPT (ai-manager.service.ts direct-passes it
 * now rather than summarizing by default; over the ceiling it is the chapter digest and the
 * subject block drops the duplicate table of contents), the insights block where it belongs, any earlier
 * field's answer it needs as input data, and an OUTPUT FORMAT naming exactly one key.
 *
 * ONE SHAPE, and it is not local-vs-cloud. Every field call — local or cloud — is the
 * prompt-set shape: that field's yml section, its self-check, the transcript, and a plain-text
 * output contract. LocalFieldUnit posts to Ollama through plain-call.ts; CloudFieldUnit posts
 * through the AI manager's plain transport. They build their prompt with the same builder and
 * read their answer through the same parser. The only difference is transport.
 *
 * THERE USED TO BE A SECOND SHAPE: the trained adapters (`promptStyle: 'adapter'`), fine-tuned
 * models fed a terse `task:`/`format:` turn with the brief baked into their weights. They were
 * RETIRED 2026-08-25 by operator decision — the prompted models replaced them — and the whole
 * mechanism went with them: the turn builders, LocalAdapterUnit, its MLX-shim spawn client, and
 * adapters.yml. A stored routing that still names one fails loudly (metadata-routing.ts's
 * REMOVED_ROUTING_OPTIONS), which is the point: silently running a different model than the
 * setting names is the failure this build refuses to have.
 *
 * TWO LOCAL MODELS IS THE BUDGET. Per-field calls make it trivially easy to have a run load
 * five models, and every load is a multi-GB stall. planMetadataUnits computes the roster of
 * distinct local models a run will make resident — the units' and the chapter pipeline's; the
 * summarizer used to be a third and is no longer on this path — logs it every run, and
 * declares a loud warning naming the responsible fields
 * when it exceeds two. It does not block: which model writes which field is the operator's
 * choice, and a silently overridden routing selection would be worse than a slow run.
 *
 * ONE num_ctx PER MODEL PER RUN. Ollama FULLY RELOADS a model on any num_ctx change
 * (ollama-json.ts trap 4), so per-call sizing would reload the 27B between titles and
 * thumbnails and again before the pinned comment. Every unit on a model shares one
 * `ModelRunContextBudget`, sized from the LARGEST prompt that model will send this run, and the
 * budget cannot size BELOW a window the job has already made resident on that model
 * (model-lifecycle.ts's ratchet) — the chapter stage runs first on the same hardware.
 *
 * NO UNIT RELEASES A MODEL. Every unit here used to unload its model as it finished, which
 * reloaded ~17GB of weights for the next call on the same model and froze the operator's
 * machine while it did. A unit DECLARES what it made resident to the job's `JobModelLifecycle`
 * and the JOB releases the set once, in a finally in metadata-generator.service.ts. That is why
 * there is no `unload()` on the unit seam any more: a per-stage release is the defect.
 */

import axios, { AxiosInstance } from 'axios';
import * as log from 'electron-log';
import { SYSTEM_PROMPTS, formatPrompt } from './system-prompts';
import { queueAITask } from '../queue-manager.service';
import { JobCancelledError, isAbortError } from './cancellation';
import { bucketNumCtx, estimateTokens } from './ollama-json';
import { askOllamaPlain, parseLines } from './plain-call';
import { DigestChapter } from './chapter-digest';
import { JobModelLifecycle } from './model-lifecycle';
import {
  CHAPTER_PIPELINE_MODELS,
  KEY_PHRASE_EMBEDDING_MODEL,
  METADATA_ROUTING_OPTIONS,
  MetadataRoutingOption,
  MetadataRoutingTaskId,
  ResolvedMetadataRouting,
} from './metadata-routing';
import { DESCRIPTION_FIELDS, DescriptionUnit } from './description-unit';
import {
  assembleTags,
  buildHashtags,
  hashtagLine,
  unusableTagList,
  GENERATED_TAG_BUDGET_CHARS,
} from './tags-hashtags';
import { promptAssets } from './prompt-assets';
import { groundViewerTitle } from './chapter-title-quality';
import { stripSpeakerPrefixes } from './transcript-import.service';
// Type-only: the units receive an AIManagerService instance, they never construct one.
// A value import here would close an import cycle (ai-manager imports this module for
// its section parser) and break at require() time.
import type { AIManagerService, MetadataResult } from './ai-manager.service';
// Type-only for the same reason, one link further round: chapter-digest.ts imports the ceiling
// from ai-manager.service, which imports this module.
import type { FieldContentMode } from './chapter-digest';

/**
 * A metadata field a unit can be responsible for.
 *
 * `hashtags`, `tags` and `spoken_keywords` are not routable tasks in the chaptered path.
 * Hashtags and tags are ASSEMBLED IN CODE from the entity and key-phrase pools (spec §4,
 * §6.2, §6.3 — tags-hashtags.ts); spoken keywords exist only in the shorts prompt set and
 * ride with whichever group absorbs the sections no unit claimed.
 *
 * `description_hook` is the first ~150 characters of the description, generated as its own
 * call by DescriptionUnit and stored as its own field so the composer can put it above the
 * chapter block (spec §3's ruled order) without parsing it back out of the description.
 */
export type MetadataFieldId =
  | 'titles'
  | 'description'
  | 'description_hook'
  | 'description_options'
  | 'tags'
  | 'thumbnail_text'
  | 'pinned_comment'
  | 'hashtags'
  | 'spoken_keywords';

/**
 * The routable tasks that get their own call on EVERY run, IN THE ORDER THEY RUN.
 *
 * TITLES ARE FIRST AND THAT IS A CONTRACT, not a preference: the thumbnail call is handed the
 * titles as input data so that "don't repeat a core word from the top 3 titles" is a rule about
 * text it can read. Everything after titles is independent of everything else after titles.
 *
 * `description` is absent because it is not a one-key field call: it is DescriptionUnit's two
 * schema-constrained calls, planned separately below off the same `description` routing entry.
 *
 * `tags` is absent because its ownership depends on the item, not on the build: an item with
 * chapters has them assembled in code from pools measured against the chapter list, and an item
 * without chapters has them written by a model. planMetadataUnits appends the tags task to this
 * list for the second kind of item, which is the only difference between the two plans.
 */
const FIELD_TASKS: Array<{ task: MetadataRoutingTaskId; field: MetadataFieldId }> = [
  { task: 'titles', field: 'titles' },
  { task: 'thumbnail_text', field: 'thumbnail_text' },
  { task: 'pinned_comment', field: 'pinned_comment' },
];

/**
 * Everything a unit needs about the ITEM. Which model, which fields and which sections
 * are properties of the unit itself, decided once when the run is planned.
 */
export interface MetadataRunContext {
  /**
   * WHAT EVERY CALL READS, in whichever of the two declared forms this item has it.
   *
   * Raw, in the ordinary case: ai-manager.service.ts direct-passes anything at or under the
   * applicable DIRECT_PASS_MAX_CHARS ceiling, so what reaches a titles call is the words the
   * video actually said, byte for byte. Over the ceiling it is the CHAPTER DIGEST — the chapter
   * list with each chapter's own detail paragraph (chapter-digest.ts). Never a blind summary:
   * the transcript summarizer was retired from this path on 2026-08-23 and survives only in
   * compilation mode, which never builds one of these contexts.
   *
   * `contentMode` says which, and it is a FIELD rather than something inferred from the length,
   * because two readers have to agree about it (Law 10): the subject block skips the separate
   * chapter table of contents when the content already IS one, and the description's
   * `{transcript}` slot stays empty rather than labelling a digest as the video's own words.
   */
  content: string;
  contentMode: FieldContentMode;
  sourceLabel: string;
  chapterSubjects: string[];
  /**
   * The per-chapter SUMMARIES, index-aligned with chapterSubjects; entries may be blank.
   *
   * These are the embedding pipeline's stage-6 threaded summaries, carried straight through
   * (ChapterPipelineResult.subjectDetails[].detail). They are the description layer's primary
   * input per spec §2 — "none of this needs to read the raw transcript" — so the same prose
   * that already reaches the report's chapter `detail` is what the hook and body are written
   * from. Nothing new is computed to get them here.
   */
  chapterDetails: string[];
  /**
   * The digest form of the published chapters (timestamp, title, detail), for a call that
   * reads the video in chapter form BY CHOICE rather than because the transcript was over
   * the ceiling. The titles call does (2026-08-24: titles written from chapters matched the
   * transcript-fed titles on every hard check at a third less prompt); a chapterless item
   * carries an empty list here, and such a call falls back to the transcript it always read.
   */
  digestChapters: DigestChapter[];
  /** The video's title or filename. Context seeding for the description calls (spec §6.1 lever 2). */
  videoTitle: string;
  /** The loaded prompt set, which in this app IS the channel. */
  promptSetName: string;
  /**
   * Proper nouns measured out of the CONTENT text (entity-extraction.ts), best-first.
   *
   * One extraction, three consumers — the description prompts, the assembled tags and the
   * derived hashtags — so those three cannot disagree about who the video is about.
   */
  entities: string[];
  /** Key phrases ranked against the content text (key-phrases.ts), best-first. */
  keyPhrases: string[];
  /**
   * The app's CONTENT text: the ad-free editor transcript when one is linked, the final
   * export's otherwise (`contentTextOf`). Tag assembly tests every candidate against it,
   * because YouTube reads a tag that is not in the content as a spam signal (spec §6.2).
   */
  contentText: string;
  /**
   * Whether the CONTENT text above is rendered in screenplay form with a speaker label on every
   * turn (`HOST:`, `CLIP:`, `UNSURE:`).
   *
   * Measured, not assumed: it is `segmentsCarrySpeakerAttribution` over the item's own segments,
   * which is the same test `buildContentText` uses to decide whether to emit the labels at all.
   * So this is true exactly when the labels are in the text, and a prompt gated on it can never
   * explain tags to a call that was not shown any — or, worse, leave a call reading them with no
   * idea what they mean, which is the case that produced "Fox News frames the 13th Amendment's
   * prisoner exception as..." about a passage the host was speaking.
   *
   * False on a text subject, on an untagged Whisper run, and on a tagged video where every
   * caption came out the same side (nothing to tell apart, so nothing is labelled).
   */
  contentSpeakerTagged: boolean;
  /**
   * Fields written by EARLIER units in this run, keyed by field id.
   *
   * Filled by runMetadataTasks as each unit returns, and read by the units whose spec declares
   * `inputFields` — today that is the thumbnail call reading the titles. It is what makes a
   * cross-field rule followable now that no two fields share a call.
   *
   * A unit that needs an input which is not here THROWS rather than carrying on: the plan
   * orders the units so that it is there, so its absence is a planning bug, not a condition to
   * be handled.
   */
  generated: Record<string, unknown>;
  /**
   * Record a DECLARED degradation on the run. Units call it for the things that are a
   * warning rather than a failure — a hook over the character cap, prose in the wrong
   * register — and the caller pushes them into the job's warnings alongside the chapter
   * pipeline's own.
   */
  warn: (message: string) => void;
}

export interface MetadataUnit {
  /** For logs and the "Show prompt" banner, e.g. `titles (local qwen3.8:27b @ …)`. */
  readonly label: string;
  /** The metadata keys this unit is responsible for returning. One, for a field call. */
  readonly fields: MetadataFieldId[];
  /**
   * Fields written EARLIER in this run that this unit READS (never writes).
   *
   * Declared on the unit and not only inside its spec so the ordering property can be checked
   * without running anything: a plan where a unit's input is written after it is a plan that
   * will throw halfway through a job. Empty for every unit that reads only the transcript.
   */
  readonly inputFields: MetadataFieldId[];
  /**
   * The exact text this unit would send. The "Show prompt" flow exists to let the user
   * read what will actually be sent, so a unit that cannot show its request must refuse
   * here for the same reason it would refuse to run.
   */
  describePrompt(ctx: MetadataRunContext): string;
  /** Resolves to only the fields this unit owns. */
  generate(ctx: MetadataRunContext): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Section parsing
// ---------------------------------------------------------------------------

export interface InstructionSection {
  /** Header normalized for lookup: uppercased, trailing parenthetical dropped, spaces to underscores. */
  key: string;
  /** Header text exactly as the prompt set wrote it. */
  header: string;
  /** The section verbatim, header line included. */
  text: string;
}

/**
 * Split a prompt set's instructions_prompt on its `## ` headers.
 *
 * The YAMLs are user-editable and their headers are not a fixed vocabulary: one prompt
 * set writes `## TAGS`, another `## TAGS (SPREAKER)`, another `## SPOKEN KEYWORDS`. The
 * key is normalized so a task can find its section without the YAML having to change,
 * and the section text is carried through byte-for-byte so nothing is reworded on the
 * way to the model.
 */
export function parseInstructionSections(instructions: string): InstructionSection[] {
  const lines = instructions.split('\n');
  const headerIndexes: number[] = [];
  lines.forEach((line, i) => {
    if (/^##\s+\S/.test(line)) headerIndexes.push(i);
  });

  return headerIndexes.map((start, n) => {
    const end = n + 1 < headerIndexes.length ? headerIndexes[n + 1] : lines.length;
    const header = lines[start].replace(/^##\s+/, '').trim();
    return {
      key: canonicalSectionKey(header),
      header,
      text: lines.slice(start, end).join('\n').replace(/\s+$/, ''),
    };
  });
}

function canonicalSectionKey(header: string): string {
  return header
    .replace(/\([^)]*\)\s*$/, '') // "TAGS (SPREAKER)" and "TAGS" are the same section
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
}

/**
 * Each field's prompt-set section and the PLAIN output shape its call answers in.
 *
 * `output` is the whole wire contract now (operator's ruling 2026-08-24: no JSON for these
 * calls unless absolutely necessary): `lines` is one option per line, `comma-line` is the tag
 * list's one comma-separated line. The single-key JSON schemas this table used to carry are
 * gone with the JSON — a plain answer has no key to drop, which was the one failure the
 * grammar was keeping out.
 *
 * `description`, `description_hook` and `description_options` are never field calls — they are
 * DescriptionUnit's own hook/blank-line/body answer — and `hashtags` is code-owned; their
 * entries exist so the field ids have one registry and the section lookups one home.
 *
 * `needsTranscript` is GONE, and its absence is the change. It used to say that description,
 * tags and hashtags were written from the chapter list alone while titles, thumbnails, pinned
 * comments and clips were written from the video. Every call reads the video now: the
 * transcript is direct-passed rather than summarized (ai-manager.service.ts), and over the
 * ceiling they all read the same chapter digest (chapter-digest.ts).
 */
interface MetadataFieldSpec {
  section: string;
  /** The call's plain answer shape. */
  output: 'lines' | 'comma-line';
}

export const METADATA_FIELD_SECTIONS: Record<MetadataFieldId, MetadataFieldSpec> = {
  titles: { section: 'TITLES', output: 'lines' },
  description: { section: 'DESCRIPTION', output: 'lines' },
  description_hook: { section: 'DESCRIPTION', output: 'lines' },
  description_options: { section: 'DESCRIPTION', output: 'lines' },
  tags: { section: 'TAGS', output: 'comma-line' },
  thumbnail_text: { section: 'THUMBNAIL_TEXT', output: 'lines' },
  pinned_comment: { section: 'PINNED_COMMENT', output: 'lines' },
  hashtags: { section: 'HASHTAGS', output: 'lines' },
  spoken_keywords: { section: 'SPOKEN_KEYWORDS', output: 'lines' },
};

export function buildOutputFormat(field: MetadataFieldId): string {
  return METADATA_FIELD_SECTIONS[field].output === 'comma-line'
    ? SYSTEM_PROMPTS.TASK_OUTPUT_COMMA
    : formatPrompt(SYSTEM_PROMPTS.TASK_OUTPUT_LINES, { field: field.replace(/_/g, ' ') });
}

export interface TaskInstructions {
  /** The instruction block for this call, ending in its own OUTPUT FORMAT and self-check. */
  text: string;
  /** The metadata key this call is responsible for returning. Exactly one. */
  metadataKeys: MetadataFieldId[];
}

/**
 * What ONE field's call is, as both the prompt builder and the key checker read it.
 *
 * Declared once and passed to both, so a call cannot be ASKED for one key and CHECKED for
 * another.
 */
export interface MetadataFieldUnitSpec {
  /** The ONE field this call writes. */
  field: MetadataFieldId;
  /** Provider-prefixed (cloud) or bare (local) model name, as the routing option gives it. */
  model: string;
  /** This call carries the CHANNEL PERFORMANCE DATA block. At most one call does. */
  insights: boolean;
  /**
   * Fields written EARLIER in this run whose answers are handed to this call as INPUT DATA.
   *
   * This is what replaces grouping. `thumbnail_text` carries `['titles']`: the titles call runs
   * first, its ten titles are rendered into this call's prompt, and "the thumbnail must not
   * repeat a core word from the top 3 titles" becomes a rule about text the model can read
   * rather than a rule about text it happened to write. The plan is what guarantees the
   * ordering; the unit refuses to run if the input is not there.
   */
  inputFields: MetadataFieldId[];
}

/**
 * Assemble ONE field's instructions: its section, its OUTPUT FORMAT, its self-check.
 *
 * The prompt set's own ordering does not survive this, and it does not need to: a call that
 * carries one section has nothing to order it against. What DOES survive is strictness — a
 * field whose section the prompt set does not define throws, naming both, because the
 * alternative is sending the call anyway with no field rules and producing metadata that looks
 * generated and was written to no brief.
 */
export function buildFieldInstructions(
  spec: MetadataFieldUnitSpec,
  sections: InstructionSection[],
  promptSetName: string,
  /**
   * The FINAL SELF-CHECK for THIS FIELD, already assembled from this field's own lines plus any
   * cross-field line whose other field is supplied to this call as input data
   * (prompt-assets.ts `selfCheckBlock`, reached through AIManagerService.fieldSelfCheck).
   */
  selfCheckText: string
): TaskInstructions {
  const sectionKey = METADATA_FIELD_SECTIONS[spec.field].section;
  const section = sections.find((s) => s.key === sectionKey);
  if (!section) {
    throw new Error(
      `Prompt set "${promptSetName}" has no "## ${sectionKey}" section, so the "${spec.field}" field has no ` +
        `instructions (sections found: ${sections.map((s) => s.header).join(', ') || 'none'})`
    );
  }
  if (!selfCheckText.trim()) {
    throw new Error(
      `The "${spec.field}" call on ${spec.model} was handed an empty FINAL SELF-CHECK; ` +
        `shared/fields/self-check.yml must at minimum define its "global" lines`
    );
  }

  return {
    text: [section.text, buildOutputFormat(spec.field).trim(), selfCheckText.replace(/\s+$/, '')].join('\n\n'),
    metadataKeys: [spec.field],
  };
}

/**
 * An earlier field's answer, rendered as INPUT DATA for a later call.
 *
 * `pending` is the "Show prompt" case: the preview is assembled before anything has run, so the
 * block says so in as many words rather than pretending the titles are there or quietly
 * disappearing. Nothing sends the pending form to a model — `generate` refuses instead.
 */
export function buildInputDataBlock(
  spec: MetadataFieldUnitSpec,
  ctx: MetadataRunContext,
  options?: { pending?: boolean }
): string {
  const blocks: string[] = [];
  for (const input of spec.inputFields) {
    if (input !== 'titles') {
      throw new Error(
        `The "${spec.field}" call asks for "${input}" as input data, and nothing knows how to render that ` +
          `field as an input block (only "titles" has one)`
      );
    }
    const written = ctx.generated[input];
    const titles = Array.isArray(written)
      ? written.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : [];
    if (titles.length === 0) {
      if (options?.pending) {
        blocks.push(SYSTEM_PROMPTS.TASK_TITLES_INPUT_PENDING);
        continue;
      }
      throw new Error(
        `The "${spec.field}" call for ${ctx.sourceLabel} needs the titles this run wrote, and there are none. ` +
          `Titles run first so that this call can read them; nothing here writes its own set or carries on without.`
      );
    }
    blocks.push(
      formatPrompt(SYSTEM_PROMPTS.TASK_TITLES_INPUT, {
        titles: titles.map((t, i) => `${i + 1}. ${t}`).join('\n'),
      })
    );
  }
  return blocks.join('\n');
}

// ---------------------------------------------------------------------------
// One num_ctx per model per run
// ---------------------------------------------------------------------------

/**
 * Hard refusal point for a local call's context window.
 *
 * Every field call carries the whole transcript now, and a long livestream transcript does not
 * fit in any local context this app is willing to ask for. Refusing names the model and the
 * call, because the actual fix is one of the two things above it: an item over the local
 * direct-pass ceiling reads the chapter digest instead (chapter-digest.ts), and a field routed
 * to the cloud gets the 400k ceiling.
 */
export const LOCAL_FIELD_CTX_MAX = 40960;

/**
 * Output budget for a local field call.
 *
 * Sized for THINKING as much as for the answer. Ten titles are ~200 tokens, but these models
 * reason first and the chapter work measured ~1,900-2,900 tokens of reasoning per call.
 * `think: false` is not an option — it relocates the reasoning into `response` and breaks the
 * JSON (ollama-json.ts, trap 2) — so the budget has to hold both.
 */
export const LOCAL_FIELD_NUM_PREDICT = 8192;

/**
 * Long enough for one item's calls to run back to back without the model being evicted.
 *
 * Exported because the operator's "ten more titles" replay is the same call on the same model
 * (more-titles.ts) and a second copy of these two numbers would be a second policy.
 */
export const LOCAL_FIELD_KEEP_ALIVE = '10m';

/** A field call on a 27B carrying a full transcript; 10 minutes is generous, not tight. */
export const LOCAL_FIELD_TIMEOUT_MS = 600_000;

/**
 * Headroom for input data a sizing pass cannot see yet.
 *
 * The budget is resolved when the FIRST call on a model runs, and at that moment the thumbnail
 * call's prompt does not contain the titles — they have not been written. Ten titles plus the
 * block's framing is ~900 characters; 2,000 is that with room. It is added to every unit that
 * declares an input field, and the guard in `generate` below turns a wrong guess into a loud
 * failure rather than a silently truncated prompt.
 */
const INPUT_DATA_ALLOWANCE_CHARS = 2000;

/**
 * The bucketed num_ctx for one MODEL for one RUN.
 *
 * PURE, so the property that matters — several calls of different sizes on one model resolve to
 * ONE value — is testable without a model. `needs` are per-call token needs (prompt + that
 * call's own output budget); the largest wins, and `bucketNumCtx` rounds it up to a 4096 bucket
 * so two items whose transcripts differ by a few hundred words also land on the same value.
 */
export function runNumCtx(options: {
  model: string;
  /** Per-call token needs on this model: estimated prompt tokens + that call's num_predict. */
  needs: number[];
  /** The window already resident on this model. Can only raise the computed value, never lower it. */
  configured?: number;
  max: number;
  what: string;
}): number {
  if (options.needs.length === 0) {
    throw new Error(`Nothing registered a prompt size for the "${options.model}" calls, so there is nothing to size`);
  }
  return bucketNumCtx({
    promptTokens: Math.max(...options.needs),
    // Already included per call in `needs` — the largest call's own output budget is what has
    // to fit alongside its own prompt, not the sum of everybody's.
    numPredict: 0,
    configured: options.configured,
    max: options.max,
    logPrefix: `[MetadataTasks] ${options.model}`,
    what: options.what,
  });
}

/**
 * ONE num_ctx for one model for one run (ollama-json.ts trap 4).
 *
 * THE DEFECT THIS EXISTS TO PREVENT. Ollama fully reloads a model on ANY num_ctx change. Under
 * grouping that never bit — one call per model, so one value. One call per FIELD means four
 * calls on the 27B whose prompts differ by the length of their instruction sections, which
 * under per-call sizing is up to four full reloads of a 17GB model inside one item.
 *
 * So every unit on a model registers its sizer here, and the FIRST call to run resolves the
 * value from the LARGEST prompt that model will send this run — including the description
 * unit's two calls, which share the 9B with the tags call and have their own smaller output
 * budget.
 */
export class ModelRunContextBudget {
  private numCtx?: number;
  private readonly sizers: Array<{ label: string; need: (ctx: MetadataRunContext) => number }> = [];

  constructor(
    readonly model: string,
    /**
     * The JOB's ratchet. A run's units are planned per ITEM, so without it item 2 would size
     * its own window from its own transcript and reload the model to make it SMALLER than the
     * one item 1 left resident — a reload that buys nothing.
     */
    private readonly lifecycle: JobModelLifecycle
  ) {}

  /** `need` returns estimated prompt tokens PLUS that call's own num_predict. */
  register(label: string, need: (ctx: MetadataRunContext) => number): void {
    this.sizers.push({ label, need });
  }

  resolve(ctx: MetadataRunContext): number {
    if (this.numCtx !== undefined) return this.numCtx;
    const measured = this.sizers.map((s) => ({ label: s.label, need: s.need(ctx) }));
    const largest = measured.reduce((a, b) => (b.need > a.need ? b : a));
    this.numCtx = runNumCtx({
      model: this.model,
      needs: measured.map((m) => m.need),
      // Never below the window this job already made resident on this model — the chapter
      // stage and the earlier items pinned theirs first. Clamped to LOCAL_FIELD_CTX_MAX by
      // `contextFloor`, so the floor can never turn into this call's refusal.
      configured: this.lifecycle.contextFloor(this.model, LOCAL_FIELD_CTX_MAX),
      max: LOCAL_FIELD_CTX_MAX,
      what:
        `the "${largest.label}" call for ${ctx.sourceLabel}, which is the largest prompt "${this.model}" ` +
        `sends this run (it carries the transcript)`,
    });
    this.lifecycle.recordContext(this.model, this.numCtx);
    log.info(
      `[MetadataTasks] "${this.model}": num_ctx pinned at ${this.numCtx} for this whole run, shared by ` +
        `${measured.length} call(s) — ${measured.map((m) => `${m.label} ${m.need}t`).join(', ')} — so Ollama ` +
        `loads it once instead of reloading between fields`
    );
    return this.numCtx;
  }
}

// ---------------------------------------------------------------------------
// The model roster
// ---------------------------------------------------------------------------

/**
 * How many DISTINCT local models one run is allowed to make resident before it says so.
 *
 * The operator's standing instruction: "preferably load no more than two LLMs to do the jobs".
 * Two is a budget, not a limit — every model is a multi-GB load and an eviction of whatever was
 * resident, so a run that touches five spends most of its wall clock loading weights.
 */
export const LOCAL_MODEL_BUDGET = 2;

/** One thing that pulls a local model into a run: a field's call, the chapters, the summarizer. */
export interface ModelRosterEntry {
  model: string;
  /** What pulls it in, named the way the operator would fix it: a field id, `chapters`, … */
  what: string;
}

export interface ModelRoster {
  /** Distinct local models this run will load, in first-appearance order. */
  models: string[];
  /** model -> everything that pulls it in. */
  byModel: Record<string, string[]>;
  /** More distinct models than LOCAL_MODEL_BUDGET. Declared and warned, never blocked. */
  overBudget: boolean;
  /** One line for the run log. */
  summary: string;
}

/**
 * The roster, as a pure function so the count and the warning can be asserted without a model.
 *
 * Embedding models are EXCLUDED, and that is a real distinction rather than an exemption:
 * nomic-embed-text is 274MB and loads beside a generation model rather than instead of it, so
 * counting it against a budget that exists to stop multi-GB reloads would misreport the cost.
 */
export function buildModelRoster(entries: ModelRosterEntry[], excludeModels: string[] = []): ModelRoster {
  const excluded = new Set(excludeModels);
  const byModel: Record<string, string[]> = {};
  const models: string[] = [];
  for (const entry of entries) {
    if (!entry.model || excluded.has(entry.model)) continue;
    if (!byModel[entry.model]) {
      byModel[entry.model] = [];
      models.push(entry.model);
    }
    byModel[entry.model].push(entry.what);
  }
  const summary = models.map((m) => `${m} (${byModel[m].join(', ')})`).join(' | ') || 'no local model';
  return { models, byModel, overBudget: models.length > LOCAL_MODEL_BUDGET, summary };
}

// ---------------------------------------------------------------------------
// The cloud field call
// ---------------------------------------------------------------------------

/**
 * ONE field, written by a cloud model, from the same prompt the local units get.
 *
 * A field routed to Sonnet or Opus takes exactly the per-field prompt its local sibling would
 * have taken; only the transport differs. The answer is PLAIN TEXT in the field's declared
 * shape (lines, or the tags' comma line), read by the same parser the local unit uses.
 */
export class CloudFieldUnit implements MetadataUnit {
  readonly label: string;
  readonly fields: MetadataFieldId[];
  readonly inputFields: MetadataFieldId[];

  constructor(
    private readonly aiManager: AIManagerService,
    private readonly spec: MetadataFieldUnitSpec
  ) {
    this.fields = [spec.field];
    this.inputFields = spec.inputFields;
    this.label = `${spec.field} (cloud ${spec.model})`;
  }

  describePrompt(ctx: MetadataRunContext): string {
    return this.aiManager.buildMetadataFieldPrompt(this.spec, ctx, { pending: true });
  }

  async generate(ctx: MetadataRunContext): Promise<Record<string, unknown>> {
    const prompt = this.aiManager.buildMetadataFieldPrompt(this.spec, ctx);
    const what = `the ${this.spec.field} call for ${ctx.sourceLabel}`;
    const text = await this.aiManager.runPlainRequest(prompt, this.spec.model, what);
    if (!text) {
      throw new Error(`The "${this.spec.field}" call on ${this.spec.model} for ${ctx.sourceLabel} came back empty`);
    }
    return readFieldAnswer(this.spec.field, text, this.spec.model, ctx);
  }
}

// ---------------------------------------------------------------------------
// The local field call
// ---------------------------------------------------------------------------

/**
 * ONE field, written by a local base model, as plain text in the field's declared shape.
 *
 * A base model knows nothing about this channel, so it gets EVERYTHING about the one field it
 * is writing: the editorial preamble, that field's `##` section from the shared field files,
 * the insights block where it belongs, the transcript, and the one-key output contract. That is
 * exactly CloudFieldUnit's prompt, built by exactly CloudFieldUnit's builder, and read back
 * through exactly CloudFieldUnit's normalizer. The only difference is the transport — and the
 * transport is where the local traps live, which is why it is one shared implementation
 * (ollama-json.ts) and not a second copy of the same four lessons.
 */
export class LocalFieldUnit implements MetadataUnit {
  readonly label: string;
  readonly fields: MetadataFieldId[];
  readonly inputFields: MetadataFieldId[];
  private readonly client: AxiosInstance;
  private readonly host: string;

  constructor(
    private readonly aiManager: AIManagerService,
    private readonly spec: MetadataFieldUnitSpec,
    private readonly option: MetadataRoutingOption,
    defaultHost: string,
    /** Shared with every other unit on this model — one num_ctx, one load. */
    private readonly budget: ModelRunContextBudget,
    /** Where this unit DECLARES the model it made resident. It never releases one itself. */
    private readonly lifecycle: JobModelLifecycle,
    private readonly abortSignal?: AbortSignal
  ) {
    this.fields = [spec.field];
    this.inputFields = spec.inputFields;
    this.host = defaultHost;
    this.label = `${spec.field} (local ${option.model} @ ${this.host})`;
    this.client = axios.create({ baseURL: this.host });
    this.budget.register(spec.field, (ctx) => this.promptTokenNeed(ctx));
  }

  describePrompt(ctx: MetadataRunContext): string {
    return this.aiManager.buildMetadataFieldPrompt(this.spec, ctx, { pending: true });
  }

  /**
   * What this call needs of a context window: its prompt plus its own output budget.
   *
   * Measured on the PENDING form of the prompt, because sizing happens before the earlier
   * fields have been written — hence the allowance for input data that is not there yet.
   */
  private promptTokenNeed(ctx: MetadataRunContext): number {
    const chars =
      this.aiManager.buildMetadataFieldPrompt(this.spec, ctx, { pending: true }).length +
      (this.spec.inputFields.length > 0 ? INPUT_DATA_ALLOWANCE_CHARS : 0);
    return estimateTokens(chars) + LOCAL_FIELD_NUM_PREDICT;
  }

  async generate(ctx: MetadataRunContext): Promise<Record<string, unknown>> {
    const prompt = this.aiManager.buildMetadataFieldPrompt(this.spec, ctx);
    const what = `the ${this.spec.field} call for ${ctx.sourceLabel}`;
    const numCtx = this.budget.resolve(ctx);

    // The sizing pass ran before this call's input data existed. If the real prompt is bigger
    // than the window that was pinned for it, Ollama would silently drop the front of it and
    // answer about the rest, so this says so instead. Raising the window here is not on the
    // table — it would reload the model and invalidate every other call's pinned value.
    const needed = estimateTokens(prompt.length) + LOCAL_FIELD_NUM_PREDICT + 512;
    if (needed > numCtx) {
      throw new Error(
        `${what} assembled to ~${needed} tokens, past the ${numCtx}-token window pinned for "${this.option.model}" ` +
          `this run. The window is pinned once per model because changing it reloads the model, so this call ` +
          `cannot be widened: shorten the transcript this item carries, or route this field to another model.`
      );
    }

    const result = await queueAITask(
      `metadata-local-${this.option.model}-${this.spec.field}-${ctx.sourceLabel}`,
      `Metadata: ${this.label}`,
      async () => {
        if (this.abortSignal?.aborted) throw new JobCancelledError('cancelled before the local field call ran');
        const answer = await askOllamaPlain(this.client, {
          model: this.option.model,
          prompt,
          numCtx,
          numPredict: LOCAL_FIELD_NUM_PREDICT,
          keepAlive: LOCAL_FIELD_KEEP_ALIVE,
          // Titles run with the thinking pass off (the /api/chat transport in plain-call.ts).
          // With it on, the local 27B spent the entire 8192-token budget reasoning about the
          // ten titles and returned a truncated fragment (verified 2026-08-30); the campaign's
          // title arms all ran thinking-off on this model and produced clean ten-line answers
          // in about a minute. The other fields keep their measured-with-thinking behavior —
          // this is scoped to the one field with evidence, not a blanket change.
          think: this.spec.field === 'titles' ? false : undefined,
          timeoutMs: LOCAL_FIELD_TIMEOUT_MS,
          signal: this.abortSignal,
          what,
          logPrefix: `[MetadataTasks] ${this.label}`,
        });
        this.lifecycle.holdOllamaModel(this.host, this.option.model, `the ${this.spec.field} call`);
        return answer;
      },
      undefined,
      LOCAL_FIELD_TIMEOUT_MS + 60_000
    );

    // A field's unusable answer is FATAL for that field, which is the opposite of the chapter
    // pipeline's policy on the same result — and deliberately so. A chapter call that comes
    // back truncated costs one chapter out of ten; a field call that comes back truncated costs
    // the whole field, and there is no partial version of a title list. Nothing retries at a
    // smaller size and nothing reroutes to another model: the user chose this model for this
    // field.
    if (!result.ok) {
      throw new Error(
        `The local "${this.spec.field}" call on ${this.option.model} for ${ctx.sourceLabel} produced no usable ` +
          `answer (${result.reason}): ${result.detail}` +
          (result.reason === 'length'
            ? ` — the ${LOCAL_FIELD_NUM_PREDICT}-token output budget was not enough for this prompt's reasoning ` +
              `plus its answer. Route this field to a larger context or to the cloud.`
            : '')
      );
    }

    return readFieldAnswer(this.spec.field, result.text, this.option.model, ctx);
  }
}

/**
 * Read one field call's plain answer into its field.
 *
 * A `lines` field comes back as one option per line (numbering tolerated and stripped —
 * plain-call.ts); the tags come back as one comma-separated line and go through the shared
 * tag-line normalizer below. A COUNT MISMATCH on a list field is a
 * declared warning and the answer is KEPT — deliver-and-curate; the operator reads ten titles
 * or eight — never a blocking check.
 */
function readFieldAnswer(
  field: MetadataFieldId,
  text: string,
  model: string,
  ctx: MetadataRunContext
): Record<string, unknown> {
  const what = `the ${field} call for ${ctx.sourceLabel}`;
  if (METADATA_FIELD_SECTIONS[field].output === 'comma-line') {
    return { [field]: normalizeTagLine(text, field, model, ctx.sourceLabel) };
  }
  const lines = parseLines(text, what);
  const expected = promptAssets().channel(ctx.promptSetName).counts[field];
  if (typeof expected === 'number' && lines.length !== expected) {
    ctx.warn(
      `the ${field} call on ${model} returned ${lines.length} option(s) where the channel asks for ` +
        `${expected}; all ${lines.length} are kept exactly as written`
    );
  }
  return { [field]: lines };
}

// ---------------------------------------------------------------------------
// Plain-text output mapping
// ---------------------------------------------------------------------------

/**
 * A tags call's one comma-separated line, in the shape the rest of the app reads.
 *
 * Deliberately identical to what normalizeMetadataKeys does to a cloud `tags` string —
 * split on commas, trim, drop any leading '#', re-join with commas — because the local
 * path bypasses that normalizer entirely and a differently-shaped tags field would
 * surface as a formatting bug in the .txt writer, far from here.
 *
 * It was written for the trained tags adapter and named for it; the adapters are gone
 * (2026-08-25) and this is now what EVERY tags answer goes through, local and cloud alike,
 * which is what the name says instead.
 */
export function normalizeTagLine(text: string, task: string, model: string, sourceLabel: string): string {
  const tags = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(', ')
    .split(',')
    .map((tag) => tag.trim().replace(/^#\s*/, ''))
    .filter((tag) => tag.length > 0);

  if (tags.length === 0) {
    throw new Error(
      `Metadata task "${task}" for ${sourceLabel} on model "${model}" returned no usable tags (got: "${text.slice(0, 120)}")`
    );
  }
  return tags.join(',');
}

// ---------------------------------------------------------------------------
// Planning a run
// ---------------------------------------------------------------------------

export interface MetadataRunPlan {
  /**
   * The units this run executes, IN ORDER.
   *
   * Two properties the order carries, both load-bearing:
   *   - TITLES FIRST, because the thumbnail call reads them as input data.
   *   - UNITS ON THE SAME MODEL RUN CONSECUTIVELY, so Ollama loads each model once. Splitting
   *     the 27B's four calls around the 9B's would evict and reload both.
   */
  units: MetadataUnit[];
  /**
   * Whether this run's prompt set publishes tags and hashtags at all.
   *
   * Both are code-assembled now, so nothing is ROUTED for them — but "this channel has no
   * tags" is still a real statement a prompt set makes by leaving the section out (the
   * Spreaker podcast set has no `## HASHTAGS` and never did), and assembling a field the
   * channel does not publish would put it in the report anyway.
   */
  assembleTags: boolean;
  assembleHashtags: boolean;
  /** The distinct local models this run will make resident, and what pulls each one in. */
  roster: ModelRoster;
  /**
   * DECLARED degradations discovered while planning, pushed into the run's warnings before the
   * first unit runs (runMetadataTasks).
   *
   * The roster going over budget is one. It is a warning rather than a refusal because which
   * model writes which field is the operator's choice, made in the routing dialog — but a run
   * that quietly loads five models looks identical, from the outside, to one that loads two and
   * is simply slow.
   */
  warnings: string[];
  /** One line for the job log: which model writes what, and how many calls that is. */
  summary: string;
}

/**
 * Everything planning a run needs, as one object.
 *
 * An options bag rather than eight positional parameters because `alsoLoads` was added late and
 * is the kind of argument that MUST be stated: it is how the caller tells the planner which
 * local models this item has already loaded outside the units — the chapter pipeline's
 * generation model, the summarizer's — and a caller that forgot it would get a two-model
 * roster for a run that actually loads four.
 */
export interface MetadataPlanRequest {
  routing: ResolvedMetadataRouting;
  defaultHost: string;
  aiManager: AIManagerService;
  hasInsights: boolean;
  /**
   * Does this item have a measured chapter list?
   *
   * Not a hint and not inferred here: the caller has just run (or declined to run) the chapter
   * pipeline and knows the answer. It decides tag ownership, and it is recorded in the run's
   * log either way — an item whose tags were written by a model and one whose tags were
   * assembled from its own transcript must never look the same in a report.
   */
  hasChapters: boolean;
  /**
   * Local models this run loads OUTSIDE the units, with what pulls each one in.
   *
   * The chapter pipeline's 27B when the item had a timestamped transcript; the summarizer's
   * when the transcript was over ai-manager's direct-pass ceiling. Both are real multi-GB
   * loads inside the same run, so both count against the two-model budget.
   */
  alsoLoads: ModelRosterEntry[];
  /**
   * The JOB's model residence, threaded to every local unit.
   *
   * REQUIRED, and not per item: a plan is built per item, and a per-item lifecycle would
   * release the 27B between two items of one job — which is the reload this object exists to
   * stop. The orchestrator makes one per job and releases it once.
   */
  lifecycle: JobModelLifecycle;
  /** This run's cancel signal, threaded to the local units. */
  abortSignal?: AbortSignal;
}

/**
 * Turn a resolved routing into the units that will run — ONE PER FIELD.
 *
 * ONE SHAPE, two transports. Every field gets that field's yml section, its self-check, the
 * transcript and a plain-text output contract; whether the model is local (LocalFieldUnit) or
 * cloud (CloudFieldUnit) decides only how the bytes travel. The second shape — the trained
 * adapters, chosen by an option's `promptStyle` — was retired 2026-08-25 with the adapters.
 *
 * WHAT REPLACED GROUPING. Fields pointed at the same model used to be written in ONE call so
 * that a cross-field rule was followable. Two things are true instead now:
 *   - ORDER. Titles run first, always, and the thumbnail call is handed them as input data
 *     (`inputFields`). The self-check line about not repeating a core word from the top 3
 *     titles is emitted for the thumbnail call because that call can READ the titles.
 *   - RESIDENCE. Units on one model run consecutively under one pinned num_ctx and a 10-minute
 *     keep-alive, so four calls on the 27B cost one load, not four.
 *
 * Two things ride with exactly one call each, and this is where that is decided:
 *   the insights block — the TITLES call, else the first call, logged. Channel performance data
 *     speaks to packaging, and titles are the packaging decision it was distilled from.
 *   the self-check — every call carries its OWN, assembled from its own field's lines plus any
 *     cross-field line whose other field it is given as input. There is no "the group that
 *     carries the self-check" any more, because there is no group.
 *
 * ABSORBED SECTIONS ARE GONE, and the layout is why. `absorbUnownedSections` existed when a
 * prompt set was a user-editable YAML whose `##` headers were not a fixed vocabulary: a section
 * nobody claimed had to ride SOMEWHERE. A channel is now pure data whose `fields` list is
 * checked against the shared field-file registry at load (prompt-assets.ts), so the sections
 * that exist are exactly the fields the channel declares. A declared field with no routing task
 * — `spoken_keywords`, which only the shorts channel publishes — gets its OWN call on the model
 * the titles are routed to, logged per run. Anything left genuinely unclaimed is named in a
 * warning rather than quietly appended to somebody else's prompt.
 *
 * `hasChapters` IS THE ONLY THING THAT VARIES BETWEEN THE TWO KINDS OF ITEM, and it varies in
 * exactly one place: who writes the tags. An item with chapters has them assembled in code from
 * pools measured against the chapter list; an item without has no such pools, so its tags are
 * written by the model the routing names. Both are logged per item.
 */
export function planMetadataUnits(request: MetadataPlanRequest): MetadataRunPlan {
  const { routing, defaultHost, aiManager, hasInsights, hasChapters, alsoLoads, lifecycle, abortSignal } =
    request;

  // A field the PROMPT SET does not define is not generated at all, whatever the routing
  // says. The Spreaker podcast set has no "## THUMBNAIL_TEXT" and never did — that is the
  // set saying this channel has no thumbnails, not a section gone missing. Decided and
  // logged up front, per run, exactly like the chapters-or-not mode decision.
  const available = aiManager.promptSetSectionKeys();
  const skipped: string[] = [];
  const warnings: string[] = [];

  /**
   * The tasks that get a routed call THIS RUN, in the order they run.
   *
   * On a chaptered item that is the four packaging fields; on a chapterless one it is those
   * four plus tags, because there is no chapter list for the tag pools to be measured against.
   */
  const routedTasks: Array<{ task: MetadataRoutingTaskId; field: MetadataFieldId }> = hasChapters
    ? FIELD_TASKS
    : [...FIELD_TASKS, { task: 'tags' as MetadataRoutingTaskId, field: 'tags' as MetadataFieldId }];

  /** One entry per planned call, in FIELD order. Re-ordered by model just before it is returned. */
  const planned: Array<{ field: MetadataFieldId; option: MetadataRoutingOption }> = [];

  for (const { task, field } of routedTasks) {
    if (!available.has(METADATA_FIELD_SECTIONS[field].section)) {
      skipped.push(field);
      continue;
    }
    const optionId = routing[task];
    const option = METADATA_ROUTING_OPTIONS[optionId];
    if (!option) {
      throw new Error(`Metadata task "${task}" is routed to unknown option "${optionId}"`);
    }
    planned.push({ field, option });
  }

  const titlesPlan = planned.find((p) => p.field === 'titles');

  /**
   * A field the CHANNEL publishes that NO routing task owns.
   *
   * `spoken_keywords` is the only one, and only on the shorts channel. It used to ride along
   * inside whichever group absorbed unclaimed sections; under one call per field it gets its
   * own call, on the model the titles are routed to, because it is a packaging decision about
   * what the clip says out loud in its first five seconds. There is no routing entry to change
   * that — so the decision is LOGGED every run rather than left to be discovered in a prompt.
   */
  const unrouted: MetadataFieldId[] = [];
  for (const [field, spec] of Object.entries(METADATA_FIELD_SECTIONS) as Array<[MetadataFieldId, { section: string }]>) {
    // Everything DescriptionUnit writes, from ITS OWN list rather than named here one at a
    // time. This used to say `field === 'description_hook'` beside the `description` check
    // below, and adding a third description field (`description_options`, 2026-08-23) walked
    // straight into it: the loop saw a field id whose section the channel publishes and which no
    // routing task owns, and warned that the alternatives would not be generated — in a run that
    // generated them. One list, two readers, and the next field added to the unit is covered.
    if (DESCRIPTION_FIELDS.includes(field)) continue;
    if (!available.has(spec.section)) continue;
    if (planned.some((p) => p.field === field)) continue;
    // Owned by code.
    if (field === 'hashtags' || field === 'tags') continue;
    unrouted.push(field);
  }
  for (const field of unrouted) {
    if (!titlesPlan) {
      warnings.push(
        `the channel publishes "${field}", which no routing selection owns and which normally rides on the ` +
          `titles model — but nothing writes titles this run, so "${field}" is not generated`
      );
      skipped.push(field);
      continue;
    }
    log.info(
      `[MetadataTasks] "${field}" is published by this channel and owned by no routing selection, so it runs as ` +
        `its own call on the model the titles use ("${titlesPlan.option.model}")`
    );
    planned.push({ field, option: titlesPlan.option });
  }

  // The description is its own pair of calls (DescriptionUnit), planned off the same
  // `description` routing entry a group used to read.
  const describes = available.has(METADATA_FIELD_SECTIONS.description.section);
  let descriptionOption: MetadataRoutingOption | undefined;
  if (describes) {
    const optionId = routing.description;
    descriptionOption = METADATA_ROUTING_OPTIONS[optionId];
    if (!descriptionOption) {
      throw new Error(`Metadata task "description" is routed to unknown option "${optionId}"`);
    }
  } else {
    skipped.push('description');
  }

  if (skipped.length > 0) {
    log.info(
      `[MetadataTasks] the loaded prompt set defines no section for ${skipped.join(', ')}, so ` +
        `${skipped.length === 1 ? 'that field is' : 'those fields are'} not generated this run`
    );
  }

  // Whether either field exists at all is the CHANNEL's statement (its `fields` list); whether
  // tags are assembled or written is this ITEM's — see `hasChapters`.
  const publishesTags = available.has(METADATA_FIELD_SECTIONS.tags.section);
  const assemblesTags = publishesTags && hasChapters;
  const assemblesHashtags = available.has(METADATA_FIELD_SECTIONS.hashtags.section);
  log.info(
    `[MetadataTasks] this item ${hasChapters ? 'HAS' : 'has NO'} chapters, so its tags are ` +
      (publishesTags
        ? hasChapters
          ? 'assembled in code from the entity and key-phrase pools and no model writes them'
          : `written by the model the "Tags" routing selection names, because there is no chapter list for those pools to be measured against`
        : 'not published by this channel at all') +
      `; hashtags ${assemblesHashtags ? 'are' : 'are not'} derived in code`
  );

  if (planned.length === 0 && !descriptionOption && !assemblesTags && !assemblesHashtags) {
    throw new Error(
      `The loaded prompt set defines none of the metadata fields this app generates ` +
        `(description, tags, hashtags, ${FIELD_TASKS.map((f) => f.field).join(', ')}), so there is nothing to run`
    );
  }

  /**
   * WHICH CALL CARRIES THE INSIGHTS BLOCK. Titles, or — where nothing writes titles this run —
   * the first call, said out loud. It is never split across calls: the block is 2-4KB of
   * derived analytics and putting it on four prompts would quadruple its cost for one decision.
   */
  const insightsField: MetadataFieldId | undefined = hasInsights
    ? planned.some((p) => p.field === 'titles')
      ? 'titles'
      : planned[0]?.field
    : undefined;
  if (hasInsights && insightsField && insightsField !== 'titles') {
    log.info(
      `[MetadataTasks] titles are not written by a prompt-set call this run, so the CHANNEL PERFORMANCE DATA ` +
        `block rides with the "${insightsField}" call instead`
    );
  }

  /** model -> the ONE context budget every unit on it shares (ollama-json trap 4). */
  const budgets = new Map<string, ModelRunContextBudget>();
  const budgetFor = (model: string): ModelRunContextBudget => {
    let budget = budgets.get(model);
    if (!budget) {
      budget = new ModelRunContextBudget(model, lifecycle);
      budgets.set(model, budget);
    }
    return budget;
  };

  /** field -> unit, built in FIELD order so `inputFields` can only ever point backwards. */
  const built: Array<{ field: MetadataFieldId; model: string; local: boolean; unit: MetadataUnit }> = [];

  for (const plan of planned) {
    const spec: MetadataFieldUnitSpec = {
      field: plan.field,
      model: plan.option.model,
      insights: plan.field === insightsField,
      // The one cross-field dependency in the build. Everything else — pinned comments, tags,
      // spoken keywords — reads the transcript and nothing else, so it can run in any order
      // after the titles.
      inputFields: plan.field === 'thumbnail_text' && titlesPlan ? ['titles'] : [],
    };
    built.push({
      field: plan.field,
      model: plan.option.model,
      local: plan.option.kind === 'local',
      unit:
        plan.option.kind === 'local'
          ? new LocalFieldUnit(
              aiManager,
              spec,
              plan.option,
              defaultHost,
              budgetFor(plan.option.model),
              lifecycle,
              abortSignal
            )
          : new CloudFieldUnit(aiManager, spec),
    });
  }

  if (descriptionOption) {
    built.push({
      field: 'description',
      model: descriptionOption.model,
      local: descriptionOption.kind === 'local',
      unit: new DescriptionUnit(
        aiManager,
        descriptionOption,
        defaultHost,
        descriptionOption.kind === 'local' ? budgetFor(descriptionOption.model) : undefined,
        lifecycle,
        abortSignal
      ),
    });
  }

  /**
   * GROUP CONSECUTIVE CALLS BY MODEL, keeping first-appearance order.
   *
   * Titles are the first field planned, so the titles model comes first and the titles call is
   * first within it — which is what the thumbnail call's input data depends on. Everything else
   * on that model follows it, then the next model's calls in a block. A Map keeps insertion
   * order, so this is the whole mechanism.
   *
   * The description used to run FIRST, on the argument that the operator watching a run wants
   * the field he cares most about to resolve first. It cannot any more: titles have to be
   * written before the thumbnail call can read them. It runs with the rest of its model's calls.
   */
  const byModel = new Map<string, MetadataUnit[]>();
  for (const entry of built) {
    const existing = byModel.get(entry.model);
    if (existing) existing.push(entry.unit);
    else byModel.set(entry.model, [entry.unit]);
  }
  const units: MetadataUnit[] = [];
  for (const modelUnits of byModel.values()) units.push(...modelUnits);

  /**
   * THE TWO-LLM BUDGET, computed after planning and declared either way.
   *
   * Everything that makes a local model resident inside this run counts: every field's call,
   * the chapter pipeline's generation model, the summarizer's if the transcript was long enough
   * to need it. The embedding model does not — see buildModelRoster.
   */
  const roster = buildModelRoster(
    [
      ...built.filter((b) => b.local).map((b) => ({ model: b.model, what: b.field })),
      ...alsoLoads,
    ],
    [KEY_PHRASE_EMBEDDING_MODEL]
  );
  log.info(
    `[MetadataTasks] this run loads ${roster.models.length} local model(s): ${roster.summary}` +
      (roster.overBudget ? '' : ` (budget is ${LOCAL_MODEL_BUDGET})`)
  );
  if (roster.overBudget) {
    const message =
      `this run loads ${roster.models.length} local models where the budget is ${LOCAL_MODEL_BUDGET} — ` +
      `${roster.summary}. Every extra model is a multi-GB load that evicts the last one, so the run will spend ` +
      `real time moving weights rather than writing. Point two of those fields at a model already on the list ` +
      `in the routing dialog to bring it back to ${LOCAL_MODEL_BUDGET}. Nothing was changed for you.`;
    log.warn(`[MetadataTasks] ${message}`);
    warnings.push(message);
  }

  const summary = [
    ...units.map((u) => u.label),
    ...(assemblesTags ? ['tags (code)'] : []),
    ...(assemblesHashtags ? ['hashtags (code)'] : []),
  ].join(' | ');
  return { units, assembleTags: assemblesTags, assembleHashtags: assemblesHashtags, roster, warnings, summary };
}

// ---------------------------------------------------------------------------
// Running the units
// ---------------------------------------------------------------------------

export interface MetadataTaskRun {
  plan: MetadataRunPlan;
  ctx: MetadataRunContext;
}

/**
 * Run the units in order and merge them into the one MetadataResult the rest of the app
 * expects.
 *
 * Nothing is caught here. A half-generated item — a description with no titles, tags from
 * one model and thumbnails from another run — is worse than no item, because it is
 * indistinguishable from a complete one once it is written to disk.
 */
/**
 * Everything a returned title is allowed to have got a proper noun FROM.
 *
 * The transcript the model read (`content` — a summary, on a long item), the app's full content
 * text, the chapter names and their summaries, and the video title and source filename — the
 * last two because the subject block explicitly tells the model to take correctly-spelled names
 * from the filename, so a name that came from there came from an input.
 *
 * Joined with newlines and matched whole-word, case- and punctuation-insensitively, with
 * possessives normalized away (entity-extraction.ts `occursIn`).
 *
 * THE SPEAKER LABELS COME OFF BOTH TRANSCRIPTS FIRST. This text is the answer to "did the video
 * contain this name?", and HOST, CLIP and UNSURE are things the app wrote onto the transcript,
 * not things the video said. Left in, they would ground a title that used them as words.
 */
export function titleGroundingText(ctx: MetadataRunContext): string {
  return [
    stripSpeakerPrefixes(ctx.content),
    stripSpeakerPrefixes(ctx.contentText),
    ctx.videoTitle,
    ctx.sourceLabel,
    ...ctx.chapterSubjects,
    ...ctx.chapterDetails,
  ]
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .join('\n');
}

/** Titles whose proper nouns the inputs do not contain, with the offending names. */
export interface UngroundedTitle {
  title: string;
  invented: string[];
}

/**
 * Which of these titles assert a name nothing in the inputs contains.
 *
 * PURE, so the check is testable without a model. It uses `groundViewerTitle`, not the chapter
 * pipeline's `groundTitle`, and the difference is measured rather than stylistic: a chapter
 * title is sentence-cased topic form, so a mid-string capital really is evidence of a name,
 * while a YouTube title Title Cases every word and tells you nothing. See that function for what
 * the viewer-facing bar is and why it is deliberately conservative.
 *
 * Possessives are handled the same way on both paths — "Gene Bailey's misreading" is grounded by
 * a transcript that says "Gene Bailey".
 */
export function ungroundedTitles(titles: unknown, groundingText: string): UngroundedTitle[] {
  if (!Array.isArray(titles)) return [];
  const faults: UngroundedTitle[] = [];
  for (const title of titles) {
    if (typeof title !== 'string' || title.trim().length === 0) continue;
    const verdict = groundViewerTitle(title, groundingText);
    if (!verdict.grounded) faults.push({ title, invented: verdict.ungrounded });
  }
  return faults;
}

/**
 * The titles grounding check: measure, re-ask ONCE, then KEEP with a declared warning.
 *
 * WHY IN CODE AND NOT IN THE PROMPT. Asking a model to "only use names from the transcript" is
 * an instruction it already believes it is following; the failure is not disobedience, it is a
 * name arriving from world knowledge or from the prompt's own examples and feeling grounded. So
 * the prompt stays positive and short, and the check happens afterwards, against the inputs.
 *
 * WHAT IT NEVER DOES: block, filter, or rewrite. A title that fails twice is published exactly
 * as the model wrote it and the run's warnings name it and the invented noun. That is the
 * operator's standing rule — deliver the output, the operator curates — and it is the same
 * one-re-ask-then-declare shape the description hook and the chapter titles already use.
 *
 * The re-ask re-runs the titles CALL and nothing else. Under grouping it re-ran the whole
 * four-field group, regenerating the thumbnail text and the pinned comments as collateral;
 * that was defensible (those fields were written to sit beside the titles being replaced) but
 * it cost three fields to fix one. One call per field makes it exact — and the fields that
 * READ the titles run afterwards, so they read the set that was kept.
 */
async function groundTitlesOnce(
  unit: MetadataUnit,
  ctx: MetadataRunContext,
  first: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const grounding = titleGroundingText(ctx);
  if (grounding.trim().length === 0) {
    // Nothing to check against is not a pass. An item with no readable content text and no
    // chapters cannot ground anything, and saying so beats reporting every title as clean.
    ctx.warn(
      'the titles could not be grounded: this item carries no transcript, chapter list or source ' +
        'name to check their proper nouns against, so nothing verified that the names in them came from the video'
    );
    return first;
  }

  const faults = ungroundedTitles(first.titles, grounding);
  if (faults.length === 0) return first;

  log.warn(
    `[MetadataTasks] ${ctx.sourceLabel}: ${faults.length} title(s) name something the inputs do not ` +
      `contain (${faults.map((f) => f.invented.join(', ')).join('; ')}); asking ${unit.label} once more`
  );

  const second = await unit.generate(ctx);
  const secondFaults = ungroundedTitles(second.titles, grounding);
  if (secondFaults.length === 0) {
    log.info(`[MetadataTasks] ${ctx.sourceLabel}: the second set of titles is grounded; keeping it`);
    return second;
  }

  ctx.warn(
    `titles were asked for twice and both times used a phrase the video's transcript, chapters and ` +
      `filename contain no part of — ` +
      secondFaults.map((f) => `"${f.title}" says ${f.invented.map((i) => `"${i}"`).join(' and ')}`).join('; ') +
      `. Check whether that is a real name from somewhere else or a claim the video does not make. The titles ` +
      `are kept exactly as the model wrote them; nothing was dropped or rewritten.`
  );
  return second;
}

export async function runMetadataTasks(
  aiManager: AIManagerService,
  run: MetadataTaskRun
): Promise<MetadataResult> {
  const merged: Record<string, unknown> = {};

  // Declared at PLAN time — the model roster going over budget, a published field nothing
  // owns — and surfaced here, because the plan has no warnings channel of its own and the
  // operator reads these in the run report beside the chapter pipeline's.
  for (const warning of run.plan.warnings) run.ctx.warn(warning);

  // NO try/finally RELEASING MODELS HERE, and its absence is the fix. This function used to
  // unload every resident unit's model as it returned — per ITEM, and per item is per stage
  // from the machine's point of view: the next call on the same 27B re-streamed 17GB of weights
  // into unified memory and froze the UI while it did. What a unit made resident is declared to
  // the job's lifecycle and released once, at the end of the job.
  for (const unit of run.plan.units) {
    console.log(`[MetadataTasks] ${run.ctx.sourceLabel}: running unit ${unit.label}`);
    let fields = await unit.generate(run.ctx);
    if (unit.fields.includes('titles')) {
      fields = await groundTitlesOnce(unit, run.ctx, fields);
    }
    if (unit.fields.includes('tags')) {
      fields = await usableTagsOrThrow(unit, run.ctx, fields);
    }
    // Before the merge, so a later unit that declares this field as INPUT DATA reads exactly
    // what this one returned — including the second set of titles when the grounding check
    // re-asked for them.
    Object.assign(run.ctx.generated, fields);
    Object.assign(merged, fields);
  }

  // Tags and hashtags, assembled from the pools with no model call at all (spec §4, §6.2,
  // §6.3). AFTER the units, because the hashtag rule dedupes against the title and the
  // titles unit is one of the ones that just ran.
  assembleCodeOwnedFields(aiManager, run, merged);

  // Description links, the channel tag append and hashtag spacing are applied ONCE, to
  // the merged object. Per unit they could not be: the links append to a description one
  // unit returns, while the channel tags append to a list assembled just above.
  return aiManager.finalizeMetadata(merged as MetadataResult);
}

/**
 * The model-written tag list, checked and asked for ONE more time before the run keeps it.
 *
 * SAME SHAPE AS `groundTitlesOnce`, and for the same reason: the judgment belongs to one field
 * and the second ask is the unit's own call re-run, so it lives beside the loop rather than
 * inside the generic unit.
 *
 * WHY THIS ONE THROWS where the titles check warns. An ungrounded title is a title — it
 * publishes, and the operator picks a different one out of the ten. A tag list that came back
 * without its commas is not a thin tag list, it is a 160-character sentence that would be
 * published to YouTube as a single tag, on a field whose own rule is that YouTube reads a tag
 * the video does not mention as a spam signal. There is no version of it that ships, so there
 * is nothing for a warning to declare: `unusableTagList` explains why it cannot be read, and
 * the second identical failure says the prompt and this model are not agreeing on the format,
 * which the operator needs to know before starting thirty more items. See `unusableTagList` for
 * why the parser cannot repair it.
 */
async function usableTagsOrThrow(
  unit: MetadataUnit,
  ctx: MetadataRunContext,
  first: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const fault = unusableTagList(first.tags);
  if (!fault) return first;

  log.warn(
    `[MetadataTasks] ${ctx.sourceLabel}: the tag list is unusable — ${fault}; asking ${unit.label} once more`
  );

  const second = await unit.generate(ctx);
  const secondFault = unusableTagList(second.tags);
  if (!secondFault) {
    log.info(`[MetadataTasks] ${ctx.sourceLabel}: the second tag list is readable; keeping it`);
    return second;
  }

  throw new Error(
    `The tags call on ${unit.label} for ${ctx.sourceLabel} returned a tag list that cannot be read as one, ` +
      `twice: first ${fault}; then ${secondFault}. The tags are separated by commas and the prompt both says ` +
      `so and shows it (shared/fields/tags.yml), so nothing here re-splits the answer on spaces — that would ` +
      `turn one multi-word tag into three tags nobody wrote. Re-run this item, or route tags to a larger model.`
  );
}

/**
 * Tags and hashtags, built in code from the pools this run already measured.
 *
 * Spec §2's ownership ruling, applied: neither field is ever emitted by a model on the
 * chaptered path. What that buys, beyond a saved call, is a property no model can offer —
 * every tag published came out of the content text, tested by `occursIn`, because YouTube
 * treats a tag the video does not mention as a spam signal (§6.2).
 *
 * The PRIMARY PHRASE is the top-ranked key phrase, which is the phrase the embedding ranking
 * put closest to the whole document. The CATEGORY terms are the highest-ranked SINGLE WORDS in
 * the same ranking — one word is what makes a term broad, and being high in the ranking is what
 * makes it this video's broad term rather than any video's. (They were briefly taken from the
 * TAIL of the ranking, on the theory that the least document-specific phrase is the most
 * general one. It is not: the tail of a spoken transcript is "lies told" and "book titled".)
 *
 * Nothing here throws on an empty pool: a video whose transcript yielded no rankable phrase
 * gets no tags and says so in the log. Manufacturing one from the filename would be inventing
 * an input.
 */
function assembleCodeOwnedFields(
  aiManager: AIManagerService,
  run: MetadataTaskRun,
  merged: Record<string, unknown>
): void {
  const ctx = run.ctx;

  if (run.plan.assembleTags) {
    const assembled = assembleTags({
      primaryPhrase: ctx.keyPhrases[0] || ctx.entities[0] || '',
      entities: ctx.entities,
      keyPhrases: ctx.keyPhrases,
      categories: ctx.keyPhrases.filter((p) => !p.includes(' ')).slice(0, 3),
      // Without the speaker labels, for the same reason the entity pool is measured without
      // them: this is the "does the video actually say this?" test that keeps a tag off a video
      // it does not belong to, and HOST/CLIP/UNSURE are words the app wrote, not words the video
      // said. A tag is a claim about the content; the labels are a claim about the transcript.
      contentText: stripSpeakerPrefixes(ctx.contentText),
    });
    merged.tags = assembled.tags.join(',');
    log.info(
      `[MetadataTasks] ${ctx.sourceLabel}: assembled ${assembled.tags.length} tag(s) in code, ` +
        `${assembled.cost}/${GENERATED_TAG_BUDGET_CHARS} characters` +
        (assembled.dropped.length > 0 ? `; ${assembled.dropped.length} left out for budget` : '') +
        (assembled.notInContent.length > 0
          ? `; ${assembled.notInContent.length} left out because the content text does not contain them`
          : '')
    );
  }

  if (run.plan.assembleHashtags) {
    const titles = Array.isArray(merged.titles) ? (merged.titles as unknown[]) : [];
    const hashtags = buildHashtags({
      entities: ctx.entities,
      keyPhrases: ctx.keyPhrases,
      // Deduped against the FIRST title, which is the one the operator publishes by default.
      title: typeof titles[0] === 'string' ? (titles[0] as string) : ctx.videoTitle,
      // The channel's own brand tag, when the prompt set declares channel_tags. Never
      // invented: a channel with no declared tag simply gets one fewer hashtag.
      brandTag: aiManager.channelTags()[0],
    });
    merged.hashtags = hashtagLine(hashtags);
    log.info(`[MetadataTasks] ${ctx.sourceLabel}: derived ${hashtags.length} hashtag(s) in code: ${merged.hashtags}`);
  }
}

/**
 * The same prompts, assembled but not sent, for the "Show prompt" flow.
 *
 * Each one is banner-labelled with its unit because the frontend renders a job's prompts
 * as a single scrollable string; unlabelled, several prompts sharing an editorial preamble
 * read as one repetitive prompt. The text under each banner is the literal request.
 */
export function buildTaskPromptsForDisplay(run: MetadataTaskRun): string[] {
  return run.plan.units.map(
    (unit) => `=== UNIT: ${unit.label} (${run.ctx.sourceLabel}) ===\n\n${unit.describePrompt(run.ctx)}`
  );
}
