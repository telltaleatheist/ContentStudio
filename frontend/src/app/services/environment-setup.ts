import { computed, Injectable, signal } from '@angular/core';
import { ElectronService, StartupReadiness } from './electron';
import { CrucibleService } from './crucible';
import type { CrucibleReadinessView } from '../features/crucible/crucible.types';

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
    category: 'tool';
    sizeBytes: number;
    recommended?: boolean;
  };
  state: 'available' | 'installed' | 'incompatible';
}

/**
 * Nothing installed on this computer and nothing registered: the only state the gate opens on.
 * A derived answer of that kind always names its repair (`install` or `connect`); main's
 * provisional "Checking for Crucible..." names none, and is not yet an answer.
 */
function noCrucibleAtAll(view: CrucibleReadinessView): boolean {
  return (view.state === 'not-installed' || view.state === 'not-configured') && view.action !== null;
}

@Injectable({ providedIn: 'root' })
export class EnvironmentSetupService {
  readonly readiness = signal<StartupReadiness | null>(null);
  readonly components = signal<DownloadableComponentStatus[]>([]);
  /**
   * THE SETUP GATE (LEDGER #221, narrowed by #224). Open only while there is NO Crucible to use:
   * none is installed on this computer and none is registered (`not-installed`,
   * `not-configured`). There is no "set up later" for that case: every transcription and model
   * call runs on Crucible (Owen, 2026-09-26: "it MUST have a crucible installed and set up
   * before the user can use the app"). A server that exists but has not answered yet
   * (`starting`, `unreachable`, main's provisional "Checking Crucible on …") is NOT a reason to
   * open it — that is the readiness banner's to report (Owen, 2026-09-26: "it shouldnt pop it up
   * unless theres no crucible server installed"). Once the app has been ready in this session,
   * nothing reopens it.
   */
  readonly setupGateOpen = signal(false);
  private gateSatisfied = false;
  readonly downloads = signal<Record<string, SetupDownload>>({});
  readonly dockDismissed = signal(false);
  readonly dockExpanded = signal(true);

  private active = 0;
  private readonly concurrency = 2;

  readonly downloadItems = computed(() => Object.values(this.downloads()));
  readonly running = computed(() =>
    this.downloadItems().some((item) => item.state === 'queued' || item.state === 'downloading')
  );

  constructor(private electron: ElectronService, private crucible: CrucibleService) {
    // Readiness is PUSHED by main whenever it changes (P1's readiness service). The gate reads
    // every push, so the first real probe answer closes it the moment the server is reached.
    this.crucible.onReadiness((view) => this.applyReadiness(view));
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

    // Transcription is Crucible's (LEDGER #206); the only local download is ffmpeg, above.
    if (readiness.ai.ready) {
      this.gateSatisfied = true;
      return;
    }
    // The startup snapshot can be main's PROVISIONAL answer ("Checking Crucible on …"), read
    // before the first probe has returned. That is not a missing server, so the gate stays shut
    // and a real derivation is asked for; only an answer that says nothing is installed or
    // registered opens it.
    try {
      this.applyReadiness(await this.crucible.refreshReadiness());
    } catch {
      // The push will carry the next answer.
    }
  }

  /** One readiness view from main, folded into the startup readiness and the gate. */
  private applyReadiness(view: CrucibleReadinessView): void {
    const ready = view.state === 'ready';
    const current = this.readiness();
    if (current) {
      this.readiness.set({
        ...current,
        ready: ready && current.transcription.ready,
        ai: { ready, provider: 'crucible', model: view.server ?? '', reason: ready ? '' : view.reason },
      });
    }
    if (ready) {
      this.gateSatisfied = true;
      this.setupGateOpen.set(false);
    } else if (!this.gateSatisfied && noCrucibleAtAll(view)) {
      this.setupGateOpen.set(true);
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
