/**
 * Per-task metadata generation
 *
 * The metadata call used to be one request that returned every field at once. It is
 * being taken apart field by field, because the fields are migrating to local
 * fine-tuned adapters one at a time (headline-14b-titles, headline-14b-descriptions and
 * headline-14b-tags exist; thumbnail text, pinned comments and clips have no adapter).
 * A single call cannot migrate by halves, so generation is split into UNITS, and
 * metadata-routing.ts says which model each field's unit runs on.
 *
 * A run's units come out of the routing in two kinds:
 *
 *   local  — one adapter call per field (description, tags, titles). Plain text in,
 *            plain text out, no JSON anywhere.
 *   cloud  — the cloud-routed fields GROUPED BY MODEL: one call per distinct model,
 *            carrying exactly that group's prompt-set sections and an OUTPUT FORMAT
 *            naming exactly that group's keys. Two fields on Sonnet and one on Opus is
 *            two calls, not three — a model asked for three fields at once writes them
 *            as one coherent package, which is the whole reason packaging used to be a
 *            single call.
 *
 * description and tags drop the transcript deliberately. Per CHAPTERING.md the adapters
 * condition on the curated subject list, so conditioning the cloud calls on the SAME
 * inputs means flipping a field to its adapter changes the model and nothing else. The
 * chapter `detail` prose exists precisely to carry the description-grade specifics the
 * transcript would otherwise have to supply.
 *
 * This only applies when chapters exist. Without them the legacy single call runs
 * unchanged — that is a mode decision based on what data is available, made and logged
 * up front, not a recovery from an error.
 */

import axios, { AxiosInstance } from 'axios';
import { spawn, ChildProcess } from 'child_process';
import * as log from 'electron-log';
import { SYSTEM_PROMPTS, formatPrompt } from './system-prompts';
import { queueAITask } from '../queue-manager.service';
import {
  METADATA_ROUTING_OPTIONS,
  MetadataRoutingOption,
  MetadataRoutingTaskId,
  ResolvedMetadataRouting,
} from './metadata-routing';
// Type-only: the units receive an AIManagerService instance, they never construct one.
// A value import here would close an import cycle (ai-manager imports this module for
// its section parser) and break at require() time.
import type { AIManagerService, MetadataResult } from './ai-manager.service';

/**
 * A metadata field a unit can be responsible for.
 *
 * `hashtags` and `spoken_keywords` are not routable tasks — see METADATA_ROUTING_TASKS.
 * Hashtags follow the description (the description adapter writes its own hashtag line);
 * spoken keywords exist only in the shorts prompt set and ride with whichever group
 * absorbs the sections no unit claimed.
 */
export type MetadataFieldId =
  | 'titles'
  | 'description'
  | 'tags'
  | 'thumbnail_text'
  | 'pinned_comment'
  | 'clip_suggestions'
  | 'hashtags'
  | 'spoken_keywords';

/** The routable tasks that produce a metadata field, in the order units run. */
const FIELD_TASKS: Array<{ task: MetadataRoutingTaskId; field: MetadataFieldId }> = [
  { task: 'description', field: 'description' },
  { task: 'tags', field: 'tags' },
  { task: 'titles', field: 'titles' },
  { task: 'thumbnail_text', field: 'thumbnail_text' },
  { task: 'pinned_comment', field: 'pinned_comment' },
  { task: 'clip_suggestions', field: 'clip_suggestions' },
];

/**
 * Everything a unit needs about the ITEM. Which model, which fields and which sections
 * are properties of the unit itself, decided once when the run is planned.
 */
export interface MetadataRunContext {
  /** Transcript or summary. Reaches only the units whose fields need it. */
  content: string;
  sourceLabel: string;
  chapterSubjects: string[];
  /** Index-aligned with chapterSubjects; entries may be blank. */
  chapterDetails: string[];
}

export interface MetadataUnit {
  /** For logs and the "Show prompt" banner, e.g. `description (local headline-14b-descriptions)`. */
  readonly label: string;
  /** The metadata keys this unit is responsible for returning. */
  readonly fields: MetadataFieldId[];
  /**
   * The exact text this unit would send. The "Show prompt" flow exists to let the user
   * read what will actually be sent, so a unit that cannot show its request must refuse
   * here for the same reason it would refuse to run.
   */
  describePrompt(ctx: MetadataRunContext): string;
  /** Resolves to only the fields this unit owns. */
  generate(ctx: MetadataRunContext): Promise<Record<string, unknown>>;
  /**
   * Release whatever this unit is holding after the last unit of a run. Only a unit with
   * resident state implements it — a cloud request has nothing to let go of, and
   * pretending otherwise would put an empty method on the seam.
   */
  unload?(): Promise<void>;
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
 * Each field's prompt-set section, the JSON shape hint it contributes to a group's
 * OUTPUT FORMAT, and whether it needs the transcript.
 *
 * The metadata keys are the ones parseMetadataResponse / normalizeMetadataKeys already
 * expect (see metadata-fields.ts) — a unit that named a key outside that registry would
 * produce a field nothing downstream reads.
 *
 * `needsTranscript` is the conditioning rule from CHAPTERING.md, stated per field rather
 * than per call: description, tags and hashtags are written from the chapter subject
 * list alone (that is what their adapters get, so that is what the cloud gets), while
 * titles, thumbnails, pinned comments and clips are written from the video.
 */
interface MetadataFieldSpec {
  section: string;
  shape: string;
  needsTranscript: boolean;
}

export const METADATA_FIELD_SECTIONS: Record<MetadataFieldId, MetadataFieldSpec> = {
  titles: { section: 'TITLES', shape: '["string", ...]', needsTranscript: true },
  description: { section: 'DESCRIPTION', shape: '"one string"', needsTranscript: false },
  tags: { section: 'TAGS', shape: '"comma-separated string"', needsTranscript: false },
  thumbnail_text: { section: 'THUMBNAIL_TEXT', shape: '["string", ...]', needsTranscript: true },
  pinned_comment: { section: 'PINNED_COMMENT', shape: '["string", ...]', needsTranscript: true },
  clip_suggestions: { section: 'CLIP_SUGGESTIONS', shape: '["string", ...]', needsTranscript: true },
  hashtags: { section: 'HASHTAGS', shape: '"#One #Two #Three"', needsTranscript: false },
  spoken_keywords: { section: 'SPOKEN_KEYWORDS', shape: '["string", ...]', needsTranscript: true },
};

/** Canonical section key -> field, for reading a prompt set back the other way. */
const SECTION_TO_FIELD: Record<string, MetadataFieldId> = Object.fromEntries(
  (Object.entries(METADATA_FIELD_SECTIONS) as Array<[MetadataFieldId, MetadataFieldSpec]>).map(
    ([field, spec]) => [spec.section, field]
  )
);

/**
 * Sections no unit may carry as instructions: chapters are code-owned (the pipeline
 * measures them), and these two are rebuilt or placed per group.
 */
const CODE_OWNED_SECTIONS = new Set(['CHAPTERS', 'OUTPUT_FORMAT', 'FINAL_SELF-CHECK']);

function buildOutputFormat(fields: MetadataFieldId[]): string {
  const keyLines = fields.map((f) => `  "${f}": ${METADATA_FIELD_SECTIONS[f].shape}`).join(',\n');
  return formatPrompt(SYSTEM_PROMPTS.TASK_OUTPUT_FORMAT, { keyLines });
}

/** Does this group's call need the transcript, or does the chapter list stand in for it? */
export function groupNeedsTranscript(fields: MetadataFieldId[]): boolean {
  return fields.some((f) => METADATA_FIELD_SECTIONS[f].needsTranscript);
}

export interface TaskInstructions {
  /** The instruction block for this group, ending in its own OUTPUT FORMAT. */
  text: string;
  /** Metadata keys this group is responsible for returning. */
  metadataKeys: MetadataFieldId[];
}

/**
 * What a cloud group is, as both the prompt builder and the key checker read it.
 *
 * Declared once and passed to both so a group cannot be ASKED for one set of keys and
 * CHECKED for another — the two are derived from the same call to buildGroupInstructions.
 */
export interface MetadataGroupSpec {
  /** Provider-prefixed model this group's single call runs on. */
  model: string;
  /** The fields routed to this model, in prompt-set order. */
  fields: MetadataFieldId[];
  /** Canonical section keys other units own. Never absorbed, never sent here. */
  ownedElsewhere: Set<string>;
  /** This group carries the sections no unit claimed (see below). Exactly one group does. */
  absorbUnownedSections: boolean;
  /** This group carries the prompt set's FINAL SELF-CHECK. Exactly one group does. */
  selfCheck: boolean;
  /** This group carries the CHANNEL PERFORMANCE DATA block. At most one group does. */
  insights: boolean;
}

/**
 * Assemble one group's instructions out of the prompt set's own sections.
 *
 * Sections are emitted in the PROMPT SET's order, not the group's, because a prompt set
 * is written to be read top to bottom and its own ordering is editorial. The set's
 * "## OUTPUT FORMAT" is replaced in place by one naming exactly this group's keys — a
 * model told to return seven keys returns seven, and the six that belong to other units
 * would be thrown away or, worse, merged over another unit's real answer.
 *
 * STRICT by design: a group whose field has no section throws naming the prompt set and
 * the section. The alternative — sending the call anyway with no field rules — produces
 * metadata that looks generated but was written to no brief at all, and nothing
 * downstream can tell the difference.
 *
 * `absorbUnownedSections` is how a user-extended prompt set survives the split. A section
 * no unit claimed is either a known field nobody routed (SPOKEN KEYWORDS, which only the
 * shorts set has and which no task in the registry routes) or something the user added
 * themselves. Both ride with the absorbing group: the known one contributes its output
 * key, the unknown one contributes instructions and a warning saying it produced no
 * field. Note that absorbing does NOT change the group's content slot — an absorbed
 * transcript-hungry section rides in whatever slot its host group already had.
 */
export function buildGroupInstructions(
  spec: MetadataGroupSpec,
  sections: InstructionSection[],
  promptSetName: string
): TaskInstructions {
  const wanted = new Map<string, MetadataFieldId>();
  for (const field of spec.fields) {
    const sectionKey = METADATA_FIELD_SECTIONS[field].section;
    if (!sections.some((s) => s.key === sectionKey)) {
      throw new Error(
        `Prompt set "${promptSetName}" has no "## ${sectionKey}" section, so the "${field}" field has no instructions ` +
          `(sections found: ${sections.map((s) => s.header).join(', ') || 'none'})`
      );
    }
    wanted.set(sectionKey, field);
  }

  const kept: string[] = [];
  const keys: MetadataFieldId[] = [];
  let outputFormatPlaced = false;

  for (const section of sections) {
    if (section.key === 'OUTPUT_FORMAT') {
      // Placeholder, so the rebuilt block lands exactly where the prompt set put it.
      kept.push('__OUTPUT_FORMAT__');
      outputFormatPlaced = true;
      continue;
    }
    if (section.key === 'FINAL_SELF-CHECK') {
      if (spec.selfCheck) kept.push(section.text);
      continue;
    }
    if (section.key === 'CHAPTERS') continue;

    const mine = wanted.get(section.key);
    if (mine) {
      keys.push(mine);
      kept.push(section.text);
      continue;
    }

    if (spec.ownedElsewhere.has(section.key) || !spec.absorbUnownedSections) continue;

    const orphanField = SECTION_TO_FIELD[section.key];
    if (orphanField) {
      keys.push(orphanField);
    } else {
      // A section this code has no output key for still reaches the model — the YAMLs
      // are the user's to extend — but it contributes nothing to the JSON, and a user
      // who added it expecting a field back needs to see why they never got one.
      log.warn(
        `[MetadataTasks] Prompt set "${promptSetName}" section "## ${section.header}" has no known output key; ` +
          `its instructions are sent with the ${spec.model} group but it contributes no JSON field`
      );
    }
    kept.push(section.text);
  }

  if (keys.length === 0) {
    throw new Error(
      `Prompt set "${promptSetName}" produced no output keys for the ${spec.model} group ` +
        `(fields routed to it: ${spec.fields.join(', ') || 'none'})`
    );
  }

  const outputFormat = buildOutputFormat(keys);
  if (!outputFormatPlaced) {
    // No "## OUTPUT FORMAT" in the prompt set to replace in place. Put ours ahead of the
    // self-check, which reads as the closing instruction.
    const selfCheck = kept.findIndex((part) => part.startsWith('## FINAL SELF-CHECK'));
    if (selfCheck === -1) kept.push('__OUTPUT_FORMAT__');
    else kept.splice(selfCheck, 0, '__OUTPUT_FORMAT__');
  }

  return {
    text: kept.map((part) => (part === '__OUTPUT_FORMAT__' ? outputFormat.trim() : part)).join('\n\n'),
    metadataKeys: keys,
  };
}

// ---------------------------------------------------------------------------
// The cloud groups
// ---------------------------------------------------------------------------

/**
 * The seam's first implementation: the same Claude/OpenAI request, JSON parse and repair
 * machinery the single-call path has always used, pointed at ONE MODEL'S share of the
 * fields.
 *
 * One instance per distinct cloud model in the routing. The fields it carries are the
 * ones the user pointed at that model, so a run with everything on Sonnet is a single
 * call that looks very like the old whole-metadata call, and a run that moves thumbnails
 * to Opus becomes two calls — never one call per field, which would cost more and lose
 * the coherence between a title and the thumbnail text written to sit beside it.
 */
export class CloudGroupUnit implements MetadataUnit {
  readonly label: string;
  readonly fields: MetadataFieldId[];

  constructor(
    private readonly aiManager: AIManagerService,
    private readonly spec: MetadataGroupSpec
  ) {
    this.fields = spec.fields;
    this.label = `${spec.fields.join(' + ')} (cloud ${spec.model})`;
  }

  describePrompt(ctx: MetadataRunContext): string {
    return this.aiManager.buildMetadataGroupPrompt(this.spec, ctx);
  }

  async generate(ctx: MetadataRunContext): Promise<Record<string, unknown>> {
    const expected = this.aiManager.metadataGroupKeys(this.spec);
    const { metadata, presentKeys } = await this.aiManager.runMetadataRequest(
      this.describePrompt(ctx),
      this.spec.model
    );

    // Take ONLY this group's keys. A response also carries the registry's other keys as
    // empty arrays / undefined (normalizeMetadataKeys fills the whole registry), and
    // merging those over another unit's real answer would blank it.
    const picked: Record<string, unknown> = {};
    for (const key of expected) {
      if (!presentKeys.has(key)) {
        throw new Error(
          `Metadata group ${this.spec.model} for ${ctx.sourceLabel} returned no "${key}" — the response must contain ` +
            `every key named in that group's OUTPUT FORMAT (got: ${Array.from(presentKeys).join(', ') || 'nothing'})`
        );
      }
      picked[key] = (metadata as Record<string, unknown>)[key];
    }
    return picked;
  }
}

// ---------------------------------------------------------------------------
// The local adapters
// ---------------------------------------------------------------------------

/**
 * The system prompts the description and tags adapters were TRAINED ON, byte for byte.
 *
 * These are not instructions in the editable sense — they are half of the model's input
 * distribution. Every example in the training set paired one of these strings with a
 * user turn in the exact shape buildAdapterUserTurn writes, and a LoRA conditioned that
 * tightly degrades on a reworded system prompt in ways that do not look like failure:
 * it keeps answering, just off-brief. So they live in code, not in the prompt-set YAMLs
 * the user edits, and they change only when an adapter is retrained.
 *
 * Note what they hand back to code: the description adapter writes its own hashtag line
 * (parsed out here into the `hashtags` field), and the tags adapter deliberately omits
 * channel and creator names because those are appended downstream.
 */
export type AdapterTask = 'description' | 'tags' | 'titles';

/**
 * The wire name for `task:` in the user turn.
 *
 * `titles` is the ContentStudio field; `title` is what the training set wrote, because
 * the adapter writes ONE title per call. The field name and the trained token are not the
 * same string and must not be conflated — the mapping is here, once.
 */
const ADAPTER_WIRE_TASK: Record<AdapterTask, string> = {
  description: 'description',
  tags: 'tags',
  titles: 'title',
};

const ADAPTER_SYSTEM_PROMPTS: Record<AdapterTask, string> = {
  description:
    'You write YouTube descriptions for independent commentary channels covering religion, politics ' +
    'and the far right. Given the list of subjects a video covers, write its description in three parts: ' +
    'one hook sentence of roughly 10-16 words saying what the video covers and why it matters; then a body ' +
    'of 2-4 sentences expanding on it with the real names and claims; then a final line of 3 to 5 hashtags. ' +
    'Every name and claim must come from the subjects. No links, no promo, no calls to subscribe and no ' +
    'timestamps - the chapter block and the standing links are assembled by code at release.',
  tags:
    'You write YouTube tags for independent commentary channels covering religion, politics and the far ' +
    'right. Given the list of subjects a video covers, write 5 to 7 comma-separated tags: the most specific ' +
    'two-to-four-word phrase for the main subject first, then the named people, organizations and events it ' +
    'covers, then the broad category terms it belongs to. Accurate and boring beats clever - tags are a ' +
    'labelling job, not a hook. No channel names and no creator names - those are appended separately.',
  titles:
    'You write YouTube titles for independent commentary channels covering religion, politics and the far ' +
    'right - the atheist, ex-religious, skeptic and left-of-centre corner of YouTube. Given a description of ' +
    'a video, write one title. Name names; plain concrete language, no corporate phrasing; be the prosecutor, ' +
    'not the journalist - state what happened and why it matters, don\'t hedge. Specificity plus an open loop ' +
    'beats vague drama. This is a standard upload: the hook lands inside the first 45 characters and the whole ' +
    'title runs 45-70 characters, covering one story.',
};

/**
 * The user turn, in the training set's exact shape.
 *
 * It conditions on the SHORT subject lines only — stage 4's 4-8 word `about` strings —
 * and never on the `detail` prose the cloud calls get. That is not a simplification: the
 * adapters only ever saw this list, and feeding them a paragraph per subject is out of
 * distribution.
 *
 * `format` is always `normal`. The training data also carries a livestream format, but
 * ContentStudio has no flag that distinguishes the two, and guessing which one a video
 * is would be inventing an input.
 */
function buildAdapterUserTurn(task: AdapterTask, subjects: string[]): string {
  const lines = subjects.map((s) => s.trim()).filter((s) => s.length > 0);
  if (lines.length === 0) {
    throw new Error(
      `Metadata task "${task}" is routed to a local adapter but the chapter subject list is empty — ` +
        `the adapter conditions on that list and has nothing else to work from`
    );
  }
  // Titles rows in the training set carry a third header line, `target:` — the CTR tier
  // the title should aim for (top-decile | strong | typical | weak; all 7,497 title rows
  // have one). AutoCutStudio's reference client (title-generator.ts buildUserPrompt)
  // sends it; this port originally dropped it, which put every titles call OFF the
  // trained input distribution. Production asks top-decile per HEADLINE.md. Description
  // and tags rows have no target line — adding one there would be equally off-brief.
  const target = task === 'titles' ? '\ntarget: top-decile' : '';
  return `task: ${ADAPTER_WIRE_TASK[task]}\nformat: normal${target}\n\nVideo:\n${lines.map((s) => `- ${s}`).join('\n')}`;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Long enough to hold the model across the description -> tags gap in one run. */
const ADAPTER_KEEP_ALIVE = '10m';
/** A 14B writing three sentences is seconds of work; five minutes is a wedged server. */
const ADAPTER_TIMEOUT_MS = 300_000;

/** How many titles the titles adapter is sampled for. One call per candidate. */
const TITLE_CANDIDATES = 6;
/** A title is one line; 64 tokens is generous for 70 characters and cheap to sample. */
const TITLE_NUM_PREDICT = 64;
/** The titles adapter's evaluated sampling settings. Not greedy — see the class comment. */
const TITLE_SAMPLING = { temperature: 0.7, top_p: 0.9, num_predict: TITLE_NUM_PREDICT };

/**
 * The seam's second implementation: one fine-tuned adapter, on a local Ollama-shaped host.
 *
 * Three tasks have a LoRA over qwen3:14b, one contract each (ADAPTER_SYSTEM_PROMPTS), and
 * ONE instance of this class serves ONE task — the models differ, the hosts can differ
 * (the 32B titles model is an MLX shim on its own port), and a run releases each one it
 * made resident.
 *
 * Decoding differs by task, and deliberately:
 *   description, tags — greedy (`temperature 0`), because a metadata run that returns a
 *     different description each time it is re-run cannot be reviewed, and greedy is what
 *     those adapters were evaluated at.
 *   titles — SAMPLED (temperature 0.7 / top_p 0.9), because the field is a LIST of
 *     alternatives. Greedy decoding would return the same title six times; the point of
 *     six candidates is six different bets.
 *
 * They answer in PLAIN TEXT, not JSON. That is the whole shape difference from the cloud
 * unit: no JSON parse, no key registry, no repair loop — a description is a description,
 * and the mapping from text to fields happens here.
 *
 * There is no local->cloud rescue anywhere in this class: a task the user routed to an
 * adapter either runs on that adapter or fails saying why.
 */
/** Model load + warmup measured at ~16s; the margin covers a cold external volume. */
const SHIM_READY_TIMEOUT_MS = 120_000;

export class LocalAdapterUnit implements MetadataUnit {
  readonly label: string;
  readonly fields: MetadataFieldId[];

  private readonly client: AxiosInstance;
  private readonly host: string;
  private readonly model: string;
  private readonly startHint?: string;
  private readonly startCommand?: string[];
  /** Models this run actually made resident — the exact set unload() releases. */
  private readonly loaded = new Set<string>();
  /** The host process THIS UNIT spawned. One found already listening is never owned, never stopped. */
  private shim?: ChildProcess;
  /** The spawned host's most recent output lines, for the error when it fails to come up. */
  private shimOutput: string[] = [];

  constructor(
    private readonly task: AdapterTask,
    option: MetadataRoutingOption,
    defaultHost: string,
    /** True when this run's `hashtags` come from the description adapter's last line. */
    private readonly ownsHashtags: boolean
  ) {
    if (option.kind !== 'local') {
      throw new Error(
        `Metadata task "${task}" was planned as a local adapter but option "${option.label}" is a ${option.kind} model`
      );
    }
    this.host = option.host || defaultHost;
    this.model = option.model;
    this.startHint = option.startHint;
    this.startCommand = option.startCommand;
    // The description adapter's trained output ENDS with a hashtag line, so this unit
    // returns `hashtags` whether or not the prompt set has a "## HASHTAGS" section —
    // there is no way to ask the adapter for a description without one, and dropping the
    // line it wrote would be discarding output the model actually produced.
    this.fields = task === 'description' && ownsHashtags ? ['description', 'hashtags'] : [task];
    this.label = `${task} (local ${this.model} @ ${this.host})`;
    this.client = axios.create({
      baseURL: this.host,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  describePrompt(ctx: MetadataRunContext): string {
    const messages = this.buildConversation(ctx);
    const decoding = this.task === 'titles'
      ? `temperature ${TITLE_SAMPLING.temperature}, top_p ${TITLE_SAMPLING.top_p}, ${TITLE_CANDIDATES} candidates`
      : 'temperature 0';
    return (
      `# LOCAL ADAPTER: ${this.model} @ ${this.host} (ollama /api/chat, think:false, ${decoding})\n\n` +
      messages.map((m) => `--- ${m.role.toUpperCase()} ---\n${m.content}`).join('\n\n')
    );
  }

  async generate(ctx: MetadataRunContext): Promise<Record<string, unknown>> {
    await this.ensureHostUp();
    const messages = this.buildConversation(ctx);

    if (this.task === 'titles') {
      return { titles: await this.generateTitles(messages, ctx) };
    }

    const answer = await this.chat(messages, ctx.sourceLabel, { temperature: 0 });

    return this.task === 'description'
      ? splitDescriptionAndHashtags(answer, this.task, this.model, ctx.sourceLabel)
      : { tags: normalizeAdapterTags(answer, this.task, this.model, ctx.sourceLabel) };
  }

  /**
   * Let the resident adapter go. Housekeeping only: a failure here costs VRAM until the
   * server's own keep-alive timer fires, which is not worth failing a finished run over
   * — the same call the chapter pipeline makes for the same reason.
   */
  async unload(): Promise<void> {
    // A host this unit spawned is stopped outright: the shim's own contract is that
    // its memory comes back when the process exits (its keep_alive eviction is a
    // deliberate no-op). One the user started stays theirs.
    if (this.shim) {
      log.info(`[MetadataTasks] stopping the "${this.model}" server this run started (releases its memory)`);
      this.shim.kill('SIGTERM');
      this.shim = undefined;
      this.loaded.clear();
      return;
    }
    for (const model of this.loaded) {
      try {
        await this.client.post('/api/generate', { model, prompt: '', keep_alive: 0 }, { timeout: 30_000 });
      } catch (error: any) {
        console.warn(`[MetadataTasks] Could not unload "${model}": ${error?.message || error}`);
      }
    }
    this.loaded.clear();
  }

  // --------------------------------------------------------------- managed host

  /**
   * App-managed adapter hosts (the 32B MLX shim) are started HERE, before the first
   * request, as a planned part of running the task — not as recovery from a failed one.
   * A server found already listening is used and left alone; one this unit spawns is
   * owned by the unit, tracked in `shim`, and stopped in unload() (which runMetadataTasks
   * calls in a finally, so a spawned host cannot outlive its run even when it fails).
   *
   * Readiness is GET /api/tags answering: the shim only opens its port after the model
   * is loaded and warmed (~16s measured), so a 200 means ready, not merely started.
   */
  private async ensureHostUp(): Promise<void> {
    if (!this.startCommand || this.shim) return;
    if (await this.hostAnswers()) return;

    const [command, ...args] = this.startCommand;
    log.info(
      `[MetadataTasks] "${this.model}": nothing is listening on ${this.host} — starting it: ${this.startCommand.join(' ')}`
    );
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.shim = child;
    this.shimOutput = [];
    const capture = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        log.info(`[${this.model}] ${trimmed}`);
        this.shimOutput.push(trimmed);
        if (this.shimOutput.length > 20) this.shimOutput.shift();
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    let exited = false;
    child.on('exit', (code) => {
      exited = true;
      if (this.shim === child) this.shim = undefined;
      log.info(`[MetadataTasks] "${this.model}" server exited with code ${code}`);
    });

    const deadline = Date.now() + SHIM_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(
          `Metadata task "${this.task}" started the server for "${this.model}" ` +
            `(${this.startCommand.join(' ')}) and it exited before answering on ${this.host}. ` +
            `Its last output:\n${this.shimOutput.join('\n') || '(none)'}`
        );
      }
      if (await this.hostAnswers()) {
        log.info(
          `[MetadataTasks] "${this.model}" is up on ${this.host} (started by this run; stopped when the run finishes)`
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    child.kill('SIGTERM');
    throw new Error(
      `Metadata task "${this.task}" started the server for "${this.model}" and it did not become ready on ` +
        `${this.host} within ${SHIM_READY_TIMEOUT_MS / 1000}s. Its last output:\n${this.shimOutput.join('\n') || '(none)'}`
    );
  }

  private async hostAnswers(): Promise<boolean> {
    try {
      await this.client.get('/api/tags', { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ conversation

  private buildConversation(ctx: MetadataRunContext): ChatMessage[] {
    return [
      { role: 'system', content: ADAPTER_SYSTEM_PROMPTS[this.task] },
      { role: 'user', content: buildAdapterUserTurn(this.task, ctx.chapterSubjects) },
    ];
  }

  // ------------------------------------------------------------------------- titles

  /**
   * Six samples of one title, deduped into the `titles` list.
   *
   * Six SEQUENTIAL calls, not six parallel ones: the adapter is resident on one GPU
   * behind a one-slot queue, so parallel requests would only queue anyway.
   *
   * Every distinct candidate is returned — the user picks. (An invented-name guard used
   * to drop candidates here and hard-fail descriptions; removed 2026-08-19 at the user's
   * direction after it false-positived on real references the subject lines didn't carry.)
   */
  private async generateTitles(messages: ChatMessage[], ctx: MetadataRunContext): Promise<string[]> {
    const raw: string[] = [];
    for (let i = 0; i < TITLE_CANDIDATES; i++) {
      raw.push(await this.chat(messages, ctx.sourceLabel, TITLE_SAMPLING));
    }

    const seen = new Set<string>();
    const distinct: string[] = [];
    for (const candidate of raw) {
      const title = candidate.trim();
      if (title.includes('\n')) {
        // The adapter writes ONE title per call. More than one line is a departure from
        // the trained output shape, and what else departed is unknown.
        log.warn(
          `[MetadataTasks] ${ctx.sourceLabel}: dropped a titles candidate that came back as more than one line ` +
            `("${title.replace(/\n/g, ' / ').slice(0, 120)}")`
        );
        continue;
      }
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push(title);
    }

    if (distinct.length < 3) {
      throw new Error(
        `Metadata task "titles" for ${ctx.sourceLabel} on model "${this.model}" produced only ${distinct.length} ` +
          `distinct title(s) from ${TITLE_CANDIDATES} samples — a title list the user cannot choose from is not a ` +
          `title list (got: ${distinct.map((t) => `"${t}"`).join(', ') || 'nothing'})`
      );
    }

    log.info(
      `[MetadataTasks] ${ctx.sourceLabel}: titles adapter kept ${distinct.length} distinct candidate(s) ` +
        `from ${TITLE_CANDIDATES} samples on "${this.model}"`
    );
    return distinct;
  }

  // -------------------------------------------------------------------- the request

  /**
   * One /api/chat call, through the single-slot AI queue.
   *
   * The queue slot is not optional bookkeeping: this is a 14B on the same GPU the
   * chapter pipeline just finished using, and the 1-concurrent AI pool is what stops two
   * of them being resident at once. It is the same slot the cloud call this replaces
   * took (AIManagerService.makeRequest queues every provider request), so routing a task
   * local adds no concurrency — it swaps what happens inside one slot.
   */
  private async chat(
    messages: ChatMessage[],
    sourceLabel: string,
    options: Record<string, number>
  ): Promise<string> {
    const requestId = Math.random().toString(36).substring(7);
    const model = this.model;
    const task = this.task;

    const text = await queueAITask<string>(
      `local-${task}-${requestId}`,
      `Local adapter: ${task} (${model})`,
      async () => {
        let data: any;
        try {
          const response = await this.client.post(
            '/api/chat',
            {
              model,
              messages,
              stream: false,
              think: false,
              keep_alive: ADAPTER_KEEP_ALIVE,
              options,
            },
            { timeout: ADAPTER_TIMEOUT_MS }
          );
          data = response.data;
        } catch (error: any) {
          const status = error?.response?.status;
          const detail = error?.response?.data?.error || error?.message || 'unknown error';
          if (status === 404) {
            throw new Error(
              `Metadata task "${task}" needs model "${model}", which is not installed on ${this.host}. ` +
                `Install it with: ollama pull ${model}  (or, for a local adapter build, ollama create ${model} -f Modelfile)`
            );
          }
          // Nothing is listening on that port. For the shim-hosted models this is the
          // expected first failure — the shim is a separate process the user starts —
          // so the error says what the port is and how to bring it up, instead of
          // leaving them to work out what ECONNREFUSED on 11435 means.
          if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND') {
            throw new Error(
              `Metadata task "${task}" is routed to "${model}" at ${this.host}, and nothing is listening there` +
                (this.startHint ? ` — ${this.startHint}` : '') +
                `. No cloud model was substituted: the task runs where it was routed or not at all.`
            );
          }
          if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
            throw new Error(
              `Metadata task "${task}" for ${sourceLabel} timed out after ${ADAPTER_TIMEOUT_MS / 1000}s on model "${model}"`
            );
          }
          throw new Error(
            `Metadata task "${task}" for ${sourceLabel} failed on model "${model}" @ ${this.host}: ${detail}`
          );
        }

        this.loaded.add(model);
        return typeof data?.message?.content === 'string' ? data.message.content : '';
      }
    );

    if (text.trim().length === 0) {
      throw new Error(
        `Metadata task "${task}" for ${sourceLabel} came back empty from model "${model}" — ` +
          `the adapter returned no text at all`
      );
    }
    return text.trim();
  }
}

// ---------------------------------------------------------------------------
// Plain-text output mapping
// ---------------------------------------------------------------------------

/** A hashtag line and nothing else: "#megachurch #biblecurriculum #streetpreacher". */
const HASHTAG_LINE = /^#\S+( #\S+)*$/;

/**
 * Split the description adapter's answer into the `description` and `hashtags` fields.
 *
 * The trailing hashtag line is part of the trained output shape, not a decoration, so an
 * answer without one is a MALFORMED generation rather than a description that happens to
 * have no hashtags: the model departed from its format, and whatever else it departed
 * from is unknown. Throw and say so.
 */
export function splitDescriptionAndHashtags(
  text: string,
  task: string,
  model: string,
  sourceLabel: string
): Record<string, unknown> {
  const lines = text.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim().length === 0) last--;

  // Interior whitespace is normalized before the test and in the stored value — the
  // separator between hashtags is not information, and finalizeMetadata normalizes it
  // again anyway. What is NOT normalized is the shape: a line with prose on it, or with
  // commas between the tags, is not this line and does not become it.
  const candidate = last >= 0 ? lines[last].trim().replace(/\s+/g, ' ') : '';
  if (!HASHTAG_LINE.test(candidate)) {
    throw new Error(
      `Metadata task "${task}" for ${sourceLabel} on model "${model}" returned no trailing hashtag line — ` +
        `the description adapter always ends with one, so this generation is malformed ` +
        `(last line was: ${candidate ? `"${candidate.slice(0, 120)}"` : 'empty'})`
    );
  }

  const description = lines.slice(0, last).join('\n').trim();
  if (description.length === 0) {
    throw new Error(
      `Metadata task "${task}" for ${sourceLabel} on model "${model}" returned a hashtag line and no description above it`
    );
  }

  return { description, hashtags: candidate };
}

/**
 * The tags adapter's one comma-separated line, in the shape the rest of the app reads.
 *
 * Deliberately identical to what normalizeMetadataKeys does to a cloud `tags` string —
 * split on commas, trim, drop any leading '#', re-join with commas — because the local
 * path bypasses that normalizer entirely and a differently-shaped tags field would
 * surface as a formatting bug in the .txt writer, far from here.
 */
export function normalizeAdapterTags(text: string, task: string, model: string, sourceLabel: string): string {
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

/** Fields with a trained adapter. Everything else is cloud-only until one exists. */
const ADAPTER_FIELDS: Record<string, AdapterTask> = {
  description: 'description',
  tags: 'tags',
  titles: 'titles',
};

export interface MetadataRunPlan {
  /** The units this run executes, in order: local adapters first, then cloud groups. */
  units: MetadataUnit[];
  /**
   * Which unit writes the `hashtags` field, decided from the routing alone.
   *
   * The description ADAPTER always ends with a hashtag line; the description CLOUD prompt
   * never does (the prompt set's own `## HASHTAGS` section is a separate section). So the
   * field follows the description task's model: locally it is parsed out of the
   * description adapter's own last line, and in the cloud the HASHTAGS section simply
   * joins whichever group already carries DESCRIPTION. Two units writing one field would
   * let the merge order decide the answer.
   */
  hashtagsOwnedByDescription: boolean;
  /** One line for the job log: which model writes what, and how many calls that is. */
  summary: string;
}

/**
 * Turn a resolved routing into the units that will run.
 *
 * The grouping rule is BY MODEL, not by field: every cloud-routed field that points at
 * the same model is written by one call. Splitting them would cost one request per field
 * and, worse, lose the coherence the prompt sets are written for — the self-check tells
 * the model its thumbnail text must not repeat words from its own titles, which is only
 * a rule it can follow if it wrote both.
 *
 * Three things ride with exactly one group each, and this is where that is decided:
 *   FINAL SELF-CHECK — the group with titles, else the largest group. It is mostly a
 *     statement about titles and thumbnails, and it cannot check fields its group did not
 *     write.
 *   the insights block — the group with titles; if titles are local, the first cloud
 *     group; if nothing is in the cloud, nowhere, and the log says so. Channel performance
 *     data speaks to packaging, and the local adapters were never trained to read it.
 *   unowned sections — the same group as the insights block. See buildGroupInstructions.
 */
export function planMetadataUnits(
  routing: ResolvedMetadataRouting,
  defaultHost: string,
  aiManager: AIManagerService,
  hasInsights: boolean
): MetadataRunPlan {
  const localPlans: Array<{ task: AdapterTask; option: MetadataRoutingOption }> = [];
  /** model -> fields, in first-appearance order (Map preserves insertion order). */
  const groupFields = new Map<string, MetadataFieldId[]>();

  // A field the PROMPT SET does not define is not generated at all, whatever the routing
  // says. The Spreaker podcast set has no "## THUMBNAIL_TEXT" and never did — that is the
  // set saying this channel has no thumbnails, not a section gone missing. Decided and
  // logged up front, per run, exactly like the chapters-or-not mode decision.
  const available = aiManager.promptSetSectionKeys();
  const skipped: string[] = [];

  for (const { task, field } of FIELD_TASKS) {
    if (!available.has(METADATA_FIELD_SECTIONS[field].section)) {
      skipped.push(field);
      continue;
    }
    const optionId = routing[task];
    const option = METADATA_ROUTING_OPTIONS[optionId];
    if (!option) {
      throw new Error(`Metadata task "${task}" is routed to unknown option "${optionId}"`);
    }
    if (option.kind === 'local') {
      const adapterTask = ADAPTER_FIELDS[field];
      if (!adapterTask) {
        throw new Error(
          `Metadata task "${task}" is routed to the local model "${option.model}", but no local adapter writes ` +
            `"${field}" — only description, tags and titles have one`
        );
      }
      localPlans.push({ task: adapterTask, option });
      continue;
    }
    const existing = groupFields.get(option.model);
    if (existing) existing.push(field);
    else groupFields.set(option.model, [field]);
  }

  if (skipped.length > 0) {
    log.info(
      `[MetadataTasks] the loaded prompt set defines no section for ${skipped.join(', ')}, so ` +
        `${skipped.length === 1 ? 'that field is' : 'those fields are'} not generated this run`
    );
  }
  if (localPlans.length === 0 && groupFields.size === 0) {
    throw new Error(
      `The loaded prompt set defines none of the metadata fields this app generates ` +
        `(${FIELD_TASKS.map((f) => f.field).join(', ')}), so there is nothing to run`
    );
  }

  const hashtagsOwnedByDescription = localPlans.some((p) => p.task === 'description');
  if (!hashtagsOwnedByDescription && available.has(METADATA_FIELD_SECTIONS.hashtags.section)) {
    // Cloud description: the HASHTAGS section joins the group that already has DESCRIPTION.
    for (const fields of groupFields.values()) {
      if (fields.includes('description')) {
        fields.push('hashtags');
        break;
      }
    }
  }

  const models = Array.from(groupFields.keys());
  const titlesModel = models.find((m) => groupFields.get(m)!.includes('titles'));
  const largestModel = models
    .slice()
    .sort((a, b) => groupFields.get(b)!.length - groupFields.get(a)!.length)[0];
  const selfCheckModel = titlesModel || largestModel;
  const primaryModel = titlesModel || models[0];

  if (models.length === 0) {
    log.info(
      '[MetadataTasks] every metadata field is routed to a local adapter: no cloud call runs, so the prompt set\'s ' +
        'self-check and the CHANNEL PERFORMANCE DATA block are unused this run (the adapters carry their own ' +
        'trained instructions and were not trained to read either)'
    );
  } else if (hasInsights && !titlesModel) {
    log.info(
      `[MetadataTasks] titles are not in the cloud this run, so the CHANNEL PERFORMANCE DATA block rides with the ` +
        `first cloud group (${primaryModel}) instead of the titles group`
    );
  }

  // Every field some OTHER unit owns, as canonical section keys, so a group never carries
  // instructions for a field it will not return.
  const ownerOf = new Map<string, string>();
  for (const plan of localPlans) ownerOf.set(METADATA_FIELD_SECTIONS[plan.task].section, `local:${plan.task}`);
  if (hashtagsOwnedByDescription) ownerOf.set(METADATA_FIELD_SECTIONS.hashtags.section, 'local:description');
  for (const [model, fields] of groupFields) {
    for (const field of fields) ownerOf.set(METADATA_FIELD_SECTIONS[field].section, `cloud:${model}`);
  }

  const units: MetadataUnit[] = localPlans.map(
    (plan) => new LocalAdapterUnit(plan.task, plan.option, defaultHost, hashtagsOwnedByDescription)
  );

  for (const [model, fields] of groupFields) {
    const ownedElsewhere = new Set<string>();
    for (const [section, owner] of ownerOf) {
      if (owner !== `cloud:${model}`) ownedElsewhere.add(section);
    }
    units.push(
      new CloudGroupUnit(aiManager, {
        model,
        fields,
        ownedElsewhere,
        absorbUnownedSections: model === primaryModel,
        selfCheck: model === selfCheckModel,
        insights: hasInsights && model === primaryModel,
      })
    );
  }

  const summary = units.map((u) => u.label).join(' | ');
  return { units, hashtagsOwnedByDescription, summary };
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
export async function runMetadataTasks(
  aiManager: AIManagerService,
  run: MetadataTaskRun
): Promise<MetadataResult> {
  const merged: Record<string, unknown> = {};
  const resident = run.plan.units.filter((u) => typeof u.unload === 'function');

  try {
    for (const unit of run.plan.units) {
      console.log(`[MetadataTasks] ${run.ctx.sourceLabel}: running unit ${unit.label}`);
      const fields = await unit.generate(run.ctx);
      Object.assign(merged, fields);
    }

    // Description links, the channel tag append and hashtag spacing are applied ONCE, to
    // the merged object. Per unit they could not be: the links append to a description one
    // unit returns, while the hashtags they sit beside come back from another — or, when
    // the description adapter runs, from that unit's own last line.
    return aiManager.finalizeMetadata(merged as MetadataResult);
  } finally {
    // A failed run leaves a 9.5GB adapter resident just as surely as a successful one, so
    // the release is in a finally. It only releases models that were actually loaded.
    for (const unit of resident) {
      await unit.unload!();
    }
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
