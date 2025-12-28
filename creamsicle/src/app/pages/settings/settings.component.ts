import { Component, signal, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonComponent } from '../../components/button/button.component';
import { ElectronService } from '../../services/electron.service';
import { NotificationService } from '../../services/notification.service';

interface ModelOption {
  value: string;
  label: string;
  provider: 'cloud' | 'local';
  icon: string;
  needsApiKey?: boolean;
}

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent],
  templateUrl: './settings.component.html',
  styleUrls: ['./settings.component.scss']
})
export class SettingsComponent implements OnInit {
  private electron = inject(ElectronService);
  private notificationService = inject(NotificationService);

  aiModel = signal('ollama:cogito:70b');
  outputDirectory = signal('~/Documents/ContentStudio Output');
  selectedPromptSet = signal('sample-youtube');

  // Active section for navigation
  activeSection = signal<'models' | 'prompts' | 'output'>('models');

  availableOllamaModels = signal<string[]>([]);
  hasOpenAIKey = signal(false);
  hasClaudeKey = signal(false);
  availablePromptSets = signal<Array<{id: string, name: string, platform: string}>>([]);

  showSaveNotification = signal(false);
  private saveNotificationTimeout: any;

  // Dynamic model options - loaded from APIs
  modelOptions = signal<ModelOption[]>([]);

  async ngOnInit() {
    try {
      const settings = await this.electron.getSettings();

      // Load AI model (check multiple possible settings keys for compatibility)
      if (settings.aiProvider && settings.aiModel) {
        this.aiModel.set(`${settings.aiProvider}:${settings.aiModel}`);
      } else if (settings.metadataProvider && settings.metadataModel) {
        this.aiModel.set(`${settings.metadataProvider}:${settings.metadataModel}`);
      } else if (settings.aiProvider && settings.ollamaModel) {
        this.aiModel.set(`${settings.aiProvider}:${settings.ollamaModel}`);
      }

      if (settings.outputDirectory) this.outputDirectory.set(settings.outputDirectory);
      if (settings.promptSet) this.selectedPromptSet.set(settings.promptSet);

      await this.loadPromptSets();
      await this.checkProviderAvailability();
    } catch (error) {
      this.notificationService.error('Settings Error', 'Failed to load settings');
    }
  }

  async loadPromptSets() {
    try {
      const result = await this.electron.listPromptSets();
      if (result.success && result.promptSets) {
        this.availablePromptSets.set(result.promptSets);
      }
    } catch (error) {
      this.notificationService.error('Prompt Sets Error', 'Failed to load prompt sets');
    }
  }

  async checkProviderAvailability() {
    try {
      const options: ModelOption[] = [];

      // Check API keys availability
      const apiKeys = await this.electron.getApiKeys();
      this.hasOpenAIKey.set(!!apiKeys.openaiApiKey);
      this.hasClaudeKey.set(!!apiKeys.claudeApiKey);

      // Fetch Ollama models dynamically
      const ollamaResult = await this.electron.getAvailableModels('ollama');
      if (ollamaResult.success && ollamaResult.models.length > 0) {
        this.availableOllamaModels.set(ollamaResult.models.map(m => m.id));
        ollamaResult.models.forEach((model) => {
          options.push({
            value: `ollama:${model.id}`,
            label: model.name,
            provider: 'local',
            icon: '💻'
          });
        });
      }

      // Fetch OpenAI models dynamically
      if (apiKeys.openaiApiKey) {
        const openaiResult = await this.electron.getAvailableModels('openai');
        if (openaiResult.success && openaiResult.models.length > 0) {
          openaiResult.models.forEach((model) => {
            options.push({
              value: `openai:${model.id}`,
              label: model.name,
              provider: 'cloud',
              icon: '☁️',
              needsApiKey: true
            });
          });
        }
      }

      // Fetch Claude models dynamically
      if (apiKeys.claudeApiKey) {
        const claudeResult = await this.electron.getAvailableModels('claude');
        if (claudeResult.success && claudeResult.models.length > 0) {
          claudeResult.models.forEach((model) => {
            options.push({
              value: `claude:${model.id}`,
              label: model.name,
              provider: 'cloud',
              icon: '☁️',
              needsApiKey: true
            });
          });
        }
      }

      this.modelOptions.set(options);
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
    const [provider, ...modelParts] = this.aiModel().split(':');
    const model = modelParts.join(':');

    const settings = {
      aiProvider: provider,
      aiModel: model,
      // Keep legacy keys for backend compatibility
      metadataProvider: provider,
      metadataModel: model,
      ollamaModel: model,
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
      this.notificationService.error('Save Error', 'Error saving settings');
    }
  }

  private showSaveSuccess() {
    if (this.saveNotificationTimeout) {
      clearTimeout(this.saveNotificationTimeout);
    }
    this.showSaveNotification.set(true);
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

  getProviderIcon(provider: string): string {
    return provider === 'cloud' ? '☁️' : '💻';
  }
}
