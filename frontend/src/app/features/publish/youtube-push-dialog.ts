/**
 * "Push to YouTube" confirmation.
 *
 * The last thing between a click and a write to a live video, so it is a LIST OF FACTS,
 * not a "are you sure?". Every field the push will send is shown with the value it will
 * send, and every field it will NOT send is shown saying so — a dialog that only listed
 * what changes leaves the operator to remember what does not.
 *
 * Presentational only. It reads nothing, calls nothing and decides nothing: the caller
 * hands it what the push will do and gets back true or false. Everything that can refuse
 * the push refuses it in the main process, after this.
 */

import { Component, Inject } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

export interface YouTubePushDialogData {
  /** The video that will be written to. */
  videoId: string;
  /** Display name of the channel it is routed to, or the raw id when there is no name. */
  channelLabel: string;
  /** snippet.title as it will be sent: chosen variant 1. */
  title: string;
  /** First line of the description, and how long the whole thing is. */
  descriptionFirstLine: string;
  descriptionChars: number;
  tagCount: number;
  /** The tags themselves, comma-joined — truncated for display by the caller. */
  tagsPreview: string;
  /** Human rendering of the schedule, or null when no schedule will be sent. */
  scheduleLabel: string | null;
  /** True when that schedule has already passed — YouTube publishes on receipt, not later. */
  schedulePast: boolean;
  /** Basename of the thumbnail file, or null when none will be uploaded. */
  thumbnailName: string | null;
  /** The thumbnail itself, when the panel already has a preview of it. */
  thumbnailDataUrl: string | null;
}

@Component({
  selector: 'app-youtube-push-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>Push to YouTube</h2>
    <mat-dialog-content>
      <p class="lead">
        This writes the values below onto video
        <code>{{ data.videoId }}</code> on <strong>{{ data.channelLabel }}</strong>.
        Nothing is uploaded and nothing is published — the video's other settings are read
        first and put back unchanged.
      </p>

      <dl class="plan">
        <dt>Title</dt>
        <dd class="value">{{ data.title }}</dd>

        <dt>Description</dt>
        <dd>
          <span class="value">{{ data.descriptionFirstLine }}</span>
          <span class="meta">{{ data.descriptionChars }} characters</span>
        </dd>

        <dt>Tags</dt>
        <dd>
          <span class="value">{{ data.tagsPreview }}</span>
          <span class="meta">{{ data.tagCount }} tag{{ data.tagCount === 1 ? '' : 's' }}</span>
        </dd>

        <dt>Schedule</dt>
        <dd>
          @if (data.scheduleLabel) {
            <span class="value">{{ data.scheduleLabel }}</span>
            @if (data.schedulePast) {
              <span class="meta past-warn">this time has already passed — sending publishes the video immediately</span>
            } @else {
              <span class="meta">the video stays private until then</span>
            }
          } @else {
            <span class="untouched">Not sent — the video's current privacy and schedule are left alone.</span>
          }
        </dd>

        <dt>Thumbnail</dt>
        <dd>
          @if (data.thumbnailName) {
            @if (data.thumbnailDataUrl) {
              <img class="thumb" [src]="data.thumbnailDataUrl" [alt]="data.thumbnailName" />
            }
            <span class="value">{{ data.thumbnailName }}</span>
            <span class="meta">re-checked against the file on disk before it is sent</span>
          } @else {
            <span class="untouched">Not sent — this item has no thumbnail attached.</span>
          }
        </dd>
      </dl>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="dialogRef.close(false)">Cancel</button>
      <button mat-flat-button color="accent" (click)="dialogRef.close(true)">
        <mat-icon>rocket_launch</mat-icon>
        Push to YouTube
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .past-warn { color: var(--danger-text, #dc2626); font-weight: 600; }
    mat-dialog-content { min-width: 520px; max-width: 720px; }
    .lead { color: rgba(255,255,255,0.7); font-size: 13px; line-height: 1.5; margin: 0 0 16px; }
    .lead code { font-family: 'SF Mono', Menlo, monospace; font-size: 12px;
      background: rgba(255,255,255,0.08); border-radius: 4px; padding: 1px 5px; }

    .plan { display: grid; grid-template-columns: 96px 1fr; gap: 10px 16px; margin: 0; }
    .plan dt { color: rgba(255,255,255,0.55); font-size: 12px; text-transform: uppercase;
      letter-spacing: 0.04em; padding-top: 2px; }
    .plan dd { margin: 0; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .value { color: rgba(255,255,255,0.92); font-size: 14px; overflow-wrap: anywhere; }
    .meta { color: rgba(255,255,255,0.45); font-size: 12px; }
    .untouched { color: rgba(255,255,255,0.5); font-size: 13px; font-style: italic; }
    .thumb { width: 160px; border-radius: 4px; margin-bottom: 4px; }
  `]
})
export class YouTubePushDialog {
  constructor(
    public dialogRef: MatDialogRef<YouTubePushDialog, boolean>,
    @Inject(MAT_DIALOG_DATA) public data: YouTubePushDialogData,
  ) {}
}
