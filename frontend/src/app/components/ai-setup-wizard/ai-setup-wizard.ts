import { Component, Output, EventEmitter, signal, ChangeDetectionStrategy, OnInit, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AiSetupService, AIAvailability } from '../../services/ai-setup.service';
import { ElectronService } from '../../services/electron';

export type WizardStep = 'welcome' | 'ollama' | 'claude' | 'openai' | 'done';

export interface RecommendedModel {
  name: string;
  size: string;
  ramRequirement: string;
  description: string;
  pullCommand: string;
  recommended?: boolean;
}

@Component({
  selector: 'app-ai-setup-wizard',
  imports: [CommonModule, FormsModule],
  templateUrl: './ai-setup-wizard.html',
  styleUrl: './ai-setup-wizard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AiSetupWizard implements OnInit {
  @Output() closed = new EventEmitter<void>();
  @Output() completed = new EventEmitter<void>();

  currentStep = signal<WizardStep>('welcome');

  // Form inputs
  claudeApiKey = signal('');
  openaiApiKey = signal('');
  ollamaHost = signal('http://localhost:11434');

  // Loading states
  isCheckingOllama = signal(false);
  isSavingKeys = signal(false);

  // Availability status
  ollamaAvailable = signal(false);
  ollamaModels = signal<string[]>([]);
  claudeKeySet = signal(false);
  openaiKeySet = signal(false);

  // Platform detection
  platform = signal('macOS'); // Will be set in ngOnInit

  // Recommended models for ContentStudio (summarization focus)
  recommendedModels: RecommendedModel[] = [
    {
      name: 'phi-3.5:3.8b',
      size: '2.2 GB',
      ramRequirement: 'Requires 4GB+ RAM',
      description: 'Best for summarization. Fast, lightweight, and efficient.',
      pullCommand: 'ollama pull phi-3.5:3.8b',
      recommended: true
    },
    {
      name: 'qwen2.5:7b',
      size: '4.7 GB',
      ramRequirement: 'Requires 8GB+ RAM',
      description: 'Great all-around model. Good for both summarization and metadata.',
      pullCommand: 'ollama pull qwen2.5:7b'
    },
    {
      name: 'llama3.1:70b',
      size: '40 GB',
      ramRequirement: 'Requires 64GB+ RAM',
      description: 'Highest quality for metadata generation. Very powerful.',
      pullCommand: 'ollama pull llama3.1:70b'
    }
  ];

  constructor(
    private aiSetupService: AiSetupService,
    private electronService: ElectronService
  ) {
    // Auto-check Ollama when entering the ollama step
    effect(() => {
      if (this.currentStep() === 'ollama' && !this.isCheckingOllama()) {
        // Delay slightly to allow UI to render first
        setTimeout(() => this.autoCheckOllama(), 300);
      }
    });
  }

  async ngOnInit() {
    // Set platform
    this.platform.set(this.detectPlatform());

    // Load existing Ollama host from settings
    try {
      const settings = await this.electronService.getSettings();
      if (settings.ollamaHost) {
        this.ollamaHost.set(settings.ollamaHost);
      }
    } catch (error) {
      console.error('Error loading settings:', error);
    }

    // Check initial AI availability
    await this.refreshAvailability();
  }

  private async refreshAvailability() {
    const availability = await this.aiSetupService.checkAIAvailability();
    this.ollamaAvailable.set(availability.hasOllama);
    this.ollamaModels.set(availability.ollamaModels);
    this.claudeKeySet.set(availability.hasClaudeKey);
    this.openaiKeySet.set(availability.hasOpenAIKey);
  }

  private detectPlatform(): string {
    const platform = this.electronService.getPlatform();
    if (platform === 'darwin') return 'macOS';
    if (platform === 'win32') return 'Windows';
    return 'Linux';
  }

  getInstallInstructions(): string[] {
    const platform = this.platform();
    if (platform === 'macOS') {
      return [
        'Download Ollama from ollama.com',
        'Open the downloaded .dmg file',
        'Drag Ollama to Applications',
        'Open Ollama from Applications',
        'Click "Allow" if prompted'
      ];
    } else if (platform === 'Windows') {
      return [
        'Download Ollama from ollama.com',
        'Run the installer (.exe)',
        'Follow the installation prompts',
        'Ollama will start automatically'
      ];
    } else {
      return [
        'Open Terminal',
        'Run: curl -fsSL https://ollama.com/install.sh | sh',
        'Start Ollama: ollama serve'
      ];
    }
  }

  selectProvider(provider: 'ollama' | 'claude' | 'openai') {
    this.currentStep.set(provider);
  }

  goToStep(step: WizardStep) {
    this.currentStep.set(step);
  }

  goBack() {
    this.currentStep.set('welcome');
  }

  async openOllamaWebsite() {
    const url = 'https://ollama.com/download';
    await this.electronService.openExternal?.(url);
  }

  async openClaudeWebsite() {
    const url = 'https://console.anthropic.com';
    await this.electronService.openExternal?.(url);
  }

  async openOpenAIWebsite() {
    const url = 'https://platform.openai.com/api-keys';
    await this.electronService.openExternal?.(url);
  }

  async autoCheckOllama() {
    // Silently check Ollama status on step load
    try {
      await this.saveOllamaHost();
      await this.refreshAvailability();
    } catch (error) {
      console.error('Error auto-checking Ollama:', error);
    }
  }

  async checkOllama() {
    this.isCheckingOllama.set(true);

    try {
      // Save Ollama host to settings
      await this.saveOllamaHost();

      // Check availability
      await this.refreshAvailability();

      // If Ollama is ready with models, go to done
      if (this.ollamaAvailable() && this.ollamaModels().length > 0) {
        this.currentStep.set('done');
      }
    } catch (error) {
      console.error('Error checking Ollama:', error);
    } finally {
      this.isCheckingOllama.set(false);
    }
  }

  async saveOllamaHost() {
    try {
      // Save Ollama host to settings via Electron
      const settings = await this.electronService.getSettings();
      await this.electronService.updateSettings({
        ...settings,
        ollamaHost: this.ollamaHost()
      });
    } catch (error) {
      console.error('Error saving Ollama host:', error);
    }
  }

  copyCommand(command: string) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(command);
      // Could show a toast notification here
    }
  }

  async saveClaudeKey() {
    if (!this.claudeApiKey()) return;

    this.isSavingKeys.set(true);

    try {
      const result = await this.aiSetupService.saveClaudeKey(this.claudeApiKey());

      if (result.success) {
        await this.refreshAvailability();
        this.currentStep.set('done');
      } else {
        alert(`Failed to save API key: ${result.error || 'Unknown error'}`);
      }
    } catch (error: any) {
      console.error('Error saving Claude key:', error);
      const errorMessage = error?.message || 'Unknown error';
      alert(`Failed to save API key: ${errorMessage}`);
    } finally {
      this.isSavingKeys.set(false);
    }
  }

  async saveOpenAIKey() {
    if (!this.openaiApiKey()) return;

    this.isSavingKeys.set(true);

    try {
      const result = await this.aiSetupService.saveOpenAIKey(this.openaiApiKey());

      if (result.success) {
        await this.refreshAvailability();
        this.currentStep.set('done');
      } else {
        alert(`Failed to save API key: ${result.error || 'Unknown error'}`);
      }
    } catch (error: any) {
      console.error('Error saving OpenAI key:', error);
      const errorMessage = error?.message || 'Unknown error';
      alert(`Failed to save API key: ${errorMessage}`);
    } finally {
      this.isSavingKeys.set(false);
    }
  }

  skipSetup() {
    this.closed.emit();
  }

  complete() {
    this.completed.emit();
  }

  hasAnyProvider(): boolean {
    return this.ollamaAvailable() || this.claudeKeySet() || this.openaiKeySet();
  }
}
