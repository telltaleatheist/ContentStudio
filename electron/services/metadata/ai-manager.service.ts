/**
 * AI Manager Service - Multi-Provider AI Support
 *
 * Handles AI metadata generation with Ollama, OpenAI, and Claude (Anthropic)
 * Replaces the Python ai_manager.py
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import axios, { AxiosInstance } from 'axios';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import * as log from 'electron-log';
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
import { queueAITask } from '../queue-manager.service';
import { JobCancelledError, isAbortError } from './cancellation';
import { stripThinking } from './plain-call';

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
 * local — NEW, and derived rather than chosen. The per-field calls refuse above
 *   LOCAL_FIELD_CTX_MAX = 40960 tokens (metadata-tasks.ts), which is ~143,000 characters at
 *   this codebase's 3.5 chars/token estimate. Out of that comes the output budget
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
  provider: 'ollama' | 'openai' | 'claude';
  /**
   * Which direct-pass ceiling the transcript is measured against, decided by WHERE THE
   * FIELD CALLS GO, not by `provider` above. The per-field metadata path sets it from the
   * resolved routing: every routed field model local → 'local' (90k), any cloud → 'cloud'
   * (60k, the cost ceiling). Absent for callers whose every call really does go through
   * `provider` (compilation packaging, episode splitting) — there the provider IS the
   * answer and it is derived, not defaulted.
   *
   * This field exists because the 2026-08-22 restructure made `provider` a legacy setting
   * the metadata calls no longer follow: an all-local run under a cloud `provider` was
   * condensing 62k-char transcripts that fit the local window raw.
   */
  transcriptCeiling?: 'local' | 'cloud';
  model?: string; // Legacy single model (backward compatibility)
  summarizationModel?: string; // Model for fast summarization
  metadataModel?: string; // Model for final metadata generation
  apiKey?: string;
  host?: string;
  promptSet?: string;
  promptSetsDir?: string;
  // "CHANNEL PERFORMANCE DATA" block from the analytics feedback loop, appended
  // to the metadata prompt when present (resolved by the caller; optional).
  insightsBlock?: string;
  /**
   * Keys for the cloud providers a per-task ROUTING may reach, independent of the
   * provider `apiKey` above.
   *
   * Routing (metadata-routing.ts) lets a single run send one group to Claude while the
   * legacy `metadataModel` points somewhere else entirely, so the key for a group's
   * provider cannot be inferred from `provider`. Absent key for a routed provider is a
   * loud failure at request time, never a silent switch to a provider that is configured.
   */
  cloudApiKeys?: { claude?: string; openai?: string };
  /**
   * Fired when the user cancels the run. Handed to every provider client so a request
   * already in flight is ABORTED rather than left to finish and be billed — a cancelled
   * job has no business still paying for a 28k-token Claude call.
   */
  abortSignal?: AbortSignal;
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
  clip_suggestions?: string[];
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
   * SCOPE: everything routed through makeRequest, which is every CLOUD call and the legacy
   * package/summarization paths. The per-field LOCAL calls (description-unit, metadata-tasks,
   * the chapter pipeline's Ollama transport) speak to Ollama directly and do not appear;
   * "Show prompt" already covers those before the run.
   *
   * One AIManagerService is constructed per generation run, so the trace's lifetime is the
   * job's and nothing carries across runs.
   */
  readonly promptTrace: Array<{ what: string; model: string; chars: number; at: string; prompt: string }> = [];

  // Ollama context window size - controls KV cache memory allocation.
  // 131072 (default) creates a ~40GB KV cache for 70B models, causing OOM on most systems.
  // 32768 reduces it to ~10GB while still supporting long prompts (master analysis, episode splitting).
  private static readonly OLLAMA_NUM_CTX = 32768;
  // A full metadata JSON can exceed 2000 tokens; too small a budget truncates the
  // JSON mid-object and fails parsing. 4096 leaves ample room in the 32k context.
  private static readonly OLLAMA_NUM_PREDICT = 4096;
  // Max prompt chars before truncation: (context - response - margin) * ~3.5 chars/token
  private static readonly OLLAMA_MAX_PROMPT_CHARS = Math.floor(
    (AIManagerService.OLLAMA_NUM_CTX - AIManagerService.OLLAMA_NUM_PREDICT - 512) * 3.5
  );

  private config: AIConfig;
  private ollamaClient?: AxiosInstance;
  private openaiClient?: OpenAI;
  private anthropicClient?: Anthropic;
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

  /**
   * Get available models for a provider
   */
  static async getAvailableModels(
    provider: 'ollama' | 'openai' | 'claude',
    apiKey?: string,
    host?: string
  ): Promise<Array<{ id: string; name: string }>> {
    try {
      if (provider === 'claude') {
        if (!apiKey) {
          throw new Error('API key required for Claude');
        }

        const anthropic = new Anthropic({ apiKey });
        log.info('[AIManager] Fetching Claude models from API...');
        const response = await anthropic.models.list();
        log.info(`[AIManager] Received ${response.data.length} models from Claude API`);

        // Log all models for debugging
        response.data.forEach(model => {
          log.info(`[AIManager] Claude model: ${model.id} (${model.display_name || 'no display name'})`);
        });

        // Filter for chat-capable models (claude-3 and claude-sonnet/opus/haiku families)
        // Exclude embedding models and other non-chat models
        const chatModels = response.data
          .filter(model => {
            const id = model.id.toLowerCase();
            // Include Claude 3.x, Claude 4.x, and sonnet/opus/haiku models
            return (id.includes('claude-3') ||
                    id.includes('claude-sonnet') ||
                    id.includes('claude-opus') ||
                    id.includes('claude-haiku')) &&
                   !id.includes('embedding');
          })
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        log.info(`[AIManager] Filtered to ${chatModels.length} chat-capable Claude models`);

        // Return up to 10 most recent chat models
        return chatModels.slice(0, 10).map(model => ({
          id: model.id,
          name: model.display_name || model.id
        }));
      } else if (provider === 'openai') {
        if (!apiKey) {
          throw new Error('API key required for OpenAI');
        }

        const openai = new OpenAI({ apiKey });
        const response = await openai.models.list();

        // Filter for chat models and get top 3
        const chatModels = response.data
          .filter(model => model.id.startsWith('gpt-'))
          .sort((a, b) => b.created - a.created)
          .slice(0, 3);

        return chatModels.map(model => ({
          id: model.id,
          name: model.id
        }));
      } else if (provider === 'ollama') {
        const ollamaHost = host || 'http://localhost:11434';
        const client = axios.create({ baseURL: ollamaHost });

        const response = await client.get('/api/tags');

        // Get top 3 models
        const models = response.data.models || [];
        const topModels = models.slice(0, 3);

        return topModels.map((model: any) => ({
          id: model.name,
          name: model.name
        }));
      }

      return [];
    } catch (error) {
      log.error(`[AIManager] Failed to get available models for ${provider}:`, error);
      console.error(`[AIManager] Failed to get available models for ${provider}:`, error);
      return [];
    }
  }

  constructor(config: AIConfig) {
    this.config = config;

    /**
     * The two models are resolved INDEPENDENTLY now, and that is a fix rather than a tidy-up.
     *
     * The old condition was `config.summarizationModel && config.metadataModel` — BOTH or
     * neither. Since this build the summarization model is declared
     * (metadata-routing.ts SUMMARIZATION_MODEL) while the metadata model comes from a Settings
     * field that may legitimately be empty, so the AND would have thrown the declared
     * summarizer away the moment Settings had no model in it and quietly summarized on
     * `ollama:phi-3.5:3.8b` instead. A declared value must not be conditional on an unrelated
     * one being present.
     */
    const PROVIDER_DEFAULTS: Record<string, { summary: string; metadata: string }> = {
      // Fast model for summaries (2.2GB) / quality model for metadata (4.7GB).
      ollama: { summary: 'ollama:phi-3.5:3.8b', metadata: 'ollama:qwen2.5:7b' },
      openai: { summary: 'openai:gpt-4o-mini', metadata: 'openai:gpt-4o' },
      claude: { summary: 'claude:claude-3-haiku-20240307', metadata: 'claude:claude-3-5-sonnet-20241022' },
    };
    const defaults = PROVIDER_DEFAULTS[config.provider];
    this.summaryModel = config.summarizationModel || config.model || defaults?.summary || '';
    this.metadataModel = config.metadataModel || config.model || defaults?.metadata || '';

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
    console.log('[AIManager] Provider:', config.provider);
    console.log('[AIManager] Summary model:', this.summaryModel);
    console.log('[AIManager] Metadata model:', this.metadataModel);
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
   * 8000 was a 14B-era number. The summarizer's transport pins num_ctx 32768 (~114,000
   * characters), so 8k chunks were spending fifteen calls on work that fits in two, and each
   * of those calls saw a fifteenth of the video with no idea what surrounded it.
   */
  private static readonly OLLAMA_SUMMARIZE_CHUNK_CHARS = 60000;

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
   * Initialize the AI provider(s) - supports multi-provider setups
   */
  async initialize(): Promise<boolean> {
    this.lastInitError = undefined;
    try {
      // Load prompts
      this.loadPrompts();

      // Helper to check if a model belongs to a specific provider
      const isClaudeModel = (model: string) =>
        model.startsWith('claude-') || model.startsWith('claude:');
      const isOpenAIModel = (model: string) =>
        model.startsWith('gpt-') || model.startsWith('openai:');
      const isOllamaModel = (model: string) =>
        !isClaudeModel(model) && !isOpenAIModel(model);

      // Detect which providers are needed based on models
      const needsOllama = isOllamaModel(this.summaryModel) || isOllamaModel(this.metadataModel);
      const needsOpenAI = isOpenAIModel(this.summaryModel) || isOpenAIModel(this.metadataModel);
      const needsClaude = isClaudeModel(this.summaryModel) || isClaudeModel(this.metadataModel);

      log.info(`[AIManager] Provider detection: needsOllama=${needsOllama}, needsOpenAI=${needsOpenAI}, needsClaude=${needsClaude}`);
      log.info(`[AIManager] Models: summary=${this.summaryModel}, metadata=${this.metadataModel}`);

      // Initialize all needed providers
      let anySuccess = false;

      if (needsOllama) {
        log.info('[AIManager] Initializing Ollama...');
        const success = await this.initializeOllama();
        log.info(`[AIManager] Ollama initialization: ${success ? 'SUCCESS' : 'FAILED'}`);
        if (success) anySuccess = true;
      }

      if (needsOpenAI) {
        log.info('[AIManager] Initializing OpenAI...');
        const success = await this.initializeOpenAI();
        log.info(`[AIManager] OpenAI initialization: ${success ? 'SUCCESS' : 'FAILED'}`);
        if (success) anySuccess = true;
      }

      if (needsClaude) {
        log.info('[AIManager] Initializing Claude...');
        const success = await this.initializeClaude();
        log.info(`[AIManager] Claude initialization: ${success ? 'SUCCESS' : 'FAILED'}`);
        if (success) anySuccess = true;
      }

      if (!anySuccess) {
        log.error('[AIManager] No AI providers initialized successfully');
        this.lastInitError = this.lastInitError || 'No AI providers initialized successfully';
      }

      return anySuccess;
    } catch (error) {
      log.error('[AIManager] Initialization failed:', error);
      console.error('[AIManager] Initialization failed:', error);
      this.lastInitError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /**
   * Initialize Ollama provider
   */
  private async initializeOllama(): Promise<boolean> {
    try {
      const host = this.config.host || 'http://localhost:11434';
      log.info(`[AIManager] Connecting to Ollama at ${host}...`);

      this.ollamaClient = axios.create({
        baseURL: host,
        headers: { 'Content-Type': 'application/json' },
        timeout: 300000, // 5 minutes
      });

      // Test connection
      const response = await this.ollamaClient.get('/api/tags');

      log.info('[AIManager] Ollama server connected');
      return true;
    } catch (error: any) {
      log.error('[AIManager] Cannot connect to Ollama:', error?.message || error);
      this.lastInitError = `Cannot connect to Ollama at ${this.config.host || 'http://localhost:11434'}: ${error?.message || error}`;
      return false;
    }
  }

  /**
   * Initialize OpenAI provider
   */
  private async initializeOpenAI(): Promise<boolean> {
    try {
      if (!this.config.apiKey) {
        log.error('[AIManager] OpenAI API key required');
        this.lastInitError = 'OpenAI API key required';
        return false;
      }

      this.openaiClient = new OpenAI({
        apiKey: this.config.apiKey,
      });

      // Pick whichever configured model is actually an OpenAI model — either
      // summaryModel or metadataModel may belong to a different provider. Strip
      // the "openai:" prefix before sending to the API.
      const isOpenAIModel = (m: string) => m.startsWith('openai:') || m.startsWith('gpt-');
      const openaiModel = isOpenAIModel(this.summaryModel) ? this.summaryModel : this.metadataModel;
      const testModel = openaiModel.replace('openai:', '');

      // Test with a simple request
      log.info(`[AIManager] Testing OpenAI connection with model: ${testModel}`);
      await this.openaiClient.chat.completions.create({
        model: testModel,
        messages: [{ role: 'user', content: 'Test' }],
        max_tokens: 5,
      });

      log.info('[AIManager] OpenAI connected successfully');
      return true;
    } catch (error: any) {
      log.error('[AIManager] Cannot connect to OpenAI:', error?.message || error);
      this.lastInitError = `Cannot connect to OpenAI: ${error?.message || error}`;
      return false;
    }
  }

  /**
   * Initialize Claude (Anthropic) provider
   */
  private async initializeClaude(): Promise<boolean> {
    // Pick whichever configured model is actually a Claude model — either
    // summaryModel or metadataModel may belong to a different provider. Strip
    // the "claude:" prefix if present.
    const isClaudeModel = (m: string) => m.startsWith('claude:') || m.startsWith('claude-');
    const claudeModel = isClaudeModel(this.metadataModel) ? this.metadataModel : this.summaryModel;
    const testModel = claudeModel.replace('claude:', '');

    try {
      if (!this.config.apiKey) {
        log.error('[AIManager] Anthropic API key required');
        this.lastInitError = 'Anthropic API key required';
        return false;
      }

      this.anthropicClient = new Anthropic({
        apiKey: this.config.apiKey,
      });

      // Test with a simple request
      log.info(`[AIManager] Testing Claude connection with model: ${testModel}`);
      await this.anthropicClient.messages.create({
        model: testModel,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Test' }],
      });

      log.info('[AIManager] Claude (Anthropic) connected successfully');
      return true;
    } catch (error: any) {
      log.error('[AIManager] Cannot connect to Claude:', error?.message || error);
      if (error?.status === 404) {
        log.error(`[AIManager] Model '${testModel}' not found - check model name`);
      }
      this.lastInitError = error?.status === 404
        ? `Claude model '${testModel}' not found - check model name`
        : `Cannot connect to Claude: ${error?.message || error}`;
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
    clip_suggestions: '["string", ...]',
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

    const ceiling = this.config.transcriptCeiling
      ?? (this.config.provider === 'ollama' ? 'local' : 'cloud');
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

    // Chunk size follows the SUMMARIZER's transport (the model doing the condensing),
    // which is independent of both `provider` and the ceiling above. Same provider
    // detection as initialize(): anything not explicitly cloud-prefixed is Ollama.
    const summaryIsCloud =
      this.summaryModel.startsWith('claude:') || this.summaryModel.startsWith('claude-') ||
      this.summaryModel.startsWith('openai:') || this.summaryModel.startsWith('gpt-');
    const chunkSize = summaryIsCloud
      ? AIManagerService.CLOUD_SUMMARIZE_CHUNK_CHARS
      : AIManagerService.OLLAMA_SUMMARIZE_CHUNK_CHARS;

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
        // 600s, matching LOCAL_GROUP_TIMEOUT_MS: this call's num_ctx differs from the
        // chapter pipeline's, so Ollama fully reloads the 27b before generating and the
        // window has to hold the reload as well as the summary.
        response = await this.makeRequest(prompt, this.summaryModel, 600, `summarization chunk ${i + 1} of ${sourceName}`);
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
    // 600s for the same reason as the chunked path above: the local model may need a
    // full reload (num_ctx change) before it can start writing.
    const response = await this.makeRequest(prompt, this.summaryModel, 600, `summarization of ${sourceName}`);

    // A trivially short/empty summary means the model produced nothing usable —
    // fail loudly rather than silently substituting truncated raw transcript.
    if (!response || response.trim().length <= 10) {
      throw new Error(`Summarization returned empty/too-short response for ${sourceName}`);
    }
    return response.trim();
  }

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
   */
  async generateMetadataFromAssembledPrompt(prompt: string): Promise<MetadataResult> {
    const { metadata } = await this.runMetadataRequest(prompt);

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
   */
  async generateCompilationMetadata(
    content: string,
    sourceName: string | undefined,
    compilationInfo: { sourceCount: number; contentTypes: string[] }
  ): Promise<MetadataResult> {
    if (!this.currentPromptSet) {
      throw new Error('No prompt set loaded');
    }

    log.info(
      `[AIManager] DECLARED MODE: compilation packaging for ${sourceName || 'unknown'} — one whole-metadata call ` +
        `covering ${compilationInfo.sourceCount} item(s) on ${this.metadataModel}, because a compilation's umbrella ` +
        `title and bulleted description are a different request shape from the routed per-field units`
    );
    console.log(`[AIManager]     Content length: ${content.length} chars`);

    const prompt = this.createCompilationPrompt(content, sourceName, compilationInfo);
    return this.generateMetadataFromAssembledPrompt(prompt);
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
   * podcast set has no thumbnail text and no clip suggestions, and never did. Planning a
   * run reads this so it can leave those fields out and say so, rather than routing a
   * field the prompt set never asked for and failing on a section that was never missing
   * by accident.
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
    const subject = this.buildSubjectBlock(
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
    // here (see planMetadataUnits).
    const insightsSuffix = spec.insights && this.config.insightsBlock ? `\n\n${this.config.insightsBlock}` : '';

    return (
      `${SYSTEM_PROMPTS.PLAIN_SYSTEM}\n\n${this.fillSubject(subject)}` +
      `${inputData ? `\n${inputData}` : ''}\n\n${instructions.text}${insightsSuffix}`
    );
  }

  /**
   * Make sure the provider behind `model` has a client, for models this instance was not
   * constructed around.
   *
   * Per-task routing can send one group to a model whose provider initialize() never
   * touched. Creating the client here is not a fallback — the model was explicitly
   * requested and this is the first time it is needed. A MISSING KEY is the failure, and
   * it throws naming the provider and the model rather than quietly sending the request
   * somewhere that is configured.
   */
  private async ensureProviderReady(model: string): Promise<void> {
    if (model.startsWith('claude:')) {
      if (this.anthropicClient) return;
      const key = this.config.cloudApiKeys?.claude
        || (this.metadataModel.startsWith('claude:') ? this.config.apiKey : undefined);
      if (!key) {
        throw new Error(
          `Metadata is routed to "${model}", but no Anthropic API key is configured. Add it in AI Setup — ` +
            `no other provider was substituted.`
        );
      }
      this.anthropicClient = new Anthropic({ apiKey: key });
      log.info(`[AIManager] Initialized Claude client on demand for routed model ${model}`);
      return;
    }

    if (model.startsWith('openai:')) {
      if (this.openaiClient) return;
      const key = this.config.cloudApiKeys?.openai
        || (this.metadataModel.startsWith('openai:') ? this.config.apiKey : undefined);
      if (!key) {
        throw new Error(
          `Metadata is routed to "${model}", but no OpenAI API key is configured. Add it in AI Setup — ` +
            `no other provider was substituted.`
        );
      }
      this.openaiClient = new OpenAI({ apiKey: key });
      log.info(`[AIManager] Initialized OpenAI client on demand for routed model ${model}`);
      return;
    }

    if (model.startsWith('ollama:') && !this.ollamaClient) {
      const host = this.config.host || 'http://localhost:11434';
      this.ollamaClient = axios.create({
        baseURL: host,
        headers: { 'Content-Type': 'application/json' },
        timeout: 300000,
      });
      log.info(`[AIManager] Initialized Ollama client on demand for routed model ${model} @ ${host}`);
    }
  }

  /**
   * Request + parse + repair, WITHOUT the description-links post-processing.
   *
   * Task units share this because those links have to be appended once, to the merged
   * result: the description they attach to and the hashtags they are normalized
   * alongside come back from two different calls.
   *
   * `model` overrides the configured metadata model — that is how one run sends its
   * titles group to one model and its thumbnail group to another.
   */
  async runMetadataRequest(
    prompt: string,
    model?: string
  ): Promise<{ metadata: MetadataResult; presentKeys: Set<string> }> {
    const requestModel = model || this.metadataModel;
    await this.ensureProviderReady(requestModel);

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.makeRequest(prompt, requestModel, 300, `metadata package (attempt ${attempt})`);

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
   * One cloud request whose answer is PLAIN TEXT — the transport for every plain-format call
   * (operator's ruling 2026-08-24: no JSON for these calls unless absolutely necessary).
   *
   * No output_config, no JSON system nudge, no stop sequences: the request is the prompt and
   * the 4000-token runaway brake and nothing else. Inline <think> blocks are stripped once,
   * here, so no caller re-learns that a reasoning model sometimes narrates before it answers.
   *
   * Returns null for an EMPTY answer — the caller's one-decision cost, exactly as the local
   * transport's `ok: false` is — and throws on transport failure, which affects every
   * remaining call. Same split as everywhere else, typed by shape rather than message text.
   */
  async runPlainRequest(prompt: string, model: string, what: string): Promise<string | null> {
    await this.ensureProviderReady(model);
    const response = await this.makeRequest(prompt, model, 300, what, true);
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
   * This is not decoration — it closes a hole the tags adapter opens deliberately. Its
   * trained system prompt says "No channel names and no creator names - those are appended
   * separately", so without this step a locally generated tag list never names the
   * channel at all.
   *
   * The channel tags are the ones that survive: if the merged list breaks the 500-character
   * budget, generated tags are dropped from the END (the tail is where the adapter puts
   * its broad category terms, the least specific and most replaceable) until it fits, and
   * the log names every one dropped. A prompt set whose channel_tags alone exceed the
   * budget is a configuration error and throws — there is nothing left to drop that would
   * not be the thing the user asked to protect.
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
   * Make request to AI provider - intelligently routes based on model name
   */
  private async makeRequest(
    prompt: string,
    model: string,
    timeout: number = 600,
    what: string = 'AI request',
    /** Plain-text call (runPlainRequest): the Claude route sends no JSON system nudge. */
    plain?: boolean
  ): Promise<string | null> {
    const requestId = Math.random().toString(36).substring(7);
    const timestamp = new Date().toISOString();

    // Recorded BEFORE the call: a request that fails or times out is still a prompt that
    // was sent, and the trace exists to answer "what did the model actually read".
    this.promptTrace.push({ what, model, chars: prompt.length, at: timestamp, prompt });

    console.log(`[AIManager] ▶ AI REQUEST START [${requestId}] at ${timestamp}`);
    console.log(`[AIManager]   Model: ${model}`);
    console.log(`[AIManager]   Prompt length: ${prompt.length} chars`);

    try {
      // Route every provider call through the single-slot AI queue (Ollama OOM
      // protection). Callers must NOT wrap makeRequest in queueAITask — nesting
      // would deadlock the 1-slot pool.
      const result = await queueAITask<string | null>(
        `ai-${requestId}`,
        `AI Request: ${model}`,
        async () => {
          // The queue slot may have been waited on for minutes. A cancel that arrives
          // while this request is QUEUED must not let it start: the caller's boundary
          // guard ran before the wait, not after it.
          if (this.config.abortSignal?.aborted) {
            throw new JobCancelledError(`before the "${model}" request left the AI queue`);
          }

          // Detect provider from model name - EXPLICIT routing, no fallbacks
          // Model format must be "provider:model" (e.g., "ollama:cogito:14b", "openai:gpt-4o", "claude:claude-3-5-sonnet")
          if (model.startsWith('openai:')) {
            console.log(`[AIManager]   Provider: OpenAI`);
            return await this.makeOpenAIRequest(prompt, model.replace('openai:', ''));
          } else if (model.startsWith('claude:')) {
            console.log(`[AIManager]   Provider: Claude`);
            return await this.makeClaudeRequest(prompt, model.replace('claude:', ''), plain);
          } else if (model.startsWith('ollama:')) {
            console.log(`[AIManager]   Provider: Ollama`);
            return await this.makeOllamaRequest(prompt, model.replace('ollama:', ''), timeout);
          } else {
            // No valid provider prefix - this is a bug, throw error
            throw new Error(`Invalid model format: "${model}". Model must have provider prefix (openai:, claude:, or ollama:)`);
          }
        }
      );

      const endTimestamp = new Date().toISOString();
      console.log(`[AIManager] ■ AI REQUEST END [${requestId}] at ${endTimestamp}`);
      console.log(`[AIManager]   Response length: ${result?.length || 0} chars`);

      return result;
    } catch (error: any) {
      const endTimestamp = new Date().toISOString();
      console.error(`[AIManager] ✖ AI REQUEST FAILED [${requestId}] at ${endTimestamp}:`, error);
      // Re-throw with context so the caller gets a useful error message. A CANCELLED
      // request arrives here as a plain Error whatever it was thrown as — the AI queue
      // re-wraps every rejection (queue-manager.service.ts) — so there is nothing to
      // re-classify here. Its message survives, and the orchestrator decides a run was
      // cancelled from the abort signal, not from the error.
      throw new Error(error?.message || `AI request failed for model "${model}"`);
    }
  }

  /**
   * Make request to Ollama
   */
  private async makeOllamaRequest(
    prompt: string,
    model: string,
    timeout: number
  ): Promise<string | null> {
    if (!this.ollamaClient) {
      throw new Error('Ollama client not initialized');
    }

    // Truncate prompt if it exceeds the context window capacity. Use MIDDLE
    // truncation: metadata prompts put the field instructions LAST, so plain
    // head-truncation would delete the instructions and keep only transcript,
    // yielding garbage. Keep the head and tail, drop the middle of the transcript.
    let effectivePrompt = prompt;
    const maxChars = AIManagerService.OLLAMA_MAX_PROMPT_CHARS;
    if (prompt.length > maxChars) {
      const marker = '\n[... transcript truncated to fit context ...]\n';
      const keep = maxChars - marker.length;
      const headLen = Math.ceil(keep / 2);
      const tailLen = Math.floor(keep / 2);
      effectivePrompt = prompt.substring(0, headLen) + marker + prompt.substring(prompt.length - tailLen);
      log.warn(`[AIManager] Prompt too long (${prompt.length} chars, max ${maxChars}), middle-truncating to ${effectivePrompt.length} chars`);
    }

    try {
      const response = await this.ollamaClient.post(
        '/api/generate',
        {
          model,
          prompt: effectivePrompt,
          stream: false,
          options: {
            num_predict: AIManagerService.OLLAMA_NUM_PREDICT,
            num_ctx: AIManagerService.OLLAMA_NUM_CTX,
          },
        },
        { timeout: timeout * 1000, signal: this.config.abortSignal }
      );

      // Warn if the response was cut off at num_predict — the JSON is likely
      // incomplete and will fail parsing (mirror the Claude max_tokens check).
      if (response.data.done_reason === 'length') {
        log.warn(`[AIManager] Ollama response was truncated (done_reason=length, hit num_predict=${AIManagerService.OLLAMA_NUM_PREDICT} limit)!`);
      }

      return response.data.response;
    } catch (error: any) {
      if (isAbortError(error)) {
        throw new JobCancelledError(`the Ollama request to "${model}" was aborted mid-flight`);
      }

      // Extract useful error details from Ollama response
      const ollamaError = error?.response?.data?.error || error?.message || 'Unknown error';
      const status = error?.response?.status;
      const isTimeout = error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT';

      if (isTimeout) {
        log.error(`[AIManager] Ollama request timed out after ${timeout}s for model "${model}"`);
        throw new Error(`Ollama request timed out after ${timeout}s. Model "${model}" may be too large for your hardware, or Ollama is still loading the model. Try a smaller model or increase available memory.`);
      } else if (status === 404) {
        log.error(`[AIManager] Ollama model "${model}" not found`);
        throw new Error(`Ollama model "${model}" not found. Make sure you've pulled it with: ollama pull ${model}`);
      } else {
        log.error(`[AIManager] Ollama request failed for model "${model}":`, ollamaError);
        throw new Error(`Ollama request failed (model: ${model}): ${ollamaError}`);
      }
    }
  }

  /**
   * Make request to OpenAI
   */
  private async makeOpenAIRequest(prompt: string, model: string): Promise<string | null> {
    if (!this.openaiClient) {
      console.error('[AIManager] OpenAI client not initialized');
      throw new Error('OpenAI client not initialized');
    }

    console.log(`[AIManager] Making OpenAI request to model: ${model}`);

    try {
      const response = await this.openaiClient.chat.completions.create(
        {
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2000,
        },
        { signal: this.config.abortSignal }
      );

      const content = response.choices[0]?.message?.content;
      console.log(`[AIManager] OpenAI response received, content length: ${content?.length || 0}`);

      if (!content) {
        console.error('[AIManager] OpenAI returned empty content. Response:', JSON.stringify(response, null, 2));
      }

      return content || null;
    } catch (error: any) {
      if (isAbortError(error)) {
        throw new JobCancelledError(`the OpenAI request to "${model}" was aborted mid-flight`);
      }
      const errorMsg = error?.message || 'Unknown error';
      console.error('[AIManager] OpenAI request failed:', errorMsg);
      console.error('[AIManager] OpenAI error details:', error?.response?.data || error);
      throw new Error(`OpenAI request failed (model: ${model}): ${errorMsg}`);
    }
  }

  /**
   * Map friendly Claude model names to actual API model names
   */
  private mapClaudeModelName(friendlyName: string): string {
    const modelMap: { [key: string]: string } = {
      // Claude 4 models
      'claude-sonnet-4': 'claude-sonnet-4-20250514',
      'claude-opus-4': 'claude-opus-4-20250514',
      // Claude 3.5 models (still widely used)
      'claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku': 'claude-3-5-haiku-20241022',
      // Older Claude 3 models
      'claude-3-haiku': 'claude-3-haiku-20240307',
      'claude-3-opus': 'claude-3-opus-20240229',
    };

    return modelMap[friendlyName] || friendlyName;
  }

  /**
   * Make request to Claude
   */
  private async makeClaudeRequest(prompt: string, model: string, plain?: boolean): Promise<string | null> {
    if (!this.anthropicClient) {
      throw new Error('Claude client not initialized');
    }

    try {
      // Map friendly name to actual API model name
      const actualModel = this.mapClaudeModelName(model);

      const params: Record<string, unknown> = {
        model: actualModel,
        // A runaway brake, not a budget: the largest legitimate metadata answer (a 3-hour
        // video's stage-1 boundary list, a compilation package) stays under ~2500 tokens.
        // The close-quote runaway this was sized against (2026-08-23: `}` streamed to a
        // 16000 ceiling, 90-150s per glitched call) died with the JSON — a plain answer has
        // no string literal to fail to close — and the brake stays because any runaway is
        // 25s at 4000 instead of minutes.
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      };
      if (!plain) {
        // The JSON nudge, for the two JSON callers left: the compilation package and the
        // episode splitter. Every routed field call goes through runPlainRequest instead.
        params.system =
          'You are a helpful assistant. When asked to return JSON, output ONLY valid JSON with no markdown, no commentary, and no extra text. Start your response with { and end with }.';
      }

      const response = (await this.anthropicClient.messages.create(
        params as never,
        // The signal is the whole point of the cancel path: without it a cancel during
        // this call is billed in full and the answer is thrown away.
        { signal: this.config.abortSignal }
      )) as Anthropic.Message;

      // Log why Claude stopped
      log.info(`[AIManager] Claude stop_reason: ${response.stop_reason}`);
      log.info(`[AIManager] Claude usage: input=${response.usage.input_tokens}, output=${response.usage.output_tokens}`);

      // Warn if response was truncated
      if (response.stop_reason === 'max_tokens') {
        log.warn('[AIManager] Response was truncated due to max_tokens limit!');
      }

      const textBlock = response.content.find((block) => block.type === 'text');
      return textBlock?.type === 'text' ? textBlock.text : null;
    } catch (error: any) {
      if (isAbortError(error)) {
        throw new JobCancelledError(`the Claude request to "${model}" was aborted mid-flight`);
      }
      const errorMsg = error?.message || 'Unknown error';
      log.error('[AIManager] Claude request failed:', errorMsg);
      console.error('[AIManager] Claude request failed:', error);
      throw new Error(`Claude request failed (model: ${model}): ${errorMsg}`);
    }
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    // No cleanup needed for current implementation
    console.log('[AIManager] Cleanup complete');
  }
}
