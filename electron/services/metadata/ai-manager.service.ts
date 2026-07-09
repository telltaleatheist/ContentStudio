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

export interface AIConfig {
  provider: 'ollama' | 'openai' | 'claude';
  model?: string; // Legacy single model (backward compatibility)
  summarizationModel?: string; // Model for fast summarization
  metadataModel?: string; // Model for final metadata generation
  apiKey?: string;
  host?: string;
  promptSet?: string;
  promptSetsDir?: string;
}

export interface MetadataResult {
  thumbnail_text?: string[];
  titles?: string[];
  description?: string;
  tags?: string;
  hashtags?: string;
  pinned_comment?: string[];
  spoken_keywords?: string[];
  clip_suggestions?: string[];
  chapters?: Array<{
    timestamp: string;
    title: string;
    sequence: number;
  }>;
}

export interface PromptSet {
  name: string;
  editorial_prompt: string;
  instructions_prompt: string;
  description_links: string;
}

export class AIManagerService {
  // Ollama context window size - controls KV cache memory allocation.
  // 131072 (default) creates a ~40GB KV cache for 70B models, causing OOM on most systems.
  // 32768 reduces it to ~10GB while still supporting long prompts (master analysis, episode splitting).
  private static readonly OLLAMA_NUM_CTX = 32768;
  private static readonly OLLAMA_NUM_PREDICT = 2000;
  // Max prompt chars before truncation: (context - response - margin) * ~3.5 chars/token
  private static readonly OLLAMA_MAX_PROMPT_CHARS = Math.floor(
    (AIManagerService.OLLAMA_NUM_CTX - AIManagerService.OLLAMA_NUM_PREDICT - 512) * 3.5
  );

  private config: AIConfig;
  private ollamaClient?: AxiosInstance;
  private openaiClient?: OpenAI;
  private anthropicClient?: Anthropic;
  private summarizationPrompts: any;
  private currentPromptSet?: PromptSet;
  private summaryModel: string = '';
  private metadataModel: string = '';
  private promptsDir: string;
  private promptSetsDir: string;

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

    // Set models - use specific models if provided, otherwise use defaults
    if (config.summarizationModel && config.metadataModel) {
      // User-specified models (from settings)
      this.summaryModel = config.summarizationModel;
      this.metadataModel = config.metadataModel;
    } else if (config.model) {
      // Legacy single model (backward compatibility)
      this.summaryModel = config.model;
      this.metadataModel = config.model;
    } else {
      // Provider defaults
      if (config.provider === 'ollama') {
        // Use different models for speed vs quality
        this.summaryModel = 'phi-3.5:3.8b'; // Fast model for summaries (2.2GB)
        this.metadataModel = 'qwen2.5:7b'; // Quality model for metadata (4.7GB)
      } else if (config.provider === 'openai') {
        this.summaryModel = 'gpt-4o-mini'; // Fast/cheap for summaries
        this.metadataModel = 'gpt-4o'; // Quality for metadata
      } else if (config.provider === 'claude') {
        this.summaryModel = 'claude-3-haiku-20240307'; // Fast
        this.metadataModel = 'claude-3-5-sonnet-20241022'; // Quality
      }
    }

    // Set prompts directories
    this.promptsDir = this.getPromptsDir();
    // Use provided promptSetsDir or fall back to bundled location
    this.promptSetsDir = config.promptSetsDir || path.join(this.promptsDir, 'prompt_sets');

    console.log('[AIManager] Initialized');
    console.log('[AIManager] Provider:', config.provider);
    console.log('[AIManager] Summary model:', this.summaryModel);
    console.log('[AIManager] Metadata model:', this.metadataModel);
  }

  /**
   * Max transcript chars to send in a single chapter-detection request.
   * Ollama's 32k context needs chunking; cloud providers (Claude 200k, OpenAI 128k)
   * handle full transcripts in one shot, which produces far better chapters —
   * the model sees the whole video, so topic boundaries and chapter-count
   * calibration ("4-6 for a long video") work as intended.
   */
  getMaxTranscriptChunkChars(): number {
    return this.config.provider === 'ollama' ? 30000 : 300000;
  }

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
      }

      return anySuccess;
    } catch (error) {
      log.error('[AIManager] Initialization failed:', error);
      console.error('[AIManager] Initialization failed:', error);
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
        return false;
      }

      this.openaiClient = new OpenAI({
        apiKey: this.config.apiKey,
      });

      // Test with a simple request
      log.info(`[AIManager] Testing OpenAI connection with model: ${this.summaryModel}`);
      await this.openaiClient.chat.completions.create({
        model: this.summaryModel,
        messages: [{ role: 'user', content: 'Test' }],
        max_tokens: 5,
      });

      log.info('[AIManager] OpenAI connected successfully');
      return true;
    } catch (error: any) {
      log.error('[AIManager] Cannot connect to OpenAI:', error?.message || error);
      return false;
    }
  }

  /**
   * Initialize Claude (Anthropic) provider
   */
  private async initializeClaude(): Promise<boolean> {
    try {
      if (!this.config.apiKey) {
        log.error('[AIManager] Anthropic API key required');
        return false;
      }

      this.anthropicClient = new Anthropic({
        apiKey: this.config.apiKey,
      });

      // Test with a simple request
      // Use metadataModel since that's the Claude model (summaryModel might be from a different provider)
      // Strip the "claude:" prefix if present
      const testModel = this.metadataModel.replace('claude:', '');
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
        log.error(`[AIManager] Model '${this.metadataModel.replace('claude:', '')}' not found - check model name`);
      }
      return false;
    }
  }

  /**
   * Load prompts from YAML files
   */
  private loadPrompts(): void {
    try {
      // Load summarization prompts
      const summarizationPath = path.join(this.promptsDir, 'summarization_prompts.yml');
      if (fs.existsSync(summarizationPath)) {
        const content = fs.readFileSync(summarizationPath, 'utf-8');
        this.summarizationPrompts = yaml.load(content);
        console.log('[AIManager] Loaded summarization prompts');
      }

      // Load prompt set
      const promptSetName = this.config.promptSet || 'sample-youtube';
      const promptSetPath = path.join(this.promptSetsDir, `${promptSetName}.yml`);

      if (fs.existsSync(promptSetPath)) {
        const content = fs.readFileSync(promptSetPath, 'utf-8');
        this.currentPromptSet = yaml.load(content) as PromptSet;
        console.log(`[AIManager] Loaded prompt set: ${this.currentPromptSet.name}`);
      } else {
        console.warn(`[AIManager] Prompt set not found: ${promptSetName}`);
      }
    } catch (error) {
      console.error('[AIManager] Error loading prompts:', error);
    }
  }

  /**
   * Summarize transcript using fast model
   */
  async summarizeTranscript(transcript: string, sourceName: string): Promise<string> {
    if (transcript.length <= 1000) {
      return transcript;
    }

    console.log(`[AIManager] ═══ SUMMARIZATION STARTING for ${sourceName} ═══`);
    console.log(`[AIManager]     Transcript length: ${transcript.length} chars`);
    console.log(`[AIManager]     Using model: ${this.summaryModel}`);

    try {
      let result: string;

      // Handle large transcripts with chunking
      if (transcript.length > 8000) {
        result = await this.summarizeLargeTranscript(transcript, sourceName);
      } else {
        result = await this.summarizeSingleChunk(transcript, sourceName);
      }

      console.log(`[AIManager] ═══ SUMMARIZATION COMPLETE for ${sourceName} ═══`);
      console.log(`[AIManager]     Summary length: ${result.length} chars`);

      return result;
    } catch (error) {
      console.error('[AIManager] ═══ SUMMARIZATION FAILED ═══:', error);
      return this.fallbackTruncate(transcript);
    }
  }

  /**
   * Summarize large transcript in chunks
   */
  private async summarizeLargeTranscript(transcript: string, sourceName: string): Promise<string> {
    const chunkSize = 8000;
    const chunks: string[] = [];

    // Split into chunks
    for (let i = 0; i < transcript.length; i += chunkSize) {
      chunks.push(transcript.slice(i, i + chunkSize));
    }

    console.log(`[AIManager] Processing ${chunks.length} chunks...`);

    const summaries: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      try {
        console.log(`[AIManager] Chunk ${i + 1}/${chunks.length}`);

        const prompt = this.createSummarizationPrompt(chunks[i], `${sourceName}_chunk_${i}`);
        const response = await this.makeRequest(prompt, this.summaryModel, 120);

        if (response && response.trim().length > 10) {
          summaries.push(response.trim());
        } else {
          summaries.push(this.fallbackTruncate(chunks[i]));
        }
      } catch (error) {
        console.error(`[AIManager] Error processing chunk ${i}:`, error);
        summaries.push(this.fallbackTruncate(chunks[i]));
      }
    }

    return summaries.join('\n\n');
  }

  /**
   * Summarize single chunk
   */
  private async summarizeSingleChunk(transcript: string, sourceName: string): Promise<string> {
    try {
      const prompt = this.createSummarizationPrompt(transcript, sourceName);
      const response = await this.makeRequest(prompt, this.summaryModel, 120);

      if (response && response.trim().length > 10) {
        return response.trim();
      } else {
        return this.fallbackTruncate(transcript);
      }
    } catch (error) {
      console.error('[AIManager] Error in single chunk summarization:', error);
      return this.fallbackTruncate(transcript);
    }
  }

  /**
   * Create summarization prompt
   */
  private createSummarizationPrompt(text: string, sourceName: string): string {
    const systemPrompt = this.summarizationPrompts?.youtube?.system ||
      'You are a helpful assistant that summarizes video transcripts.';

    const userPrompt = (this.summarizationPrompts?.youtube?.user || 'Summarize this transcript:\n\n{transcript}')
      .replace('{transcript}', text);

    // Add source filename context if available
    const sourceContext = sourceName ? `\n\nSource: ${sourceName}\n(Use the source filename for context about names, topics, and proper nouns)` : '';

    return `${systemPrompt}\n\n${userPrompt}${sourceContext}`;
  }

  /**
   * Fallback truncation for when summarization fails
   */
  private fallbackTruncate(text: string): string {
    const truncated = text.slice(0, 4000);
    console.log(`[AIManager] Using fallback truncation (${truncated.length} chars)`);
    return truncated;
  }

  /**
   * Generate metadata from transcript/summary
   */
  async generateMetadata(
    content: string,
    sourceName?: string,
    compilationInfo?: { sourceCount: number; contentTypes: string[] }
  ): Promise<MetadataResult> {
    if (!this.currentPromptSet) {
      throw new Error('No prompt set loaded');
    }

    console.log(`[AIManager] === METADATA GENERATION STARTING for ${sourceName || 'unknown'} ===`);
    console.log(`[AIManager]     Content length: ${content.length} chars`);
    console.log(`[AIManager]     Using model: ${this.metadataModel}`);
    console.log(`[AIManager]     Compilation: ${compilationInfo ? `yes (${compilationInfo.sourceCount} items)` : 'no'}`);

    const prompt = this.createMetadataPrompt(content, sourceName, compilationInfo);

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.makeRequest(prompt, this.metadataModel, 300);

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
        // Parse the response
        const metadata = this.parseMetadataResponse(response);

        console.log(`[AIManager] === METADATA GENERATION COMPLETE for ${sourceName || 'unknown'} ===`);
        console.log(`[AIManager]     Generated ${Object.keys(metadata).length} fields`);

        return this.addDescriptionLinks(metadata);
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
   * Create metadata generation prompt
   */
  private createMetadataPrompt(
    content: string,
    sourceName?: string,
    compilationInfo?: { sourceCount: number; contentTypes: string[] }
  ): string {
    if (!this.currentPromptSet) {
      throw new Error('No prompt set loaded');
    }

    // Use centralized system prompt
    const systemPrompt = SYSTEM_PROMPTS.JSON_SYSTEM;

    // Hardcoded compilation instructions (works with any prompt set)
    let compilationContext = '';
    if (compilationInfo) {
      const contentTypeStr = compilationInfo.contentTypes.join(', ');
      compilationContext = formatPrompt(SYSTEM_PROMPTS.COMPILATION_CONTEXT, {
        sourceCount: compilationInfo.sourceCount,
        contentTypes: contentTypeStr,
      });
    }

    // Replace {subject} placeholder with actual content
    // Add source filename context if available
    const sourceContext = sourceName ? `\n\nSource: ${sourceName}\n(Use the source filename for context about names, topics, and proper nouns - it may contain correctly spelled names or important keywords)` : '';
    const subject = `${compilationContext}${sourceContext}\n\n${content}`;

    const editorialPrompt = this.currentPromptSet.editorial_prompt.replace('{subject}', subject);

    // Instructions prompt defines what to generate
    let instructionsPrompt = this.currentPromptSet.instructions_prompt;

    // In compilation mode, append an override block that REPLACES the TITLES,
    // DESCRIPTION, and TAGS rules to reflect all items. Appending (rather than
    // regex-surgery on the user-editable YAML) is robust to any prompt-set format.
    if (compilationInfo) {
      const overrideBlock = formatPrompt(SYSTEM_PROMPTS.COMPILATION_INSTRUCTIONS_OVERRIDE, {
        sourceCount: compilationInfo.sourceCount,
      });
      instructionsPrompt = `${instructionsPrompt}\n${overrideBlock}`;
    }

    return `${systemPrompt}\n\n${editorialPrompt}\n\n${instructionsPrompt}`;
  }

  /**
   * Parse metadata response from AI
   */
  private parseMetadataResponse(response: string): MetadataResult {
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
  private normalizeMetadataKeys(raw: any): MetadataResult {
    const result: MetadataResult = {};

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

      switch (def.kind) {
        case 'string': {
          target[def.key] = pick([def.key, ...def.aliases]);
          break;
        }
        case 'stringArray': {
          const arr = toStrArray(pick([def.key, ...def.aliases]));
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

    return result;
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
    timeout: number = 600
  ): Promise<string | null> {
    const requestId = Math.random().toString(36).substring(7);
    const timestamp = new Date().toISOString();

    console.log(`[AIManager] ▶ AI REQUEST START [${requestId}] at ${timestamp}`);
    console.log(`[AIManager]   Model: ${model}`);
    console.log(`[AIManager]   Prompt length: ${prompt.length} chars`);

    try {
      let result: string | null = null;

      // Detect provider from model name - EXPLICIT routing, no fallbacks
      // Model format must be "provider:model" (e.g., "ollama:cogito:14b", "openai:gpt-4o", "claude:claude-3-5-sonnet")
      if (model.startsWith('openai:')) {
        console.log(`[AIManager]   Provider: OpenAI`);
        result = await this.makeOpenAIRequest(prompt, model.replace('openai:', ''));
      } else if (model.startsWith('claude:')) {
        console.log(`[AIManager]   Provider: Claude`);
        result = await this.makeClaudeRequest(prompt, model.replace('claude:', ''));
      } else if (model.startsWith('ollama:')) {
        console.log(`[AIManager]   Provider: Ollama`);
        result = await this.makeOllamaRequest(prompt, model.replace('ollama:', ''), timeout);
      } else {
        // No valid provider prefix - this is a bug, throw error
        throw new Error(`Invalid model format: "${model}". Model must have provider prefix (openai:, claude:, or ollama:)`);
      }

      const endTimestamp = new Date().toISOString();
      console.log(`[AIManager] ■ AI REQUEST END [${requestId}] at ${endTimestamp}`);
      console.log(`[AIManager]   Response length: ${result?.length || 0} chars`);

      return result;
    } catch (error: any) {
      const endTimestamp = new Date().toISOString();
      console.error(`[AIManager] ✖ AI REQUEST FAILED [${requestId}] at ${endTimestamp}:`, error);
      // Re-throw with context so the caller gets a useful error message
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

    // Truncate prompt if it exceeds the context window capacity
    let effectivePrompt = prompt;
    if (prompt.length > AIManagerService.OLLAMA_MAX_PROMPT_CHARS) {
      log.warn(`[AIManager] Prompt too long (${prompt.length} chars, max ${AIManagerService.OLLAMA_MAX_PROMPT_CHARS}), truncating`);
      effectivePrompt = prompt.substring(0, AIManagerService.OLLAMA_MAX_PROMPT_CHARS);
    }

    try {
      const response = await this.ollamaClient.post(
        '/api/generate',
        {
          model,
          prompt: effectivePrompt,
          stream: false,
          options: {
            temperature: 0.7,
            num_predict: AIManagerService.OLLAMA_NUM_PREDICT,
            num_ctx: AIManagerService.OLLAMA_NUM_CTX,
          },
        },
        { timeout: timeout * 1000 }
      );

      return response.data.response;
    } catch (error: any) {
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
      const response = await this.openaiClient.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.7,
      });

      const content = response.choices[0]?.message?.content;
      console.log(`[AIManager] OpenAI response received, content length: ${content?.length || 0}`);

      if (!content) {
        console.error('[AIManager] OpenAI returned empty content. Response:', JSON.stringify(response, null, 2));
      }

      return content || null;
    } catch (error: any) {
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
  private async makeClaudeRequest(prompt: string, model: string): Promise<string | null> {
    if (!this.anthropicClient) {
      throw new Error('Claude client not initialized');
    }

    try {
      // Map friendly name to actual API model name
      const actualModel = this.mapClaudeModelName(model);

      const response = await this.anthropicClient.messages.create({
        model: actualModel,
        max_tokens: 16000,
        system: 'You are a helpful assistant. When asked to return JSON, output ONLY valid JSON with no markdown, no commentary, and no extra text. Start your response with { and end with }.',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      });

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
