/**
 * Per-task routing: which model writes which field
 *
 * Metadata used to be one call to one model. It is now one call per TASK, each settable to
 * its own model, so "which model" stopped being a single setting and became a table. (The
 * tasks were once migrating to local fine-tuned adapters one at a time; the adapters were
 * retired 2026-08-25 and every option here is a plain prompted model.) This module is the
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
 *
 * The ONE exception is an id THIS BUILD REMOVED, which is a different event: the user chose
 * something legitimate and an upgrade took it away, and throwing there fails the very modal
 * they would fix it in. Those ids are listed in REMOVED_ROUTING_TASKS /
 * REMOVED_ROUTING_OPTIONS and dropped by `migrateStoredRouting` with a logged notice and a
 * write-back — a recorded migration, not a silent substitution. Anything else still throws.
 */

import * as log from 'electron-log';

export type MetadataRoutingTaskId =
  | 'titles'
  | 'description'
  | 'chapters'
  | 'tags'
  | 'thumbnail_text'
  | 'pinned_comment';

export interface MetadataRoutingOption {
  /** 'cloud' goes through AIManagerService's provider clients; 'local' through Ollama. */
  kind: 'cloud' | 'local';
  /** What the modal shows. */
  label: string;
  /**
   * Cloud: the provider-prefixed model AIManagerService.makeRequest routes on.
   * Local: the bare Ollama model name, as `ollama list` prints it.
   */
  model: string;
  /**
   * THERE IS NO PER-OPTION HOST, AND NO PROMPT SHAPE TO CHOOSE, as of 2026-08-25.
   *
   * This interface used to carry `host`, `startHint`, `startCommand` and `promptStyle`, and
   * all four existed for one thing: the trained adapters, and in particular the 32B titles
   * model on its own Ollama-SHAPED MLX shim, which the app started on demand. The operator
   * retired the adapters — the prompted models replaced them — so every local option is now a
   * plain Ollama model on the one configured host, in the one prompt-set shape, and there is
   * nothing left for those fields to vary. Keeping them would have described a choice the
   * build can no longer make.
   */
}

/**
 * The model the ALWAYS-ON chapter pipeline runs, which is deliberately not a routing option
 * any more.
 *
 * Chapters used to be a routed task with six options across three architectures. As of
 * 2026-08-22 there is one — the whole-transcript call (chapter-whole-transcript.service.ts,
 * CHAPTERING.md's reversal section) — and it is not a choice: every run that has a
 * timestamped transcript chapters it this way. A picker with one entry is not a picker, and
 * the dead architectures it used to offer are deleted rather than left selectable.
 *
 * It is still DECLARED here rather than hidden inside the pipeline, because the routing modal
 * reports whether it is installed before a run spends an hour finding out.
 *
 * ONE MODEL, where this used to name two. `nomic-embed-text` was the chapter pipeline's
 * junction scorer and the chapter pipeline no longer scores junctions; it is still used, by
 * key-phrase ranking, and it is declared where THAT reads it (KEY_PHRASE_EMBEDDING_MODEL
 * below). Leaving it in a constant called CHAPTER_PIPELINE_MODELS would say a run's chapters
 * depend on a model they cannot even reach.
 */
/**
 * The model that extracts evidence from a transcript, on the ONE path that still asks for it.
 *
 * COMPILATION MODE IS THE ONLY SURVIVING CONSUMER (2026-08-23). Compilation joins every item's
 * output into a single combined prompt, so each item has to arrive short by construction
 * whatever its length — `forceCondense`, which is not size-dependent and never was. And a
 * compilation item cannot use the alternative: the chapter digest that replaced summarization on
 * the per-item path needs a chapter list, and compilation runs no chapter pipeline (its items
 * are joined, and one chapter list per item is not one video's table of contents). So this stays,
 * scoped to the mode the operator selects.
 *
 * What it is NO LONGER used for: the per-item metadata path. An over-ceiling item there reads
 * the chapter digest (chapter-digest.ts), on the operator's ruling that a condensation is only
 * acceptable in the form of chapters. If compilation ever grows chapters per item, this constant
 * and the summarize functions in ai-manager.service.ts go with it.
 *
 * DECLARED HERE, not routed, and not taken from the Settings page. Summarization used to run on
 * whatever the "AI Model" picker said — which meant a user who had ever configured a cloud
 * model was silently paying a cloud provider to read every transcript, on a run whose every
 * other field was local. That is the kind of divergence this build exists to remove: the
 * summarizer is a fixed, stated part of the compilation pipeline, exactly like
 * CHAPTER_PIPELINE_MODELS below, and it is stated in one place.
 *
 * Provider-prefixed because AIManagerService's model strings are.
 *
 * NOT a fallback for an absent setting — there is no setting. Anyone who wants a different
 * summarizer changes this line, and the change is visible in the diff and in the run's log.
 */
export const SUMMARIZATION_MODEL = 'ollama:qwen3.8:27b';

export const CHAPTER_PIPELINE_MODELS = {
  /** Reads the whole transcript in one call, then writes each chapter's detail. */
  generation: 'qwen3.8:27b',
} as const;

/**
 * The embedding model key-phrase ranking uses (key-phrases.ts), declared for the same reason
 * the chapter model is: the routing modal can say it is missing before a run finds out.
 *
 * Its absence is NOT a failure — the ranking falls to frequency and the run RECORDS that as a
 * declared mode in its warnings — so the modal reports it as a quality notice rather than a
 * blocker. It is also the one local model this app loads that does NOT count against the
 * two-model budget: 274MB loads beside a generation model rather than instead of it.
 */
export const KEY_PHRASE_EMBEDDING_MODEL = 'nomic-embed-text';

export const METADATA_ROUTING_OPTIONS: Record<string, MetadataRoutingOption> = {
  sonnet5: { kind: 'cloud', label: 'Claude Sonnet 5', model: 'claude:claude-sonnet-5' },
  opus5: { kind: 'cloud', label: 'Claude Opus 5', model: 'claude:claude-opus-5' },
  /**
   * The subscription rung (operator, 2026-08-24): the same Sonnet, reached through the
   * `claude -p` CLI on the operator's Claude Code plan instead of the metered API key.
   * ALWAYS Sonnet — the option's one job is "this field's test runs cost nothing extra",
   * and a model picker inside a transport picker would be two decisions wearing one id.
   * `kind: 'cloud'` is honest: the modal reports it as cloud, the chapter service stands
   * its local machinery down for it, and the run holds no local model for it. The spawn
   * failing (binary not on PATH, nonzero exit) throws loudly at call time — there is no
   * API fallback, deliberately: falling back would silently bill the key this option
   * exists to protect.
   */
  'claude-cli': { kind: 'cloud', label: 'claude -p (Opus, subscription)', model: 'claude-cli:opus' },
  /**
   * The Sonnet rung of the same transport, split out 2026-08-24 when the operator asked
   * the claude -p rung to run Opus for an in-app comparison. Same key-free spawn, same
   * no-fallback rule; only the CLI model alias differs.
   */
  'claude-cli-sonnet': { kind: 'cloud', label: 'claude -p (Sonnet, subscription)', model: 'claude-cli:sonnet' },
  /**
   * The cheap cloud rung, added 2026-08-24. The prompt harness ran the production prompts
   * against it (tools/prompt-tune, cycle 1): descriptions and chapter details held at n=2
   * with zero factual-check failures. Offered on every big field so the operator can run
   * that comparison for real; not a default anywhere until it earns one.
   */
  haiku45: { kind: 'cloud', label: 'Claude Haiku 4.5', model: 'claude:claude-haiku-4-5' },
  /**
   * The local default for the text fields as of 2026-08-22.
   *
   * It replaces the headline-14b adapters, which are not a choice any more: their base
   * model (cogito:14b) was deleted from this machine, so every `headline-14b-*` tag left in
   * Ollama is a shell that cannot load. Removing the options rather than leaving them
   * selectable is the point — an option naming a model that cannot run is a job that fails
   * an hour in. Every remaining adapter followed them out on 2026-08-25.
   */
  'qwen35-9b': { kind: 'local', label: 'Qwen3.5 9B', model: 'qwen3.5:9b' },
  /**
   * The metadata spec's A/B candidate for the two MECHANICAL calls, offered on description
   * and tags and nowhere else.
   *
   * §5's measurement is what makes a 4b credible here at all: qwen3.5:4b is the measured floor
   * for schema-constrained mechanical work (10/10 on boundary placement, ~1.2s a call), and
   * the description hook and body became exactly that kind of work when they stopped reading
   * the transcript and started reading the chapter summaries under a JSON Schema. The same
   * measurement says qwen3.5:2b fails instruction-following even constrained, so there is no
   * smaller rung offered.
   *
   * NOT the default, deliberately. The default stays the 9B and this is the option the
   * operator flips to run the comparison §7.3 asks for — adopt the 4b only if he cannot
   * reliably tell which is which. A default that changed on the strength of an untested
   * proposal would make that comparison retrospective.
   */
  'qwen35-4b': { kind: 'local', label: 'Qwen3.5 4B', model: 'qwen3.5:4b' },
  /**
   * A BASE model on fields that used to be cloud-only, which is a deliberate exception to
   * this file's own rule and the reason the note below METADATA_ROUTING_TASKS was rewritten.
   *
   * Measured on this machine, this model given a GENERIC brief writes a colon title 47% of
   * the time, and colons lose head-to-head 20-to-5 in the operator's own A/B record. It is
   * offered anyway because it is not given a generic brief — it runs the same prompt
   * pipeline as everything else, which carries the per-channel yml sets and the abLearnings
   * block, and the same measurement showed the shape collapses to 0% once real head-to-heads
   * are in the prompt. The caveat is real but it is a property of the prompt, not the model.
   *
   * Consequence worth knowing before choosing it: a larger model amplifies whatever the
   * prompt teaches, in both directions.
   *
   * The label carries no field suffix on purpose. Every `(titles)` / `(tags)` /
   * `(descriptions)` label this table ever had marked a TRAINED ADAPTER, and this is a base
   * model appearing in six different dropdowns.
   *
   * CHECKED, because it was expected to be a problem and is not: this model reasons by
   * default, and on Ollama's /api/chat that reasoning lands in `message.thinking` while
   * `message.content` comes back EMPTY unless the caller sends `think: false`. This app does
   * not use /api/chat — the local client posts to /api/generate and reads `data.response`,
   * and that endpoint returns `response` and `thinking` as SEPARATE fields. Probed with this
   * app's exact options block (temperature 0.7, num_predict 4096, num_ctx 32768): 74
   * characters of `response`, 566 of `thinking`, done_reason "stop". The content arrives and
   * the reasoning is discarded, which is what we want. No think flag needed — but anyone
   * moving this app to /api/chat must add one, or every local field silently becomes an
   * empty string. The one shape that DOES bite is `format: "json"`, which constrains the
   * whole stream and can leave the object in `thinking`; ollama-json.ts handles exactly that
   * case and nothing wider.
   */
  'qwen38-27b': { kind: 'local', label: 'Qwen 27B', model: 'qwen3.8:27b' },
};

export interface MetadataRoutingTask {
  id: MetadataRoutingTaskId;
  label: string;
  /** Option ids offered for this task, in the order the modal should list them. */
  options: string[];
  /** Runs when the stored setting has no entry for this task. Must be in `options`. */
  defaultOptionId: string;
  /**
   * Rendered as a row in the routing modal. The big determinative fields are rows
   * (operator's direction, 2026-08-24: "the big models that determine things like titles -
   * i should be able to set those to whatever"); the small-model work is not ("if we use
   * 9b for something then leave it") — tags stay a stored-entry-only setting exactly as
   * the old slot design left them.
   */
  modal: boolean;
}

/**
 * The table. Order is the modal's order.
 *
 * ALL SIX TASKS ARE NOW LOCAL-BY-DEFAULT AND CLOUD-CAPABLE, which is the opposite of what
 * this note used to say. It read: "`chapters` is local-only because the sealed pipeline
 * makes hundreds of one-question calls per video ... thumbnail_text and pinned_comment are
 * cloud-only for the opposite reason: no adapter has been trained for them yet, and pointing
 * them at a base model would answer the brief fluently and wrongly."
 * Both halves of that stopped being true on 2026-08-22:
 *
 *  - `chapters` is not in this table at all. It is not routed, because there is nothing
 *    left to route it to: the embedding pipeline is the only chaptering architecture and it
 *    always runs (CHAPTER_PIPELINE_MODELS above).
 *  - The adapter argument died with its base model. cogito:14b was deleted from this
 *    machine, so `headline-14b-descriptions` / `-tags` / `-titles` cannot load, and holding
 *    three fields at cloud-only to wait for adapters that no longer have a base is waiting
 *    for nothing. The base-model caveat still stands and is written out in full on the
 *    `qwen38-27b` option — it is a property of a GENERIC brief, and these tasks send the
 *    per-channel yml sets and the abLearnings block, not a generic brief.
 *
 * EVERY DEFAULT IS LOCAL AS OF THIS BUILD. Titles were the last cloud default and moved to
 * the 27B; pinned comments moved off the 9B onto it too. The shipped table is now:
 *
 *   titles, thumbnail_text, pinned_comment  ->  qwen3.8:27b
 *   description                             ->  qwen3.5:9b (DescriptionUnit)
 *   tags                                    ->  code-assembled where the item has chapters,
 *                                               else qwen3.5:9b
 *
 * THE GROUPING IS THE POINT, not just the model choice. Four fields on ONE model is ONE call,
 * and the fields in it are the ones the prompt sets were written to be written together: the
 * self-check's "the thumbnail text must not repeat a word from your top 3 titles" is a rule a
 * model can only follow if it wrote both, and for a year it could not. Where the operator
 * routes them apart, the self-check is assembled per group instead (prompt-assets.ts
 * `selfCheckBlock`) so no group is ever handed a check about a field it will not write.
 *
 * The two fields that stay off the big model do so for stated reasons: the description is two
 * schema-constrained mechanical calls over already-extracted inputs, which is what the 9B is
 * for; tags on a chaptered item are not written by a model at all.
 *
 * Cloud stays offered on every task. Nothing here is a fallback: a local model that fails
 * fails the field, and the user picks the cloud option deliberately if they want it.
 */
export const METADATA_ROUTING_TASKS: MetadataRoutingTask[] = [
  {
    /**
     * LOCAL BY DEFAULT as of this build, which is the last field to move.
     *
     * Titles were the one task still defaulting to a cloud model, and the argument for that
     * was never really about titles — it was that the 27B, given a GENERIC brief, writes a
     * colon title 47% of the time. That measurement is on the option itself (`qwen38-27b`
     * above) along with what it actually means: the shape collapses to 0% once the real
     * head-to-heads are in the prompt, and this path always puts them there.
     *
     * Ordered so the shipped default is first.
     */
    id: 'titles',
    label: 'Titles',
    options: ['qwen38-27b', 'sonnet5', 'opus5', 'haiku45', 'claude-cli', 'claude-cli-sonnet'],
    defaultOptionId: 'qwen38-27b',
    modal: true,
  },
  {
    id: 'description',
    label: 'Description',
    options: ['qwen38-27b', 'qwen35-9b', 'qwen35-4b', 'sonnet5', 'opus5', 'haiku45', 'claude-cli', 'claude-cli-sonnet'],
    // 27B as of 2026-08-23, up from the 9B: the 9B default shipped a description that
    // misattributed the video's claims and invented facts (the f2-braeden-sorbo
    // comparison). 9b/4b remain offered for the A/B.
    defaultOptionId: 'qwen38-27b',
    modal: true,
  },
  {
    /**
     * A ROUTED TASK AGAIN as of 2026-08-24, which reverses 2026-08-22 — deliberately, and
     * for a different reason than the routing it replaces. Chapters stopped being routed
     * when the dead architectures left one pipeline with one model; then chapters followed
     * the writing-model slot as a projection (the chapter labels are what the description
     * conditions on, so the model trusted with one was trusted with the other). The
     * operator's per-field direction dissolves the slot, so the projection has nothing to
     * project from — chapters get their own row, defaulting to the same local model the
     * projection defaulted to. The compilation summarizer follows THIS field's selection
     * (ipc-handlers), because condensation rewrites the words every content field reads.
     *
     * Only the capable rungs are offered: the 9B on chapters was HALF of the measured
     * 2026-08-23 failure stack (whisper base + 9B routing, metadata-pipeline comparison),
     * and offering it here would sell the exact regression that comparison caught.
     */
    id: 'chapters',
    label: 'Chapters',
    options: ['qwen38-27b', 'sonnet5', 'opus5', 'haiku45', 'claude-cli', 'claude-cli-sonnet'],
    defaultOptionId: 'qwen38-27b',
    modal: true,
  },
  {
    /**
     * READ ON THE TEXT-SUBJECT PATH, not on the chaptered one.
     *
     * An item WITH chapters has its tags assembled in code from the entity and key-phrase
     * pools (metadata spec §4 and §6.2, tags-hashtags.ts): no model writes them, so this
     * selection is not consulted for that item and the run's log says so per item.
     *
     * An item WITHOUT chapters — a text subject the operator typed, an import whose chapter
     * pipeline came back short — has no chapter list for those pools to be measured against, so
     * its tags ARE written by a model, and this is the entry that says which one. That used to
     * happen inside a single legacy whole-metadata call on whatever the Settings page's "AI
     * Model" picker said; it is now this routed unit like every other field, which is the whole
     * point of killing that path.
     *
     * It is offered the 4b for the same reason description is: if tags ever go back to a model
     * on the chaptered path too, that is the comparison to run.
     */
    id: 'tags',
    label: 'Tags',
    options: ['qwen35-9b', 'qwen35-4b', 'qwen38-27b', 'sonnet5', 'opus5', 'claude-cli', 'claude-cli-sonnet'],
    defaultOptionId: 'qwen35-9b',
    // NOT a modal row — the operator's "if we use 9b for something then leave it". The
    // 9b/4b A/B stays a stored per-task entry set outside the modal, as it always was.
    modal: false,
  },
  {
    id: 'thumbnail_text',
    label: 'Thumbnail text',
    // 27B by default: the output is three words and the judgement behind them is the whole
    // video, so the cheaper model saves nothing worth having here.
    options: ['qwen38-27b', 'qwen35-9b', 'sonnet5', 'opus5', 'haiku45', 'claude-cli', 'claude-cli-sonnet'],
    defaultOptionId: 'qwen38-27b',
    modal: true,
  },
  {
    /**
     * 27B by default, moved off the 9B in this build at the operator's direction.
     *
     * The reason is grouping as much as quality: pinned comments now share a model with
     * titles and thumbnails, so all three are written by ONE model that can see its own
     * titles — which is what makes "reference something specific from this video" and the
     * cross-field self-check followable instead of aspirational.
     */
    id: 'pinned_comment',
    label: 'Pinned comment',
    options: ['qwen38-27b', 'qwen35-9b', 'sonnet5', 'opus5', 'haiku45', 'claude-cli', 'claude-cli-sonnet'],
    defaultOptionId: 'qwen38-27b',
    modal: true,
  },
];

/**
 * Which model the chapter pipeline runs on: the `chapters` task's own selection.
 *
 * HISTORY, because this function has now pointed at three different truths: chapters were a
 * routed task (pre-2026-08-22), then a projection of the writing-model slot (the slot's four
 * packaging fields plus description moved together, and chapters followed their agreement,
 * falling to the declared local constant when a hand-set store disagreed). The slot is gone
 * — the modal is per-field as of 2026-08-24 — so chapters are a routed task again and this
 * is a plain table read. The name and signature survive because four call sites (the two
 * chapter runs, the two-model budget, the compilation summarizer) built on them.
 */
export function resolveChapterModelOption(resolved: ResolvedMetadataRouting): MetadataRoutingOption {
  return routingOption('chapters', resolved.chapters);
}

/**
 * Ids this build used to offer, and why they went. Read by `migrateStoredRouting` ONLY.
 *
 * An existing store holds whatever the user last chose, and on 2026-08-22 a whole task and
 * six options stopped existing. Without this, `validateRoutingSelection` throws on the
 * store's own contents — which is right for a hand-edited typo and wrong for a setting this
 * build removed underneath the user, because the throw lands in `metadata-routing:get`,
 * which is the one screen where they could have fixed it.
 *
 * So removal is RECORDED here rather than guessed at the read site: an id in this map is
 * dropped with a logged notice quoting the reason, and an id that is NOT in this map still
 * throws exactly as before. Anyone removing an option in future adds it here in the same
 * commit, or existing installs break on upgrade.
 */
export const REMOVED_ROUTING_TASKS: Record<string, string> = {
  // `chapters` was in this map from 2026-08-22 to 2026-08-24 ("no longer routed"); it is a
  // routed task again, so a stored chapters entry is validated like any other. Its DEAD
  // OPTION ids from the removed architectures stay in REMOVED_ROUTING_OPTIONS below and are
  // still dropped with a notice.
  clip_suggestions:
    'clip suggestions were retired 2026-08-25 by operator decision — the field is not generated, ' +
    'not published and not offered any more, so there is nothing left for a routing entry to name',
};

export const REMOVED_ROUTING_OPTIONS: Record<string, string> = {
  'cogito-14b': 'cogito:14b was deleted from this machine',
  'qwen25-14b': 'it was offered for chapters only, and chapters are no longer routed',
  'qwen3-14b': 'it was offered for chapters only, and chapters are no longer routed',
  'chapters-qwen27b-single': 'the single-call chapter architecture was removed',
  'chapters-embedding':
    'the embedding pipeline stopped being one chapter option among several and became the ' +
    'only one, so it is not selectable any more — it always runs',
  'headline-desc-14b': 'its base model (cogito:14b) was deleted, so the adapter cannot load',
  'headline-tags-14b': 'its base model (cogito:14b) was deleted, so the adapter cannot load',
  'headline-titles-14b': 'its base model (cogito:14b) was deleted, so the adapter cannot load',
  // The last one standing. Its base model was fine and its MLX shim still runs — this is a
  // DECISION, not an outage, which is why the reason says so: an operator who reads the
  // notice should not go looking for a broken server.
  'headline-titles-32b':
    'the trained adapters were retired 2026-08-25 by operator decision — prompted models replaced ' +
    'them, so the 32B titles adapter, its MLX shim and adapters.yml are all gone from this build',
};

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
 * and an option that exists but is not offered for this task.
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

/**
 * What a stored routing looked like after this build was done reading it.
 *
 * `changed` is the whole point: the caller writes the migrated object BACK to the store
 * when it is true, so the notice is logged once on the first launch after the upgrade
 * rather than on every read for the rest of the install's life.
 */
export interface MetadataRoutingMigration {
  selections: MetadataRoutingSelections;
  changed: boolean;
  /** One human-readable line per entry dropped. Empty when nothing was. */
  notices: string[];
}

/**
 * Read a STORED routing, dropping the entries this build removed.
 *
 * This is the only reader that is allowed to be lenient, and it is lenient about exactly
 * one thing: ids listed in REMOVED_ROUTING_TASKS / REMOVED_ROUTING_OPTIONS above, plus an
 * option that is still known but is no longer OFFERED for its task. Those three cases are
 * this build's own doing — the user chose something legitimate and an upgrade took it away
 * — so dropping them back to the shipped default is a recorded migration, and it is
 * recorded: every drop is logged with the reason, and `changed` tells the caller to persist
 * the result so the notice is not repeated forever.
 *
 * Everything else still throws. An option id that was never in this table is a typo or a
 * hand-edited store, and quietly running a different model than the one the file names is
 * precisely the failure this module exists to prevent.
 *
 * NOT called by `metadata-routing:set`. Input arriving from the modal is validated
 * strictly — the modal can only offer what this build has, so a rejected id there is a bug
 * in the modal, not an upgrade.
 */
export function migrateStoredRouting(stored: unknown): MetadataRoutingMigration {
  if (stored === undefined || stored === null) {
    return { selections: {}, changed: false, notices: [] };
  }
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    throw new Error(`metadataRouting must be an object of taskId -> optionId (got ${JSON.stringify(stored)})`);
  }

  const selections: MetadataRoutingSelections = {};
  const notices: string[] = [];

  for (const [taskId, optionId] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof optionId !== 'string' || optionId.trim().length === 0) {
      throw new Error(`metadataRouting.${taskId} must be an option id string (got ${JSON.stringify(optionId)})`);
    }

    const removedTask = REMOVED_ROUTING_TASKS[taskId];
    if (removedTask) {
      notices.push(`dropped metadataRouting.${taskId} (was "${optionId}"): ${removedTask}`);
      continue;
    }

    const removedOption = REMOVED_ROUTING_OPTIONS[optionId];
    if (removedOption) {
      const task = taskDef(taskId);
      notices.push(
        `dropped metadataRouting.${taskId} = "${optionId}": ${removedOption}; ` +
          `${task ? `"${task.label}" falls back to its shipped default, ${task.defaultOptionId}` : 'the entry is gone'}`
      );
      continue;
    }

    // Still a known option, but this build no longer offers it HERE (e.g. a task's option
    // list was narrowed). Same class of event as a removal and recorded the same way.
    const task = taskDef(taskId);
    if (task && METADATA_ROUTING_OPTIONS[optionId] && !task.options.includes(optionId)) {
      notices.push(
        `dropped metadataRouting.${taskId} = "${optionId}": that option is no longer offered for ` +
          `"${task.label}"; it falls back to the shipped default, ${task.defaultOptionId}`
      );
      continue;
    }

    // Anything left is validated exactly as before — including the unknown-id throw.
    validateRoutingSelection(taskId, optionId);
    selections[taskId as MetadataRoutingTaskId] = optionId;
  }

  // THE SLOT'S LAST ACT (2026-08-24). Until this build, chapters were not stored — they ran
  // on the writing-model slot's PROJECTION: when titles, description, thumbnail, pinned and
  // clips all resolved to one slot option, chapters followed it; otherwise the local
  // constant. A store from that era where the projection agreed on a CLOUD model would,
  // without this, silently drop its chapters back to the local default — the exact
  // "silently get something else" this module exists to prevent. So the projection is
  // computed ONE more time, here, and written down as the chapters entry it always
  // effectively was. Local agreement needs no entry: it equals the shipped default.
  if (!('chapters' in selections)) {
    // `clip_suggestions` was the fifth voter here until the field was retired (2026-08-25).
    // Its vote is gone with it rather than defaulted in: a store from the slot era set all
    // five together, so the four that remain agree exactly when the five did.
    const exSlotTasks: MetadataRoutingTaskId[] = [
      'titles', 'description', 'thumbnail_text', 'pinned_comment',
    ];
    const exSlotOptions = ['qwen38-27b', 'sonnet5', 'opus5'];
    const picks = exSlotTasks.map(
      (id) => selections[id] || METADATA_ROUTING_TASKS.find((task) => task.id === id)!.defaultOptionId
    );
    const agreed =
      picks.every((id) => id === picks[0]) && exSlotOptions.includes(picks[0]) ? picks[0] : null;
    const chaptersDefault = METADATA_ROUTING_TASKS.find((task) => task.id === 'chapters')!.defaultOptionId;
    if (agreed && agreed !== chaptersDefault) {
      selections.chapters = agreed;
      notices.push(
        `wrote metadataRouting.chapters = "${agreed}": chapters used to follow the writing-model ` +
          `slot's agreement, the slot is gone (per-field routing), and this store's fields agreed ` +
          `on that option — recorded so the next run chapters on the same model as the last one`
      );
    }
  }

  const changed = notices.length > 0;
  for (const notice of notices) {
    log.warn(`[MetadataRouting] settings migration: ${notice}`);
  }
  return { selections, changed, notices };
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
 * - `unknown` — nobody can say: Ollama did not answer, so NOTHING it serves can be judged.
 *   Deliberately distinct from `not-installed`: "we could not check" and "it is not there"
 *   have different fixes, and collapsing them would be a guess.
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
 * Ollama prints an untagged model as `name:latest`, and the registry has written bare names
 * before now. Comparing the two raw would report an installed model as missing.
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
}

export interface MetadataRoutingTaskView {
  id: string;
  label: string;
  options: MetadataRoutingOptionView[];
  selectedOptionId: string;
  /** Rendered as a row in the modal. False = stored-entry-only (tags). */
  modal: boolean;
}

/** The state of the Ollama host every plain-local option was judged against. */
export interface MetadataRoutingHostView {
  host: string;
  reachable: boolean;
  error?: string;
  installedCount: number;
}

/**
 * The two models nobody chooses, which still have to be REPORTED.
 *
 * Chapters run on every item with a timestamped transcript, on CHAPTER_PIPELINE_MODELS.
 * Key-phrase ranking runs on every item, on KEY_PHRASE_EMBEDDING_MODEL. Nobody picks either,
 * so there is no row to hang a "not installed" warning off — but the warning is the part that
 * was worth having: a stored `cogito:14b` selection once cost a job its chapters an hour into
 * the run, and the probe exists so that is said BEFORE the run rather than after it.
 *
 * The two are separate fields because they are not the same failure. Without the chapter
 * model an item gets no chapters at all; without the embedding model the run continues with
 * frequency-ranked key phrases and declares it in its warnings, which the user should get to
 * decline in advance.
 *
 * `keyPhrase*` used to be `embedding*` on this same view, when the embedding model was the
 * chapter pipeline's junction scorer. It is renamed rather than repurposed: reporting it
 * under chapters would say a run's chapters depend on it, and since 2026-08-22 they do not.
 */
export interface MetadataRoutingChaptersView {
  generationModel: string;
  keyPhraseModel: string;
  generationAvailability: MetadataRoutingAvailability;
  keyPhraseAvailability: MetadataRoutingAvailability;
}

export interface MetadataRoutingView {
  tasks: MetadataRoutingTaskView[];
  localModels: MetadataRoutingHostView;
  chapters: MetadataRoutingChaptersView;
}

function optionView(id: string, inventory: OllamaInventory): MetadataRoutingOptionView {
  const option = METADATA_ROUTING_OPTIONS[id];
  const base = { id, label: option.label, model: option.model };

  if (option.kind === 'cloud') {
    return { ...base, availability: 'cloud' };
  }
  if (!inventory.reachable) {
    return { ...base, availability: 'unknown' };
  }

  const installed = inventory.models.some(
    (name) => normalizeOllamaName(name) === normalizeOllamaName(option.model)
  );
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
  const chapterModel = (name: string): MetadataRoutingAvailability => {
    if (!inventory.reachable) return 'unknown';
    return inventory.models.some((installed) => normalizeOllamaName(installed) === normalizeOllamaName(name))
      ? 'installed'
      : 'not-installed';
  };
  return {
    tasks: METADATA_ROUTING_TASKS.map((task) => ({
      id: task.id,
      label: task.label,
      options: task.options.map((id) => optionView(id, inventory)),
      selectedOptionId: resolved[task.id],
      modal: task.modal,
    })),
    chapters: (() => {
      // The model chapters will actually run on: the chapters row's selection, reported by
      // the same function generation consults, so the modal can never say one model while
      // the run uses another.
      const chapterOption = resolveChapterModelOption(resolved);
      return {
        generationModel: chapterOption.model,
        keyPhraseModel: KEY_PHRASE_EMBEDDING_MODEL,
        generationAvailability:
          chapterOption.kind === 'cloud' ? ('cloud' as const) : chapterModel(chapterOption.model),
        keyPhraseAvailability: chapterModel(KEY_PHRASE_EMBEDDING_MODEL),
      };
    })(),
    localModels: {
      host: inventory.host,
      reachable: inventory.reachable,
      error: inventory.error,
      installedCount: inventory.models.length,
    },
  };
}

