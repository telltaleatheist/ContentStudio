import { Component, signal, OnInit, OnDestroy, computed } from '@angular/core';
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
import { ActivatedRoute, Router } from '@angular/router';
import type { Subscription } from 'rxjs';

interface ModelOption {
  value: string;
  label: string;
  provider: 'cloud' | 'local';
  icon: string;
  needsApiKey?: boolean;
}

interface DownloadComponent {
  component: { id: string; name: string; description: string; category: 'tool' | 'whisper'; sizeBytes: number; recommended?: boolean };
  state: 'available' | 'installed' | 'incompatible';
  reason?: string;
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
export class Settings implements OnInit, OnDestroy {
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

  // Output settings — populated from the backend's get-settings (always a real
  // path) in ngOnInit; empty until then.
  outputDirectory = signal('');

  // Prompt set selection
  /**
   * The default channel a run publishes to. EMPTY until the list arrives or a stored setting
   * names one — see loadPromptSets. It used to be seeded with 'sample-youtube', a prompt set
   * this repo has not shipped in a very long time.
   */
  selectedPromptSet = signal('');
  availablePromptSets = signal<Array<{id: string, name: string, platform: string}>>([]);

  // A saved model that isn't present in the fetched provider lists (e.g. the
  // provider's model-list fetch failed, or the API's top-N changed). Kept as a
  // selectable option so we never silently swap the user's saved choice.
  savedModelFallback = signal<ModelOption | null>(null);
  downloadableComponents = signal<DownloadComponent[]>([]);
  componentProgress = signal<Record<string, number>>({});
  whisperModel = signal('small');

  // Path to a clean solo recording of the operator's voice. Empty is a declared mode,
  // not an oversight: with nothing enrolled the pipeline skips speaker tagging entirely,
  // which is why main.ts ships no default for it.
  speakerEnrollmentAudio = signal('');
  setupRequired = signal(false);
  setupNeedsAI = signal(false);
  setupNeedsTranscription = signal(false);
  setupAIReason = signal('');
  setupMissingComponents = signal<string[]>([]);
  private removeComponentProgressListener?: () => void;
  private routeSubscription?: Subscription;

  // ------------------------------------------------------------------------ Spreaker
  //
  // Deliberately NOT part of `saveSettings()`. The show id and the token live in their own
  // 0600 file in userData (spreaker-credentials.json), they are validated together in the
  // main process, and a save that rejects an unparseable show id must not also fail to
  // save the output directory. Same reasoning as the API keys, which have never gone
  // through update-settings either.

  /** What the main process says about this machine's Spreaker setup. null until asked. */
  spreakerStatus = signal<{
    configured: boolean;
    hasToken: boolean;
    showId: string | null;
    showName: string | null;
    savedAt: string | null;
    credentialsPath: string;
    reason: string | null;
  } | null>(null);

  /** The boxes. Seeded from the status for the two that are not secrets. */
  spreakerShowId = signal('');
  spreakerShowName = signal('');

  /**
   * The token box, and it is ALWAYS EMPTY on load.
   *
   * The stored token is never read back — `status` carries only whether one exists — so
   * there is nothing to prefill it with. Leaving it blank and saving keeps the stored
   * token: that is what the main process does with an omitted token, and it is what makes
   * "fix the show id" a one-field edit.
   */
  spreakerToken = signal('');
  spreakerSaving = signal(false);

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

    // Keep a saved-but-unavailable model selectable rather than dropping it
    const fallback = this.savedModelFallback();
    if (fallback && !options.some(o => o.value === fallback.value)) {
      options.push(fallback);
    }

    return options;
  });

  // Build a placeholder option for a saved model that isn't in the fetched lists
  private makeSavedModelOption(savedModel: string): ModelOption {
    const [provider, ...modelParts] = savedModel.split(':');
    const model = modelParts.join(':');
    const isLocal = provider === 'ollama';
    return {
      value: savedModel,
      label: `${model} (saved)`,
      provider: isLocal ? 'local' : 'cloud',
      icon: isLocal ? 'computer' : 'cloud',
      needsApiKey: !isLocal
    };
  }

  constructor(
    private electron: ElectronService,
    private notificationService: NotificationService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  async ngOnInit() {
    this.routeSubscription = this.route.queryParamMap.subscribe((params) => {
      const required = params.get('setup') === 'required';
      const needsAI = params.get('ai') === 'required';
      this.setupRequired.set(required);
      this.setupNeedsAI.set(needsAI);
      this.setupNeedsTranscription.set(params.get('transcription') === 'required');
      this.setupAIReason.set(params.get('aiReason') || '');
      this.setupMissingComponents.set((params.get('missing') || '').split('|').filter(Boolean));
      if (required && needsAI) this.showWizard.set(true);
    });
    this.removeComponentProgressListener = this.electron.onComponentProgress((progress) => {
      this.componentProgress.update((current) => ({ ...current, [progress.id]: progress.pct }));
    });
    // Load current settings from Electron
    try {
      const settings = await this.electron.getSettings();

      if (settings.outputDirectory) this.outputDirectory.set(settings.outputDirectory);
      if (settings.promptSet) this.selectedPromptSet.set(settings.promptSet);
      if (settings.whisperModel) this.whisperModel.set(settings.whisperModel);
      if (settings.speakerEnrollmentAudio) this.speakerEnrollmentAudio.set(settings.speakerEnrollmentAudio);
      await this.loadComponents();

      // Load available prompt sets
      await this.loadPromptSets();

      // Check which AI providers are configured and fetch available models from APIs
      await this.checkProviderAvailability();

      // The Spreaker credentials, from their own file. Not fatal to the rest of this
      // method — a settings page that failed to load entirely because a podcast
      // integration is unset would be a worse bug than the one it reported.
      await this.loadSpreakerStatus();

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
        } else {
          // Saved model isn't in the fetched list (fetch failed, or the API's
          // top-N changed). Keep the user's choice selected instead of silently
          // swapping it — append it as an extra option and select it.
          console.warn('Saved model not in fetched list:', savedModel, '- keeping it selected');
          this.savedModelFallback.set(this.makeSavedModelOption(savedModel));
          this.metadataModel.set(savedModel);
        }
      } else if (this.modelOptions().length > 0) {
        // No saved model, default to first available
        this.metadataModel.set(this.modelOptions()[0].value);
      }
    } catch (error) {
      this.notificationService.error('Settings Error', 'Failed to load settings: ' + (error as Error).message, false);
    }
  }

  ngOnDestroy() {
    this.removeComponentProgressListener?.();
    this.routeSubscription?.unsubscribe();
  }

  async loadComponents() {
    this.downloadableComponents.set(await this.electron.listComponents());
  }

  async installComponent(id: string) {
    const result = await this.electron.installComponent(id);
    if (!result.ok) this.notificationService.error('Download failed', result.error || 'Component installation failed', false);
    await this.loadComponents();
    await this.refreshSetupReadiness();
  }

  async uninstallComponent(id: string) {
    const result = await this.electron.uninstallComponent(id);
    if (!result.success) this.notificationService.error('Cannot remove model', result.error || 'Component removal failed', false);
    await this.loadComponents();
    await this.refreshSetupReadiness();
  }

  private async refreshSetupReadiness() {
    const readiness = await this.electron.getStartupReadiness();
    this.setupRequired.set(!readiness.ready);
    this.setupNeedsAI.set(!readiness.ai.ready);
    this.setupNeedsTranscription.set(!readiness.transcription.ready);
    this.setupAIReason.set(readiness.ai.reason);
    this.setupMissingComponents.set(readiness.transcription.missingComponents);
    if (readiness.ready) {
      await this.router.navigate([], {
        relativeTo: this.route,
        queryParams: {
          setup: null,
          ai: null,
          transcription: null,
          aiReason: null,
          missing: null,
        },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    }
  }

  formatBytes(bytes: number): string {
    return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
  }

  installedWhisperModels(): DownloadComponent[] {
    return this.downloadableComponents().filter((item) => item.component.category === 'whisper' && item.state === 'installed');
  }

  async loadPromptSets() {
    try {
      const result = await this.electron.listPromptSets();
      if (result.success && result.promptSets) {
        this.availablePromptSets.set(result.promptSets);
        // Show what will actually be used: a stored selection a later build removed, or no
        // stored selection at all, both resolve to the first channel that really exists.
        const current = this.selectedPromptSet();
        if (result.promptSets.length > 0 && !result.promptSets.some((set: {id: string}) => set.id === current)) {
          this.selectedPromptSet.set(result.promptSets[0].id);
        }
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

  async selectEnrollmentAudio() {
    const result = await this.electron.selectEnrollmentAudio();
    if (result.success && result.file) {
      this.speakerEnrollmentAudio.set(result.file);
    }
  }

  clearEnrollmentAudio() {
    this.speakerEnrollmentAudio.set('');
  }

  /**
   * Read this machine's Spreaker setup and seed the two non-secret boxes.
   *
   * The token box is never seeded — there is nothing to seed it with, by design. A
   * failure is REPORTED: "not configured" and "we could not tell" are different, and only
   * the first one is something the operator can act on by typing.
   */
  private async loadSpreakerStatus(): Promise<void> {
    const res = await this.electron.spreakerGetStatus();
    if (!res.success || !res.data) {
      this.notificationService.error(
        'Spreaker',
        res.error ?? 'Could not read the Spreaker settings on this machine.',
        false
      );
      return;
    }
    this.spreakerStatus.set(res.data);
    this.spreakerShowId.set(res.data.showId ?? '');
    this.spreakerShowName.set(res.data.showName ?? '');
  }

  /**
   * Save the show id, and the token when one has been typed.
   *
   * An EMPTY token box means "leave the stored one alone", which is why it is omitted
   * rather than sent as ''. Sending '' would be indistinguishable from asking to remove
   * the token, and the main process refuses that on purpose — removing it is Clear, which
   * says what it does.
   */
  async saveSpreaker(): Promise<void> {
    this.spreakerSaving.set(true);
    try {
      const token = this.spreakerToken().trim();
      const res = await this.electron.spreakerSaveCredentials({
        showId: this.spreakerShowId().trim(),
        showName: this.spreakerShowName().trim() || null,
        ...(token ? { accessToken: token } : {}),
      });

      if (!res.success || !res.data) {
        // Verbatim: the main process names the value and the rule ("…is not a number. It
        // is the numeric id in your show's URL"), which is the whole of the fix.
        this.notificationService.error('Spreaker', res.error ?? 'Failed to save', false);
        return;
      }

      this.spreakerStatus.set(res.data);
      // The typed token has been stored and is never displayed again.
      this.spreakerToken.set('');
      this.notificationService.success(
        'Spreaker',
        res.data.configured
          ? `Saved — uploads will go to show ${res.data.showId}.`
          : `Saved, but ${res.data.reason}`,
        false
      );
    } finally {
      this.spreakerSaving.set(false);
    }
  }

  /** Remove the stored credentials entirely. Confirmed, because it disconnects uploads. */
  async clearSpreaker(): Promise<void> {
    const ok = window.confirm(
      'Remove the stored Spreaker access token and show id from this machine?\n\n' +
      'Nothing on Spreaker changes. Podcast items will refuse to upload until a token is ' +
      'pasted again.'
    );
    if (!ok) return;

    this.spreakerSaving.set(true);
    try {
      const res = await this.electron.spreakerClearCredentials();
      if (!res.success || !res.data) {
        this.notificationService.error('Spreaker', res.error ?? 'Failed to clear', false);
        return;
      }
      this.spreakerStatus.set(res.data);
      this.spreakerShowId.set('');
      this.spreakerShowName.set('');
      this.spreakerToken.set('');
      this.notificationService.success('Spreaker', 'Credentials removed from this machine.', false);
    } finally {
      this.spreakerSaving.set(false);
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
      promptSet: this.selectedPromptSet(),
      whisperModel: this.whisperModel(),
      speakerEnrollmentAudio: this.speakerEnrollmentAudio()
    };

    try {
      const result = await this.electron.updateSettings(settings);
      if (result.success) {
        this.notificationService.success('Settings Saved', 'Your settings have been saved successfully', false);
        this.showSaveSuccess();
        await this.refreshSetupReadiness();
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
          // Keep the user's saved model selected instead of silently swapping it
          console.log('Previously selected model not in fetched list, keeping it selected:', modelValue);
          this.savedModelFallback.set(this.makeSavedModelOption(modelValue));
          this.metadataModel.set(modelValue);
        }
      }

      this.notificationService.success('AI Setup Complete', 'Your AI configuration has been saved. Please select a model from the dropdown.', false);
      await this.refreshSetupReadiness();
    } catch (error) {
      this.notificationService.error('Settings Error', 'Failed to reload settings: ' + (error as Error).message, false);
    }
  }
}
