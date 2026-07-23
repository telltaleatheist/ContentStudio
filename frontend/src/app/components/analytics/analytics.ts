import { Component, signal, OnInit, OnDestroy } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { FormsModule } from '@angular/forms';
import {
  ElectronService,
  AnalyticsChannel,
  AnalyticsChannelInsights,
  AnalyticsChannelSummary,
  AnalyticsCrossChannelInsights,
  AnalyticsIngestInfo,
  YouTubeConnection,
  YouTubeCollectorState,
  YouTubeChannelCollectResult,
} from '../../services/electron';
import { NotificationService } from '../../services/notification';

interface PromptSetListItem {
  id: string;
  name: string;
}

interface ChannelInsightsEntry {
  channelId: string;
  name: string;
  insights: AnalyticsChannelInsights | null;
}

@Component({
  selector: 'app-analytics',
  standalone: true,
  imports: [
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    FormsModule,
  ],
  templateUrl: './analytics.html',
  styleUrl: './analytics.scss',
})
export class Analytics implements OnInit, OnDestroy {
  // Poll the read-only display data so the page updates live as the extension
  // pushes snapshots and the backend auto-re-distills (no manual refresh needed).
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Channel registry
  channels = signal<AnalyticsChannel[]>([]);
  promptSets = signal<PromptSetListItem[]>([]);

  // Add-channel form
  newChannelId = signal('');
  newChannelName = signal('');
  newChannelPromptSets = signal<string[]>([]);

  // Inline edit state (one channel at a time)
  editingChannelId = signal<string | null>(null);
  editChannelId = signal('');
  editChannelName = signal('');
  editChannelPromptSets = signal<string[]>([]);

  // Ingest server status
  ingestInfo = signal<AnalyticsIngestInfo | null>(null);
  tokenRevealed = signal(false);

  // Per-channel summaries
  summaries = signal<AnalyticsChannelSummary[]>([]);

  // Insights
  channelInsights = signal<ChannelInsightsEntry[]>([]);
  crossChannel = signal<AnalyticsCrossChannelInsights | null>(null);

  // YouTube connections + API collector
  connections = signal<YouTubeConnection[]>([]);
  collectorState = signal<YouTubeCollectorState | null>(null);

  // Busy flags
  distilling = signal(false);
  seeding = signal(false);
  connecting = signal(false);
  collectingChannel = signal<string | null>(null); // channelId, or '*' for all
  disconnectingChannel = signal<string | null>(null);

  constructor(
    private electron: ElectronService,
    private notificationService: NotificationService
  ) {}

  async ngOnInit() {
    await Promise.all([
      this.loadChannels(),
      this.loadPromptSets(),
      this.loadIngestInfo(),
      this.loadSummary(),
      this.loadInsights(),
      this.loadConnections(),
      this.loadCollectorState(),
    ]);
    // Live refresh: re-pull the display data on an interval so newly ingested +
    // re-distilled analytics appear without the user reloading or re-distilling.
    this.pollTimer = setInterval(() => void this.refreshLiveData(), 8000);
  }

  ngOnDestroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  /** Read-only refreshers only — never touches edit state or triggers a collection. */
  private async refreshLiveData() {
    try {
      await Promise.all([
        this.loadIngestInfo(),
        this.loadSummary(),
        this.loadInsights(),
        this.loadCollectorState(),
      ]);
    } catch {
      // Transient read failure — the next tick retries; don't spam the console.
    }
  }

  // ==================== LOADERS ====================

  async loadChannels() {
    const result = await this.electron.analyticsListChannels();
    if (result.success && result.channels) {
      this.channels.set(result.channels);
    } else if (result.error) {
      this.notificationService.error('Analytics', 'Failed to load channels: ' + result.error, false);
    }
  }

  async loadPromptSets() {
    try {
      const result = await this.electron.listPromptSets();
      if (result.success) {
        this.promptSets.set(result.promptSets);
      }
    } catch (error) {
      this.notificationService.error('Analytics', 'Failed to load prompt sets: ' + (error as Error).message, false);
    }
  }

  async loadIngestInfo() {
    const result = await this.electron.analyticsGetIngestInfo();
    this.ingestInfo.set(result);
  }

  async loadSummary() {
    const result = await this.electron.analyticsGetSummary();
    if (result.success && result.channels) {
      this.summaries.set(result.channels);
    }
  }

  async loadInsights() {
    const result = await this.electron.analyticsGetInsights();
    if (result.success) {
      this.channelInsights.set(result.channels || []);
      this.crossChannel.set(result.crossChannel || null);
    }
  }

  async loadConnections() {
    const result = await this.electron.youtubeListConnections();
    if (result.success && result.connections) {
      this.connections.set(result.connections);
    } else if (result.error) {
      this.notificationService.error('YouTube', 'Failed to load connections: ' + result.error, false);
    }
  }

  async loadCollectorState() {
    const result = await this.electron.youtubeGetCollectorState();
    if (result.success && result.state) {
      this.collectorState.set(result.state);
    }
  }

  // ==================== YOUTUBE CONNECTIONS ====================

  async connectChannel() {
    this.connecting.set(true);
    try {
      const result = await this.electron.youtubeConnectChannel();
      if (result.success && result.channelId) {
        this.notificationService.success(
          'YouTube',
          `Connected "${result.channelTitle}"`,
          false
        );
        await Promise.all([this.loadConnections(), this.loadChannels(), this.loadSummary()]);
      } else {
        // Show the named error message verbatim (missing creds, denied, timeout…).
        this.notificationService.error('YouTube', result.error || 'Connect failed', false);
      }
    } finally {
      this.connecting.set(false);
    }
  }

  async disconnectChannel(connection: YouTubeConnection) {
    this.disconnectingChannel.set(connection.channelId);
    try {
      const result = await this.electron.youtubeDisconnectChannel(connection.channelId);
      if (result.success) {
        this.notificationService.success('YouTube', `Disconnected "${connection.channelTitle}"`, false);
        await Promise.all([this.loadConnections(), this.loadCollectorState()]);
      } else {
        this.notificationService.error('YouTube', result.error || 'Disconnect failed', false);
      }
    } finally {
      this.disconnectingChannel.set(null);
    }
  }

  async collectNow(channelId?: string) {
    this.collectingChannel.set(channelId || '*');
    try {
      const result = await this.electron.youtubeCollectNow(channelId);
      if (result.success && result.results) {
        const totalSnapshots = result.results.reduce((sum, r) => sum + r.snapshotsWritten, 0);
        const totalErrors = result.results.reduce((sum, r) => sum + r.errors.length, 0);
        this.notificationService.success(
          'YouTube',
          `Collected ${result.results.length} channel(s): ${totalSnapshots} snapshots` +
          (totalErrors > 0 ? `, ${totalErrors} error(s)` : ''),
          false
        );
        await Promise.all([
          this.loadCollectorState(),
          this.loadSummary(),
          this.loadInsights(),
          this.loadConnections(),
        ]);
      } else {
        this.notificationService.error('YouTube', result.error || 'Collection failed', false);
      }
    } finally {
      this.collectingChannel.set(null);
    }
  }

  /** Per-channel last-run result from the collector state (null when never run). */
  channelRunResult(channelId: string): YouTubeChannelCollectResult | null {
    const state = this.collectorState();
    return state?.channels?.[channelId]?.lastResult ?? null;
  }

  fmtDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${Math.round(ms / 100) / 10}s`;
  }

  // ==================== CHANNEL REGISTRY ====================

  async addChannel() {
    const channelId = this.newChannelId().trim();
    const name = this.newChannelName().trim();
    if (!channelId || !name) {
      this.notificationService.error('Analytics', 'Channel ID and name are required', false);
      return;
    }

    const result = await this.electron.analyticsAddChannel({
      channelId,
      name,
      promptSets: this.newChannelPromptSets(),
    });

    if (result.success && result.channels) {
      this.channels.set(result.channels);
      this.newChannelId.set('');
      this.newChannelName.set('');
      this.newChannelPromptSets.set([]);
      this.notificationService.success('Analytics', `Channel "${name}" registered`, false);
      await this.loadSummary();
    } else {
      this.notificationService.error('Analytics', result.error || 'Failed to add channel', false);
    }
  }

  startEdit(channel: AnalyticsChannel) {
    this.editingChannelId.set(channel.channelId);
    this.editChannelId.set(channel.channelId);
    this.editChannelName.set(channel.name);
    this.editChannelPromptSets.set([...channel.promptSets]);
  }

  cancelEdit() {
    this.editingChannelId.set(null);
  }

  async saveEdit() {
    const originalId = this.editingChannelId();
    if (!originalId) return;

    const result = await this.electron.analyticsUpdateChannel(originalId, {
      channelId: this.editChannelId().trim(),
      name: this.editChannelName().trim(),
      promptSets: this.editChannelPromptSets(),
    });

    if (result.success && result.channels) {
      this.channels.set(result.channels);
      this.editingChannelId.set(null);
      this.notificationService.success('Analytics', 'Channel updated', false);
      await this.loadSummary();
    } else {
      this.notificationService.error('Analytics', result.error || 'Failed to update channel', false);
    }
  }

  async deleteChannel(channel: AnalyticsChannel) {
    const result = await this.electron.analyticsDeleteChannel(channel.channelId);
    if (result.success && result.channels) {
      this.channels.set(result.channels);
      this.notificationService.success('Analytics', `Channel "${channel.name}" removed`, false);
      await Promise.all([this.loadSummary(), this.loadInsights()]);
    } else {
      this.notificationService.error('Analytics', result.error || 'Failed to delete channel', false);
    }
  }

  promptSetNames(ids: string[]): string {
    if (ids.length === 0) return 'No prompt sets mapped';
    const byId = new Map(this.promptSets().map((p) => [p.id, p.name]));
    return ids.map((id) => byId.get(id) || id).join(', ');
  }

  // ==================== INGEST ====================

  async copyToken() {
    const token = this.ingestInfo()?.token;
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      this.notificationService.success('Analytics', 'Ingest token copied to clipboard', false);
    } catch {
      this.notificationService.error('Analytics', 'Failed to copy token to clipboard', false);
    }
  }

  toggleTokenReveal() {
    this.tokenRevealed.set(!this.tokenRevealed());
  }

  maskedToken(): string {
    const token = this.ingestInfo()?.token || '';
    if (!token) return '';
    if (this.tokenRevealed()) return token;
    return token.slice(0, 6) + '…' + token.slice(-4);
  }

  // ==================== ACTIONS ====================

  async runDistillation() {
    this.distilling.set(true);
    try {
      const result = await this.electron.analyticsRunDistillation();
      if (result.success && result.summary) {
        const s = result.summary;
        this.notificationService.success(
          'Analytics',
          `Distilled ${s.channels} channel(s): ${s.videosProcessed} videos, ${s.verdictsWritten} verdicts`,
          false
        );
        await Promise.all([this.loadSummary(), this.loadInsights()]);
      } else {
        this.notificationService.error('Analytics', result.error || 'Distillation failed', false);
      }
    } finally {
      this.distilling.set(false);
    }
  }

  async seedFakeData() {
    this.seeding.set(true);
    try {
      const result = await this.electron.analyticsSeedFakeData();
      if (result.success && result.summary) {
        const s = result.summary;
        this.notificationService.success(
          'Analytics',
          `Seeded ${s.channels} channel(s): ${s.videos} videos, ${s.snapshots} snapshots`,
          false
        );
        await Promise.all([this.loadChannels(), this.loadSummary(), this.loadIngestInfo()]);
      } else {
        this.notificationService.error('Analytics', result.error || 'Seeding failed', false);
      }
    } finally {
      this.seeding.set(false);
    }
  }

  // ==================== FORMATTERS ====================

  fmtPct(value: number | null | undefined): string {
    if (value === null || value === undefined) return 'n/a';
    return `${Math.round(value * 10) / 10}%`;
  }

  fmtPctl(value: number | null | undefined): string {
    if (value === null || value === undefined) return 'n/a';
    return `p${Math.round(value)}`;
  }

  fmtNum(value: number | null | undefined): string {
    if (value === null || value === undefined) return 'n/a';
    return Math.round(value).toLocaleString('en-US');
  }

  fmtDate(value: string | null | undefined): string {
    if (!value) return 'never';
    return new Date(value).toLocaleString();
  }

  fmtTrend(value: number): string {
    return value === -1 ? 'new' : `${value}x`;
  }

  channelName(channelId: string): string {
    const channel = this.channels().find((c) => c.channelId === channelId);
    return channel ? channel.name : channelId;
  }
}
