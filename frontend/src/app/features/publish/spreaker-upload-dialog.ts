/**
 * "Upload to Spreaker" confirmation.
 *
 * The last thing between a click and a new episode in a public podcast feed, so it is a
 * LIST OF FACTS, not an "are you sure?". Every field the upload will send is shown with
 * the value it will send.
 *
 * It carries one line the YouTube dialog has no equivalent of, and it is the reason this
 * is a separate component rather than a parameterisation of that one: a Spreaker upload
 * has NO DRAFT STATE. Unless the item carries a schedule, the episode is public as soon
 * as Spreaker finishes encoding it. The YouTube push writes metadata onto a video the
 * operator already uploaded and reviewed; this one publishes.
 *
 * Presentational only. It reads nothing, calls nothing and decides nothing: the caller
 * hands it what the upload will do and gets back true or false. Everything that can
 * refuse the upload refuses it in the main process, after this.
 */

import { Component, Inject } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

export interface SpreakerUploadDialogData {
  /** The show the episode is created on: its name if the operator gave one, else its id. */
  showLabel: string;
  /** The episode title as it will be sent: chosen variant 1. */
  title: string;
  /** First line of the description, and how long the whole thing is. */
  descriptionFirstLine: string;
  descriptionChars: number;
  tagCount: number;
  /** The tags themselves, comma-joined — truncated for display by the caller. */
  tagsPreview: string;
  /** Basename of the audio file that will be uploaded. */
  audioName: string;
  /** Its full path, for the row's tooltip — this points at an external volume. */
  audioPath: string;
  /** `1:04:12 · 126.6 MB · mp3`, composed by the caller. */
  audioFacts: string;
  /**
   * What happens when it lands: the schedule, or the fact that it goes public on arrival.
   * Never null — "no schedule" is the consequential case here, not the quiet one.
   */
  publicationNote: string;
  /** Non-fatal notes about the audio file, shown as-is. */
  warnings: string[];
}

@Component({
  selector: 'app-spreaker-upload-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>Upload to Spreaker</h2>
    <mat-dialog-content>
      <p class="lead">
        This creates a new episode on <strong>{{ data.showLabel }}</strong> and uploads the
        audio file below. Spreaker has no draft state — an episode is live as soon as it
        finishes encoding, unless it is scheduled.
      </p>

      <dl class="plan">
        <dt>Title</dt>
        <dd class="value">{{ data.title }}</dd>

        <dt>Description</dt>
        <dd>
          @if (data.descriptionChars > 0) {
            <span class="value">{{ data.descriptionFirstLine }}</span>
            <span class="meta">{{ data.descriptionChars }} characters</span>
          } @else {
            <span class="untouched">Empty — the episode is published without a description.</span>
          }
        </dd>

        <dt>Tags</dt>
        <dd>
          @if (data.tagCount > 0) {
            <span class="value">{{ data.tagsPreview }}</span>
            <span class="meta">{{ data.tagCount }} tag{{ data.tagCount === 1 ? '' : 's' }}</span>
          } @else {
            <span class="untouched">Not sent — this item resolves to no tags.</span>
          }
        </dd>

        <dt>Audio</dt>
        <dd>
          <span class="value" [title]="data.audioPath">{{ data.audioName }}</span>
          <span class="meta">{{ data.audioFacts }} — re-checked against the file on disk before it is sent</span>
        </dd>

        <dt>Publication</dt>
        <dd><span class="value">{{ data.publicationNote }}</span></dd>
      </dl>

      @for (warning of data.warnings; track $index) {
        <p class="warn"><mat-icon>warning</mat-icon><span>{{ warning }}</span></p>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="dialogRef.close(false)">Cancel</button>
      <button mat-flat-button color="accent" (click)="dialogRef.close(true)">
        <mat-icon>podcasts</mat-icon>
        Upload episode
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { min-width: 520px; max-width: 720px; }
    .lead { color: rgba(255,255,255,0.7); font-size: 13px; line-height: 1.5; margin: 0 0 16px; }

    .plan { display: grid; grid-template-columns: 110px 1fr; gap: 10px 16px; margin: 0; }
    .plan dt { color: rgba(255,255,255,0.55); font-size: 12px; text-transform: uppercase;
      letter-spacing: 0.04em; padding-top: 2px; }
    .plan dd { margin: 0; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .value { color: rgba(255,255,255,0.92); font-size: 14px; overflow-wrap: anywhere; }
    .meta { color: rgba(255,255,255,0.45); font-size: 12px; }
    .untouched { color: rgba(255,255,255,0.5); font-size: 13px; font-style: italic; }

    .warn { display: flex; gap: 8px; align-items: flex-start; margin: 14px 0 0;
      color: #ffb74d; font-size: 12px; line-height: 1.5; }
    .warn mat-icon { font-size: 16px; width: 16px; height: 16px; flex: none; margin-top: 1px; }
  `]
})
export class SpreakerUploadDialog {
  constructor(
    public dialogRef: MatDialogRef<SpreakerUploadDialog, boolean>,
    @Inject(MAT_DIALOG_DATA) public data: SpreakerUploadDialogData,
  ) {}
}
