/**
 * Per-task metadata generation
 *
 * The metadata call used to be one request that returned every field at once. It is
 * being taken apart field by field, because the fields are migrating to local
 * fine-tuned adapters one at a time (headline-14b-titles exists; description and tags
 * adapters come later). A single call cannot migrate by halves, so generation is split
 * into TASK UNITS with a backend behind each one:
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

import * as log from 'electron-log';
import { SYSTEM_PROMPTS, formatPrompt } from './system-prompts';
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
  promptSetName: string
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

  for (const section of sections) {
    if (PACKAGING_EXCLUDED.has(section.key)) continue;

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
 * The only working backend: the same Claude/OpenAI/Ollama request, JSON parse and repair
 * machinery the single-call path has always used, pointed at one task's prompt.
 */
export class CloudTaskBackend implements MetadataTaskBackend {
  readonly id = 'cloud';

  constructor(private readonly aiManager: AIManagerService) {}

  describePrompt(input: MetadataTaskInput): string {
    return this.aiManager.buildMetadataTaskPrompt(input);
  }

  async generate(input: MetadataTaskInput): Promise<Record<string, unknown>> {
    const expected = this.aiManager.metadataTaskKeys(input.task);
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

/**
 * The seam's second implementation, and deliberately not a working one.
 *
 * Routing a task here before its adapter exists must stop the run and say so. Quietly
 * sending it to the cloud instead would mean the user believes a field is being
 * generated locally while it is not — the exact silent substitution that makes a
 * migration impossible to verify.
 */
export class LocalAdapterTaskBackend implements MetadataTaskBackend {
  readonly id = 'local';

  describePrompt(input: MetadataTaskInput): string {
    return this.refuse(input.task);
  }

  async generate(input: MetadataTaskInput): Promise<Record<string, unknown>> {
    return this.refuse(input.task);
  }

  private refuse(task: MetadataTaskId): never {
    throw new Error(
      `Task '${task}' is configured for backend 'local' but no local adapter integration is implemented yet (adapter not trained).`
    );
  }
}

export type MetadataTaskBackendConfig = Partial<Record<MetadataTaskId, string>>;

/**
 * Resolve the settings key `metadataTaskBackends` into backend instances. Tasks the
 * config does not mention run on the cloud — that is the documented default, not a
 * recovery. A backend NAME the config does mention but this code does not know is a
 * different thing entirely and throws.
 */
export function resolveTaskBackends(
  config: MetadataTaskBackendConfig | undefined,
  aiManager: AIManagerService
): Record<MetadataTaskId, MetadataTaskBackend> {
  const cloud = new CloudTaskBackend(aiManager);
  const resolved = {} as Record<MetadataTaskId, MetadataTaskBackend>;

  for (const task of METADATA_TASK_ORDER) {
    const choice = config?.[task] || 'cloud';
    if (choice === 'cloud') {
      resolved[task] = cloud;
    } else if (choice === 'local') {
      resolved[task] = new LocalAdapterTaskBackend();
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
}

function taskInput(run: MetadataTaskRun, task: MetadataTaskId): MetadataTaskInput {
  return {
    task,
    content: run.content,
    sourceLabel: run.sourceLabel,
    chapterSubjects: run.chapterSubjects,
    chapterDetails: run.chapterDetails,
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

  for (const task of METADATA_TASK_ORDER) {
    const backend = run.backends[task];
    console.log(`[MetadataTasks] ${run.sourceLabel}: running "${task}" on backend "${backend.id}"`);
    const fields = await backend.generate(taskInput(run, task));
    Object.assign(merged, fields);
  }

  // Description links and hashtag spacing are applied ONCE, to the merged object. Per
  // unit they could not be: the links append to a description the description unit
  // returns, while the hashtags they sit beside come back from the packaging unit.
  return aiManager.finalizeMetadata(merged as MetadataResult);
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
