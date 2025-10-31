import { Component, signal, OnInit, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../services/electron';

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

  // Output settings
  outputDirectory = signal('~/Documents/LaunchPad Output');

  // Model options for dropdown
  modelOptions = computed<ModelOption[]>(() => {
    const options: ModelOption[] = [
      // Cloud models at top
      { value: 'openai:gpt-4o', label: 'ChatGPT 4o', provider: 'cloud', icon: 'cloud', needsApiKey: true },
      { value: 'openai:gpt-4-turbo', label: 'ChatGPT 4 Turbo', provider: 'cloud', icon: 'cloud', needsApiKey: true },
      { value: 'openai:gpt-3.5-turbo', label: 'ChatGPT 3.5 Turbo', provider: 'cloud', icon: 'cloud', needsApiKey: true },
      { value: 'claude:claude-3-opus', label: 'Claude 3 Opus', provider: 'cloud', icon: 'cloud', needsApiKey: true },
      { value: 'claude:claude-3-sonnet', label: 'Claude 3 Sonnet', provider: 'cloud', icon: 'cloud', needsApiKey: true },
      { value: 'claude:claude-3-haiku', label: 'Claude 3 Haiku', provider: 'cloud', icon: 'cloud', needsApiKey: true },
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

  constructor(private electron: ElectronService) {}

  async ngOnInit() {
    // Load current settings from Electron
    try {
      const settings = await this.electron.getSettings();

      // Reconstruct selected model from provider and model
      if (settings.aiProvider && settings.aiProvider === 'ollama') {
        this.selectedModel.set(`ollama:${settings.ollamaModel || 'cogito:70b'}`);
      } else if (settings.aiProvider === 'openai') {
        this.selectedModel.set('openai:gpt-4o');
      } else if (settings.aiProvider === 'claude') {
        this.selectedModel.set('claude:claude-3-opus');
      }

      if (settings.ollamaHost) this.ollamaHost.set(settings.ollamaHost);
      if (settings.openaiApiKey) this.openaiApiKey.set(settings.openaiApiKey);
      if (settings.claudeApiKey) this.claudeApiKey.set(settings.claudeApiKey);
      if (settings.outputDirectory) this.outputDirectory.set(settings.outputDirectory);

      // Try to fetch available Ollama models
      await this.fetchOllamaModels();
    } catch (error) {
      console.error('Error loading settings:', error);
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
      outputDirectory: this.outputDirectory()
    };

    try {
      const result = await this.electron.updateSettings(settings);
      if (result.success) {
        console.log('Settings saved successfully');
      } else {
        console.error('Failed to save settings');
      }
    } catch (error) {
      console.error('Error saving settings:', error);
    }
  }

  getModelIcon(option: ModelOption): string {
    return option.icon;
  }

  getModelLabel(option: ModelOption): string {
    return option.label;
  }
}