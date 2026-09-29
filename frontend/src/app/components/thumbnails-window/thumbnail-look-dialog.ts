import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { ElectronService } from '../../services/electron';
import type { LookBorder, LookLogo, LookPhotos, LookSlot, LookStyle } from './thumbnails.types';

/**
 * THUMBNAIL LOOK: the one look for all three channels (Owen, 2026-09-28): the reaction photos (add,
 * remove), the logo, the border overlay (2026-09-29), and the font, colours, text size and spaces.
 * Moved here from the retired Thumbnails test tab. (The photo notes went 2026-09-29 with the model's
 * photo ranking that read them: Owen picks the photos himself.) Opened from the reports page's Thumbnails window and from Settings; the metadata run
 * reads the same saved settings at job time, and the window's redraws use them at once.
 *
 * Every change to the photos, the logo and the border file is saved when it is made (they are files
 * copied into the app); the look (including whether the border is drawn) is saved with "Save look",
 * because a half-typed number should not redraw anything.
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
            <div class="photo" [title]="p.name">
              <img [src]="p.preview" [alt]="p.name" />
              <span class="name">{{ p.name }}</span>
              <button class="remove" (click)="removePhoto(p.name)" [disabled]="busy()" [attr.aria-label]="'Remove ' + p.name" title="Remove from the app">Remove</button>
            </div>
          }
        </div>
        @for (p of photos().photos; track p.name) {
          @if (p.trim) { <p class="line hint">{{ p.trim }}</p> }
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

      <section>
        <h3>Border</h3>
        <div class="row">
          @if (border().border; as b) {
            <img class="border-thumb" [src]="b.preview" [alt]="b.name" />
            <span [title]="b.file">{{ b.name }} ({{ b.width }}x{{ b.height }}), kept in the app</span>
          } @else {
            <span>No border. Thumbnails are drawn without one.</span>
          }
          <button mat-stroked-button (click)="chooseBorder()" [disabled]="busy()"
                  title="A PNG the size of a thumbnail with a transparent middle: drawn over the whole picture, under the words, photo and logo">{{ border().border ? 'Replace…' : 'Choose file…' }}</button>
          @if (style(); as s) {
            <label class="check" [title]="border().border ? 'Draw the border on every thumbnail (saved with Save look)' : 'No border file is kept'">
              <input type="checkbox" [ngModel]="s.border" (ngModelChange)="set('border', $event)" /> Draw the border</label>
          }
        </div>
      </section>

      @if (style(); as s) {
        <section>
          <h3>Look <span class="hint">{{ stored() ? 'your saved look' : 'the default look (nothing saved yet)' }}</span></h3>
          @if (storedLine(); as l) { <p class="hint">{{ l }}</p> }
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
            <label class="field"><span class="label">Photo outline (px at 1080p, 0 for none)</span>
              <input type="number" min="0" max="40" step="1" [ngModel]="s.reactionOutlinePx" (ngModelChange)="set('reactionOutlinePx', $event)" /></label>
            <label class="field"><span class="label">Photo below the bottom edge (% of its height)</span>
              <input type="number" min="0" max="50" step="5" [ngModel]="pct(s.reactionBleed)" (ngModelChange)="set('reactionBleed', $event / 100)" /></label>
            <label class="field" title="Words are kept off faces while they can be this big; below it they are drawn smaller where they cover the least of a face. They are never refused."><span class="label">Smallest letters kept off faces (% of height)</span>
              <input type="number" min="5" max="40" step="1" [ngModel]="pct(s.minCapFraction)" (ngModelChange)="set('minCapFraction', $event / 100)" /></label>
            <label class="field"><span class="label">Largest letters (% of height)</span>
              <input type="number" min="5" max="50" step="1" [ngModel]="pct(s.maxCapFraction)" (ngModelChange)="set('maxCapFraction', $event / 100)" /></label>
            <label class="field" title="100% fills the space the words fit; 85% (the default) draws them 15% smaller"><span class="label">Text size (% of the largest that fits)</span>
              <input type="number" min="50" max="100" step="5" [ngModel]="pct(s.textScale)" (ngModelChange)="set('textScale', $event / 100)" /></label>
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
    .border-thumb { width: 160px; aspect-ratio: 16 / 9; background: #7a7a7a; border-radius: 3px; }
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
  readonly border = signal<LookBorder>({ border: null });
  readonly stored = signal(false);
  /** Said when the saved look was read with newer defaults (text size, border). */
  readonly storedLine = signal<string | null>(null);
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
    // Their own attempts: a kept logo or border that cannot be read is said by name without hiding the rest.
    await this.attempt(async () => this.logo.set(await this.electron.thumbnailsLogo()));
    await this.attempt(async () => this.border.set(await this.electron.thumbnailsBorder()));
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
    if (!window.confirm(`Remove "${name}" from your reaction photos? Only the app's copy goes.`)) return;
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

  // ── border ─────────────────────────────────────────────────────────────────

  async chooseBorder(): Promise<void> {
    await this.attempt(async () => {
      const picked = await this.electron.thumbnailsChooseBorder();
      if (picked !== null) this.border.set(picked);
    });
  }

  // ── the look ───────────────────────────────────────────────────────────────

  async loadStyle(line: string | null): Promise<void> {
    const { style, stored, line: storedLine } = await this.electron.thumbnailsGetStyle();
    this.style.set(style);
    this.stored.set(stored);
    this.storedLine.set(storedLine);
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
      this.storedLine.set(null);
      this.styleLine.set('Saved. Thumbnails drawn from now on use this look.');
    });
  }
}
