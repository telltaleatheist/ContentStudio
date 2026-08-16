/**
 * Per-task metadata generation
 *
 * The metadata call used to be one request that returned every field at once. It is
 * being taken apart field by field, because the fields are migrating to local
 * fine-tuned adapters one at a time (headline-14b-titles, headline-14b-descriptions and
 * headline-14b-tags exist; packaging has no adapter). A single call cannot migrate by
 * halves, so generation is split into TASK UNITS with a backend behind each one:
 *
 *   description — conditioned on the chapter subject list + details, NOT the transcript
 *   tags        — same conditioning as description
 *   packaging   — everything else (titles, thumbnail text, hashtags, pinned comment,
 *                 clip suggestions, spoken keywords), still conditioned on the
 *                 transcript/summary plus the chapters and the insights block
 *
 * description and tags drop the transcript deliberately. Per CHAPTERING.md the future
 * adapters condition on the curated subject list, so conditioning the cloud calls on the
 * SAME inputs means flipping a task to its adapter changes the backend and nothing else.
 * The chapter `detail` prose exists precisely to carry the description-grade specifics
 * the transcript would otherwise have to supply.
 *
 * This only applies when chapters exist. Without them the legacy single call runs
 * unchanged — that is a mode decision based on what data is available, made and logged
 * up front, not a recovery from an error.
 */

import axios, { AxiosInstance } from 'axios';
import * as log from 'electron-log';
import { SYSTEM_PROMPTS, formatPrompt } from './system-prompts';
import { queueAITask } from '../queue-manager.service';
// Type-only: the backends receive an AIManagerService instance, they never construct
// one. A value import here would close an import cycle (ai-manager imports this module
// for its section parser) and break at require() time.
import type { AIManagerService, MetadataResult } from './ai-manager.service';

export type MetadataTaskId = 'description' | 'tags' | 'packaging';

/** Order matters: description and tags are cheap and their failures should surface first. */
export const METADATA_TASK_ORDER: MetadataTaskId[] = ['description', 'tags', 'packaging'];

/**
 * Everything a task needs to state WHAT to generate, with no statement of how. A local
 * adapter and a cloud prompt read the same fields — the adapter would take
 * chapterSubjects/chapterDetails and ignore `content`, which is exactly the point of
 * conditioning the cloud calls on the same inputs today.
 */
export interface MetadataTaskInput {
  task: MetadataTaskId;
  /** Transcript or summary. Used by the packaging task only. */
  content: string;
  sourceLabel: string;
  chapterSubjects: string[];
  /** Index-aligned with chapterSubjects; entries may be blank. */
  chapterDetails: string[];
  /**
   * True when the DESCRIPTION task owns the `hashtags` field for this run.
   *
   * The description adapter was trained to end every description with its own hashtag
   * line, so when description runs locally that line IS the hashtags field. Packaging
   * must then not generate hashtags as well: two calls writing one field means the
   * merge order silently decides which one the user gets. Whichever unit does not own
   * the field is told so here, and drops it from both its instructions and its keys.
   */
  hashtagsOwnedByDescription: boolean;
}

export interface MetadataTaskBackend {
  /** Matches the routing config value ('cloud' | 'local'). */
  readonly id: string;
  /**
   * The exact text this backend would send. The "Show prompt" flow exists to let the
   * user read what will actually be sent, so a backend that cannot show its request
   * must refuse here for the same reason it would refuse to run.
   */
  describePrompt(input: MetadataTaskInput): string;
  /** Resolves to only the fields this task owns. */
  generate(input: MetadataTaskInput): Promise<Record<string, unknown>>;
  /**
   * Release whatever this backend is holding after the last task of a run. Only a
   * backend with resident state implements it — a cloud request has nothing to let go
   * of, and pretending otherwise would put an empty method on the seam.
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
 * Sections the packaging task owns, and the JSON shape hint each contributes to the
 * per-task OUTPUT FORMAT. The metadata keys are the ones parseMetadataResponse /
 * normalizeMetadataKeys already expect (see metadata-fields.ts) — a task that named a
 * key outside that registry would produce a field nothing downstream reads.
 */
const PACKAGING_SECTIONS: Record<string, { metadataKey: string; shape: string }> = {
  TITLES: { metadataKey: 'titles', shape: '["string", ...]' },
  THUMBNAIL_TEXT: { metadataKey: 'thumbnail_text', shape: '["string", ...]' },
  HASHTAGS: { metadataKey: 'hashtags', shape: '"#One #Two #Three"' },
  PINNED_COMMENT: { metadataKey: 'pinned_comment', shape: '["string", ...]' },
  CLIP_SUGGESTIONS: { metadataKey: 'clip_suggestions', shape: '["string", ...]' },
  SPOKEN_KEYWORDS: { metadataKey: 'spoken_keywords', shape: '["string", ...]' },
};

/** Sections the packaging task must NOT carry: two moved to their own units, one is code-owned. */
const PACKAGING_EXCLUDED = new Set(['DESCRIPTION', 'TAGS', 'CHAPTERS']);

const SINGLE_FIELD_TASKS: Record<'description' | 'tags', { section: string; metadataKey: string; shape: string }> = {
  description: { section: 'DESCRIPTION', metadataKey: 'description', shape: '"one string"' },
  tags: { section: 'TAGS', metadataKey: 'tags', shape: '"comma-separated string"' },
};

function buildOutputFormat(keys: Array<{ metadataKey: string; shape: string }>): string {
  const keyLines = keys.map((k) => `  "${k.metadataKey}": ${k.shape}`).join(',\n');
  return formatPrompt(SYSTEM_PROMPTS.TASK_OUTPUT_FORMAT, { keyLines });
}

export interface TaskInstructions {
  /** The instruction block for this task, ending in its own OUTPUT FORMAT. */
  text: string;
  /** Metadata keys this task is responsible for returning. */
  metadataKeys: string[];
}

/**
 * Assemble one task's instructions out of the prompt set's own sections.
 *
 * STRICT by design: a task whose section is missing throws naming the prompt set and the
 * section. The alternative — sending the call anyway with no field rules — produces
 * metadata that looks generated but was written to no brief at all, and nothing
 * downstream can tell the difference.
 */
export function buildTaskInstructions(
  task: MetadataTaskId,
  sections: InstructionSection[],
  promptSetName: string,
  options?: { hashtagsOwnedByDescription?: boolean }
): TaskInstructions {
  if (task === 'description' || task === 'tags') {
    const spec = SINGLE_FIELD_TASKS[task];
    const section = sections.find((s) => s.key === spec.section);
    if (!section) {
      throw new Error(
        `Prompt set "${promptSetName}" has no "## ${spec.section}" section, so the "${task}" task has no instructions ` +
          `(sections found: ${sections.map((s) => s.header).join(', ') || 'none'})`
      );
    }
    return {
      text: `${section.text}\n${buildOutputFormat([spec])}`,
      metadataKeys: [spec.metadataKey],
    };
  }

  // Packaging: everything the other two units did not take, with the prompt set's own
  // OUTPUT FORMAT swapped for one naming only the keys this call is responsible for.
  // The self-check section rides along untouched — it is the prompt set's last word on
  // titles and thumbnails, which is precisely what this call generates.
  const kept: string[] = [];
  const keys: Array<{ metadataKey: string; shape: string }> = [];
  let outputFormatPlaced = false;

  // HASHTAGS leaves packaging entirely when the description adapter owns them — the
  // section text goes too, not just the output key. Leaving the rules in while removing
  // the key would ask this call to follow instructions for a field it may not return.
  const excluded = options?.hashtagsOwnedByDescription
    ? new Set([...PACKAGING_EXCLUDED, 'HASHTAGS'])
    : PACKAGING_EXCLUDED;

  for (const section of sections) {
    if (excluded.has(section.key)) continue;

    if (section.key === 'OUTPUT_FORMAT') {
      kept.push('__OUTPUT_FORMAT__');
      outputFormatPlaced = true;
      continue;
    }

    const packaging = PACKAGING_SECTIONS[section.key];
    if (packaging) {
      keys.push(packaging);
    } else if (section.key !== 'FINAL_SELF-CHECK') {
      // A section this code has no output key for still reaches the model — the YAMLs
      // are the user's to extend — but it contributes nothing to the JSON, and a user
      // who added it expecting a field back needs to see why they never got one.
      log.warn(
        `[MetadataTasks] Prompt set "${promptSetName}" section "## ${section.header}" has no known output key; ` +
          `its instructions are sent with the packaging task but it contributes no JSON field`
      );
    }
    kept.push(section.text);
  }

  if (keys.length === 0) {
    throw new Error(
      `Prompt set "${promptSetName}" has no packaging sections (${Object.keys(PACKAGING_SECTIONS).join(', ')}), ` +
        `so the "packaging" task has nothing to generate`
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
    metadataKeys: keys.map((k) => k.metadataKey),
  };
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/**
 * The seam's first implementation: the same Claude/OpenAI/Ollama request, JSON parse and
 * repair machinery the single-call path has always used, pointed at one task's prompt.
 * Still the only backend that can generate packaging, and the way back for description
 * and tags when a run should not touch the local adapters.
 */
export class CloudTaskBackend implements MetadataTaskBackend {
  readonly id = 'cloud';

  constructor(private readonly aiManager: AIManagerService) {}

  describePrompt(input: MetadataTaskInput): string {
    return this.aiManager.buildMetadataTaskPrompt(input);
  }

  async generate(input: MetadataTaskInput): Promise<Record<string, unknown>> {
    const expected = this.aiManager.metadataTaskKeys(input);
    const { metadata, presentKeys } = await this.aiManager.runMetadataRequest(this.describePrompt(input));

    // Take ONLY this task's keys. A response also carries the registry's other keys as
    // empty arrays / undefined (normalizeMetadataKeys fills the whole registry), and
    // merging those over another task's real answer would blank it.
    const picked: Record<string, unknown> = {};
    for (const key of expected) {
      if (!presentKeys.has(key)) {
        throw new Error(
          `Metadata task "${input.task}" for ${input.sourceLabel} returned no "${key}" — the response must contain ` +
            `every key named in that task's OUTPUT FORMAT (got: ${Array.from(presentKeys).join(', ') || 'nothing'})`
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
const ADAPTER_SYSTEM_PROMPTS: Record<'description' | 'tags', string> = {
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
function buildAdapterUserTurn(task: 'description' | 'tags', subjects: string[]): string {
  const lines = subjects.map((s) => s.trim()).filter((s) => s.length > 0);
  if (lines.length === 0) {
    throw new Error(
      `Metadata task "${task}" is routed to a local adapter but the chapter subject list is empty — ` +
        `the adapter conditions on that list and has nothing else to work from`
    );
  }
  return `task: ${task}\nformat: normal\n\nVideo:\n${lines.map((s) => `- ${s}`).join('\n')}`;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Long enough to hold the model across the description -> tags gap in one run. */
const ADAPTER_KEEP_ALIVE = '10m';
/** A 14B writing three sentences is seconds of work; five minutes is a wedged server. */
const ADAPTER_TIMEOUT_MS = 300_000;

/**
 * The seam's second implementation: the fine-tuned adapters, on this machine's Ollama.
 *
 * Two tasks, two LoRAs over qwen3:14b, one contract each (ADAPTER_SYSTEM_PROMPTS). They
 * are chat models run greedily — `think: false`, temperature 0 — because a metadata run
 * that returns a different description each time it is re-run cannot be reviewed, and
 * because greedy decoding is what the adapters were evaluated at.
 *
 * They answer in PLAIN TEXT, not JSON. That is the whole shape difference from the cloud
 * backend: no JSON parse, no key registry, no repair loop — a description is a
 * description, and the mapping from text to fields happens here.
 *
 * There is NO adapter for packaging, and this class refuses that task rather than
 * pretending. There is also no local->cloud rescue anywhere in it: a task the user
 * routed to an adapter either runs on that adapter or fails saying why.
 */
export class LocalAdapterTaskBackend implements MetadataTaskBackend {
  readonly id = 'local';

  private readonly client: AxiosInstance;
  /** Models this run actually made resident — the exact set unload() releases. */
  private readonly loaded = new Set<string>();

  constructor(
    private readonly host: string,
    private readonly models: MetadataTaskModelConfig
  ) {
    this.client = axios.create({
      baseURL: host,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  describePrompt(input: MetadataTaskInput): string {
    const task = this.adapterTask(input.task);
    const model = this.modelFor(task);
    const messages = this.buildConversation(task, input);
    return (
      `# LOCAL ADAPTER: ${model} @ ${this.host} (ollama /api/chat, think:false, temperature 0)\n\n` +
      messages.map((m) => `--- ${m.role.toUpperCase()} ---\n${m.content}`).join('\n\n')
    );
  }

  async generate(input: MetadataTaskInput): Promise<Record<string, unknown>> {
    const task = this.adapterTask(input.task);
    const model = this.modelFor(task);
    const messages = this.buildConversation(task, input);

    const answer = await this.chat(model, messages, task, input.sourceLabel);
    const checked = await this.guardAgainstInventedNames(model, messages, answer, task, input);

    return task === 'description'
      ? splitDescriptionAndHashtags(checked, task, model, input.sourceLabel)
      : { tags: normalizeAdapterTags(checked, task, model, input.sourceLabel) };
  }

  /**
   * Let the resident adapters go. Housekeeping only: a failure here costs VRAM until
   * Ollama's own keep-alive timer fires, which is not worth failing a finished run over
   * — the same call the chapter pipeline makes for the same reason.
   */
  async unload(): Promise<void> {
    for (const model of this.loaded) {
      try {
        await this.client.post('/api/generate', { model, prompt: '', keep_alive: 0 }, { timeout: 30_000 });
      } catch (error: any) {
        console.warn(`[MetadataTasks] Could not unload "${model}": ${error?.message || error}`);
      }
    }
    this.loaded.clear();
  }

  // ------------------------------------------------------------------ conversation

  private adapterTask(task: MetadataTaskId): 'description' | 'tags' {
    if (task === 'description' || task === 'tags') return task;
    throw new Error(
      `Metadata task "${task}" is routed to backend 'local', but there is no local adapter for it — ` +
        `only "description" (headline-14b-descriptions) and "tags" (headline-14b-tags) have one. ` +
        `Set metadataTaskBackends.${task} to "cloud".`
    );
  }

  private modelFor(task: 'description' | 'tags'): string {
    const model = (this.models[task] || '').trim();
    if (!model) {
      throw new Error(
        `Metadata task "${task}" is routed to backend 'local' but metadataTaskModels.${task} names no model — ` +
          `set it to that adapter's Ollama model name (the shipped default is ` +
          `"${DEFAULT_METADATA_TASK_MODELS[task]}")`
      );
    }
    return model;
  }

  private buildConversation(task: 'description' | 'tags', input: MetadataTaskInput): ChatMessage[] {
    return [
      { role: 'system', content: ADAPTER_SYSTEM_PROMPTS[task] },
      { role: 'user', content: buildAdapterUserTurn(task, input.chapterSubjects) },
    ];
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
    model: string,
    messages: ChatMessage[],
    task: 'description' | 'tags',
    sourceLabel: string
  ): Promise<string> {
    const requestId = Math.random().toString(36).substring(7);

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
              options: { temperature: 0 },
            },
            { timeout: ADAPTER_TIMEOUT_MS }
          );
          data = response.data;
        } catch (error: any) {
          const status = error?.response?.status;
          const detail = error?.response?.data?.error || error?.message || 'unknown error';
          if (status === 404) {
            throw new Error(
              `Metadata task "${task}" needs Ollama model "${model}", which is not installed on ${this.host}. ` +
                `Install it with: ollama pull ${model}  (or, for a local adapter build, ollama create ${model} -f Modelfile)`
            );
          }
          if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
            throw new Error(
              `Metadata task "${task}" for ${sourceLabel} timed out after ${ADAPTER_TIMEOUT_MS / 1000}s on model "${model}"`
            );
          }
          throw new Error(
            `Metadata task "${task}" for ${sourceLabel} failed on model "${model}": ${detail}`
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

  // ------------------------------------------------------------- hallucination guard

  /**
   * These adapters' one known failure mode: given a subject with no name in it ("unnamed
   * street preacher"), they supply a famous one, and they do it deterministically — so
   * temperature 0 does not save you and re-running gives the same invented name. A
   * fabricated name in a published description is the worst outcome this file can
   * produce, so it is checked in code rather than asked for in the prompt.
   *
   * One corrective re-ask, phrased as the next turn of the same conversation (the model's
   * own answer, then a user correction), and if it names something unmatched a second
   * time the run stops. There is no third try and no scrubbing of the offending name:
   * an answer that has to be edited to be safe was not written from the subjects.
   */
  private async guardAgainstInventedNames(
    model: string,
    messages: ChatMessage[],
    answer: string,
    task: 'description' | 'tags',
    input: MetadataTaskInput
  ): Promise<string> {
    const conditioning = [...input.chapterSubjects, input.sourceLabel];

    const first = findUnsupportedNames(answer, conditioning);
    log.info(
      `[MetadataTasks] ${input.sourceLabel}: "${task}" name guard checked ${first.candidates} candidate name(s) ` +
        `against ${input.chapterSubjects.length} subject line(s) — ${first.unsupported.length === 0 ? 'clean' : `unsupported: ${first.unsupported.join(', ')}`}`
    );
    if (first.unsupported.length === 0) return answer;

    const quoted = first.unsupported.map((n) => `"${n}"`).join(' and ');
    log.warn(
      `[MetadataTasks] ${input.sourceLabel}: "${task}" named ${quoted}, which the subjects do not — re-asking once`
    );

    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: answer },
      {
        role: 'user',
        content:
          `Your previous answer mentioned ${quoted}, which the subject list does not. ` +
          `Rewrite using only names the subjects provide.`,
      },
    ];

    const retried = await this.chat(model, retryMessages, task, input.sourceLabel);
    const second = findUnsupportedNames(retried, conditioning);
    log.info(
      `[MetadataTasks] ${input.sourceLabel}: "${task}" name guard re-checked ${second.candidates} candidate name(s) ` +
        `after the corrective retry — ${second.unsupported.length === 0 ? 'clean' : `still unsupported: ${second.unsupported.join(', ')}`}`
    );

    if (second.unsupported.length > 0) {
      throw new Error(
        `Metadata task "${task}" for ${input.sourceLabel} on model "${model}" named ` +
          `${second.unsupported.map((n) => `"${n}"`).join(' and ')}, which does not appear in this video's chapter ` +
          `subjects. The adapter invented it, and it did so again after one corrective retry. Refusing rather ` +
          `than publishing a name the video never says.`
      );
    }
    return retried;
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
// Invented-name detection
// ---------------------------------------------------------------------------

/**
 * Words that carry a capital in a sentence's first slot for grammatical reasons only.
 *
 * Weighted towards PREPOSITIONS and conjunctions, because those are the ones that do real
 * damage: a preposition opening a sentence gets glued to the name after it ("Across the
 * US", "In Texas"), and the joined phrase then fails the check on a word that was never a
 * name. Determiners, pronouns and the handful of adverbs that open a hook sentence round
 * it out. Nothing here can name a person, an organization or a place.
 */
const SENTENCE_STARTERS = new Set([
  // determiners, pronouns, quantifiers
  'a', 'all', 'an', 'another', 'any', 'anyone', 'both', 'each', 'either', 'every', 'everyone',
  'few', 'he', 'her', 'here', 'his', 'i', 'it', 'its', 'many', 'more', 'most', 'much',
  'neither', 'no', 'none', 'one', 'other', 'others', 'our', 'several', 'she', 'some', 'such',
  'that', 'the', 'their', 'them', 'there', 'these', 'they', 'this', 'those', 'two', 'three',
  'we', 'what', 'which', 'who', 'whose', 'you', 'your',
  // prepositions
  'about', 'above', 'across', 'after', 'against', 'along', 'alongside', 'amid', 'among',
  'amongst', 'around', 'as', 'at', 'before', 'behind', 'below', 'beneath', 'beside',
  'between', 'beyond', 'by', 'despite', 'down', 'during', 'following', 'for', 'from', 'in',
  'inside', 'into', 'near', 'of', 'off', 'on', 'onto', 'outside', 'over', 'per', 'since',
  'through', 'throughout', 'to', 'toward', 'towards', 'under', 'until', 'up', 'upon', 'via',
  'with', 'within', 'without',
  // conjunctions and sentence adverbs
  'after', 'although', 'and', 'because', 'but', 'even', 'finally', 'first', 'however', 'if',
  'instead', 'last', 'later', 'meanwhile', 'nor', 'not', 'now', 'once', 'only', 'or', 'out',
  'so', 'still', 'then', 'though', 'today', 'when', 'where', 'while', 'why', 'yet',
]);

/**
 * Capitalized words that are CATEGORIES rather than identities, plus the channel and
 * format vocabulary the adapters use about themselves.
 *
 * The tags adapter is instructed to end with "the broad category terms it belongs to",
 * so a guard that demanded every capitalized word appear in the subject list would fail
 * the model for obeying its own brief. None of these names anybody: no person, no
 * organization, no place. That boundary is the whole list — a place name stays checkable
 * precisely because "Texas" IS the kind of specific the adapter invents.
 */
const CATEGORY_WORDS = new Set([
  // channel / format / promo vocabulary
  'youtube', 'patreon', 'twitch', 'tiktok', 'instagram', 'facebook', 'twitter', 'substack',
  'discord', 'spotify', 'podcast', 'podcasts', 'video', 'videos', 'livestream', 'stream',
  'episode', 'chapter', 'chapters', 'shorts', 'subscribe', 'channel',
  // the beat itself
  'america', 'american', 'americans', 'us', 'usa', 'western', 'christian', 'christians',
  'christianity', 'christ', 'jesus', 'god', 'bible', 'biblical', 'scripture', 'church',
  'churches', 'evangelical', 'evangelicals', 'evangelicalism', 'catholic', 'catholics',
  'protestant', 'protestants', 'baptist', 'baptists', 'atheist', 'atheists', 'atheism',
  'religion', 'religious', 'politics', 'political', 'conservative', 'conservatives',
  'liberal', 'liberals', 'republican', 'republicans', 'democrat', 'democrats', 'democratic',
  'nationalism', 'nationalist', 'nationalists',
]);

/** Lowercase words that hold a name together: "Church of Christ", "Southern Baptist Convention". */
const NAME_CONNECTORS = new Set(['of', 'the', 'and', 'for', 'de', 'del', 'da', 'di', 'van', 'von', 'la', 'le']);

export interface NameGuardResult {
  /** How many proper-noun candidates were extracted and checked. */
  candidates: number;
  /** The ones no conditioning line supports, de-duplicated, in order of appearance. */
  unsupported: string[];
}

/**
 * Strip surrounding punctuation and any possessive from one whitespace-delimited word.
 * Periods go entirely, interior ones included, so "U.S." arrives as the single token
 * "US" that wordTokens would reduce it to anyway rather than splitting into "u" and "s".
 */
function bareWord(raw: string): string {
  return raw
    .replace(/^[^\p{L}\p{N}#]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .replace(/['’]s$/i, '')
    .replace(/\./g, '');
}

/**
 * Hashtags as the guard reads them: '#JoelOsteen' is a name claim and has to be checked,
 * '#megachurch' is a lowercase category word and never becomes a candidate at all. The
 * '#' goes, and CamelCase splits into words so "#BibleCurriculum" can match a subject
 * line that writes it as two.
 */
function expandHashtag(token: string): string {
  return token.replace(/^#+/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function isCapitalized(word: string): boolean {
  return /^\p{Lu}[\p{L}\p{N}'’.-]*$/u.test(word);
}

/**
 * Levenshtein distance, capped: the loop stops as soon as every cell in a row exceeds
 * `max`, so a candidate is compared against a whole subject list cheaply.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

/**
 * How far a token may drift and still count as the same word.
 *
 * The tolerance exists for TRANSCRIPTION GARBLE — the subject lines were written from
 * auto-captions, so a name reaches the adapter mis-spelled and comes back spelled right
 * (or the reverse). It scales with length because a flat allowance of 2 on a short word
 * matches everything: at distance 2, "Bush" is "Rush", "push" and "bust", which would
 * wave through exactly the substitution this guard exists to catch.
 */
function editTolerance(length: number): number {
  if (length <= 4) return 0;
  if (length <= 7) return 1;
  return 2;
}

/**
 * Same word, different ending: "fabricated"/"fabricating", "harasses"/"harassment",
 * "testimonies"/"testimony".
 *
 * Inflection is not garble and edit distance does not see it — "fabricated" is 3 edits
 * from "fabricating", which no tolerance a short name can survive would cover. So it is
 * matched on the stem instead, with the divergence held to a suffix: six shared leading
 * characters, at most three left over on the shorter word and four on the longer. That
 * ceiling is what keeps it from being a general prefix match — "Christian" does not
 * reach "Christopher", and "Bush" does not reach "Bushnell".
 */
function sameStem(a: string, b: string): boolean {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  if (shared < 6) return false;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  return shorter - shared <= 3 && longer - shared <= 4;
}

function tokenSupported(token: string, conditioningTokens: string[]): boolean {
  const tolerance = editTolerance(token.length);
  for (const other of conditioningTokens) {
    if (other === token) return true;
    // Plurals, and "megachurch" inside "megachurches". Possessives are already stripped.
    if (token.length >= 5 && (other.includes(token) || token.includes(other))) return true;
    if (sameStem(token, other)) return true;
    if (tolerance > 0 && editDistance(token, other, tolerance) <= tolerance) return true;
  }
  return false;
}

function wordTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/**
 * Every proper-noun-shaped phrase in `text` that the conditioning lines do not support.
 *
 * Extraction is deliberately shallow — runs of capitalized tokens, joined across the
 * small set of lowercase connectors real names contain — because the alternative is a
 * named-entity model, and a guard that needs its own model to run is a guard that fails
 * when the thing it guards fails. Shallow extraction over-collects; the filters below,
 * and matching against the subjects, decide what survives.
 *
 * Exported so the negative path is testable without a model call.
 */
export function findUnsupportedNames(text: string, conditioning: string[]): NameGuardResult {
  const conditioningLower = conditioning.join(' \n ').toLowerCase().replace(/['’]/g, '');
  const conditioningTokens = wordTokens(conditioning.join(' '));

  const candidates: Array<{ phrase: string; first: boolean }> = [];
  // Sentence boundaries matter only for the first-word rule, so a newline counts as one.
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const words = sentence.trim().split(/\s+/);
    let phrase: string[] = [];
    let phraseStartsSentence = false;

    const flush = () => {
      // A connector can only sit BETWEEN names, never end a phrase ("Church of").
      while (phrase.length > 0 && NAME_CONNECTORS.has(phrase[phrase.length - 1].toLowerCase())) {
        phrase.pop();
      }
      // A grammar word in the sentence's first slot is not part of the name that follows
      // it: "Across the US" is one capitalized run to this extractor but one name to a
      // reader, and left joined it would fail the check on the "Across". The connector
      // behind it goes too, since nothing is named "the US". Dropping them also moves the
      // real name out of first position, which is honest — "US" there IS a capital by
      // choice, so it stays subject to the full check rather than the first-slot exemption.
      while (phrase.length > 0) {
        const head = phrase[0].toLowerCase();
        const grammarFirst = phraseStartsSentence && SENTENCE_STARTERS.has(head);
        if (!grammarFirst && !NAME_CONNECTORS.has(head)) break;
        phrase.shift();
        phraseStartsSentence = false;
      }
      if (phrase.length > 0) candidates.push({ phrase: phrase.join(' '), first: phraseStartsSentence });
      phrase = [];
    };

    for (let i = 0; i < words.length; i++) {
      const word = bareWord(words[i].startsWith('#') ? expandHashtag(words[i]) : words[i]);
      // expandHashtag can turn one token into two ("#BibleCurriculum" -> "Bible Curriculum");
      // handle the pieces as if they had been written apart.
      const pieces = word.split(/\s+/).filter((p) => p.length > 0);
      if (pieces.length === 0) {
        flush();
        continue;
      }
      for (const piece of pieces) {
        if (isCapitalized(piece)) {
          if (phrase.length === 0) phraseStartsSentence = i === 0;
          phrase.push(piece);
        } else if (phrase.length > 0 && NAME_CONNECTORS.has(piece.toLowerCase())) {
          phrase.push(piece);
        } else {
          flush();
        }
      }
    }
    flush();
  }

  // Words that carry a capital SOMEWHERE other than a sentence's first slot. A word only
  // ever seen in first position is capitalized by grammar as far as this code can tell;
  // one seen mid-sentence is capitalized by choice, which is what a name is.
  const capitalizedMidSentence = new Set<string>();
  for (const { phrase, first } of candidates) {
    const tokens = wordTokens(phrase);
    for (let i = 0; i < tokens.length; i++) {
      if (!first || i > 0) capitalizedMidSentence.add(tokens[i]);
    }
  }

  const seen = new Set<string>();
  const unsupported: string[] = [];
  let checked = 0;

  for (const { phrase, first } of candidates) {
    const tokens = wordTokens(phrase).filter((t) => !NAME_CONNECTORS.has(t));
    if (tokens.length === 0) continue;

    // Two exemptions for the one shape this extractor cannot read: a lone capital in a
    // sentence's first slot. The word list catches the obvious grammar words, and the
    // corroboration rule catches the rest — "Watch" opening a hook sentence and never
    // appearing again is not a name, while an invented surname is used more than once or
    // is used mid-sentence. Both only ever apply to a SINGLE token in FIRST position;
    // "Joel Osteen" opening a sentence is checked like any other name.
    if (tokens.length === 1 && first && SENTENCE_STARTERS.has(tokens[0])) continue;
    if (tokens.length === 1 && first && !capitalizedMidSentence.has(tokens[0])) continue;
    // Category words wherever they appear are not claims about anyone — see CATEGORY_WORDS.
    if (tokens.every((t) => CATEGORY_WORDS.has(t))) continue;

    checked++;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (conditioningLower.includes(key.replace(/['’]/g, ''))) continue;
    if (tokens.every((t) => tokenSupported(t, conditioningTokens))) continue;

    unsupported.push(phrase);
  }

  return { candidates: checked, unsupported };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export type MetadataTaskBackendConfig = Partial<Record<MetadataTaskId, string>>;
/** Ollama model name per locally-routed task, from the `metadataTaskModels` setting. */
export type MetadataTaskModelConfig = Partial<Record<MetadataTaskId, string>>;

/**
 * Shipped routing: the description and tags adapters are trained, deployed and are the
 * point of the split, so they are what a fresh install runs. Packaging stays on the
 * cloud because it has no adapter.
 */
export const DEFAULT_METADATA_TASK_BACKENDS: MetadataTaskBackendConfig = {
  description: 'local',
  tags: 'local',
};

/** Shipped adapter model names — LoRAs over qwen3:14b, on the local Ollama. */
export const DEFAULT_METADATA_TASK_MODELS: MetadataTaskModelConfig = {
  description: 'headline-14b-descriptions',
  tags: 'headline-14b-tags',
};

/**
 * Resolve the settings keys `metadataTaskBackends` / `metadataTaskModels` into backend
 * instances. A task the config does not mention runs on the cloud — that is the
 * documented default for a task with no adapter, not a recovery. A backend NAME the
 * config does mention but this code does not know is a different thing entirely and
 * throws, as does a local task whose model name is missing: both mean the user asked for
 * something specific and would otherwise silently get something else.
 *
 * ONE LocalAdapterTaskBackend serves every locally-routed task, so both adapters are
 * loaded and released by the same object and the run has exactly one unload to make.
 */
export function resolveTaskBackends(
  config: MetadataTaskBackendConfig | undefined,
  models: MetadataTaskModelConfig | undefined,
  host: string,
  aiManager: AIManagerService
): Record<MetadataTaskId, MetadataTaskBackend> {
  const cloud = new CloudTaskBackend(aiManager);
  const resolved = {} as Record<MetadataTaskId, MetadataTaskBackend>;
  let local: LocalAdapterTaskBackend | undefined;

  for (const task of METADATA_TASK_ORDER) {
    const choice = config?.[task] || 'cloud';
    if (choice === 'cloud') {
      resolved[task] = cloud;
    } else if (choice === 'local') {
      if (task === 'packaging') {
        throw new Error(
          `metadataTaskBackends.packaging is set to "local", but no local adapter generates packaging ` +
            `(titles, thumbnail text, pinned comments, clips, spoken keywords). Only "description" and ` +
            `"tags" have adapters.`
        );
      }
      if (!(models?.[task] || '').trim()) {
        throw new Error(
          `metadataTaskBackends.${task} is set to "local" but metadataTaskModels.${task} names no model — ` +
            `set it to that adapter's Ollama model name (the shipped default is "${DEFAULT_METADATA_TASK_MODELS[task]}")`
        );
      }
      local = local || new LocalAdapterTaskBackend(host, models || {});
      resolved[task] = local;
    } else {
      throw new Error(
        `metadataTaskBackends.${task} is set to "${choice}", which is not a known backend (expected "cloud" or "local")`
      );
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Running the units
// ---------------------------------------------------------------------------

export interface MetadataTaskRun {
  backends: Record<MetadataTaskId, MetadataTaskBackend>;
  content: string;
  sourceLabel: string;
  chapterSubjects: string[];
  chapterDetails: string[];
  /** See MetadataTaskInput.hashtagsOwnedByDescription — decided once, for the whole run. */
  hashtagsOwnedByDescription: boolean;
}

/**
 * Which unit writes the `hashtags` field, decided from the routing alone.
 *
 * The description ADAPTER always ends with a hashtag line; the description CLOUD prompt
 * never does (the prompt set's own `## HASHTAGS` section belongs to packaging). So the
 * field follows the description task's backend, and packaging is told which run it is in
 * rather than discovering it from what came back.
 */
export function hashtagsComeFromDescription(backends: Record<MetadataTaskId, MetadataTaskBackend>): boolean {
  return backends.description.id === 'local';
}

function taskInput(run: MetadataTaskRun, task: MetadataTaskId): MetadataTaskInput {
  return {
    task,
    content: run.content,
    sourceLabel: run.sourceLabel,
    chapterSubjects: run.chapterSubjects,
    chapterDetails: run.chapterDetails,
    hashtagsOwnedByDescription: run.hashtagsOwnedByDescription,
  };
}

/**
 * Run the three units in order and merge them into the one MetadataResult the rest of
 * the app expects.
 *
 * Nothing is caught here. A half-generated item — a description with no titles, tags
 * from one model and packaging from another run — is worse than no item, because it is
 * indistinguishable from a complete one once it is written to disk.
 */
export async function runMetadataTasks(
  aiManager: AIManagerService,
  run: MetadataTaskRun
): Promise<MetadataResult> {
  const merged: Record<string, unknown> = {};
  // De-duplicated because one LocalAdapterTaskBackend instance serves every locally
  // routed task — unloading it twice would be two calls saying the same thing.
  const resident = new Set(Object.values(run.backends).filter((b) => typeof b.unload === 'function'));

  try {
    for (const task of METADATA_TASK_ORDER) {
      const backend = run.backends[task];
      console.log(`[MetadataTasks] ${run.sourceLabel}: running "${task}" on backend "${backend.id}"`);
      const fields = await backend.generate(taskInput(run, task));
      Object.assign(merged, fields);
    }

    // Description links and hashtag spacing are applied ONCE, to the merged object. Per
    // unit they could not be: the links append to a description the description unit
    // returns, while the hashtags they sit beside come back from the packaging unit —
    // or, when the description adapter runs, from the description unit's own last line.
    return aiManager.finalizeMetadata(merged as MetadataResult);
  } finally {
    // A failed run leaves a 9.5GB adapter resident just as surely as a successful one,
    // so the release is in a finally. It only releases models that were actually loaded.
    for (const backend of resident) {
      await backend.unload!();
    }
  }
}

/**
 * The same three prompts, assembled but not sent, for the "Show prompt" flow.
 *
 * Each one is banner-labelled with its task because the frontend renders a job's prompts
 * as a single scrollable string; unlabelled, three prompts sharing an editorial preamble
 * read as one repetitive prompt. The text under each banner is the literal request.
 */
export function buildTaskPromptsForDisplay(run: MetadataTaskRun): string[] {
  return METADATA_TASK_ORDER.map((task) => {
    const body = run.backends[task].describePrompt(taskInput(run, task));
    return `=== TASK: ${task.toUpperCase()} (${run.sourceLabel}) ===\n\n${body}`;
  });
}
