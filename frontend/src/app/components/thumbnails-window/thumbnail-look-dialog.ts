import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { ElectronService } from '../../services/electron';
import type { LookLogo, LookPhotos, LookSlot, LookStyle } from './thumbnails.types';

/**
 * THUMBNAIL LOOK: the one look for all three channels (Owen, 2026-09-28): the reaction photos (add,
 * remove, notes), the logo, and the font, colours and spaces. Moved here from the retired Thumbnails
 * test tab. Opened from the reports page's Thumbnails window and from Settings; the metadata run
 * reads the same saved settings at job time, and the window's redraws use them at once.
 *
 * Every change to the photos and the logo is saved when it is made (they are files copied into the
 * app); the look is saved with "Save look", because a half-typed number should not redraw anything.
 */
@Component({
  selector: 'app-thumbnail-look-dialog',
  standalone: true,
  imports: [FormsModule, MatButtonModule, MatDialogModule],
  template: `
    <h2 mat-dialog-title>Thumbnail look</h2>
    <mat-dialog-content class="look-dialog">
      <p class="hint">One look for all three channels. The metadata run and the Thumbnails window both use what is saved here.</p>
      @if (error(); as e) { <p class="error">{{ e }}</p> }

      <section>
        <h3>Reaction photos</h3>
        <div class="row">
          <span [title]="photos().folder">{{ photos().photos.length }} photo{{ photos().photos.length === 1 ? '' : 's' }}, kept in the app</span>
          <button mat-stroked-button (click)="addPhotos()" [disabled]="busy()"
                  title="PNG cut-outs, or a folder of them: copied into the app, so they never need adding again">Add photos…</button>
          @if (photos().photos.length > 0) {
            <button mat-stroked-button (click)="notesOpen.set(!notesOpen())">{{ notesOpen() ? 'Hide notes' : 'Edit notes' }}</button>
          }
        </div>
        @if (photos().offer; as offer) {
          <div class="row">
            <span>Your {{ offer.count }} photos in {{ offer.from }} are not in the app yet.</span>
            <button mat-flat-button color="primary" (click)="copyOldPhotos()" [disabled]="busy()">Copy these into the app</button>
            <span class="hint">Your originals are only read, never moved or changed.</span>
          </div>
        }
        @if (photoLine(); as line) { <p class="line">{{ line }}</p> }
        <div class="photos">
          @for (p of photos().photos; track p.name) {
            <div class="photo" [title]="p.note ?? p.name">
              <img [src]="p.preview" [alt]="p.name" />
              <span class="name">{{ p.name }}</span>
              <button class="remove" (click)="removePhoto(p.name)" [disabled]="busy()" [attr.aria-label]="'Remove ' + p.name" title="Remove from the app">Remove</button>
            </div>
          }
        </div>
        @for (p of photos().photos; track p.name) {
          @if (p.trim) { <p class="line hint">{{ p.trim }}</p> }
        }
        @if (notesOpen()) {
          <p class="hint">A note says what the photo shows and when it fits. The photo ranking reads these notes. Drafts are marked until you save your own.</p>
          <div class="notes">
            @for (p of photos().photos; track p.name) {
              <label class="note">
                <span class="note-name">{{ p.name }}{{ p.draft ? ' (draft)' : '' }}</span>
                <input type="text" #noteBox [value]="p.note ?? ''" (keydown.enter)="saveNote(p.name, noteBox.value)" />
                <button mat-stroked-button (click)="saveNote(p.name, noteBox.value)" [disabled]="busy()">Save</button>
              </label>
            }
          </div>
        }
      </section>

      <section>
        <h3>Logo</h3>
        <div class="row">
          @if (logo().logo; as lg) {
            <img class="logo-thumb" [src]="lg.preview" [alt]="lg.name" />
            <span [title]="lg.file">{{ lg.name }} ({{ lg.width }}x{{ lg.height }}), kept in the app</span>
          } @else {
            <span>No logo. Thumbnails are drawn without one.</span>
          }
          <button mat-stroked-button (click)="chooseLogo()" [disabled]="busy()">{{ logo().logo ? 'Replace…' : 'Add logo…' }}</button>
          @if (logo().offer; as offer) {
            <span>{{ offer.from }} is not in the app yet.</span>
            <button mat-flat-button color="primary" (click)="copyOldLogo()" [disabled]="busy()">Copy it into the app</button>
          }
        </div>
      </section>

      @if (style(); as s) {
        <section>
          <h3>Look <span class="hint">{{ stored() ? 'your saved look' : 'the default look (nothing saved yet)' }}</span></h3>
          <div class="look">
            <label class="field"><span class="label">Font</span>
              <input type="text" [ngModel]="s.font" (ngModelChange)="set('font', $event)" /></label>
            <label class="field"><span class="label">Letters</span>
              <input type="color" [ngModel]="s.fill" (ngModelChange)="set('fill', $event)" /></label>
            <label class="field"><span class="label">Outline</span>
              <input type="color" [ngModel]="s.stroke" (ngModelChange)="set('stroke', $event)" /></label>
            <label class="field"><span class="label">Outline thickness (% of letter size)</span>
              <input type="number" min="0" max="30" step="1" [ngModel]="pct(s.strokeRatio)" (ngModelChange)="set('strokeRatio', $event / 100)" /></label>
            <label class="check"><input type="checkbox" [ngModel]="s.patch" (ngModelChange)="set('patch', $event)" /> Soft dark patch behind the words</label>
            <label class="field"><span class="label">Patch darkness (%)</span>
              <input type="number" min="0" max="100" step="5" [ngModel]="pct(s.patchDarken)" (ngModelChange)="set('patchDarken', $event / 100)" /></label>
            <label class="check"><input type="checkbox" [ngModel]="s.vignette" (ngModelChange)="set('vignette', $event)" /> Dark edges</label>
            <label class="field"><span class="label">Edge darkness (%)</span>
              <input type="number" min="0" max="100" step="5" [ngModel]="pct(s.vignetteStrength)" (ngModelChange)="set('vignetteStrength', $event / 100)" /></label>
            <label class="field"><span class="label">Photo outline (px at 1080p, 0 for none)</span>
              <input type="number" min="0" max="40" step="1" [ngModel]="s.reactionOutlinePx" (ngModelChange)="set('reactionOutlinePx', $event)" /></label>
            <label class="field"><span class="label">Photo below the bottom edge (% of its height)</span>
              <input type="number" min="0" max="50" step="5" [ngModel]="pct(s.reactionBleed)" (ngModelChange)="set('reactionBleed', $event / 100)" /></label>
            <label class="field" title="Words are kept off faces while they can be this big; below it they are drawn smaller where they cover the least of a face. They are never refused."><span class="label">Smallest letters kept off faces (% of height)</span>
              <input type="number" min="5" max="40" step="1" [ngModel]="pct(s.minCapFraction)" (ngModelChange)="set('minCapFraction', $event / 100)" /></label>
            <label class="field"><span class="label">Largest letters (% of height)</span>
              <input type="number" min="5" max="50" step="1" [ngModel]="pct(s.maxCapFraction)" (ngModelChange)="set('maxCapFraction', $event / 100)" /></label>
            @for (slot of slots; track slot.key) {
              <div class="slot">
                <span class="label">{{ slot.label }}, % of the picture:</span>
                @for (k of edges; track k.key) {
                  <label class="mini"><span>{{ k.label }}</span>
                    <input type="number" min="0" max="100" step="0.5" [ngModel]="pct(s[slot.key][k.key])" (ngModelChange)="setSlot(slot.key, k.key, $event)" /></label>
                }
              </div>
            }
          </div>
          <p class="hint">The words go in the box from the left edge to where your reaction photo begins, on one or two lines.</p>
          <div class="row">
            <button mat-flat-button color="primary" (click)="saveStyle()" [disabled]="busy()">Save look</button>
            <button mat-stroked-button (click)="loadStyle('Put back to the saved look.')" [disabled]="busy()">Put back the saved look</button>
            @if (styleLine(); as line) { <span class="hint">{{ line }}</span> }
          </div>
        </section>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Close</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .look-dialog { font-family: var(--font-family); font-size: 13px; color: var(--text-primary); min-width: 640px; }
    section { border-top: 1px solid var(--border-color); padding-top: 10px; margin-top: 10px; }
    h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
    .hint { color: var(--text-secondary); font-size: 12px; font-weight: 400; }
    .error { color: var(--danger-text); }
    .line { margin: 4px 0; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 0; }
    .photos { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
    .photo { display: flex; flex-direction: column; align-items: center; gap: 2px; width: 96px;
      img { height: 72px; max-width: 96px; object-fit: contain; background: var(--bg-secondary); border-radius: 4px; }
      .name { font-size: 12px; text-align: center; }
      .remove { font-size: 12px; background: none; border: none; color: var(--text-secondary); cursor: pointer; text-decoration: underline; }
    }
    .logo-thumb { height: 40px; }
    .notes { display: flex; flex-direction: column; gap: 4px; }
    .note { display: flex; align-items: center; gap: 8px;
      .note-name { width: 160px; flex: 0 0 auto; }
      input { flex: 1; font: inherit; padding: 4px 6px; }
    }
    .look { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; }
    .field { display: flex; flex-direction: column; gap: 2px;
      input { font: inherit; padding: 3px 6px; max-width: 200px; }
    }
    .label { font-size: 12px; color: var(--text-secondary); }
    .check { display: flex; align-items: center; gap: 6px; }
    .slot { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .mini { display: flex; align-items: center; gap: 4px; font-size: 12px; input { width: 64px; font: inherit; } }
  `],
})
export class ThumbnailLookDialog implements OnInit {
  private readonly electron = inject(ElectronService);

  readonly photos = signal<LookPhotos>({ folder: '', photos: [], offer: null });
  readonly logo = signal<LookLogo>({ logo: null, offer: null });
  readonly style = signal<LookStyle | null>(null);
  readonly stored = signal(false);
  readonly notesOpen = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly photoLine = signal<string | null>(null);
  readonly styleLine = signal<string | null>(null);

  readonly slots: Array<{ key: 'reactionSlot' | 'logoSlot'; label: string }> = [
    { key: 'reactionSlot', label: 'Your reaction photo (right side and bottom anchored)' },
    { key: 'logoSlot', label: 'Logo (fitted inside, top right)' },
  ];
  readonly edges: Array<{ key: keyof LookSlot; label: string }> = [
    { key: 'x', label: 'left' }, { key: 'y', label: 'top' }, { key: 'w', label: 'width' }, { key: 'h', label: 'height' },
  ];

  async ngOnInit(): Promise<void> {
    await this.attempt(async () => {
      this.photos.set(await this.electron.thumbnailsPhotos());
      await this.loadStyle(null);
    });
    // Its own attempt: a kept logo that cannot be read is said by name without hiding the rest.
    await this.attempt(async () => this.logo.set(await this.electron.thumbnailsLogo()));
  }

  private async attempt(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await fn();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  // ── photos ─────────────────────────────────────────────────────────────────

  async addPhotos(): Promise<void> {
    this.photoLine.set(null);
    await this.attempt(async () => {
      let out = await this.electron.thumbnailsChoosePhotos();
      if (out === null) return;
      if (out.already.length > 0) {
        const names = out.already.map((n) => `"${n}"`).join(', ');
        if (!window.confirm(`Already in your reaction photos: ${names}. Replace ${out.already.length === 1 ? 'it' : 'them'} with the chosen file${out.already.length === 1 ? '' : 's'}? (Nothing was added yet.)`)) {
          this.photoLine.set(`Nothing added: ${names} ${out.already.length === 1 ? 'is' : 'are'} already there.`);
          return;
        }
        out = await this.electron.thumbnailsAddPhotos(out.chosen, true);
      }
      this.photoLine.set(`Added ${out.added.length}${out.replaced.length ? `, replaced ${out.replaced.length}` : ''}. They are kept in the app from now on.`);
      this.photos.set(await this.electron.thumbnailsPhotos());
    });
  }

  async removePhoto(name: string): Promise<void> {
    if (!window.confirm(`Remove "${name}" from your reaction photos? Only the app's copy goes; your note for it stays.`)) return;
    await this.attempt(async () => {
      await this.electron.thumbnailsRemovePhoto(name);
      this.photoLine.set(`Removed "${name}".`);
      this.photos.set(await this.electron.thumbnailsPhotos());
    });
  }

  async copyOldPhotos(): Promise<void> {
    await this.attempt(async () => {
      const out = await this.electron.thumbnailsCopyOldPhotos();
      this.photoLine.set(`Copied ${out.added.length} photos into the app. Your originals were not touched.`);
      this.photos.set(await this.electron.thumbnailsPhotos());
    });
  }

  async saveNote(name: string, note: string): Promise<void> {
    await this.attempt(async () => {
      await this.electron.thumbnailsSetPhotoNote(name, note);
      this.photos.set(await this.electron.thumbnailsPhotos());
      this.photoLine.set(`Saved the note for "${name}".`);
    });
  }

  // ── logo ───────────────────────────────────────────────────────────────────

  async chooseLogo(): Promise<void> {
    await this.attempt(async () => {
      const picked = await this.electron.thumbnailsChooseLogo();
      if (picked !== null) this.logo.set(picked);
    });
  }

  async copyOldLogo(): Promise<void> {
    await this.attempt(async () => this.logo.set(await this.electron.thumbnailsCopyOldLogo()));
  }

  // ── the look ───────────────────────────────────────────────────────────────

  async loadStyle(line: string | null): Promise<void> {
    const { style, stored } = await this.electron.thumbnailsGetStyle();
    this.style.set(style);
    this.stored.set(stored);
    this.styleLine.set(line);
  }

  set<K extends keyof LookStyle>(key: K, value: LookStyle[K]): void {
    const style = this.style();
    if (style !== null) this.style.set({ ...style, [key]: value });
  }

  setSlot(slot: 'reactionSlot' | 'logoSlot', key: keyof LookSlot, percent: number): void {
    const style = this.style();
    if (style !== null) this.style.set({ ...style, [slot]: { ...style[slot], [key]: percent / 100 } });
  }

  pct(value: number): number {
    return Math.round(value * 1000) / 10;
  }

  async saveStyle(): Promise<void> {
    const style = this.style();
    if (style === null) return;
    await this.attempt(async () => {
      this.style.set(await this.electron.thumbnailsSetStyle(style));
      this.stored.set(true);
      this.styleLine.set('Saved. Thumbnails drawn from now on use this look.');
    });
  }
}
