import { Injectable, signal } from '@angular/core';
import { ElectronService } from './electron';

export interface AIAvailability {
  hasOllama: boolean;
  hasClaudeKey: boolean;
  hasOpenAIKey: boolean;
  ollamaModels: string[];
  isChecking: boolean;
  lastChecked?: Date;
}

export interface AISetupStatus {
  isReady: boolean;
  needsSetup: boolean;
  availableProviders: ('ollama' | 'claude' | 'openai')[];
  message?: string;
}

export interface ModelConfig {
  provider: 'ollama' | 'claude' | 'openai';
  model: string;
  apiKey?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AiSetupService {
  // Reactive state
  availability = signal<AIAvailability>({
    hasOllama: false,
    hasClaudeKey: false,
    hasOpenAIKey: false,
    ollamaModels: [],
    isChecking: false
  });

  constructor(private electron: ElectronService) {}

  /**
   * Check all AI providers and update availability status
   */
  async checkAIAvailability(): Promise<AIAvailability> {
    this.availability.update(v => ({ ...v, isChecking: true }));

    try {
      // Check Ollama
      const ollamaResult = await this.electron.checkOllama();

      // Check API keys
      const keysResult = await this.electron.getApiKeys();

      const newAvailability: AIAvailability = {
        hasOllama: ollamaResult.available || false,
        ollamaModels: ollamaResult.models || [],
        hasClaudeKey: !!keysResult.claudeApiKey,
        hasOpenAIKey: !!keysResult.openaiApiKey,
        isChecking: false,
        lastChecked: new Date()
      };

      this.availability.set(newAvailability);
      return newAvailability;
    } catch (error) {
      console.error('Error checking AI availability:', error);
      this.availability.update(v => ({
        ...v,
        isChecking: false,
        lastChecked: new Date()
      }));
      return this.availability();
    }
  }

  /**
   * Get setup status based on current availability
   */
  getSetupStatus(): AISetupStatus {
    const avail = this.availability();
    const providers: ('ollama' | 'claude' | 'openai')[] = [];

    if (avail.hasOllama && avail.ollamaModels.length > 0) {
      providers.push('ollama');
    }
    if (avail.hasClaudeKey) {
      providers.push('claude');
    }
    if (avail.hasOpenAIKey) {
      providers.push('openai');
    }

    const isReady = providers.length > 0;
    let message = '';

    if (!isReady) {
      message = 'No AI providers configured';
    } else if (providers.includes('ollama')) {
      message = `Ollama ready with ${avail.ollamaModels.length} model(s)`;
    } else {
      message = `Ready with ${providers.join(', ')}`;
    }

    return {
      isReady,
      needsSetup: !isReady,
      availableProviders: providers,
      message
    };
  }

  /**
   * Save Claude API key
   */
  async saveClaudeKey(apiKey: string): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await this.electron.saveApiKey('claude', apiKey.trim());
      if (result.success) {
        await this.checkAIAvailability(); // Refresh availability
      }
      return result;
    } catch (error) {
      console.error('Error saving Claude key:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Save OpenAI API key
   */
  async saveOpenAIKey(apiKey: string): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await this.electron.saveApiKey('openai', apiKey.trim());
      if (result.success) {
        await this.checkAIAvailability(); // Refresh availability
      }
      return result;
    } catch (error) {
      console.error('Error saving OpenAI key:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Get platform-specific Ollama installation instructions
   */
  getOllamaInstallInstructions(): { platform: string; instructions: string; downloadUrl: string } {
    const platform = this.electron.getPlatform();

    const instructions: Record<string, any> = {
      darwin: {
        platform: 'macOS',
        instructions: '1. Download Ollama for macOS\n2. Open the DMG file\n3. Drag Ollama to Applications\n4. Open Ollama from Applications\n5. Run: ollama pull phi-3.5:3.8b',
        downloadUrl: 'https://ollama.com/download/mac'
      },
      win32: {
        platform: 'Windows',
        instructions: '1. Download Ollama for Windows\n2. Run the installer\n3. Follow the setup wizard\n4. Open Command Prompt\n5. Run: ollama pull phi-3.5:3.8b',
        downloadUrl: 'https://ollama.com/download/windows'
      },
      linux: {
        platform: 'Linux',
        instructions: '1. Open terminal\n2. Run: curl -fsSL https://ollama.com/install.sh | sh\n3. Wait for installation\n4. Run: ollama pull phi-3.5:3.8b',
        downloadUrl: 'https://ollama.com/download/linux'
      }
    };

    return instructions[platform] || instructions.linux;
  }

  /**
   * Get recommended models for different use cases
   */
  getRecommendedModels() {
    return {
      summarization: [
        { name: 'phi-3.5:3.8b', size: '2.2 GB', description: 'Fast, lightweight, recommended for summarization' },
        { name: 'llama3.2:3b', size: '2.0 GB', description: 'Very fast, good for quick summaries' },
        { name: 'qwen2.5:7b', size: '4.7 GB', description: 'Higher quality, slower' }
      ],
      metadata: [
        { name: 'qwen2.5:14b', size: '9.0 GB', description: 'High quality, best for metadata' },
        { name: 'llama3.1:70b', size: '40 GB', description: 'Excellent quality, requires powerful hardware' },
        { name: 'claude-sonnet-4.5', provider: 'claude', description: 'Excellent quality, API-based, costs ~$0.002/video' },
        { name: 'gpt-4o', provider: 'openai', description: 'High quality, API-based, costs ~$0.005/video' }
      ]
    };
  }
}
