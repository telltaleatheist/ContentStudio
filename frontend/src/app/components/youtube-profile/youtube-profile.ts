import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { ElectronService, YouTubeConnection } from '../../services/electron';
import { NotificationService } from '../../services/notification';

/**
 * Toolbar sign-in widget for the YouTube OAuth connections.
 *
 * Signed out: a "Sign in" button that runs the standard Google consent flow
 * (same IPC path the Analytics page uses). Signed in: the first channel's
 * avatar opens a menu listing every connected channel, with per-channel
 * disconnect and a "Sign in to another channel" action. Channels without a
 * stored avatar (pre-avatar bundles whose backfill hasn't succeeded yet)
 * show a generic account icon.
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

  constructor(
    private electron: ElectronService,
    private notifications: NotificationService,
  ) {}

  ngOnInit(): void {
    void this.loadConnections();
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
