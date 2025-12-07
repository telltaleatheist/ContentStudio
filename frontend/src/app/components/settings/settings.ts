import { Component, signal, OnInit, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../services/electron';
import { NotificationService } from '../../services/notification';
import { AiSetupWizard } from '../ai-setup-wizard/ai-setup-wizard';

interface ModelOption {
  value: string;
  label: string;
  provider: 'cloud' | 'local';
  icon: string;
  needsApiKey?: boolean;
}

@Component({
  selector: 'app-settings',
  imports: [
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    FormsModule,
    AiSetupWizard
  ],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings implements OnInit {
  // Separate model selection for summarization and metadata generation
  summarizationModel = signal('ollama:phi-3.5:3.8b');
  metadataModel = signal('ollama:cogito:70b');

  // Provider availability
  availableOllamaModels = signal<string[]>([]);
  hasOpenAIKey = signal(false);
  hasClaudeKey = signal(false);

  // Save notification
  showSaveNotification = signal(false);
  saveNotificationTimeout: any;

  // AI Setup Wizard
  showWizard = signal(false);

  // Output settings
  outputDirectory = signal('~/Documents/LaunchPad Output');

  // Prompt set selection
  selectedPromptSet = signal('youtube-telltale');
  availablePromptSets = signal<Array<{id: string, name: string, platform: string}>>([]);

  // Model options for dropdown - filtered by configured providers
  modelOptions = computed<ModelOption[]>(() => {
    const options: ModelOption[] = [];

    // Add OpenAI models if API key is configured
    if (this.hasOpenAIKey()) {
      options.push(
        { value: 'openai:gpt-4o', label: 'ChatGPT 4o', provider: 'cloud', icon: 'cloud', needsApiKey: true },
        { value: 'openai:gpt-4-turbo', label: 'ChatGPT 4 Turbo', provider: 'cloud', icon: 'cloud', needsApiKey: true },
        { value: 'openai:gpt-3.5-turbo', label: 'ChatGPT 3.5 Turbo', provider: 'cloud', icon: 'cloud', needsApiKey: true }
      );
    }

    // Add Claude models if API key is configured
    if (this.hasClaudeKey()) {
      options.push(
        { value: 'claude:claude-sonnet-4', label: 'Claude Sonnet 4.5 (Newest)', provider: 'cloud', icon: 'cloud', needsApiKey: true },
        { value: 'claude:claude-3-5-sonnet', label: 'Claude 3.5 Sonnet (Recommended)', provider: 'cloud', icon: 'cloud', needsApiKey: true },
        { value: 'claude:claude-3-5-haiku', label: 'Claude 3.5 Haiku', provider: 'cloud', icon: 'cloud', needsApiKey: true }
      );
    }

    // Add local Ollama models if Ollama is available
    const ollamaModels = this.availableOllamaModels();
    if (ollamaModels.length > 0) {
      ollamaModels.forEach(model => {
        options.push({
          value: `ollama:${model}`,
          label: model,
          provider: 'local',
          icon: 'computer'
        });
      });
    }

    return options;
  });

  constructor(
    private electron: ElectronService,
    private notificationService: NotificationService
  ) {}

  async ngOnInit() {
    // Load current settings from Electron
    try {
      const settings = await this.electron.getSettings();

      // Load summarization model
      if (settings.summarizationProvider && settings.summarizationModel) {
        this.summarizationModel.set(`${settings.summarizationProvider}:${settings.summarizationModel}`);
      } else {
        // Default to small fast model for summarization
        this.summarizationModel.set('ollama:phi-3.5:3.8b');
      }

      // Load metadata generation model (backward compatibility with old settings)
      if (settings.metadataProvider && settings.metadataModel) {
        this.metadataModel.set(`${settings.metadataProvider}:${settings.metadataModel}`);
      } else if (settings.aiProvider && settings.ollamaModel) {
        // Use old settings format if new format not available
        this.metadataModel.set(`${settings.aiProvider}:${settings.ollamaModel}`);
      }

      if (settings.outputDirectory) this.outputDirectory.set(settings.outputDirectory);
      if (settings.promptSet) this.selectedPromptSet.set(settings.promptSet);

      // Load available prompt sets
      await this.loadPromptSets();

      // Check which AI providers are configured
      await this.checkProviderAvailability();
    } catch (error) {
      this.notificationService.error('Settings Error', 'Failed to load settings: ' + (error as Error).message, false);
    }
  }

  async loadPromptSets() {
    try {
      const result = await this.electron.listPromptSets();
      if (result.success && result.promptSets) {
        this.availablePromptSets.set(result.promptSets);
      }
    } catch (error) {
      this.notificationService.error('Prompt Sets Error', 'Failed to load prompt sets: ' + (error as Error).message);
    }
  }

  async checkProviderAvailability() {
    try {
      // Check Ollama
      const ollamaResult = await this.electron.checkOllama();
      if (ollamaResult.available && ollamaResult.models.length > 0) {
        this.availableOllamaModels.set(ollamaResult.models);
      }

      // Check API keys
      const apiKeys = await this.electron.getApiKeys();
      this.hasOpenAIKey.set(!!apiKeys.openaiApiKey);
      this.hasClaudeKey.set(!!apiKeys.claudeApiKey);
    } catch (error) {
      console.log('Error checking provider availability:', error);
    }
  }

  async selectOutputDirectory() {
    const result = await this.electron.selectOutputDirectory();
    if (result.success && result.directory) {
      this.outputDirectory.set(result.directory);
    }
  }

  async saveSettings() {
    // Parse summarization model
    const [summProvider, ...summModelParts] = this.summarizationModel().split(':');
    const summModel = summModelParts.join(':');

    // Parse metadata generation model
    const [metaProvider, ...metaModelParts] = this.metadataModel().split(':');
    const metaModel = metaModelParts.join(':');

    const settings = {
      // New format
      summarizationProvider: summProvider,
      summarizationModel: summModel,
      metadataProvider: metaProvider,
      metadataModel: metaModel,
      // Backward compatibility
      aiProvider: metaProvider,
      ollamaModel: metaModel,
      // Other settings
      outputDirectory: this.outputDirectory(),
      promptSet: this.selectedPromptSet()
    };

    try {
      const result = await this.electron.updateSettings(settings);
      if (result.success) {
        this.notificationService.success('Settings Saved', 'Your settings have been saved successfully', false);
        this.showSaveSuccess();
      } else {
        this.notificationService.error('Save Failed', 'Failed to save settings', false);
      }
    } catch (error) {
      this.notificationService.error('Save Error', 'Error saving settings: ' + (error as Error).message, false);
    }
  }

  private showSaveSuccess() {
    // Clear any existing timeout
    if (this.saveNotificationTimeout) {
      clearTimeout(this.saveNotificationTimeout);
    }

    // Show notification
    this.showSaveNotification.set(true);

    // Hide after 3 seconds
    this.saveNotificationTimeout = setTimeout(() => {
      this.showSaveNotification.set(false);
    }, 3000);
  }

  dismissSaveNotification() {
    if (this.saveNotificationTimeout) {
      clearTimeout(this.saveNotificationTimeout);
    }
    this.showSaveNotification.set(false);
  }

  getModelIcon(option: ModelOption): string {
    return option.icon;
  }

  getModelLabel(option: ModelOption): string {
    return option.label;
  }

  // AI Setup Wizard methods
  openWizard() {
    this.showWizard.set(true);
  }

  closeWizard() {
    this.showWizard.set(false);
  }

  async wizardCompleted() {
    this.showWizard.set(false);
    // Reload settings to pick up new AI configuration
    try {
      const settings = await this.electron.getSettings();

      // Load summarization model
      if (settings.summarizationProvider && settings.summarizationModel) {
        this.summarizationModel.set(`${settings.summarizationProvider}:${settings.summarizationModel}`);
      }

      // Load metadata generation model
      if (settings.metadataProvider && settings.metadataModel) {
        this.metadataModel.set(`${settings.metadataProvider}:${settings.metadataModel}`);
      }

      // Refresh provider availability
      await this.checkProviderAvailability();

      this.notificationService.success('AI Setup Complete', 'Your AI configuration has been saved', false);
    } catch (error) {
      this.notificationService.error('Settings Error', 'Failed to reload settings: ' + (error as Error).message, false);
    }
  }
}