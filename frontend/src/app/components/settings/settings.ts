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
  // Single model for all AI tasks (summarization + metadata generation)
  metadataModel = signal('ollama:cogito:70b');

  // Provider availability
  availableOllamaModels = signal<string[]>([]);
  availableClaudeModels = signal<Array<{ id: string; name: string }>>([]);
  availableOpenAIModels = signal<Array<{ id: string; name: string }>>([]);
  hasOpenAIKey = signal(false);
  hasClaudeKey = signal(false);
  isLoadingModels = signal(false);

  // Save notification
  showSaveNotification = signal(false);
  saveNotificationTimeout: any;

  // AI Setup Wizard
  showWizard = signal(false);

  // Output settings
  outputDirectory = signal('~/Documents/LaunchPad Output');

  // Prompt set selection
  selectedPromptSet = signal('sample-youtube');
  availablePromptSets = signal<Array<{id: string, name: string, platform: string}>>([]);

  // Model options for dropdown - filtered by configured providers
  modelOptions = computed<ModelOption[]>(() => {
    const options: ModelOption[] = [];

    // Add OpenAI models fetched from API
    const openaiModels = this.availableOpenAIModels();
    if (openaiModels.length > 0) {
      openaiModels.forEach(model => {
        options.push({
          value: `openai:${model.id}`,
          label: model.name,
          provider: 'cloud',
          icon: 'cloud',
          needsApiKey: true
        });
      });
    }

    // Add Claude models fetched from API
    const claudeModels = this.availableClaudeModels();
    if (claudeModels.length > 0) {
      claudeModels.forEach(model => {
        options.push({
          value: `claude:${model.id}`,
          label: model.name,
          provider: 'cloud',
          icon: 'cloud',
          needsApiKey: true
        });
      });
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

      if (settings.outputDirectory) this.outputDirectory.set(settings.outputDirectory);
      if (settings.promptSet) this.selectedPromptSet.set(settings.promptSet);

      // Load available prompt sets
      await this.loadPromptSets();

      // Check which AI providers are configured and fetch available models from APIs
      await this.checkProviderAvailability();

      // Now load AI model (after we have the available models)
      let savedModel = '';
      if (settings.metadataProvider && settings.metadataModel) {
        savedModel = `${settings.metadataProvider}:${settings.metadataModel}`;
      } else if (settings.aiProvider && settings.ollamaModel) {
        // Use old settings format if new format not available
        savedModel = `${settings.aiProvider}:${settings.ollamaModel}`;
      }

      if (savedModel) {
        // Check if the saved model is in our available options
        const availableValues = this.modelOptions().map(o => o.value);
        if (availableValues.includes(savedModel)) {
          this.metadataModel.set(savedModel);
        } else if (availableValues.length > 0) {
          // Model not available (might be outdated), default to first available
          console.warn('Saved model not available:', savedModel, '- defaulting to:', availableValues[0]);
          this.metadataModel.set(availableValues[0]);
        }
      } else if (this.modelOptions().length > 0) {
        // No saved model, default to first available
        this.metadataModel.set(this.modelOptions()[0].value);
      }
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
    this.isLoadingModels.set(true);
    try {
      // Check API keys first
      const apiKeys = await this.electron.getApiKeys();
      this.hasOpenAIKey.set(!!apiKeys.openaiApiKey);
      this.hasClaudeKey.set(!!apiKeys.claudeApiKey);

      // Fetch all models in parallel
      const [ollamaResult, claudeResult, openaiResult] = await Promise.all([
        this.electron.checkOllama(),
        apiKeys.claudeApiKey ? this.electron.getAvailableModels('claude') : Promise.resolve({ success: false, models: [] as Array<{ id: string; name: string }>, error: undefined }),
        apiKeys.openaiApiKey ? this.electron.getAvailableModels('openai') : Promise.resolve({ success: false, models: [] as Array<{ id: string; name: string }>, error: undefined })
      ]);

      // Set Ollama models
      if (ollamaResult.available && ollamaResult.models.length > 0) {
        this.availableOllamaModels.set(ollamaResult.models);
      }

      // Set Claude models (fetched directly from API)
      if (claudeResult.success && claudeResult.models.length > 0) {
        this.availableClaudeModels.set(claudeResult.models);
        console.log('Loaded Claude models from API:', claudeResult.models);
      } else if (apiKeys.claudeApiKey && 'error' in claudeResult) {
        console.warn('Failed to fetch Claude models from API:', claudeResult.error);
      }

      // Set OpenAI models (fetched directly from API)
      if (openaiResult.success && openaiResult.models.length > 0) {
        this.availableOpenAIModels.set(openaiResult.models);
        console.log('Loaded OpenAI models from API:', openaiResult.models);
      } else if (apiKeys.openaiApiKey && 'error' in openaiResult) {
        console.warn('Failed to fetch OpenAI models from API:', openaiResult.error);
      }
    } catch (error) {
      console.log('Error checking provider availability:', error);
    } finally {
      this.isLoadingModels.set(false);
    }
  }

  async selectOutputDirectory() {
    const result = await this.electron.selectOutputDirectory();
    if (result.success && result.directory) {
      this.outputDirectory.set(result.directory);
    }
  }

  async saveSettings() {
    // Parse the single AI model (used for both summarization and metadata generation)
    const [provider, ...modelParts] = this.metadataModel().split(':');
    const model = modelParts.join(':');

    const settings = {
      // Use same model for both summarization and metadata
      summarizationProvider: provider,
      summarizationModel: model,
      metadataProvider: provider,
      metadataModel: model,
      // Backward compatibility
      aiProvider: provider,
      ollamaModel: model,
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
    // Reload settings and refresh available models from APIs
    try {
      const settings = await this.electron.getSettings();

      // Refresh provider availability and fetch models from APIs
      await this.checkProviderAvailability();

      // Load AI model (if valid)
      if (settings.metadataProvider && settings.metadataModel) {
        const modelValue = `${settings.metadataProvider}:${settings.metadataModel}`;
        // Check if the saved model is in our available options
        const availableValues = this.modelOptions().map(o => o.value);
        if (availableValues.includes(modelValue)) {
          this.metadataModel.set(modelValue);
        } else {
          // Model not available, select first available model
          if (availableValues.length > 0) {
            this.metadataModel.set(availableValues[0]);
            console.log('Previously selected model not available, defaulting to:', availableValues[0]);
          }
        }
      }

      this.notificationService.success('AI Setup Complete', 'Your AI configuration has been saved. Please select a model from the dropdown.', false);
    } catch (error) {
      this.notificationService.error('Settings Error', 'Failed to reload settings: ' + (error as Error).message, false);
    }
  }
}