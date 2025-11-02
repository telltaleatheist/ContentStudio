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
    FormsModule
  ],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings implements OnInit {
  // Consolidated model selection (provider:model format)
  selectedModel = signal('ollama:cogito:70b');

  // API Keys
  openaiApiKey = signal('');
  claudeApiKey = signal('');

  // Ollama settings
  ollamaHost = signal('http://localhost:11434');
  availableOllamaModels = signal<string[]>([]);

  // Save notification
  showSaveNotification = signal(false);
  saveNotificationTimeout: any;

  // Output settings
  outputDirectory = signal('~/Documents/LaunchPad Output');

  // Prompt set selection
  selectedPromptSet = signal('youtube-telltale');
  availablePromptSets = signal<Array<{id: string, name: string, platform: string}>>([]);

  // Model options for dropdown
  modelOptions = computed<ModelOption[]>(() => {
    const options: ModelOption[] = [
      // Cloud models at top
      { value: 'openai:gpt-4o', label: 'ChatGPT 4o', provider: 'cloud', icon: 'cloud', needsApiKey: true },
      { value: 'openai:gpt-4-turbo', label: 'ChatGPT 4 Turbo', provider: 'cloud', icon: 'cloud', needsApiKey: true },
      { value: 'openai:gpt-3.5-turbo', label: 'ChatGPT 3.5 Turbo', provider: 'cloud', icon: 'cloud', needsApiKey: true },
      { value: 'claude:claude-3-5-sonnet', label: 'Claude 3.5 Sonnet (Recommended)', provider: 'cloud', icon: 'cloud', needsApiKey: true },
      { value: 'claude:claude-3-5-haiku', label: 'Claude 3.5 Haiku', provider: 'cloud', icon: 'cloud', needsApiKey: true },
      { value: 'claude:claude-3-opus', label: 'Claude 3 Opus (Legacy)', provider: 'cloud', icon: 'cloud', needsApiKey: true },
      { value: 'claude:claude-3-sonnet', label: 'Claude 3 Sonnet (Legacy)', provider: 'cloud', icon: 'cloud', needsApiKey: true },
      { value: 'claude:claude-3-haiku', label: 'Claude 3 Haiku (Legacy)', provider: 'cloud', icon: 'cloud', needsApiKey: true },
    ];

    // Add local Ollama models at bottom
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
    } else {
      // Default Ollama models if none detected
      options.push(
        { value: 'ollama:cogito:70b', label: 'cogito:70b', provider: 'local', icon: 'computer' },
        { value: 'ollama:llama3.1:70b', label: 'llama3.1:70b', provider: 'local', icon: 'computer' },
        { value: 'ollama:llama3.1:8b', label: 'llama3.1:8b', provider: 'local', icon: 'computer' },
        { value: 'ollama:qwen2.5:7b', label: 'qwen2.5:7b', provider: 'local', icon: 'computer' },
        { value: 'ollama:mistral:7b', label: 'mistral:7b', provider: 'local', icon: 'computer' }
      );
    }

    return options;
  });

  // Computed properties for showing API key fields
  needsOpenAIKey = computed(() => this.selectedModel().startsWith('openai:'));
  needsClaudeKey = computed(() => this.selectedModel().startsWith('claude:'));
  isOllamaModel = computed(() => this.selectedModel().startsWith('ollama:'));

  constructor(
    private electron: ElectronService,
    private notificationService: NotificationService
  ) {}

  async ngOnInit() {
    // Load current settings from Electron
    try {
      const settings = await this.electron.getSettings();

      // Reconstruct selected model from provider and model
      // Note: ollamaModel is used for all providers (reused for OpenAI, Claude, and Ollama)
      if (settings.aiProvider && settings.aiProvider === 'ollama') {
        this.selectedModel.set(`ollama:${settings.ollamaModel || 'cogito:70b'}`);
      } else if (settings.aiProvider === 'openai') {
        const openaiModel = settings.ollamaModel || 'gpt-4o';
        this.selectedModel.set(`openai:${openaiModel}`);
      } else if (settings.aiProvider === 'claude') {
        const claudeModel = settings.ollamaModel || 'claude-3-5-sonnet';
        this.selectedModel.set(`claude:${claudeModel}`);
      }

      if (settings.ollamaHost) this.ollamaHost.set(settings.ollamaHost);
      if (settings.openaiApiKey) this.openaiApiKey.set(settings.openaiApiKey);
      if (settings.claudeApiKey) this.claudeApiKey.set(settings.claudeApiKey);
      if (settings.outputDirectory) this.outputDirectory.set(settings.outputDirectory);
      if (settings.promptSet) this.selectedPromptSet.set(settings.promptSet);

      // Load available prompt sets
      await this.loadPromptSets();

      // Try to fetch available Ollama models
      await this.fetchOllamaModels();
    } catch (error) {
      this.notificationService.error('Settings Error', 'Failed to load settings: ' + (error as Error).message);
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

  async fetchOllamaModels() {
    // TODO: Implement IPC call to fetch Ollama models
    // For now, we'll use the default list
  }

  async selectOutputDirectory() {
    const result = await this.electron.selectOutputDirectory();
    if (result.success && result.directory) {
      this.outputDirectory.set(result.directory);
    }
  }

  async saveSettings() {
    // Parse provider and model from selectedModel (format: "provider:model")
    const [provider, ...modelParts] = this.selectedModel().split(':');
    const model = modelParts.join(':'); // Rejoin in case model name has colons

    const settings = {
      aiProvider: provider,
      ollamaModel: provider === 'ollama' ? model : '',
      ollamaHost: this.ollamaHost(),
      openaiApiKey: this.openaiApiKey(),
      claudeApiKey: this.claudeApiKey(),
      outputDirectory: this.outputDirectory(),
      promptSet: this.selectedPromptSet()
    };

    try {
      const result = await this.electron.updateSettings(settings);
      if (result.success) {
        this.notificationService.success('Settings Saved', 'Your settings have been saved successfully');
        this.showSaveSuccess();
      } else {
        this.notificationService.error('Save Failed', 'Failed to save settings');
      }
    } catch (error) {
      this.notificationService.error('Save Error', 'Error saving settings: ' + (error as Error).message);
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
}