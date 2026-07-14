import { computed, Injectable, signal } from '@angular/core';
import { ElectronService, StartupReadiness } from './electron';

export type SetupDownloadState = 'queued' | 'downloading' | 'done' | 'failed';

export interface SetupDownload {
  id: string;
  name: string;
  required: boolean;
  state: SetupDownloadState;
  pct: number;
  message: string;
}

export interface DownloadableComponentStatus {
  component: {
    id: string;
    name: string;
    description: string;
    category: 'tool' | 'whisper';
    sizeBytes: number;
    recommended?: boolean;
  };
  state: 'available' | 'installed' | 'incompatible';
}

@Injectable({ providedIn: 'root' })
export class EnvironmentSetupService {
  readonly readiness = signal<StartupReadiness | null>(null);
  readonly components = signal<DownloadableComponentStatus[]>([]);
  readonly optionalDialogOpen = signal(false);
  readonly downloads = signal<Record<string, SetupDownload>>({});
  readonly dockDismissed = signal(false);
  readonly dockExpanded = signal(true);

  private active = 0;
  private readonly concurrency = 2;

  readonly downloadItems = computed(() => Object.values(this.downloads()));
  readonly whisperModels = computed(() =>
    this.components().filter((item) => item.component.category === 'whisper' && item.state !== 'incompatible')
  );
  readonly running = computed(() =>
    this.downloadItems().some((item) => item.state === 'queued' || item.state === 'downloading')
  );

  constructor(private electron: ElectronService) {
    this.electron.onComponentProgress((progress) => {
      const existing = this.downloads()[progress.id];
      if (!existing || existing.state === 'done' || existing.state === 'failed') return;
      const state = progress.phase === 'error' ? 'failed' : existing.state === 'queued' ? 'downloading' : existing.state;
      this.patch(progress.id, {
        state,
        pct: progress.pct ?? existing.pct,
        message: progress.message || this.phaseLabel(progress.phase),
      });
    });
  }

  async initialize(): Promise<void> {
    await this.refresh();
    const readiness = this.readiness();
    if (!readiness) return;

    for (const tool of readiness.transcription.missingRequiredTools) {
      this.enqueue(tool.id, tool.name, true);
    }

    if (!readiness.ai.ready || !readiness.transcription.selectedModelInstalled) {
      this.optionalDialogOpen.set(true);
    }
  }

  async refresh(): Promise<void> {
    const [readiness, components] = await Promise.all([
      this.electron.getStartupReadiness(),
      this.electron.listComponents(),
    ]);
    this.readiness.set(readiness);
    this.components.set(components);
  }

  enqueue(id: string, name: string, required = false): void {
    const component = this.components().find((item) => item.component.id === id);
    if (component?.state === 'installed') return;
    const current = this.downloads()[id];
    if (current && current.state !== 'failed') return;

    this.patch(id, { id, name, required, state: 'queued', pct: 0, message: 'Queued' });
    this.dockDismissed.set(false);
    this.runQueue();
  }

  async chooseWhisperModel(id: string): Promise<void> {
    const component = this.components().find((item) => item.component.id === id);
    if (!component || component.component.category !== 'whisper') {
      throw new Error(`Unknown Whisper model: ${id}`);
    }
    const settings = await this.electron.getSettings();
    await this.electron.updateSettings({ ...settings, whisperModel: id.replace(/^whisper-/, '') });
    if (component.state !== 'installed') this.enqueue(id, component.component.name, false);
    await this.refresh();
  }

  closeOptionalDialog(): void {
    this.optionalDialogOpen.set(false);
  }

  private runQueue(): void {
    while (this.active < this.concurrency) {
      const next = this.downloadItems().find((item) => item.state === 'queued');
      if (!next) return;
      this.start(next);
    }
  }

  private start(item: SetupDownload): void {
    this.active++;
    this.patch(item.id, { state: 'downloading', message: 'Starting…' });
    this.electron.installComponent(item.id)
      .then((result) => {
        if (result.ok) this.patch(item.id, { state: 'done', pct: 100, message: 'Installed' });
        else this.patch(item.id, { state: 'failed', message: result.error || 'Installation failed' });
      })
      .catch((error: unknown) => {
        this.patch(item.id, { state: 'failed', message: error instanceof Error ? error.message : 'Installation failed' });
      })
      .finally(async () => {
        this.active--;
        await this.refresh();
        this.runQueue();
      });
  }

  private patch(id: string, patch: Partial<SetupDownload>): void {
    const existing = this.downloads()[id] || ({ id } as SetupDownload);
    this.downloads.set({ ...this.downloads(), [id]: { ...existing, ...patch } });
  }

  private phaseLabel(phase: string): string {
    if (phase === 'download') return 'Downloading';
    if (phase === 'verify') return 'Verifying';
    if (phase === 'extract') return 'Installing';
    if (phase === 'done') return 'Installed';
    return 'Preparing';
  }
}
