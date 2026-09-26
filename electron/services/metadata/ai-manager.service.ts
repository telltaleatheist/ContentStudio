/**
 * AI Manager Service: the prompt assembly every metadata call shares, and the two doors a
 * model call leaves the app through.
 *
 * Every model call goes through ONE Crucible transport (electron/crucible/transport.ts,
 * LEDGER #193), except `claude -p`, which stays outside Crucible as the subscription test
 * transport and keeps its own branch in `makeRequest`. The Anthropic, OpenAI and Ollama
 * clients this service used to construct are gone with P2 (plan 6.1, 6.5): the routing table
 * picks the model (LEDGER #204), the selected Crucible server runs it, and the key is that
 * server's (#194).
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFileSync } from 'child_process';
import * as os from 'os';
import * as log from 'electron-log';
import { ANTHROPIC_MAX_TOKENS, crucibleTransport, type PromptTraceRecord } from '../../crucible/transport';
import { isUpstreamModelId } from '../../crucible/acts';
import type { JobLeases } from '../../crucible/lease';
import { renderChapterList } from './chapter-digest';
import { SYSTEM_PROMPTS, formatPrompt } from './system-prompts';
import { METADATA_FIELDS } from './metadata-fields';
import {
  InstructionSection,
  MetadataFieldId,
  MetadataFieldUnitSpec,
  MetadataRunContext,
  buildFieldInstructions,
  buildInputDataBlock,
  parseInstructionSections,
} from './metadata-tasks';
import { ChannelData, PROMPTS_SUBDIR, initPromptAssets, promptAssets } from './prompt-assets';
import { Chapter } from './chapter-generator.service';
import { queueAITask, routeOfModelId } from '../queue-manager.service';
import { JobCancelledError } from './cancellation';
import { stripThinking } from './plain-call';
import { loadContextFor } from './context-sizing';

/**
 * How much raw transcript each transport reads BEFORE anything is condensed.
 *
 * Module-level and exported because the rule is asserted in the pure-check harness
 * (tools/routing-publish-checks.js): the whole point of the 2026-08-22 change is that a local
 * run reads the video rather than a précis of it, and a threshold that quietly drifted back
 * down would look exactly like a run that happened to have a long transcript.
 *
 * cloud — unchanged. ~60k characters is roughly an hour of speech, and beyond it the
 *   evidence-extraction pass is cheaper than the tokens.
 * local — NEW, and derived rather than chosen. The per-field calls refused above
 *   LOCAL_FIELD_CTX_MAX = 40960 tokens (metadata-tasks.ts, retired in P4: each call now asks
 *   for its own 8,192 step and the server refuses above its own ceiling), which is ~143,000
 *   characters at this codebase's 3.5 chars/token estimate. Out of that comes the output budget
 *   (num_predict 8192 ≈ 29,000 characters) and the prompt assembled around the transcript
 *   (editorial core, field section, self-check, chapter block, insights ≈ 20,000 characters).
 *   143k - 29k - 20k ≈ 94k; 90,000 is that with the margin left in.
 */
export const DIRECT_PASS_MAX_CHARS = {
  // 400k as of 2026-08-23, up from 60k — an operator-directed priority call, made the day a
  // 60,695-char podcast missed the old ceiling by 695 characters and spent seven minutes
  // being summarized on the local 27B, shedding exactly the verbatim phrasing the ship-field
  // bars require (LEDGER.md §1: correctness over cost, "it can take as long as it needs").
  // The cloud models this app routes to carry a 1M-token window; 400k chars ≈ ~110k tokens,
  // which fits every call with scaffolding to spare and covers a ~6-hour transcript. Cost at
  // the ceiling is a few dollars per video and only on the rare item that big — the 60k
  // number was a cost guard from when descriptions ran local and cloud was the exception.
  cloud: 400000,
  local: 90000,
} as const;

/**
 * Does this transcript reach the model AS ITSELF?
 *
 * The one place the question is answered, so the threshold cannot be stated in one place and
 * applied in another. `forceCondense` is the compilation mode's declared exception: its items'
 * outputs are joined into one combined prompt, so each has to be short by construction whatever
 * its length.
 */
export function directPassesRaw(options: {
  chars: number;
  /** Which DIRECT_PASS_MAX_CHARS entry the transcript is measured against. */
  ceiling: 'local' | 'cloud';
  forceCondense?: boolean;
}): boolean {
  if (options.forceCondense) return false;
  return options.chars <= DIRECT_PASS_MAX_CHARS[options.ceiling];
}

export interface AIConfig {
  /**
   * Which direct-pass ceiling a transcript is measured against, decided by WHERE THE FIELD
   * CALLS GO: every routed field model local -> 'local' (90k), any cloud -> 'cloud'. Required
   * by `summarizeTranscript`, which refuses without it: the provider setting it used to be
   * derived from is gone (P2), and a ceiling guessed from nothing is Law 1's fallback.
   */
  transcriptCeiling?: 'local' | 'cloud';
  /** The compilation summarizer's model (metadata-routing SUMMARIZATION_MODEL, or the chapters row). */
  summarizationModel?: string;
  /**
   * The model a caller that routes one whole-service call names up front: the episode
   * splitter's chapters selection. No routed field call reads it (LEDGER #204).
   */
  metadataModel?: string;
  promptSet?: string;
  promptSetsDir?: string;
  // "CHANNEL PERFORMANCE DATA" block from the analytics feedback loop, appended
  // to the metadata prompt when present (resolved by the caller; optional).
  insightsBlock?: string;
  /**
   * Fired when the user cancels the run. Handed to every call so a request already in flight
   * is ABORTED rather than left to finish and be billed.
   */
  abortSignal?: AbortSignal;
  /**
   * The JOB's Crucible leases (plan 13.3), for the local calls this service sends itself
   * (compilation summarizing and packaging). Absent: each such call is a one-call job,
   * leased and released around itself.
   */
  jobLeases?: JobLeases;
}

/**
 * How one plain call is shaped, stated at every call site (plan 6.3): THINKING is never left
 * to a model default, because the 9B's manifest defaults it off and the 27B's states nothing,
 * so one call would behave two ways (plan 1).
 */
export interface PlainCallShape {
  thinking: boolean;
  /**
   * The local output budget. On an `anthropic/` model the door always sends 16000 (LEDGER
   * #187) and this is not read; on `claude -p` neither is.
   */
  maxTokens?: number;
  /** Local only: the context to load the model at when this job loads it (today's num_ctx). */
  loadContext?: number;
  /** Local only: the chapter stage's consensus samples. Refused on a cloud upstream (#194). */
  temperature?: number;
  /** The job's leases, when the caller has a job; else the service's own, else a one-call job. */
  job?: JobLeases;
  /** A wall clock on the answer (the old per-call timeouts). */
  timeoutMs?: number;
}

export interface MetadataResult {
  thumbnail_text?: string[];
  titles?: string[];
  description?: string;
  /**
   * The description's opening line, <=150 characters (metadata spec §1.1).
   *
   * Present only on items generated through the chaptered path by this build or later. Its
   * absence is what tells description-composer.ts to compose an item the way it always did.
   */
  description_hook?: string;
  /**
   * The OTHER descriptions this run wrote, each already flattened to `<hook>\n\n<body>` —
   * the shape the composer publishes, minus the chapter block it inserts between them.
   *
   * ADDITIVE, and it never changes what `description` means. `description` is still the one
   * description of this item: the publish pipeline, the carry-forward and every stored report
   * read exactly the field they always read. These are alternatives the operator may choose to
   * paste over it, in the same relation to `description` that `titles` has always had to the
   * title he ends up using.
   *
   * Absent on every item generated before this build, and on any run whose extra candidates
   * all failed — which is a declared warning, not a missing contract.
   */
  description_options?: string[];
  tags?: string;
  hashtags?: string;
  pinned_comment?: string[];
  spoken_keywords?: string[];
  // The chapter pipeline's own shape, not a local copy of it: chapters now carry a
  // `detail` sentence, an approximate-start flag and their pre-consolidation
  // sub-chapters, and every one of those has to survive the trip to the output files.
  chapters?: Chapter[];
  /**
   * Chapters the promo classifier took out of the published list (promo-chapters.ts),
   * each carrying `isPromo: true`.
   *
   * They are kept in the job JSON so nothing the pipeline measured and named is silently
   * lost — the user can see exactly which spans were treated as ads. Nothing downstream
   * publishes or conditions on them.
   */
  excludedChapters?: Chapter[];
  /**
   * Why this item has no chapters, when the user asked for them.
   *
   * The run's `warnings` array says the same thing, but it lives only as long as the
   * completion response — open the report a week later and a chapterless item looks
   * identical to one that was never meant to have chapters. This travels with the item
   * into the job JSON and the TXT, so the reason outlives the run that produced it.
   *
   * `failed` is the pipeline throwing; `skipped` is the item never reaching it, or its
   * result being discarded before it could publish (too few chapters, all promo).
   */
  chaptersSkipped?: { outcome: 'failed' | 'skipped'; reason: string };
}

/**
 * A channel's prompt set, ASSEMBLED from the prompt assets rather than read from one file.
 *
 * The shape is unchanged from when it was a whole YAML on disk, deliberately: everything
 * downstream of here — the section parser, the group builder, the tag append, the description
 * links — reads these four strings and does not care that `editorial_prompt` is now the shared
 * editorial blocks with this channel's variant applied, or that `instructions_prompt` is the
 * shared per-field sections in this channel's declared order. Assembly happens once, in
 * `loadPrompts`; see prompt-assets.ts for what it assembles from.
 */
export interface PromptSet {
  name: string;
  editorial_prompt: string;
  instructions_prompt: string;
  description_links: string;
  /**
   * Channel and creator tags appended to every generated tag list for this prompt set.
   *
   * OPTIONAL, and absent means absent — no append, no default, no guess at what the
   * channel is called. It exists because the tags adapter is TRAINED to leave channel and
   * creator names out ("those are appended separately"), so the names are a property of
   * the prompt set, which is the thing that knows which channel it publishes to.
   */
  channel_tags?: string[];
}

export class AIManagerService {
  /**
   * Every prompt this instance has sent through makeRequest, in send order — what the call
   * was for, which model read it, its size, and the prompt text itself.
   *
   * WHY: the operator judging a bad field has the OUTPUT and nothing else; whether the
   * input was overloaded, thin, or garbled is unanswerable after the run. The generator
   * slices this per item onto `_prompt_trace`, the job JSON stores it, and the reports
   * page renders it — so every generated item can show exactly what the models were told.
   *
   * SCOPE: EVERY call, since P2. The one door (crucible/transport.ts) records each call here
   * with the Crucible server that ran it (Law 8), local and cloud alike, and the `claude -p`
   * branch records its own with `claude -p` as the server. The per-field local calls used to
   * speak to Ollama directly and never appeared; they go through the same door now, handed
   * this array.
   *
   * One AIManagerService is constructed per generation run, so the trace's lifetime is the
   * job's and nothing carries across runs.
   */
  readonly promptTrace: PromptTraceRecord[] = [];

  private config: AIConfig;
  private currentPromptSet?: PromptSet;
  /**
   * The CHANNEL behind the loaded prompt set (prompts/channels/*.yml): its field list, its
   * counts, its variant selections. Kept alongside the assembled PromptSet because the
   * per-group self-check has to be assembled from the fields a group actually holds, which is a
   * question about the channel and not about the assembled string.
   */
  private currentChannel?: ChannelData;
  // instructions_prompt split on its `## ` headers. Parsed once per loaded prompt set —
  // every task unit asks for it, and the file cannot change mid-run.
  private instructionSectionsCache?: InstructionSection[];
  private summaryModel: string = '';
  private metadataModel: string = '';
  private promptsDir: string;
  private promptSetsDir: string;
  // Why the last initialize() returned false — callers append this to their error
  // so users see the actual cause (bad API key, Ollama down, malformed prompt set)
  // instead of a bare "Failed to initialize AI manager".
  lastInitError?: string;

  constructor(config: AIConfig) {
    this.config = config;

    // Each model is exactly what the caller named, or nothing. PROVIDER_DEFAULTS, which
    // supplied a model per provider when none was named, is deleted (plan 6.5, Law 1): a
    // model nobody chose is the call LEDGER #204 was written about. A call that needs one
    // and has none refuses by name where it is made.
    this.summaryModel = config.summarizationModel || '';
    this.metadataModel = config.metadataModel || '';

    // Set prompts directories
    this.promptsDir = this.getPromptsDir();
    // Use provided promptSetsDir or fall back to bundled location
    this.promptSetsDir = config.promptSetsDir || path.join(this.promptsDir, 'prompt_sets');

    /**
     * Load the prompt assets HERE, in the constructor, rather than lazily at first use.
     *
     * Every path that reaches a model — metadata, chapters, descriptions, adapters, episode
     * splitting — runs under a service constructed here, so this is the one choke point where
     * "the prompts are missing" can be discovered before an hour of transcription has been
     * spent. It throws; it does not warn and carry on with something built in, because there is
     * nothing built in.
     */
    initPromptAssets(path.join(this.promptSetsDir, PROMPTS_SUBDIR));

    console.log('[AIManager] Initialized');
    console.log('[AIManager] Summary model:', this.summaryModel || '(none named)');
    console.log('[AIManager] Metadata model:', this.metadataModel || '(none named)');
  }

  /**
   * The direct-pass ceilings live at module scope (DIRECT_PASS_MAX_CHARS above) because the
   * pure-check harness asserts them. What stays here is the CHUNK size used once a transcript
   * is over one of them.
   *
   * Above direct-pass size, evidence is extracted in large chunks: few requests, less prompt
   * overhead, and far better per-chunk context than the old 8k chunks.
   */
  private static readonly CLOUD_SUMMARIZE_CHUNK_CHARS = 60000;

  /**
   * Chunk size when a transcript is over the direct-pass ceiling and has to be condensed.
   *
   * 8000 was a 14B-era number: 8k chunks spent fifteen calls on work that fits in two, and
   * each of those calls saw a fifteenth of the video with no idea what surrounded it. 60,000
   * characters is ~17k tokens plus the 4096 budget; the call is loaded at that size and checked
   * against the loaded context before sending.
   *
   * NOT LOWERED IN P4 (plan 7.3 said "the chunk size drops to <=12k per call"; the brief made it
   * conditional on a measurement). Measured offline (docs/crucible/P4.md "Offline measurements"):
   * a full chunk's call needs ~21.8k tokens (a ~17.7k-token prompt plus the 4,096 budget), at the 24,576
   * step, which the Mac 27B's ceiling (131,072, mlx-darwin) and the PC 27B's (32,768,
   * cuda-linux) both hold. So it stays one chunk per 60,000 characters.
   */
  private static readonly LOCAL_SUMMARIZE_CHUNK_CHARS = 60000;

  /**
   * Get the prompts directory path
   * Note: Legacy prompts are no longer used - we use system-prompts.ts and promptSetsDir instead
   */
  private getPromptsDir(): string {
    // Prompts are now handled by system-prompts.ts (hardcoded) and promptSetsDir (user config)
    // Return a fallback path that may not exist - loadPrompts() handles missing files gracefully
    const possiblePaths = [
      // User's Application Support directory (passed via config.promptSetsDir)
      this.config.promptSetsDir,
      // Packaged app paths
      path.join(process.resourcesPath || '', 'prompts'),
      // Development paths
      path.join(process.cwd(), 'prompts'),
    ].filter(Boolean);

    for (const p of possiblePaths) {
      if (p && fs.existsSync(p)) {
        return p;
      }
    }

    // Return the first possible path even if it doesn't exist
    // loadPrompts() will handle missing files gracefully
    console.log('[AIManager] No prompts directory found, using system prompts only');
    return possiblePaths[0] || process.cwd();
  }

  /**
   * Load this run's prompt set. It no longer prepares or probes any model client (P2): every
   * call is prepared by the one door on the model IT names, and a server that cannot run it
   * refuses THAT call by name. No provider is probed per run (LEDGER #204: a probe on the
   * legacy Settings model failed runs routed entirely to `claude -p`).
   */
  async initialize(): Promise<boolean> {
    this.lastInitError = undefined;
    try {
      this.loadPrompts();
      return true;
    } catch (error) {
      log.error('[AIManager] Initialization failed:', error);
      this.lastInitError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /**
   * Assemble this run's prompt set out of the prompt assets.
   *
   * WHAT REPLACED WHAT. This used to read one big per-channel YAML out of userData and hand it
   * downstream whole. There is no per-channel YAML any more: a channel is a small DATA file
   * (prompts/channels/*.yml) naming its focus paragraph, which fields it publishes, how many of
   * each, and its links, and everything model-facing comes from prompts/shared/. This method is
   * where those are put together, once, into the same four-string shape the rest of the service
   * has always consumed.
   *
   * THE ORDER OF THE INSTRUCTIONS is the channel's declared field order, then OUTPUT FORMAT,
   * then the FINAL SELF-CHECK — which is what the old sets did by hand and what
   * `parseInstructionSections` downstream expects to find. The self-check placed HERE is the
   * whole-channel one, used by the compilation call; a routed FIELD call gets a self-check
   * assembled from its own field's lines instead (buildFieldInstructions).
   *
   * AN UNKNOWN CHANNEL THROWS. An ABSENT one is a warning and nothing more: master analysis and
   * the episode splitter construct this service with no prompt set at all and never generate
   * metadata, and failing their startup over a channel they will not use would be inventing a
   * requirement.
   */
  /**
   * The compilation call's whole-object OUTPUT FORMAT — the ONE metadata answer still asked
   * for as JSON. It is genuinely structured (every field the channel publishes, in one
   * object), which is the "absolutely necessary" bar the 2026-08-24 no-JSON ruling sets;
   * every routed field call answers in plain text through buildOutputFormat instead.
   */
  private static readonly COMPILATION_FIELD_SHAPES: Record<string, string> = {
    titles: '["string", ...]',
    description: '"one string"',
    description_hook: '"one string"',
    description_options: '["string", ...]',
    tags: '"comma-separated string"',
    thumbnail_text: '["string", ...]',
    pinned_comment: '["string", ...]',
    hashtags: '"#One #Two #Three"',
    spoken_keywords: '["string", ...]',
  };

  private static buildCompilationOutputFormat(fields: MetadataFieldId[]): string {
    const keyLines = fields
      .map((f) => `  "${f}": ${AIManagerService.COMPILATION_FIELD_SHAPES[f] || '"one string"'}`)
      .join(',\n');
    return formatPrompt(SYSTEM_PROMPTS.COMPILATION_OUTPUT_FORMAT, { keyLines });
  }

  private loadPrompts(): void {
    const assets = promptAssets();
    const promptSetName = this.config.promptSet;

    if (!promptSetName) {
      log.info('[AIManager] no prompt set requested; this service will not generate channel metadata');
      return;
    }
    if (!assets.hasChannel(promptSetName)) {
      throw new Error(
        `No channel "${promptSetName}" in the prompt assets. Known channels: ${assets.channelIds().join(', ')}. ` +
          `(Channel ids live in the "id:" key of electron/assets/prompts/channels/*.yml and are unchanged from ` +
          `the prompt-set filenames they replaced.)`
      );
    }

    const channel = assets.channel(promptSetName);
    const fields = channel.fields as MetadataFieldId[];
    const sections = fields.map((field) => assets.fieldSection(channel, field));
    const instructions = [
      ...sections,
      AIManagerService.buildCompilationOutputFormat(fields).trim(),
      assets.selfCheckBlock(channel, fields),
    ].join('\n\n');

    this.currentChannel = channel;
    this.currentPromptSet = {
      name: channel.name,
      editorial_prompt: assets.editorialPrompt(channel),
      instructions_prompt: instructions,
      description_links: channel.descriptionLinks,
      channel_tags: channel.channelTags,
    };
    this.instructionSectionsCache = undefined;

    if (channel.channelTags && channel.channelTags.length > 0) {
      log.info(
        `[AIManager] channel "${channel.id}" appends ${channel.channelTags.length} channel tag(s): ` +
          channel.channelTags.join(', ')
      );
    } else {
      log.info(`[AIManager] channel "${channel.id}" declares no channel_tags, so no channel or creator tags are appended`);
    }
    log.info(
      `[AIManager] assembled prompt set for "${channel.id}" (${channel.name}): fields ${fields.join(', ')}; ` +
        `editorial variant "${channel.editorialVariant}", field variant "${channel.fieldVariant}"`
    );
  }

  /**
   * Prepare transcript content — for COMPILATION MODE, which is the only caller left.
   *
   * THE RAW TRANSCRIPT IS THE INPUT everywhere else. A transcript up to the applicable
   * direct-pass ceiling passes through UNCHANGED — the field calls read the video, not a précis
   * of it — which is cheaper (no summarizer input, no summarizer output, no second call) and
   * better (verbatim quotes, phrasing and sarcasm survive to the model that has to write a title
   * out of them).
   *
   * WHAT CHANGED ON 2026-08-23. This method used to fire for two reasons; it now fires for one.
   * The reason it lost was "the transcript genuinely cannot fit": the per-item metadata path no
   * longer condenses an over-ceiling transcript here, it reads the CHAPTER DIGEST instead
   * (chapter-digest.ts), because the operator's ruling was that if something has to stand in for
   * the video it has to be the chapters. The warning below said the cost of the old behaviour out
   * loud — "verbatim quotes and phrasing do not survive that step" — and the chapter details do
   * not pay it, having each been written from their own chapter's raw transcript.
   *
   * The reason it kept is `forceCondense`: compilation items, whose per-item outputs are joined
   * into ONE combined prompt and so must each be short by construction, whatever their length.
   * That mode runs no chapter pipeline, so the digest is not available to it — see
   * SUMMARIZATION_MODEL in metadata-routing.ts. The over-ceiling branch below is therefore only
   * reachable through a caller that supplies no ceiling of its own (episode splitting,
   * compilation packaging) and it is left standing rather than deleted for exactly those.
   */
  async summarizeTranscript(
    transcript: string,
    sourceName: string,
    options?: { forceCondense?: boolean }
  ): Promise<string> {
    if (transcript.length <= 1000) {
      return transcript;
    }

    const ceiling = this.config.transcriptCeiling;
    if (ceiling === undefined) {
      throw new Error(
        `summarizeTranscript for ${sourceName} was called on a service constructed with no transcriptCeiling; ` +
          `the ceiling follows where the field calls go, and this caller did not say.`
      );
    }
    const directPassMax = DIRECT_PASS_MAX_CHARS[ceiling];

    if (directPassesRaw({ chars: transcript.length, ceiling, forceCondense: options?.forceCondense })) {
      console.log(
        `[AIManager] Direct pass for ${sourceName}: ${transcript.length} chars of raw transcript sent to the ` +
          `metadata calls unsummarized (${ceiling} ceiling ${directPassMax})`
      );
      return transcript;
    }

    // A DECLARED degradation either way, said out loud with which of the two reasons it was.
    if (options?.forceCondense) {
      log.info(
        `[AIManager] ${sourceName}: condensing ${transcript.length} chars because this item asked for it ` +
          `(compilation mode joins every item's output into one combined prompt)`
      );
    } else {
      log.warn(
        `[AIManager] ${sourceName}: ${transcript.length} chars is over the ${directPassMax}-character ` +
          `direct-pass ceiling, so the metadata calls will read an evidence extraction rather than the ` +
          `transcript itself. Verbatim quotes and phrasing do not survive that step.`
      );
    }

    console.log(`[AIManager] ═══ SUMMARIZATION STARTING for ${sourceName} ═══`);
    console.log(`[AIManager]     Transcript length: ${transcript.length} chars`);
    console.log(`[AIManager]     Using model: ${this.summaryModel}`);

    // Chunk size follows the SUMMARIZER's model (the one doing the condensing), which is
    // independent of the ceiling above: a Crucible upstream id or `claude -p` is cloud,
    // anything else is a model a Crucible server holds.
    if (!this.summaryModel) {
      throw new Error(`Summarizing ${sourceName} needs the summarizer model, and this service was constructed with none.`);
    }
    const summaryIsCloud = isUpstreamModelId(this.summaryModel) || this.summaryModel.startsWith('claude-cli:');
    const chunkSize = summaryIsCloud
      ? AIManagerService.CLOUD_SUMMARIZE_CHUNK_CHARS
      : AIManagerService.LOCAL_SUMMARIZE_CHUNK_CHARS;

    try {
      let result: string;

      // Handle large transcripts with chunking
      if (transcript.length > chunkSize) {
        result = await this.summarizeLargeTranscript(transcript, sourceName, chunkSize);
      } else {
        result = await this.summarizeSingleChunk(transcript, sourceName);
      }

      console.log(`[AIManager] ═══ SUMMARIZATION COMPLETE for ${sourceName} ═══`);
      console.log(`[AIManager]     Summary length: ${result.length} chars`);

      return result;
    } catch (error) {
      // Propagate instead of silently substituting truncated raw transcript — a
      // masked failure produces plausible-but-wrong metadata. The thrown error
      // already carries source/chunk context from the inner summarize methods.
      console.error('[AIManager] ═══ SUMMARIZATION FAILED ═══:', error);
      throw error;
    }
  }

  /**
   * Summarize large transcript in chunks
   */
  private async summarizeLargeTranscript(transcript: string, sourceName: string, chunkSize: number): Promise<string> {
    const chunks: string[] = [];

    // Split into chunks
    for (let i = 0; i < transcript.length; i += chunkSize) {
      chunks.push(transcript.slice(i, i + chunkSize));
    }

    console.log(`[AIManager] Processing ${chunks.length} chunks...`);

    const summaries: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      console.log(`[AIManager] Chunk ${i + 1}/${chunks.length}`);

      const prompt = this.createSummarizationPrompt(chunks[i], `${sourceName}_chunk_${i}`);
      let response: string | null;
      try {
        response = await this.runPlainRequest(
          prompt, this.summaryModel, `summarization chunk ${i + 1} of ${sourceName}`, this.summaryShape(prompt));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Summarization failed for ${sourceName} chunk ${i + 1}/${chunks.length}: ${reason}`);
      }

      // A trivially short/empty summary means the model produced nothing usable —
      // fail loudly rather than silently substituting truncated raw transcript.
      if (!response || response.trim().length <= 10) {
        throw new Error(`Summarization returned empty/too-short response for ${sourceName} chunk ${i + 1}/${chunks.length}`);
      }
      summaries.push(response.trim());
    }

    return summaries.join('\n\n');
  }

  /**
   * Summarize single chunk
   */
  private async summarizeSingleChunk(transcript: string, sourceName: string): Promise<string> {
    const prompt = this.createSummarizationPrompt(transcript, sourceName);
    const response = await this.runPlainRequest(prompt, this.summaryModel, `summarization of ${sourceName}`, this.summaryShape(prompt));

    // A trivially short/empty summary means the model produced nothing usable —
    // fail loudly rather than silently substituting truncated raw transcript.
    if (!response || response.trim().length <= 10) {
      throw new Error(`Summarization returned empty/too-short response for ${sourceName}`);
    }
    return response.trim();
  }

  /**
   * The compilation condensation call's shape (plan 6.3): thinking off, a 4096-token answer,
   * and on a local model the smallest context step its own prompt needs (LEDGER #209). 600 s is
   * the clock it always had.
   */
  private summaryShape(prompt: string): PlainCallShape {
    return {
      thinking: false,
      maxTokens: AIManagerService.SUMMARY_MAX_TOKENS,
      loadContext: loadContextFor(prompt.length, AIManagerService.SUMMARY_MAX_TOKENS),
      timeoutMs: 600_000,
    };
  }

  /**
   * The condensation answer's budget (plan 6.3 row: 4096). KEPT by P4's budget review: two
   * recorded local answers (1,055 and 1,086 output tokens, Mac 27B) are too few to size a
   * budget by, and lowering it would not change the step a full chunk loads at (24,576 either
   * way). docs/crucible/P4.md "Budgets".
   */
  private static readonly SUMMARY_MAX_TOKENS = 4096;
  /**
   * The compilation package's local budget (plan 6.3 row: 4096 local, 16000 cloud). KEPT by P4's
   * budget review: one recorded local answer (541 output tokens) is no evidence to size by.
   */
  private static readonly PACKAGE_LOCAL_MAX_TOKENS = 4096;

  /**
   * The evidence-extraction prompt that runs before anything else reads a transcript.
   *
   * THE FALLBACK THAT WAS HERE IS GONE, and it was the worst one in the app. It read:
   *
   *     this.summarizationPrompts?.youtube?.system || 'You are a helpful assistant that
   *       summarizes video transcripts.'
   *
   * with a matching `|| 'Summarize this transcript:\n\n{transcript}'` on the user turn. The
   * real prompt exists to PRESERVE AMMUNITION — exact quotes, named people, the specific
   * claims a title has to be anchored to — and explicitly says a smooth generalized summary is
   * a failed output. The substitute asked for precisely that smooth generalized summary. Its
   * output then became the `{subject}` every downstream field was written from, so a missing
   * asset file produced a whole run of plausible, unanchored metadata with nothing anywhere
   * saying the evidence had been thrown away.
   *
   * It now throws, naming the file and the key.
   */
  private createSummarizationPrompt(text: string, sourceName: string): string {
    const assets = promptAssets();
    const systemPrompt = assets.pipeline('summarization.yml', 'youtube.system');
    // Function replacer: transcript text routinely contains $-patterns ($&, $', $`).
    const userPrompt = assets
      .pipeline('summarization.yml', 'youtube.user')
      .replace('{transcript}', () => text);

    const sourceContext = sourceName
      ? assets.pipeline('summarization.yml', 'youtube.source_context').replace(/\{sourceName\}/g, () => sourceName)
      : '';

    return `${systemPrompt}\n\n${userPrompt}${sourceContext}`;
  }

  /**
   * Assemble the COMPILATION prompt without sending it, for the "Show prompt" flow.
   *
   * `compilationInfo` is REQUIRED and the parameter is no longer optional, which is the type
   * system carrying the rule stated on `generateCompilationMetadata` below: there is one
   * whole-metadata call left in this app and it is the compilation one.
   */
  buildCompilationPrompt(
    content: string,
    sourceName: string | undefined,
    compilationInfo: { sourceCount: number; contentTypes: string[] }
  ): string {
    return this.createCompilationPrompt(content, sourceName, compilationInfo);
  }

  /**
   * Run the request + parse + links loop against an ALREADY-assembled prompt.
   * Split out of generateMetadata so the "Show prompt" flow can assemble the prompt
   * up front and later send this exact prompt when the user confirms.
   *
   * `model` is REQUIRED and has no default (2026-09-13). Its one caller today is
   * compilation packaging, and the absent argument was exactly how that call ended up on
   * `metadataModel` — a model nobody in the routing table had chosen. Anything that sends an
   * assembled prompt names what sends it.
   */
  async generateMetadataFromAssembledPrompt(prompt: string, model: string): Promise<MetadataResult> {
    const { metadata } = await this.runMetadataRequest(prompt, model);

    console.log(`[AIManager] === METADATA GENERATION COMPLETE ===`);
    console.log(`[AIManager]     Generated ${Object.keys(metadata).length} fields`);

    return this.finalizeMetadata(metadata);
  }

  /**
   * THE ONE SURVIVING WHOLE-METADATA CALL: a compilation.
   *
   * WHAT WENT. This method used to take any item at all and write every field in one request to
   * whatever model the Settings page's "AI Model" picker named. That was the LEGACY PATH, and an
   * item reached it not because anyone chose it but because it had no chapters — a typed text
   * subject, an import whose chapter pipeline came back short, a video that was all ads. So a
   * run could silently divide in two: chaptered items generated as routed local units against
   * the routing table, chapterless ones generated as one call against a Settings field the
   * operator had probably forgotten was there, possibly to a cloud provider, with nothing in the
   * report distinguishing them. Every one of those items now plans the SAME routed units
   * (metadata-tasks.ts, planMetadataUnits), with the text subject as their content slot.
   *
   * WHY A COMPILATION IS NOT THAT. A compilation is a DECLARED MODE — the operator selects it —
   * and it is genuinely a different request: N unrelated items, one umbrella title, and a
   * description that must be a bulleted list in item order and nothing else. The routed units do
   * not have that shape, and forcing them into it would mean a second set of prompts for a mode
   * that already has one. So this call stays, gated on `compilationInfo` being present in the
   * signature rather than at runtime, named for what it is, and logged as a declared mode every
   * time it runs.
   *
   * WHAT IT NO LONGER SHARES WITH THE LEGACY PATH IS THE MODEL (2026-09-13). `model` is
   * REQUIRED, for the same reason `compilationInfo` is: until this parameter existed the call
   * fell through to `metadataModel` — the very Settings field described above — so a
   * compilation was the one run in this app that ignored the routing table outright. It now
   * comes in resolved (resolveCompilationPackagingOption: the `titles` selection) and is named
   * in the log line below, so a compilation is routed like everything else and says so.
   */
  async generateCompilationMetadata(
    content: string,
    sourceName: string | undefined,
    compilationInfo: { sourceCount: number; contentTypes: string[] },
    model: string
  ): Promise<MetadataResult> {
    if (!this.currentPromptSet) {
      throw new Error('No prompt set loaded');
    }

    log.info(
      `[AIManager] DECLARED MODE: compilation packaging for ${sourceName || 'unknown'} — one whole-metadata call ` +
        `covering ${compilationInfo.sourceCount} item(s) on ${model} (the routing table's "titles" selection, ` +
        `resolveCompilationPackagingOption), because a compilation's umbrella title and bulleted description are ` +
        `a different request shape from the routed per-field units`
    );
    console.log(`[AIManager]     Content length: ${content.length} chars`);

    const prompt = this.createCompilationPrompt(content, sourceName, compilationInfo);
    return this.generateMetadataFromAssembledPrompt(prompt, model);
  }

  /**
   * The compilation prompt: the whole channel brief, every field at once, with the compilation
   * overrides appended.
   *
   * The override block is APPENDED rather than spliced over the TITLES / DESCRIPTION / TAGS
   * sections, and says in its own first line that it replaces them. That was robust to any
   * prompt-set format when the sets were user-edited YAML; it is kept now because it is still
   * the honest shape — the reader of this prompt sees both the standing rules and the ones that
   * supersede them for this request, in that order.
   */
  private createCompilationPrompt(
    content: string,
    sourceName: string | undefined,
    compilationInfo: { sourceCount: number; contentTypes: string[] }
  ): string {
    if (!this.currentPromptSet) {
      throw new Error('No prompt set loaded');
    }

    const systemPrompt = SYSTEM_PROMPTS.JSON_SYSTEM;
    const subject = this.buildSubjectBlock(content, sourceName, compilationInfo);
    const editorialPrompt = this.fillSubject(subject);

    const overrideBlock = formatPrompt(SYSTEM_PROMPTS.COMPILATION_INSTRUCTIONS_OVERRIDE, {
      sourceCount: compilationInfo.sourceCount,
    });
    const instructionsPrompt = `${this.currentPromptSet.instructions_prompt}\n${overrideBlock}`;

    // Analytics feedback loop: append the pre-resolved channel performance
    // block (if any) AFTER the existing prompt content — purely additive.
    const insightsSuffix = this.config.insightsBlock ? `\n\n${this.config.insightsBlock}` : '';

    return `${systemPrompt}\n\n${editorialPrompt}\n\n${instructionsPrompt}${insightsSuffix}`;
  }

  /**
   * The `{subject}` payload: compilation framing, source filename, the chapter table of
   * contents, then the content slot. Shared by the compilation call and the routed group
   * calls, so a group differs from the whole-metadata call only in what it puts in that
   * content slot — the transcript for packaging, a short "the chapters are the content"
   * note for the fields conditioned on the chapter list.
   */
  private buildSubjectBlock(
    content: string,
    sourceName?: string,
    compilationInfo?: { sourceCount: number; contentTypes: string[] },
    chapterSubjects?: string[],
    chapterDetails?: string[]
  ): string {
    // Hardcoded compilation instructions (works with any prompt set)
    let compilationContext = '';
    if (compilationInfo) {
      const contentTypeStr = compilationInfo.contentTypes.join(', ');
      compilationContext = formatPrompt(SYSTEM_PROMPTS.COMPILATION_CONTEXT, {
        sourceCount: compilationInfo.sourceCount,
        contentTypes: contentTypeStr,
      });
    }

    // Add source filename context if available
    const sourceContext = sourceName ? `\n\nSource: ${sourceName}\n(Use the source filename for context about names, topics, and proper nouns - it may contain correctly spelled names or important keywords)` : '';

    const chapterContext = chapterSubjects && chapterSubjects.length > 0
      ? formatPrompt(SYSTEM_PROMPTS.CHAPTER_SUBJECTS_CONTEXT, {
          chapterList: chapterSubjects
            .map((s, i) => {
              const detail = (chapterDetails?.[i] || '').trim();
              // Indented under its own subject, one line each: the block stays a
              // scannable table of contents rather than becoming a second transcript.
              return detail ? `${i + 1}. ${s}\n   ${detail}` : `${i + 1}. ${s}`;
            })
            .join('\n'),
        })
      : '';

    return `${compilationContext}${sourceContext}\n${chapterContext}\n${content}`;
  }

  /** Replace the prompt set's {subject} placeholder. */
  private fillSubject(subject: string): string {
    if (!this.currentPromptSet) {
      throw new Error('No prompt set loaded');
    }
    // Function replacer: transcript text routinely contains $-patterns ($&, $', $`),
    // which a plain string replacement would expand and corrupt the prompt with.
    return this.currentPromptSet.editorial_prompt.replace('{subject}', () => subject);
  }

  /**
   * The canonical section keys the loaded prompt set actually defines.
   *
   * A prompt set is the statement of WHICH FIELDS this channel publishes: the Spreaker
   * podcast set has no thumbnail text and never did. Planning a run reads this so it can
   * leave those fields out and say so, rather than routing a field the prompt set never
   * asked for and failing on a section that was never missing by accident.
   */
  promptSetSectionKeys(): Set<string> {
    return new Set(this.instructionSections().map((s) => s.key));
  }

  /**
   * This run's channel data (prompts/channels/*.yml), or a throw.
   *
   * Exposed because the per-group self-check has to be assembled from a group's own fields, and
   * that is a question about the channel — which field variant, which counts — not about the
   * already-assembled instructions string.
   */
  private channel(): ChannelData {
    if (!this.currentChannel) {
      throw new Error('No prompt set loaded');
    }
    return this.currentChannel;
  }

  /**
   * The FINAL SELF-CHECK for ONE FIELD's call.
   *
   * THE DEFECT THIS FIXES. The self-check used to ride as ONE verbatim block with whichever
   * call held the titles, so a call that wrote only titles was told "thumbnail options don't
   * repeat core words from the top 3 titles" about thumbnail text it would never see.
   * Unfollowable lines are not harmless — they teach a model that some of this prompt is
   * decoration.
   *
   * `inputFields` is what keeps the CROSS-FIELD lines alive now that no two fields share a
   * call. A line that needs a second field is emitted when that field is either written here or
   * SUPPLIED here as input data: the thumbnail call is handed the titles, so it is told not to
   * repeat their core words, and it can obey because it can read them.
   */
  fieldSelfCheck(field: MetadataFieldId, inputFields: MetadataFieldId[] = []): string {
    return promptAssets().selfCheckBlock(this.channel(), [field], inputFields);
  }

  /** instructions_prompt split on its `## ` headers, parsed once per loaded prompt set. */
  private instructionSections(): InstructionSection[] {
    if (!this.currentPromptSet) {
      throw new Error('No prompt set loaded');
    }
    if (!this.instructionSectionsCache) {
      this.instructionSectionsCache = parseInstructionSections(this.currentPromptSet.instructions_prompt);
    }
    return this.instructionSectionsCache;
  }

  /**
   * Assemble ONE FIELD's prompt (metadata-tasks.ts).
   *
   * Same three blocks the whole-metadata prompt has always had — the plain-text system header,
   * editorial prompt with the subject filled in, instructions — except the instructions are ONE
   * field's section, an OUTPUT FORMAT naming that field's plain shape (lines, or the tags'
   * comma line), and the self-check lines that one field can perform.
   *
   * WHAT CHANGED IN THE SUBJECT BLOCK: the transcript reaches EVERY call. It used to reach only
   * the calls whose fields were declared to need it, and the rest got a short "the chapter list
   * is the content" stand-in — a concession to context windows that meant the description was
   * written from a précis of the video. The transcript is direct-passed now
   * (summarizeTranscript above), so there is one content slot and it holds the video.
   *
   * `pending` is the "Show prompt" preview, assembled before any call has run: a call that
   * reads an earlier field's answer renders a labelled placeholder instead of that answer. It
   * is never the shape that gets SENT — buildInputDataBlock refuses without the real input.
   */
  buildMetadataFieldPrompt(
    spec: MetadataFieldUnitSpec,
    ctx: MetadataRunContext,
    options?: { pending?: boolean }
  ): string {
    if (!this.currentPromptSet) {
      throw new Error('No prompt set loaded');
    }

    const promptSetName = this.config.promptSet || this.currentPromptSet.name || 'unknown';
    /**
     * The chapter table of contents is passed only on the RAW path.
     *
     * On the digest path `ctx.content` already IS that table of contents — the same chapters,
     * with their timestamps and the same detail prose, under a header that says there is no
     * fuller transcript below (chapter-digest.ts). Passing the subjects as well would print the
     * list twice under two different headings, which reads to a model as a video with twice as
     * much in it. One item, one statement of what it covers.
     */
    const digestMode = ctx.contentMode === 'chapter-digest';
    // TITLES READ THE VIDEO IN CHAPTER FORM whenever chapters exist — a choice, not a
    // ceiling (operator, 2026-08-24: "wire it in", after the measured f3 side-by-side where
    // chapter-fed titles matched transcript-fed titles on every hard check and pulled
    // sharper specifics from the details, at a third less prompt). The digest content
    // replaces the transcript AND the separate chapter table (one statement of what the
    // video covers, same rule as digest mode), under the chosen-not-forced header, because
    // "this transcript is longer than one call can read" would be false here. A chapterless
    // item has an empty digest and keeps the transcript — there is nothing else to stand on.
    const titlesOnChapters =
      spec.field === 'titles' && !digestMode && ctx.digestChapters.length > 0;
    const subject = titlesOnChapters
      ? this.buildSubjectBlock(
          formatPrompt(SYSTEM_PROMPTS.CHAPTER_DIGEST_CHOSEN, {
            chapterList: renderChapterList(ctx.digestChapters),
          }),
          ctx.sourceLabel,
          undefined,
          undefined,
          undefined
        )
      : this.buildSubjectBlock(
          ctx.content,
          ctx.sourceLabel,
          undefined,
          digestMode ? undefined : ctx.chapterSubjects,
          digestMode ? undefined : ctx.chapterDetails
        );
    // Whatever an earlier call in this run wrote that this one has to read — today, the titles
    // the thumbnail text has to avoid repeating.
    const inputData = buildInputDataBlock(spec, ctx, options);
    const instructions = buildFieldInstructions(
      spec,
      this.instructionSections(),
      promptSetName,
      this.fieldSelfCheck(spec.field, spec.inputFields)
    );

    // Channel performance data speaks to titles, thumbnails and packaging — the fields it
    // was distilled from. Which call carries it is decided when the run is planned, not
    // here (see planMetadataUnits). It rides BEFORE the instructions: the last thing the
    // model reads must be the rules and the self-check, not a stats dump — appended-after
    // was measured 2026-08-24 as the layout, and the f3 side-by-side with the block moved
    // above the rules held every check.
    const insightsBlock = spec.insights && this.config.insightsBlock ? `\n\n${this.config.insightsBlock}` : '';

    return (
      `${SYSTEM_PROMPTS.PLAIN_SYSTEM}\n\n${this.fillSubject(subject)}` +
      `${inputData ? `\n${inputData}` : ''}${insightsBlock}\n\n${instructions.text}`
    );
  }

  /**
   * Request + parse + repair, WITHOUT the description-links post-processing.
   *
   * Task units share this because those links have to be appended once, to the merged
   * result: the description they attach to and the hashtags they are normalized
   * alongside come back from two different calls.
   *
   * `model` is REQUIRED (2026-09-24): it is the routing table's selection for the group
   * being asked for. It used to default to the legacy Settings `metadataModel`, a model the
   * routing table never chose — Owen: "it should never call something i didnt expect it to
   * call".
   */
  async runMetadataRequest(
    prompt: string,
    model: string
  ): Promise<{ metadata: MetadataResult; presentKeys: Set<string> }> {
    if (!model) {
      throw new Error('runMetadataRequest needs the routed model for this call; there is no default model.');
    }
    const requestModel = model;
    // The compilation package, the one JSON caller left (Law 12's exception): thinking off,
    // JSON asked of a local model through response_format json_object (plan 6.3), 4096 tokens
    // local and the Anthropic ceiling on cloud. On cloud the JSON contract rides in the system
    // turn, as it always did: a json_schema would become a forced tool through Crucible, and
    // how that combines with thinking is unmeasured (plan 19 N6).
    const shape: PlainCallShape = {
      thinking: false,
      maxTokens: AIManagerService.PACKAGE_LOCAL_MAX_TOKENS,
      loadContext: loadContextFor(prompt.length, AIManagerService.PACKAGE_LOCAL_MAX_TOKENS),
      timeoutMs: 300_000,
    };

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.makeRequest(prompt, requestModel, `metadata package (attempt ${attempt})`, shape, 'json');

      if (!response) {
        log.error('[AIManager] === METADATA GENERATION FAILED ===');
        log.error('[AIManager]     No response from AI');
        if (attempt < maxAttempts) {
          log.info(`[AIManager] Retrying metadata generation (attempt ${attempt + 1}/${maxAttempts})...`);
          continue;
        }
        throw new Error('No response from AI');
      }

      try {
        return this.parseMetadataResponse(response);
      } catch (parseError) {
        if (attempt < maxAttempts) {
          log.warn(`[AIManager] Metadata parse failed on attempt ${attempt}, retrying...`);
          continue;
        }
        throw parseError;
      }
    }

    // Should not reach here, but satisfy TypeScript
    throw new Error('Failed to generate metadata after retries');
  }

  /**
   * `runPlainRequest` (below the insights setters): one request whose answer is PLAIN TEXT, on
   * any routed model: `claude -p`, or the Crucible door for a local or `anthropic/` model
   * (operator's ruling 2026-08-24: no JSON for these calls unless absolutely necessary).
   *
   * No JSON system nudge, no stop sequences: the request is the prompt, the plain system turn
   * on cloud, and the shape the caller states. Inline <think> blocks are stripped once, here,
   * so no caller re-learns that a reasoning model sometimes narrates before it answers.
   *
   * Returns null for an EMPTY answer — the caller's one-decision cost, exactly as the local
   * transport's `ok: false` is — and throws on transport failure, which affects every
   * remaining call. Same split as everywhere else, typed by shape rather than message text.
   */
  /**
   * The resolved COMPACT insights block, set once per run after guideline resolution —
   * which needs this instance's transports, so it cannot ride in on the constructor config
   * (insights-guidelines.ts has the order of events).
   */
  setInsightsBlock(block: string): void {
    this.config.insightsBlock = block;
  }

  hasInsightsBlock(): boolean {
    return Boolean(this.config.insightsBlock);
  }

  async runPlainRequest(prompt: string, model: string, what: string, shape: PlainCallShape): Promise<string | null> {
    const response = await this.makeRequest(prompt, model, what, shape, 'plain');
    const text = stripThinking(response || '');
    if (text.length === 0) {
      log.warn(`[AIManager] the answer to ${what} from "${model}" came back empty`);
      return null;
    }
    return text;
  }

  /**
   * The loaded prompt set's channel and creator tags, in its own order.
   *
   * Read by the code that DERIVES hashtags: §6.3 wants the channel's brand tag among them when
   * the channel uses one, and the prompt set is the thing that knows whether it does. Empty
   * when the set declares none — nothing is guessed from the set's filename.
   */
  channelTags(): string[] {
    return (this.currentPromptSet?.channel_tags || []).map((t) => t.trim()).filter((t) => t.length > 0);
  }

  /**
   * The loaded prompt set's description_links block, trimmed — the constant `addDescriptionLinks`
   * appends beneath every generated description.
   *
   * Read by the SCRUB pass, which has to hold it back: it is a fixed block of URLs the prompt set
   * authored, not text a model wrote, and sending fifteen links through a rewrite call to change
   * nothing is how a link comes back mangled. Empty when the set declares none.
   */
  descriptionLinks(): string {
    return (this.currentPromptSet?.description_links || '').trim();
  }

  /**
   * The loaded channel's promoted_items list — the creator's own plugs, read here for the
   * chapter pipeline's prompts (the field instructions get theirs through fieldSection's
   * {promoted_items} slot). Empty when the channel declares none.
   */
  promotedItems(): string[] {
    return (this.currentChannel?.promotedItems || []).map((t) => t.trim()).filter((t) => t.length > 0);
  }

  /**
   * Public entry to the post-processing every generated item gets, whichever path it came
   * from: the prompt set's channel tags, its description links, hashtag spacing.
   *
   * Both paths run it — the single legacy call through generateMetadataFromAssembledPrompt
   * and the per-unit path through runMetadataTasks — because the channel tags belong to
   * the prompt set, not to whichever model happened to write the tags.
   */
  finalizeMetadata(metadata: MetadataResult): MetadataResult {
    this.appendChannelTags(metadata);
    return this.addDescriptionLinks(metadata);
  }

  /**
   * YouTube's tag budget: 500 characters over the whole list.
   *
   * A tag containing a space costs two more than it looks, because YouTube quotes
   * multi-word tags when it counts them. Separators count too, so the cost is measured
   * against the joined string rather than the sum of the parts.
   */
  private static readonly TAG_BUDGET_CHARS = 500;

  private static tagBudgetCost(tags: string[]): number {
    return tags.join(',').length + tags.filter((t) => /\s/.test(t)).length * 2;
  }

  /**
   * Append the prompt set's channel_tags to the generated tag list.
   *
   * This is not decoration. Nothing in a tags call names the channel as a TAG — the shared
   * TAGS instruction asks for terms about the video's subject, and the channel's own brand
   * terms reach the model as `{brand_terms}` guidance rather than as a guaranteed output —
   * so without this step a generated tag list can come back naming the channel nowhere.
   * (It closed the same hole for the retired tags adapter, whose trained system prompt said
   * "No channel names and no creator names - those are appended separately". The adapter is
   * gone as of 2026-08-25; the hole it named is a property of the tags call, not of it.)
   *
   * THE TAIL-DROP IS YOUTUBE'S BUDGET, NOT ANY ONE MODEL'S HABIT, which is why it outlived
   * the adapter: 500 characters is the hard limit on the whole list whoever wrote it. The
   * channel tags are the ones that survive — if the merged list breaks the budget, generated
   * tags are dropped from the END (a tag list runs most-specific-first, so the tail is the
   * most replaceable end of any of them) until it fits, and the log names every one dropped.
   * A prompt set whose channel_tags alone exceed the budget is a configuration error and
   * throws — there is nothing left to drop that would not be the thing the user asked to
   * protect.
   */
  private appendChannelTags(metadata: MetadataResult): void {
    const channelTags = (this.currentPromptSet?.channel_tags || [])
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (channelTags.length === 0) return;

    const promptSetName = this.config.promptSet || this.currentPromptSet?.name || 'unknown';

    if (typeof metadata.tags !== 'string' || metadata.tags.trim().length === 0) {
      log.warn(
        `[AIManager] Prompt set "${promptSetName}" defines channel_tags but this item has no tags field to append ` +
          `them to; the channel tags were NOT written as a tag list of their own`
      );
      return;
    }

    const generated = metadata.tags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const seen = new Set(generated.map((t) => t.toLowerCase()));
    const toAppend = channelTags.filter((t) => !seen.has(t.toLowerCase()));
    const alreadyPresent = channelTags.filter((t) => seen.has(t.toLowerCase()));
    if (alreadyPresent.length > 0) {
      log.info(
        `[AIManager] Channel tag(s) already present in the generated list, not duplicated: ${alreadyPresent.join(', ')}`
      );
    }

    const channelCost = AIManagerService.tagBudgetCost(toAppend);
    if (channelCost > AIManagerService.TAG_BUDGET_CHARS) {
      throw new Error(
        `Prompt set "${promptSetName}" defines channel_tags costing ${channelCost} characters, which alone exceeds ` +
          `YouTube's ${AIManagerService.TAG_BUDGET_CHARS}-character tag budget (a tag with a space costs 2 extra). ` +
          `Shorten channel_tags.`
      );
    }

    const kept = [...generated];
    const dropped: string[] = [];
    while (AIManagerService.tagBudgetCost([...kept, ...toAppend]) > AIManagerService.TAG_BUDGET_CHARS && kept.length > 0) {
      dropped.push(kept.pop()!);
    }

    if (dropped.length > 0) {
      log.warn(
        `[AIManager] Tag budget: appending the channel tags (${toAppend.join(', ')}) would exceed ` +
          `${AIManagerService.TAG_BUDGET_CHARS} characters, so ${dropped.length} generated tag(s) were dropped from ` +
          `the end of the list: ${dropped.reverse().join(', ')}`
      );
    }

    const merged = [...kept, ...toAppend];
    metadata.tags = merged.join(',');
    log.info(
      `[AIManager] Tags: ${merged.length} tag(s), ${AIManagerService.tagBudgetCost(merged)}/` +
        `${AIManagerService.TAG_BUDGET_CHARS} characters after appending ${toAppend.length} channel tag(s)`
    );
  }

  /**
   * Parse metadata response from AI.
   *
   * `presentKeys` records which registry fields the model ACTUALLY returned (under their
   * canonical name or an alias), as opposed to the ones normalizeMetadataKeys fills in
   * empty. Per-task callers need that distinction: a task that was asked for one field
   * and returned nothing has failed, and an empty array is not the same answer as a
   * missing key.
   *
   * Its one caller is the COMPILATION path (runMetadataRequest) — the routed field calls
   * answer in plain text and never come through here. It is not just JSON.parse — it is four
   * stages of repair against the shapes models actually return.
   */
  parseMetadataResponse(response: string): { metadata: MetadataResult; presentKeys: Set<string> } {
    try {
      // Step 1: Remove markdown code blocks if present
      let cleaned = response.trim();

      // Remove ```json and ``` markers
      cleaned = cleaned.replace(/^```json\s*/i, '');
      cleaned = cleaned.replace(/^```\s*/i, '');
      cleaned = cleaned.replace(/\s*```$/i, '');

      // Step 2: Try to extract JSON object
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log.error('[AIManager] No JSON found in response');
        log.error('[AIManager] Response preview:', response.substring(0, 500));
        throw new Error('No JSON found in response');
      }

      let jsonStr = jsonMatch[0];

      // Step 3: Try parsing with increasingly aggressive repair
      const parseAttempts: { name: string; transform: (s: string) => string }[] = [
        { name: 'as-is', transform: (s) => s },
        { name: 'fix trailing commas', transform: (s) => s.replace(/,\s*([\]}])/g, '$1') },
        { name: 'fix newlines in strings', transform: (s) => {
          // Replace literal newlines inside JSON string values with \\n
          return s.replace(/"([^"]*?)"/g, (_match, content) => {
            return '"' + content.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
          });
        }},
        { name: 'aggressive repair', transform: (s) => {
          let fixed = s;
          // Fix trailing commas
          fixed = fixed.replace(/,\s*([\]}])/g, '$1');
          // Fix newlines in strings
          fixed = fixed.replace(/"([^"]*?)"/g, (_match, content) => {
            return '"' + content.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
          });
          // Fix single quotes used as JSON quotes (only around values)
          fixed = fixed.replace(/:\s*'([^']*)'/g, ': "$1"');
          // Remove control characters
          fixed = fixed.replace(/[\x00-\x1f\x7f]/g, (ch) => {
            if (ch === '\n' || ch === '\r' || ch === '\t') return ch; // already handled
            return '';
          });
          return fixed;
        }},
      ];

      for (const attempt of parseAttempts) {
        try {
          const transformed = attempt.transform(jsonStr);
          const parsed = JSON.parse(transformed);
          if (attempt.name !== 'as-is') {
            log.info(`[AIManager] JSON parsed successfully after repair: ${attempt.name}`);
          }
          return this.normalizeMetadataKeys(parsed);
        } catch {
          // Continue to next attempt
        }
      }

      // All attempts failed - log details for debugging
      log.error('[AIManager] All JSON parse attempts failed');
      log.error('[AIManager] JSON preview:', jsonStr.substring(0, 1000));
      throw new Error('Failed to parse metadata response');
    } catch (error) {
      log.error('[AIManager] Error parsing metadata response:', error);
      log.error('[AIManager] Response preview:', response.substring(0, 1000));
      throw new Error('Failed to parse metadata response');
    }
  }

  /**
   * Normalize AI response keys to match MetadataResult interface.
   * Different models return varying key names (e.g. "titleOptions" vs "titles").
   */
  private normalizeMetadataKeys(raw: any): { metadata: MetadataResult; presentKeys: Set<string> } {
    const result: MetadataResult = {};
    const presentKeys = new Set<string>();

    // Helper: extract string from any value (handles objects AI models might return)
    const toStr = (val: any): string => {
      if (typeof val === 'string') return val;
      if (val && typeof val === 'object') {
        return val.text || val.title || val.value || val.content || val.label || JSON.stringify(val);
      }
      return String(val ?? '');
    };

    // Helper: normalize an array of items to string[]
    const toStrArray = (arr: any): string[] => {
      if (!arr) return [];
      if (!Array.isArray(arr)) return [toStr(arr)];
      return arr.map(toStr);
    };

    // Pick the first truthy value among [canonical key, ...aliases] (replicates
    // the previous `raw.a || raw.b || raw.c` resolution semantics).
    const pick = (keys: string[]): any => {
      let val: any = undefined;
      for (const k of keys) {
        val = val || raw[k];
      }
      return val;
    };

    // Drive normalization entirely from the field registry so adding a future
    // field is a single entry in metadata-fields.ts.
    for (const def of METADATA_FIELDS) {
      const target = result as any;

      // Presence is recorded BEFORE normalization, from the raw response: an empty
      // array normalizes to undefined for some fields, and "the model returned []" and
      // "the model never mentioned this field" are different answers to a task unit.
      const rawValue = pick([def.key, ...def.aliases]);
      if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
        presentKeys.add(def.key);
      }

      switch (def.kind) {
        case 'string': {
          // Stringify when the model returns an object for a string field —
          // otherwise a raw object is assigned and downstream .replace() throws,
          // getting misdiagnosed as a parse error.
          target[def.key] = rawValue == null ? rawValue : toStr(rawValue);
          break;
        }
        case 'stringArray': {
          const arr = toStrArray(rawValue);
          if (def.emptyToUndefined && arr.length === 0) {
            target[def.key] = undefined;
          } else {
            target[def.key] = arr;
          }
          break;
        }
        case 'tags': {
          // Could be string or array; strip leading "#" from individual tags.
          const rawTags = raw[def.key];
          if (Array.isArray(rawTags)) {
            target[def.key] = rawTags.map((t: any) => toStr(t).replace(/^#\s*/, '')).join(',');
          } else if (typeof rawTags === 'string') {
            target[def.key] = rawTags.split(',').map((t: string) => t.trim().replace(/^#\s*/, '')).join(',');
          } else {
            target[def.key] = rawTags;
          }
          break;
        }
        case 'hashtags': {
          // Plain passthrough.
          target[def.key] = raw[def.key];
          break;
        }
      }
    }

    return { metadata: result, presentKeys };
  }

  /**
   * Add description links from prompt set to metadata
   */
  private addDescriptionLinks(metadata: MetadataResult): MetadataResult {
    if (!metadata.description) {
      return metadata;
    }

    // Remove [TIMESTAMPS] placeholder if present
    metadata.description = metadata.description.replace(/\[TIMESTAMPS\]/g, '').trim();

    // Get description links from current prompt set
    if (this.currentPromptSet?.description_links) {
      const descriptionLinks = this.currentPromptSet.description_links.trim();
      if (descriptionLinks) {
        console.log('[AIManager] Adding description links from prompt set');
        metadata.description = metadata.description + '\n\n' + descriptionLinks;
      }
    }

    // Ensure hashtags are space-separated (not comma-separated)
    if (metadata.hashtags) {
      // Remove commas and extra spaces, ensure single spaces between hashtags
      metadata.hashtags = metadata.hashtags
        .replace(/,\s*/g, ' ')  // Replace commas with spaces
        .replace(/\s+/g, ' ')   // Normalize multiple spaces to single space
        .trim();
    }

    return metadata;
  }

  /**
   * THE TWO DOORS a model call leaves this app through, chosen by the model string alone.
   *
   *   claude-cli:<alias>   `claude -p`, outside Crucible (LEDGER #193), exactly as before.
   *   anything else        the Crucible transport, which refuses a string that is not a
   *                        Crucible id by name (a stale `ollama:`/`claude:`/`openai:` one).
   *
   * Every call goes through its LANE itself (electron/crucible/lanes.ts, P3): a local model
   * takes its server's one GPU slot, a cloud one and `claude -p` take none (plan 13.1). Callers
   * must NOT wrap makeRequest in queueAITask: nesting would deadlock the slot. A cancel that
   * arrives while the request waits for the slot stops it before it is sent.
   */
  private async makeRequest(
    prompt: string,
    model: string,
    what: string,
    shape: PlainCallShape,
    /** `plain` (runPlainRequest) or `json` (the compilation package): which system turn a cloud call carries. */
    mode: 'plain' | 'json'
  ): Promise<string | null> {
    const requestId = Math.random().toString(36).substring(7);
    console.log(`[AIManager] AI REQUEST START [${requestId}] ${what} on ${model} (${prompt.length} chars)`);

    try {
      const result = await queueAITask<string | null>(
        routeOfModelId(model),
        `ai-${requestId}`,
        `AI Request: ${model}`,
        async () => {
          if (this.config.abortSignal?.aborted) {
            throw new JobCancelledError(`before the "${model}" request left the AI queue`);
          }
          if (model.startsWith('claude-cli:')) {
            // Recorded here, not by the Crucible door, BEFORE the call: a request that fails is
            // still a prompt that was sent. The "server" is the transport's own name (Law 8).
            this.promptTrace.push({ what, model, chars: prompt.length, at: new Date().toISOString(), prompt, server: 'claude -p' });
            console.log(`[AIManager]   Provider: claude -p (subscription)`);
            return await this.makeClaudeCliRequest(prompt, model.replace('claude-cli:', ''), mode === 'plain');
          }
          const cloud = isUpstreamModelId(model);
          if (!cloud && shape.maxTokens === undefined) {
            throw new Error(`${what} on the local model ${model} stated no output budget; every local call states one.`);
          }
          const job = shape.job ?? this.config.jobLeases;
          const answer = await crucibleTransport().chat({
            model,
            prompt,
            // The system turn is the cloud contract, as makeClaudeRequest sent it; a local
            // prompt carries the plain contract inline already (the field prompts open with it).
            ...(cloud ? { system: mode === 'plain' ? SYSTEM_PROMPTS.PLAIN_SYSTEM : AIManagerService.JSON_SYSTEM_TURN } : {}),
            act: 'generate',
            thinking: shape.thinking,
            maxTokens: cloud ? ANTHROPIC_MAX_TOKENS : shape.maxTokens!,
            ...(shape.temperature === undefined ? {} : { temperature: shape.temperature }),
            ...(mode === 'json' && !cloud ? { responseFormat: { type: 'json_object' as const } } : {}),
            ...(cloud || shape.loadContext === undefined ? {} : { loadContext: shape.loadContext }),
            ...(job === undefined ? {} : { job }),
            ...(this.config.abortSignal === undefined ? {} : { signal: this.config.abortSignal }),
            ...(shape.timeoutMs === undefined ? {} : { timeoutMs: shape.timeoutMs }),
            what,
            trace: this.promptTrace,
          });
          return answer.text;
        }
      );
      console.log(`[AIManager] AI REQUEST END [${requestId}] (${result?.length || 0} chars)`);
      return result;
    } catch (error: any) {
      console.error(`[AIManager] AI REQUEST FAILED [${requestId}]:`, error?.message || error);
      // Re-thrown AS ITSELF: the lanes pass a call's error through with its type, and a
      // caller with a declared policy for one of the door's refusals (`over_context`,
      // `truncated`) reads its code (Law 10); a park reads the SDK refusal the door carries as
      // its `cause` (P3). The orchestrator decides a run was cancelled from the abort signal.
      throw error;
    }
  }

  /**
   * The JSON contract, as the one cloud JSON caller left (the compilation package) sends it in
   * the system turn. Kept word for word from makeClaudeRequest.
   */
  private static readonly JSON_SYSTEM_TURN =
    'You are a helpful assistant. When asked to return JSON, output ONLY valid JSON with no markdown, no commentary, and no extra text. Start your response with { and end with }.';

  /**
   * The `claude -p` transport — the routing modal's subscription rung (operator, 2026-08-24).
   *
   * The SAME contract as makeClaudeRequest, reached through the Claude Code CLI on the
   * operator's subscription instead of the metered API key: the plain/JSON system split is
   * carried over via --system-prompt, and the model is ALWAYS sonnet — that is the option's
   * declared meaning, not a default.
   *
   * FAILS LOUDLY, never falls through to the API: an unresolvable binary or a nonzero exit
   * throws naming the fix. Falling back to the API would silently bill the key this transport
   * exists to protect.
   *
   * The binary is LOOKED UP rather than assumed to be on PATH — a GUI launch does not inherit
   * the shell's, and this used to fail with ENOENT in the packaged app while working in every
   * terminal. See resolveClaudeBinary.
   *
   * Cancellation kills the child; unlike the API path there is no server-side abort, so the
   * kill is the whole cancel.
   */
  /**
   * Where `claude` actually is, asked of the operator's own login shell.
   *
   * A DOUBLE-CLICKED APP DOES NOT INHERIT A SHELL'S PATH. macOS hands a GUI launch the bare
   * `/usr/bin:/bin:/usr/sbin:/sbin`, and `claude` on this machine lives under nvm
   * (`~/.nvm/versions/node/<version>/bin`), a directory that exists only because a shell rc
   * file put it there. So `spawn('claude')` from the packaged app failed with ENOENT while the
   * exact same command worked in every terminal the operator had open — and the error told
   * them to relaunch from a terminal, which is a workaround for a lookup this can just do.
   *
   * The lookup is `command -v` in the operator's own shell, because that is the same question
   * their terminal answers, asked the same way. Not a hardcoded list of install locations: the
   * nvm path carries a node version in it and would be wrong the day node is upgraded, which
   * is exactly the silently-substituted-binary failure this codebase refuses elsewhere (see
   * BinaryResolver).
   *
   * `-ilc`, AND THE `i` IS NOT OPTIONAL. A login shell alone (`-lc`) reads .zshenv/.zprofile
   * and answers with nothing here — nvm is set up in .zshrc, which only an INTERACTIVE shell
   * sources. Measured from an environment stripped to a GUI launch's PATH: `-lc` returned an
   * empty string, `-ilc` returned the real path. A login shell appeared to work only when it
   * was handed a PATH that already had the answer in it.
   *
   * The value is fenced in sentinels because an interactive shell runs the operator's whole
   * .zshrc, and anything in there that prints lands on the same stdout. Reading between the
   * markers takes the answer and ignores the greeting.
   *
   * THROWS when the shell cannot name it — there is no second strategy and no bare-name
   * attempt, because a spawn that then fails somewhere later with a worse message is the bug,
   * not the fix. Cached on success only, so fixing an install and retrying does not need a
   * restart.
   */
  private static claudeBinaryPath: string | null = null;

  private resolveClaudeBinary(): string {
    if (AIManagerService.claudeBinaryPath) return AIManagerService.claudeBinaryPath;

    // The operator's OWN shell, so their own rc files are the ones consulted. The default is
    // resolved at the read site per this app's convention; macOS has made zsh the login shell
    // since Catalina.
    const shell = process.env.SHELL || '/bin/zsh';
    const script = 'printf __CS_CLAUDE__%s__CS_END__ "$(command -v claude)"';
    let out = '';
    try {
      out = execFileSync(shell, ['-ilc', script], {
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      throw new Error(
        `the claude-cli transport could not locate the \`claude\` binary: \`${shell} -ilc\` ` +
        `failed (${err?.message || String(err)}). Install Claude Code, or route this field to ` +
        `a different model.`
      );
    }

    const found = (/__CS_CLAUDE__([\s\S]*?)__CS_END__/.exec(out)?.[1] || '').trim();
    // `command -v` answers with nothing when there is no claude, and can name a shell function
    // or an alias rather than a file. Only a real executable is accepted — spawning anything
    // else fails later and less clearly.
    if (!found || !fs.existsSync(found)) {
      throw new Error(
        `the claude-cli transport could not locate the \`claude\` binary: \`${shell} -ilc ` +
        `'command -v claude'\` answered ${found ? `"${found}", which is not a file on disk` : 'nothing'}. ` +
        `Install Claude Code, or route this field to a different model.`
      );
    }

    log.info(`[AIManager] resolved claude to ${found} (via ${shell} -ilc)`);
    AIManagerService.claudeBinaryPath = found;
    return found;
  }

  private makeClaudeCliRequest(prompt: string, cliModel: string, plain?: boolean): Promise<string | null> {
    const system = plain
      ? SYSTEM_PROMPTS.PLAIN_SYSTEM
      : 'You are a helpful assistant. When asked to return JSON, output ONLY valid JSON with no markdown, no commentary, and no extra text. Start your response with { and end with }.';
    log.info(`[AIManager] claude -p --model ${cliModel} (${prompt.length} chars, ${plain ? 'plain' : 'json'})`);

    // HERMETIC CWD (2026-08-24 night). `claude -p` loads project memory and CLAUDE.md for
    // whatever directory it runs in; spawned with the app's cwd — the repo, in dev — it
    // inherited a project memory full of the operator's name, which then surfaced in chapter
    // titles as an invented narrator ("Owen shows..."). The prompt must be this call's WHOLE
    // input, so every spawn runs in a dedicated empty directory instead.
    const hermeticCwd = path.join(os.tmpdir(), 'contentstudio-claude-cli');
    fs.mkdirSync(hermeticCwd, { recursive: true });

    // Resolved BEFORE the promise, so a missing binary throws to the caller as itself rather
    // than as a rejection racing the spawn.
    const binary = this.resolveClaudeBinary();

    return new Promise<string | null>((resolve, reject) => {
      const child = spawn(binary, ['-p', '--model', cliModel, '--system-prompt', system], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: hermeticCwd,
        env: {
          ...process.env,
          // The CLI's own directory goes on the child's PATH for the same reason the binary
          // had to be resolved at all: a GUI launch has none of it, and anything the CLI
          // shells out to would hit the identical ENOENT one level deeper.
          PATH: `${path.dirname(binary)}${path.delimiter}${process.env.PATH || ''}`,
          // A run inside a Claude Code session must not inherit its entrypoint state.
          CLAUDE_CODE_ENTRYPOINT: undefined,
        } as NodeJS.ProcessEnv,
      });

      const abortSignal = this.config.abortSignal;
      const onAbort = () => child.kill('SIGTERM');
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      // The API path is bounded by the Anthropic SDK's own 10-minute request timeout; an
      // unbounded spawn would let one hung CLI call hold the 1-slot AI queue forever.
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 10 * 60 * 1000);

      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
        // ENOENT here no longer means "not on PATH" — the binary was resolved to an existing
        // file moments ago, so it means the file has since gone or cannot be executed. Said
        // as what it is, naming the path, rather than repeating the old PATH advice that
        // would now send the operator after the wrong thing entirely.
        reject(
          error.code === 'ENOENT'
            ? new Error(
                `the claude-cli transport resolved \`claude\` to ${binary}, but spawning it failed ` +
                  `with ENOENT — the file has gone, or it is not executable. Reinstall Claude Code, ` +
                  `or route this field to a different model.`
              )
            : error
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
        if (abortSignal?.aborted) {
          reject(new JobCancelledError('the claude -p request was killed mid-flight'));
        } else if (timedOut) {
          reject(new Error('claude -p was killed after 10 minutes without answering'));
        } else if (code !== 0) {
          reject(new Error(`claude -p exited ${code}: ${err.trim() || '(no stderr)'}`));
        } else {
          log.info(`[AIManager] claude -p answered (${out.trim().length} chars)`);
          resolve(out.trim());
        }
      });
      child.stdin.end(prompt);
    });
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    // No cleanup needed for current implementation
    console.log('[AIManager] Cleanup complete');
  }
}
