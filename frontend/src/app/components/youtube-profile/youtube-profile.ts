import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { Router } from '@angular/router';
import { ElectronService, YouTubeConnection } from '../../services/electron';
import { NotificationService } from '../../services/notification';
import type { SpreakerStatus } from '../../features/publish/publish.types';

/**
 * Toolbar accounts widget — every destination this app can publish to, in one menu.
 *
 * Two sections, because they are two different kinds of connection and saying so is
 * clearer than pretending otherwise: YouTube is OAuth and holds SEVERAL channels, each
 * signed in through Google's consent flow; Spreaker is ONE show authenticated by a token
 * the operator pastes.
 *
 * The Spreaker token is not editable here. It is a secret that needs a show id beside it
 * and a sentence explaining where to get it, none of which belongs in a dropdown — the
 * menu reports the connection and sends the operator to Settings to change it.
 *
 * Channels without a stored avatar (pre-avatar bundles whose backfill hasn't succeeded
 * yet) show a generic account icon.
 */
@Component({
  selector: 'youtube-profile',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, MatDividerModule],
  templateUrl: './youtube-profile.html',
  styleUrls: ['./youtube-profile.scss'],
})
export class YouTubeProfileComponent implements OnInit {
  readonly connections = signal<YouTubeConnection[]>([]);
  /** True from the click until the consent flow settles (can be minutes). */
  readonly connecting = signal(false);
  /** channelId currently disconnecting, or null. */
  readonly disconnecting = signal<string | null>(null);
  /** channelIds whose avatar <img> failed to load — fall back to the icon. */
  readonly brokenAvatars = signal<Set<string>>(new Set());

  /** The Spreaker connection, or null until the first check answers. */
  readonly spreaker = signal<SpreakerStatus | null>(null);
  readonly spreakerBusy = signal(false);

  constructor(
    private electron: ElectronService,
    private notifications: NotificationService,
    private router: Router,
  ) {}

  ngOnInit(): void {
    void this.loadConnections();
    void this.loadSpreaker();
  }

  async loadSpreaker(): Promise<void> {
    const result = await this.electron.spreakerGetStatus();
    if (result.success && result.data) {
      this.spreaker.set(result.data);
    } else {
      // Not a toast: an unconfigured Spreaker is the normal state for anyone who does not
      // publish a podcast, and greeting them with an error every launch would be noise.
      this.spreaker.set(null);
    }
  }

  spreakerConnected(): boolean {
    return this.spreaker()?.configured === true;
  }

  /** What the toolbar avatar says it opens, named by what is actually connected. */
  toolbarTooltip(): string {
    const parts: string[] = [];
    const first = this.primary();
    if (first) {
      const others = this.connections().length - 1;
      parts.push(`YouTube: ${first.channelTitle}${others > 0 ? ` +${others}` : ''}`);
    }
    const sp = this.spreaker();
    if (sp?.configured) parts.push(`Spreaker: ${sp.showName || sp.showId}`);
    return parts.length > 0 ? parts.join(' · ') : 'Accounts';
  }

  openSpreakerSettings(): void {
    void this.router.navigate(['/settings'], { queryParams: { section: 'spreaker' } });
  }

  async disconnectSpreaker(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    this.spreakerBusy.set(true);
    try {
      const result = await this.electron.spreakerClearCredentials();
      if (result.success) {
        this.notifications.success('Spreaker', 'Disconnected', false);
        await this.loadSpreaker();
      } else {
        this.notifications.error('Spreaker', result.error || 'Disconnect failed', false);
      }
    } finally {
      this.spreakerBusy.set(false);
    }
  }

  async loadConnections(): Promise<void> {
    const result = await this.electron.youtubeListConnections();
    if (result.success && result.connections) {
      this.connections.set(result.connections);
    } else {
      this.notifications.error('YouTube', result.error || 'Could not list YouTube connections', false);
    }
  }

  async connect(): Promise<void> {
    this.connecting.set(true);
    try {
      const result = await this.electron.youtubeConnectChannel();
      if (result.success && result.channelId) {
        this.notifications.success('YouTube', `Connected "${result.channelTitle}"`, false);
        await this.loadConnections();
      } else {
        // Show the named error message verbatim (missing creds, denied, timeout…).
        this.notifications.error('YouTube', result.error || 'Connect failed', false);
      }
    } finally {
      this.connecting.set(false);
    }
  }

  async disconnect(connection: YouTubeConnection, event: MouseEvent): Promise<void> {
    // Keep the menu open and the row click inert while we work.
    event.stopPropagation();
    this.disconnecting.set(connection.channelId);
    try {
      const result = await this.electron.youtubeDisconnectChannel(connection.channelId);
      if (result.success) {
        this.notifications.success('YouTube', `Disconnected "${connection.channelTitle}"`, false);
        await this.loadConnections();
      } else {
        this.notifications.error('YouTube', result.error || 'Disconnect failed', false);
      }
    } finally {
      this.disconnecting.set(null);
    }
  }

  avatarFailed(channelId: string): void {
    this.brokenAvatars.update((set) => new Set(set).add(channelId));
  }

  hasAvatar(connection: YouTubeConnection): boolean {
    return !!connection.channelThumbnailUrl && !this.brokenAvatars().has(connection.channelId);
  }

  /** The avatar shown on the toolbar button — first connected channel. */
  primary(): YouTubeConnection | null {
    return this.connections()[0] ?? null;
  }
}
