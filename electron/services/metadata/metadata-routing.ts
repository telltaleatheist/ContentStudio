/**
 * Per-task routing: which model writes which field
 *
 * Metadata used to be one call to one model. It is now one call per TASK, and the tasks
 * are migrating to local fine-tuned adapters one at a time, so "which model" stopped
 * being a single setting and became a table. This module is that table, and it is the
 * only place it exists: the settings modal renders it, the store persists selections
 * against it, and generation resolves selections through it. Nothing downstream may
 * invent a model name or a default.
 *
 * The setting is ONE key, `metadataRouting: Record<taskId, optionId>`. It replaces the
 * short-lived `metadataTaskBackends` / `metadataTaskModels` pair outright — those two
 * never shipped, so there is no migration and stale copies of them in an existing store
 * are simply ignored.
 *
 * Absent key, or absent entry for a task: the registry's default runs. A PRESENT entry
 * naming an option this table does not know, or an option that is not offered for that
 * task, throws — the user asked for something specific and must not silently get
 * something else.
 */

import * as log from 'electron-log';

export type MetadataRoutingTaskId =
  | 'chapters'
  | 'titles'
  | 'description'
  | 'tags'
  | 'thumbnail_text'
  | 'pinned_comment'
  | 'clip_suggestions';

export interface MetadataRoutingOption {
  /** 'cloud' goes through AIManagerService's provider clients; 'local' through the adapters. */
  kind: 'cloud' | 'local';
  /** What the modal shows. */
  label: string;
  /**
   * Cloud: the provider-prefixed model AIManagerService.makeRequest routes on.
   * Local: the bare Ollama model name, as `ollama list` prints it.
   */
  model: string;
  /**
   * Non-default local host. Only the 32B titles model has one: it is served by an
   * Ollama-SHAPED MLX shim on 11435, not by Ollama itself.
   */
  host?: string;
  /**
   * How to start `host` when nothing answers on it. Carried on the option because the
   * backend that hits the connection refusal has no idea what is supposed to be
   * listening there, and "connection refused" on a port the user has never heard of is
   * not an actionable error.
   */
  startHint?: string;
  /**
   * The argv that starts `host`, for servers the app manages itself. When present, the
   * unit probes the host before its first request and SPAWNS this when nothing answers
   * — a planned part of running the task, not a recovery path — then stops the process
   * it started when the run finishes. A server found already listening is used as-is
   * and never stopped: whoever started it owns it.
   */
  startCommand?: string[];
}

/** The shim behind headline-32b-titles. It is not Ollama and it is not always running. */
export const HEADLINE_32B_HOST = 'http://localhost:11435';
const HEADLINE_32B_START_HINT =
  'that host is the Ollama-shaped MLX shim for the 32B titles model, not Ollama itself — start it with ' +
  '`python AutoCutStudioApp/tools/headline32b-server/serve.py`';

/**
 * The one option id that selects a different chapter ARCHITECTURE rather than a different
 * chapter model. Exported so metadata-generator.service.ts can branch on it by identity
 * instead of matching a string literal in two files.
 */
export const CHAPTERS_SINGLE_CALL_OPTION_ID = 'chapters-qwen27b-single';

export const METADATA_ROUTING_OPTIONS: Record<string, MetadataRoutingOption> = {
  sonnet5: { kind: 'cloud', label: 'Claude Sonnet 5', model: 'claude:claude-sonnet-5' },
  opus5: { kind: 'cloud', label: 'Claude Opus 5', model: 'claude:claude-opus-5' },
  'cogito-14b': { kind: 'local', label: 'Cogito 14B', model: 'cogito:14b' },
  'qwen25-14b': { kind: 'local', label: 'Qwen2.5 14B', model: 'qwen2.5:14b' },
  'qwen3-14b': { kind: 'local', label: 'Qwen3 14B', model: 'qwen3:14b' },
  'headline-desc-14b': { kind: 'local', label: 'Headline 14B (descriptions)', model: 'headline-14b-descriptions' },
  'headline-tags-14b': { kind: 'local', label: 'Headline 14B (tags)', model: 'headline-14b-tags' },
  'headline-titles-14b': { kind: 'local', label: 'Headline 14B (titles)', model: 'headline-14b-titles' },
  /**
   * A BASE model on the titles field, which is a deliberate exception to this file's own rule.
   *
   * Everything else offered for titles is either a cloud model or a trained headline adapter.
   * The note on METADATA_ROUTING_TASKS warns that pointing a base model at a brief makes it
   * "answer fluently and wrongly", and that applies here: measured on this machine, this model
   * given a generic brief writes a colon title 47% of the time, and colons lose head-to-head
   * 20-to-5 in the operator's own A/B record.
   *
   * It is offered for CHAPTERS as well as titles, which is a different argument. Chapters are
   * not a voice problem — the sealed pipeline asks hundreds of short factual questions about a
   * transcript, so a base model with no adapter is the normal shape there rather than an
   * exception. It also matters that it is INSTALLED: of the three options this table offered
   * for chapters, two name models that are not present on the operator's machine, including
   * the default, which is why chaptering silently produced nothing until it was diagnosed.
   *
   * The label carries no field suffix on purpose. Every other `(titles)` / `(tags)` /
   * `(descriptions)` label in this table marks a TRAINED ADAPTER, and this is a base model
   * appearing in two different dropdowns; "Qwen 27B (titles)" inside the Chapters list would
   * be wrong twice over.
   *
   * It is offered anyway because it is not GIVEN a generic brief — it runs the same prompt
   * pipeline as everything else, which carries the per-channel yml sets and the abLearnings
   * block, and the same measurement showed the shape collapses to 0% once real head-to-heads
   * are in the prompt. The caveat is real but it is a property of the prompt, not the model.
   *
   * Consequence worth knowing before choosing it: a larger model amplifies whatever the prompt
   * teaches, in both directions. The yml sets currently REQUIRE one question-format title per
   * batch of ten, against a shape that loses 15-to-2.
   *
   * CHECKED, because it was expected to be a problem and is not: this model reasons by default,
   * and on Ollama's /api/chat that reasoning lands in `message.thinking` while `message.content`
   * comes back EMPTY unless the caller sends `think: false`. A title needs ~13 tokens and the
   * reasoning spends hundreds, so the generation hits its cap mid-thought and returns nothing.
   * This app does not use /api/chat — ai-manager posts to /api/generate and reads
   * `data.response`, and that endpoint returns `response` and `thinking` as SEPARATE fields.
   * Probed with this app's exact options block (temperature 0.7, num_predict 4096,
   * num_ctx 32768): 74 characters of `response`, 566 of `thinking`, done_reason "stop". The
   * content arrives and the reasoning is discarded, which is what we want. No think flag needed
   * — but anyone moving this app to /api/chat must add one, or every local title silently
   * becomes an empty string.
   */
  'qwen38-27b': { kind: 'local', label: 'Qwen 27B', model: 'qwen3.8:27b' },
  /**
   * The same model, on a different ARCHITECTURE — chapters only.
   *
   * Every other option in this table names a model that runs the task's normal code path.
   * This one is a path selector: picking it routes chapters to
   * chapter-single-call.service.ts, which sends the WHOLE transcript in ONE call, instead
   * of to the sealed 5-stage pipeline's ~390 one-question calls. Same model file, same
   * host, ~390x fewer requests, and a completely different failure surface — hence its own
   * id rather than a flag hidden somewhere else.
   *
   * Measured 2026-08-21 across four videos, 8.8 minutes to 2h08
   * (/Volumes/Callisto/Projects/tools/chapter-experiment/RESULTS.md): 5 of 5 ground-truth
   * story boundaries on a 2h08 stream, worst offset 54 s, zero invented names in any run,
   * and whisper garble repaired from whole-video context in ways a span-local call cannot
   * manage. Against that, cadence is unstable without a stated budget (a 44x swing at
   * temperature 0) and four tokens of cosmetic punctuation once moved a count 8 -> 13, so
   * the count, the ordering, the spacing and every quote are enforced in code and a list
   * that misses fails the stage outright.
   *
   * "experimental" in the label is the honest word for that: it is a one-shot with a much
   * narrower validated record than the sealed pipeline, and when it fails it fails the
   * whole chapter list rather than degrading one chapter.
   */
  [CHAPTERS_SINGLE_CALL_OPTION_ID]: {
    kind: 'local',
    label: 'Qwen 27B — single call (experimental)',
    model: 'qwen3.8:27b',
  },
  'headline-titles-32b': {
    kind: 'local',
    label: 'Headline 32B (titles)',
    model: 'headline-32b-titles',
    host: HEADLINE_32B_HOST,
    startHint: HEADLINE_32B_START_HINT,
    startCommand: [
      '/bin/sh',
      '/Volumes/Callisto/Projects/AutoCutStudioApp/tools/headline32b-server/serve-headline-32b.sh',
    ],
  },
};

export interface MetadataRoutingTask {
  id: MetadataRoutingTaskId;
  label: string;
  /** Option ids offered for this task, in the order the modal should list them. */
  options: string[];
  /** Runs when the stored setting has no entry for this task. Must be in `options`. */
  defaultOptionId: string;
}

/**
 * The table. Order is the modal's order.
 *
 * `chapters` is local-only because the sealed pipeline (CHAPTERING.md) makes hundreds of
 * one-question calls per video — a shape that only makes sense on a local model, and one
 * a cloud bill would not survive. thumbnail_text, pinned_comment and clip_suggestions are
 * cloud-only for the opposite reason: no adapter has been trained for them yet, and
 * pointing them at a base model would answer the brief fluently and wrongly.
 */
export const METADATA_ROUTING_TASKS: MetadataRoutingTask[] = [
  {
    id: 'chapters',
    label: 'Chapters',
    options: ['cogito-14b', 'qwen25-14b', 'qwen3-14b', 'qwen38-27b', CHAPTERS_SINGLE_CALL_OPTION_ID],
    defaultOptionId: 'cogito-14b',
  },
  {
    id: 'titles',
    label: 'Titles',
    options: ['sonnet5', 'opus5', 'headline-titles-14b', 'headline-titles-32b', 'qwen38-27b'],
    defaultOptionId: 'sonnet5',
  },
  {
    id: 'description',
    label: 'Description',
    options: ['headline-desc-14b', 'sonnet5', 'opus5'],
    defaultOptionId: 'headline-desc-14b',
  },
  {
    id: 'tags',
    label: 'Tags',
    options: ['headline-tags-14b', 'sonnet5', 'opus5'],
    defaultOptionId: 'headline-tags-14b',
  },
  {
    id: 'thumbnail_text',
    label: 'Thumbnail text',
    options: ['sonnet5', 'opus5'],
    defaultOptionId: 'sonnet5',
  },
  {
    id: 'pinned_comment',
    label: 'Pinned comment',
    options: ['sonnet5', 'opus5'],
    defaultOptionId: 'sonnet5',
  },
  {
    id: 'clip_suggestions',
    label: 'Clip suggestions',
    options: ['sonnet5', 'opus5'],
    defaultOptionId: 'sonnet5',
  },
];

/** Stored shape: taskId -> optionId. Partial by design; absent entries take the default. */
export type MetadataRoutingSelections = Partial<Record<MetadataRoutingTaskId, string>>;

/** Every task resolved to an option id — what generation actually runs. */
export type ResolvedMetadataRouting = Record<MetadataRoutingTaskId, string>;

function taskDef(taskId: string): MetadataRoutingTask | undefined {
  return METADATA_ROUTING_TASKS.find((t) => t.id === taskId);
}

/**
 * One selection, validated against the table.
 *
 * Two distinct failures, named distinctly, because they have different fixes: an option
 * this build has never heard of (stale setting, typo, an option removed by an upgrade)
 * and an option that exists but is not offered for this task (cloud model on the chapter
 * pipeline, adapter on a field it was not trained for).
 */
export function validateRoutingSelection(taskId: string, optionId: string): void {
  const task = taskDef(taskId);
  if (!task) {
    throw new Error(
      `metadataRouting names task "${taskId}", which is not a metadata task ` +
        `(known tasks: ${METADATA_ROUTING_TASKS.map((t) => t.id).join(', ')})`
    );
  }
  if (!METADATA_ROUTING_OPTIONS[optionId]) {
    throw new Error(
      `metadataRouting.${taskId} is set to "${optionId}", which is not a known model option ` +
        `(known options: ${Object.keys(METADATA_ROUTING_OPTIONS).join(', ')})`
    );
  }
  if (!task.options.includes(optionId)) {
    throw new Error(
      `metadataRouting.${taskId} is set to "${optionId}", which is not offered for the "${task.label}" task ` +
        `(offered: ${task.options.join(', ')})`
    );
  }
}

/** Validate a whole selections object, e.g. one arriving over IPC from the modal. */
export function validateRoutingSelections(selections: unknown): MetadataRoutingSelections {
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) {
    throw new Error(`metadataRouting must be an object of taskId -> optionId (got ${JSON.stringify(selections)})`);
  }
  const validated: MetadataRoutingSelections = {};
  for (const [taskId, optionId] of Object.entries(selections as Record<string, unknown>)) {
    if (typeof optionId !== 'string' || optionId.trim().length === 0) {
      throw new Error(`metadataRouting.${taskId} must be an option id string (got ${JSON.stringify(optionId)})`);
    }
    validateRoutingSelection(taskId, optionId);
    validated[taskId as MetadataRoutingTaskId] = optionId;
  }
  return validated;
}

/**
 * Fill in the defaults and validate what the user chose.
 *
 * Called at job time from the store, so a setting edited between runs takes effect on the
 * next run without any coupling between the modal and the queue.
 */
export function resolveMetadataRouting(stored: unknown): ResolvedMetadataRouting {
  const selections = stored === undefined || stored === null ? {} : validateRoutingSelections(stored);
  const resolved = {} as ResolvedMetadataRouting;
  for (const task of METADATA_ROUTING_TASKS) {
    resolved[task.id] = selections[task.id] || task.defaultOptionId;
  }
  return resolved;
}

export function routingOption(taskId: MetadataRoutingTaskId, optionId: string): MetadataRoutingOption {
  validateRoutingSelection(taskId, optionId);
  return METADATA_ROUTING_OPTIONS[optionId];
}

/** One line naming what this run will use, for the job log. */
export function describeRouting(routing: ResolvedMetadataRouting): string {
  return METADATA_ROUTING_TASKS.map((t) => `${t.id}=${METADATA_ROUTING_OPTIONS[routing[t.id]].model}`).join(', ');
}

// ---------------------------------------------------------------------------
// The IPC payload
// ---------------------------------------------------------------------------

/**
 * Is this option's model actually there?
 *
 * - `cloud` — the question does not apply; a Claude/OpenAI model is present by definition.
 * - `installed` / `not-installed` — Ollama answered and either does or does not list it.
 * - `unknown` — nobody can say. Either Ollama did not answer (so NOTHING it serves can be
 *   judged), or the option is served by something that is not Ollama and has no listing to
 *   read. Deliberately distinct from `not-installed`: "we could not check" and "it is not
 *   there" have different fixes, and collapsing them would be a guess.
 */
export type MetadataRoutingAvailability = 'cloud' | 'installed' | 'not-installed' | 'unknown';

/** What one read of Ollama's GET /api/tags says. */
export interface OllamaInventory {
  host: string;
  reachable: boolean;
  /** Model names exactly as /api/tags lists them. Empty when the host did not answer. */
  models: string[];
  /** Why the host could not be read. Present only when `reachable` is false. */
  error?: string;
}

/**
 * An option is served by plain Ollama when it is local and names no host of its own.
 * The one option that DOES name a host (the 32B titles model) is served by an
 * Ollama-shaped MLX shim this app starts on demand — its /api/tags is a different
 * server's, and a shim that is merely not running is not a missing model.
 */
function servedByOllama(option: MetadataRoutingOption): boolean {
  return option.kind === 'local' && !option.host;
}

/**
 * Ollama prints an untagged model as `name:latest`, and the registry writes the bare name
 * for the adapters (`headline-14b-descriptions`). Comparing the two raw would report every
 * installed adapter as missing.
 */
function normalizeOllamaName(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}

/**
 * Read the installed model list off an Ollama host.
 *
 * A host that does not answer comes back as `reachable: false` WITH the reason, not as an
 * empty model list: an empty list would mark every local option "not installed", which is
 * a different claim than "we could not ask". This is a status query for the picker — it
 * changes no behaviour and substitutes no model, and generation still fails loudly on a
 * model that is not there.
 */
export async function probeOllamaInventory(host: string): Promise<OllamaInventory> {
  const base = host.replace(/\/$/, '');
  try {
    const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) {
      return { host: base, reachable: false, models: [], error: `Ollama at ${base} returned HTTP ${response.status}.` };
    }
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    if (!Array.isArray(data.models)) {
      // A 200 with no model list is not "nothing is installed" — it is something other
      // than Ollama answering on that port, and calling it an empty inventory would mark
      // every local option missing on the strength of a reply we did not understand.
      return { host: base, reachable: false, models: [], error: `${base}/api/tags answered without a model list.` };
    }
    const models = data.models.map((m) => String(m.name || '')).filter((name) => name.length > 0);
    return { host: base, reachable: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { host: base, reachable: false, models: [], error: `Ollama at ${base} could not be reached: ${message}` };
  }
}

export interface MetadataRoutingOptionView {
  id: string;
  label: string;
  /** The model this option names, so the modal can say which one is missing. */
  model: string;
  availability: MetadataRoutingAvailability;
  /** Why the availability is `unknown` for a reason the host banner does not already give. */
  availabilityNote?: string;
}

export interface MetadataRoutingTaskView {
  id: string;
  label: string;
  options: MetadataRoutingOptionView[];
  selectedOptionId: string;
}

/** The state of the Ollama host every plain-local option was judged against. */
export interface MetadataRoutingHostView {
  host: string;
  reachable: boolean;
  error?: string;
  installedCount: number;
}

export interface MetadataRoutingView {
  tasks: MetadataRoutingTaskView[];
  localModels: MetadataRoutingHostView;
}

function optionView(id: string, inventory: OllamaInventory): MetadataRoutingOptionView {
  const option = METADATA_ROUTING_OPTIONS[id];
  const base = { id, label: option.label, model: option.model };

  if (option.kind === 'cloud') {
    return { ...base, availability: 'cloud' };
  }
  if (!servedByOllama(option)) {
    return {
      ...base,
      availability: 'unknown',
      availabilityNote:
        `served by the Ollama-shaped shim on ${option.host}, which this app starts on demand — ` +
        `Ollama does not list it, so whether it is present cannot be checked from here`,
    };
  }
  if (!inventory.reachable) {
    return { ...base, availability: 'unknown' };
  }
  const installed = inventory.models.some((name) => normalizeOllamaName(name) === normalizeOllamaName(option.model));
  return { ...base, availability: installed ? 'installed' : 'not-installed' };
}

/**
 * The whole table plus this store's selections, in the shape the modal consumes.
 *
 * FROZEN contract (metadata-routing:get). The frontend is written against exactly this,
 * so the registry may gain tasks and options without the payload changing shape.
 *
 * Each option carries whether its model is actually installed, because a routing that
 * names a model the machine does not have looks exactly like one that works until the
 * run reaches it — which is how a stored `cogito:14b` selection silently cost a job its
 * chapters. Nothing is hidden and nothing is substituted: a missing model stays
 * selectable and still fails loudly at generation time.
 *
 * A stored selection that fails validation is not quietly replaced by the default here
 * either — resolveMetadataRouting throws, the IPC call fails, and the modal shows the
 * user the same error a generation would have failed with.
 */
export function buildRoutingView(stored: unknown, inventory: OllamaInventory): MetadataRoutingView {
  const resolved = resolveMetadataRouting(stored);
  return {
    tasks: METADATA_ROUTING_TASKS.map((task) => ({
      id: task.id,
      label: task.label,
      options: task.options.map((id) => optionView(id, inventory)),
      selectedOptionId: resolved[task.id],
    })),
    localModels: {
      host: inventory.host,
      reachable: inventory.reachable,
      error: inventory.error,
      installedCount: inventory.models.length,
    },
  };
}

/** Log the routing once per resolve, so a job's log says which models wrote its fields. */
export function logRouting(context: string, routing: ResolvedMetadataRouting): void {
  log.info(`[MetadataRouting] ${context}: ${describeRouting(routing)}`);
}
