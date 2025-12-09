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
import { SYSTEM_PROMPTS, formatPrompt } from './system-prompts';

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

      // Detect which providers are needed based on models
      const needsOllama = !this.summaryModel.startsWith('gpt-') &&
                          !this.summaryModel.startsWith('claude-') &&
                          !this.summaryModel.startsWith('openai:') ||
                          !this.metadataModel.startsWith('gpt-') &&
                          !this.metadataModel.startsWith('claude-') &&
                          !this.metadataModel.startsWith('openai:');

      const needsOpenAI = this.summaryModel.startsWith('gpt-') ||
                          this.summaryModel.startsWith('openai:') ||
                          this.metadataModel.startsWith('gpt-') ||
                          this.metadataModel.startsWith('openai:');

      const needsClaude = this.summaryModel.startsWith('claude-') ||
                          this.metadataModel.startsWith('claude-');

      // Initialize all needed providers
      let anySuccess = false;

      if (needsOllama) {
        const success = await this.initializeOllama();
        if (success) anySuccess = true;
      }

      if (needsOpenAI) {
        const success = await this.initializeOpenAI();
        if (success) anySuccess = true;
      }

      if (needsClaude) {
        const success = await this.initializeClaude();
        if (success) anySuccess = true;
      }

      return anySuccess;
    } catch (error) {
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

      this.ollamaClient = axios.create({
        baseURL: host,
        headers: { 'Content-Type': 'application/json' },
        timeout: 300000, // 5 minutes
      });

      // Test connection
      const response = await this.ollamaClient.get('/api/tags');

      console.log('[AIManager] Ollama server connected');
      return true;
    } catch (error) {
      console.error('[AIManager] Cannot connect to Ollama:', error);
      return false;
    }
  }

  /**
   * Initialize OpenAI provider
   */
  private async initializeOpenAI(): Promise<boolean> {
    try {
      if (!this.config.apiKey) {
        console.error('[AIManager] OpenAI API key required');
        return false;
      }

      this.openaiClient = new OpenAI({
        apiKey: this.config.apiKey,
      });

      // Test with a simple request
      await this.openaiClient.chat.completions.create({
        model: this.summaryModel,
        messages: [{ role: 'user', content: 'Test' }],
        max_tokens: 5,
      });

      console.log('[AIManager] OpenAI connected successfully');
      return true;
    } catch (error) {
      console.error('[AIManager] Cannot connect to OpenAI:', error);
      return false;
    }
  }

  /**
   * Initialize Claude (Anthropic) provider
   */
  private async initializeClaude(): Promise<boolean> {
    try {
      if (!this.config.apiKey) {
        console.error('[AIManager] Anthropic API key required');
        return false;
      }

      this.anthropicClient = new Anthropic({
        apiKey: this.config.apiKey,
      });

      // Test with a simple request
      // Use metadataModel since that's the Claude model (summaryModel might be from a different provider)
      await this.anthropicClient.messages.create({
        model: this.metadataModel,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Test' }],
      });

      console.log('[AIManager] Claude (Anthropic) connected successfully');
      return true;
    } catch (error) {
      console.error('[AIManager] Cannot connect to Claude:', error);
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
    generateChapters = false,
    compilationInfo?: { sourceCount: number; contentTypes: string[] }
  ): Promise<MetadataResult> {
    if (!this.currentPromptSet) {
      throw new Error('No prompt set loaded');
    }

    console.log(`[AIManager] === METADATA GENERATION STARTING for ${sourceName || 'unknown'} ===`);
    console.log(`[AIManager]     Content length: ${content.length} chars`);
    console.log(`[AIManager]     Using model: ${this.metadataModel}`);
    console.log(`[AIManager]     Generate chapters: ${generateChapters}`);
    console.log(`[AIManager]     Compilation: ${compilationInfo ? `yes (${compilationInfo.sourceCount} items)` : 'no'}`);

    const prompt = this.createMetadataPrompt(content, sourceName, generateChapters, compilationInfo);
    const response = await this.makeRequest(prompt, this.metadataModel, 300);

    if (!response) {
      console.error('[AIManager] === METADATA GENERATION FAILED ===');
      console.error('[AIManager]     No response from AI');
      throw new Error('No response from AI');
    }

    // Parse the response
    const metadata = this.parseMetadataResponse(response);

    console.log(`[AIManager] === METADATA GENERATION COMPLETE for ${sourceName || 'unknown'} ===`);
    console.log(`[AIManager]     Generated ${Object.keys(metadata).length} fields`);

    // Add description links from prompt set
    return this.addDescriptionLinks(metadata);
  }

  /**
   * Create metadata generation prompt
   */
  private createMetadataPrompt(
    content: string,
    sourceName?: string,
    generateChapters = false,
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

    // Inject chapters instructions if requested
    if (generateChapters) {
      instructionsPrompt += SYSTEM_PROMPTS.CHAPTERS_INSTRUCTIONS;
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
        console.error('[AIManager] No JSON found in response');
        throw new Error('No JSON found in response');
      }

      let jsonStr = jsonMatch[0];

      // Step 3: Try parsing
      try {
        // First attempt: try parsing as-is
        return JSON.parse(jsonStr);
      } catch (firstError) {
        console.log('[AIManager] Initial parse failed, trying to clean JSON...');
        console.log('[AIManager] Parse error was:', firstError);
        console.log('[AIManager] JSON preview:', jsonStr.substring(0, 500));

        // If parsing fails, it's likely due to unescaped newlines in strings
        // This is a last-resort fallback - log and throw
        console.error('[AIManager] Cleaned JSON:', jsonStr.substring(0, 1000));
        console.error('[AIManager] Parse error:', firstError);
        throw new Error('Failed to parse metadata response');
      }
    } catch (error) {
      console.error('[AIManager] Error parsing metadata response:', error);
      console.error('[AIManager] Response preview:', response.substring(0, 1000));
      throw new Error('Failed to parse metadata response');
    }
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

      // Detect provider from model name for multi-provider support
      if (model.startsWith('gpt-') || model.startsWith('openai:')) {
        result = await this.makeOpenAIRequest(prompt, model);
      } else if (model.startsWith('claude-')) {
        result = await this.makeClaudeRequest(prompt, model);
      } else {
        // Assume Ollama for all other models (local models)
        result = await this.makeOllamaRequest(prompt, model, timeout);
      }

      const endTimestamp = new Date().toISOString();
      console.log(`[AIManager] ■ AI REQUEST END [${requestId}] at ${endTimestamp}`);
      console.log(`[AIManager]   Response length: ${result?.length || 0} chars`);

      return result;
    } catch (error) {
      const endTimestamp = new Date().toISOString();
      console.error(`[AIManager] ✖ AI REQUEST FAILED [${requestId}] at ${endTimestamp}:`, error);
      return null;
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

    try {
      const response = await this.ollamaClient.post(
        '/api/generate',
        {
          model,
          prompt,
          stream: false,
          options: {
            temperature: 0.7,
            num_predict: 2000,
          },
        },
        { timeout: timeout * 1000 }
      );

      return response.data.response;
    } catch (error) {
      console.error('[AIManager] Ollama request failed:', error);
      return null;
    }
  }

  /**
   * Make request to OpenAI
   */
  private async makeOpenAIRequest(prompt: string, model: string): Promise<string | null> {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not initialized');
    }

    try {
      const response = await this.openaiClient.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.7,
      });

      return response.choices[0]?.message?.content || null;
    } catch (error) {
      console.error('[AIManager] OpenAI request failed:', error);
      return null;
    }
  }

  /**
   * Map friendly Claude model names to actual API model names
   */
  private mapClaudeModelName(friendlyName: string): string {
    const modelMap: { [key: string]: string } = {
      'claude-sonnet-4': 'claude-sonnet-4-20250514',
      'claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku': 'claude-3-5-haiku-20241022',
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
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
      });

      // Log why Claude stopped
      console.log('[AIManager] Claude stop_reason:', response.stop_reason);
      console.log('[AIManager] Claude usage:', response.usage);

      const textBlock = response.content.find((block) => block.type === 'text');
      return textBlock?.type === 'text' ? textBlock.text : null;
    } catch (error) {
      console.error('[AIManager] Claude request failed:', error);
      return null;
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
