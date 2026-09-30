import { AfterViewInit, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { PreviewPieces, Redrawer, drawCard } from './thumbnail-preview';
import { clampBox, clampFrame, clampPhoto, scaleBox, zoomFrame, type Card } from './thumbnails-compose';
import { textBoxOf, type CardAdjust, type Composition, type FrameView, type PhotoPlaceEdit, type Rect, type TextBoxEdit } from './thumbnail-shared';
import type { ComposeView } from './thumbnails.types';

export interface ThumbnailCardEditorData {
  card: Card;
  pieces: PreviewPieces;
  compose: Extract<ComposeView, { ok: true }>;
  /** The title the card goes with, for the heading; null when it is not saved as a pick. */
  title: string | null;
}

type Piece = 'frame' | 'text' | 'photo';

type Drag =
  | { mode: 'move' | 'size'; piece: 'frame'; start: { x: number; y: number }; from: FrameView }
  | { mode: 'move' | 'size'; piece: 'text'; start: { x: number; y: number }; from: TextBoxEdit }
  | { mode: 'move' | 'size'; piece: 'photo'; start: { x: number; y: number }; from: PhotoPlaceEdit; aspect: number };

const LABEL: Record<Piece, string> = { frame: 'Frame', text: 'Text', photo: 'Photo' };

/**
 * ONE CARD, LARGER, TO EDIT (the card editor, 2026-09-29, Owen: "i should be able to hit a zoom
 * button on a frame and resize (zoom/shrink) or reposition any of the three elements. logo goes in
 * top right automatically, border goes on top of the image automatically and neither of those two
 * should be edited").
 *
 * The three pieces the card has (the frame, the text, the photo) can each be moved (drag) and
 * resized (scroll wheel, the Size slider, or the corner handle). The frame zoomed in is a crop,
 * zoomed out a smaller frame on black. The words are fitted into the box he sizes (one or two
 * lines, as large as the box allows). The logo and border are drawn where the final render puts
 * them and cannot be picked. Each piece has its Reset. The preview is the final render's own layout
 * and drawing (thumbnail-preview.ts). Done hands back the edits (the window keeps them on the card,
 * not saved until Save thumbnails); Cancel drops them.
 */
@Component({
  selector: 'app-thumbnail-card-editor',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, MatProgressSpinnerModule],
  template: `
    <h2 mat-dialog-title>Edit thumbnail {{ data.card.n }}@if (data.title) { <span class="for"> · goes with “{{ data.title }}”</span> }</h2>
    <mat-dialog-content class="ed">
      <p class="hint">Click the frame, the text or the photo, then drag it to move it. Scroll, use the Size slider or drag the corner handle to make it bigger or smaller. Your logo and border are placed for you.</p>
      <div class="bar">
        @for (p of pieces; track p) {
          <button class="piece" [class.on]="selected() === p" (click)="selected.set(p)">{{ label(p) }}@if (edited(p)) { <span class="dot" title="Changed">•</span> }</button>
        }
        <span class="spacer"></span>
        <label class="size">Size
          <input type="range" [min]="range().min" [max]="range().max" step="1" [value]="sizeValue()" (input)="setSize(+$any($event.target).value)" />
          <span class="num">{{ sizeValue() }}%</span>
        </label>
        <button mat-stroked-button (click)="reset(selected())" [disabled]="!edited(selected())"
                [title]="edited(selected()) ? 'Put the ' + label(selected()).toLowerCase() + ' back where it was placed for you' : 'Not changed'">Reset {{ label(selected()).toLowerCase() }}</button>
      </div>
      <div class="stage" #stage (pointerdown)="down($event)" (pointermove)="move($event)" (pointerup)="up($event)" (pointercancel)="up($event)" (wheel)="wheel($event)">
        <canvas #canvas width="1280" height="720"></canvas>
        @if (shown(); as b) {
          <div class="sel" [style.left.%]="b.x" [style.top.%]="b.y" [style.width.%]="b.w" [style.height.%]="b.h">
            <span class="handle" title="Drag to resize" (pointerdown)="down($event, true)"></span>
          </div>
        }
        @if (loading()) { <span class="loading"><mat-spinner diameter="22"></mat-spinner></span> }
      </div>
      @if (error(); as e) { <p class="warn">{{ e }}</p> }
      @for (n of notes(); track $index) { <p class="hint">{{ n }}</p> }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="ref.close()">Cancel</button>
      <button mat-flat-button color="primary" (click)="done()">Done</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .ed { font-family: var(--font-family); font-size: 13px; color: var(--text-primary); }
    .for { font-weight: 400; font-size: 14px; color: var(--text-secondary); }
    .hint { color: var(--text-secondary); font-size: 12px; margin: 4px 0 8px; }
    .warn { color: var(--warning-text); font-size: 12px; margin: 6px 0 0; }
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
    .spacer { flex: 1; }
    .piece {
      font: inherit; padding: 5px 14px; border-radius: 14px; cursor: pointer;
      border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary);
      &.on { border-color: var(--primary-orange); box-shadow: inset 0 0 0 1px var(--primary-orange); font-weight: 600; }
      .dot { color: var(--primary-orange); margin-left: 4px; }
    }
    .size { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); }
    .size input { width: 180px; accent-color: var(--primary-orange); }
    .num { min-width: 42px; text-align: right; font-variant-numeric: tabular-nums; }
    .stage {
      position: relative; width: 100%; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 4px;
      background: #000; touch-action: none; cursor: move; user-select: none;
      canvas { width: 100%; height: 100%; display: block; }
    }
    .sel {
      position: absolute; box-sizing: border-box; border: 2px dashed var(--primary-orange); pointer-events: none;
      .handle {
        position: absolute; right: -8px; bottom: -8px; width: 16px; height: 16px; border-radius: 3px;
        background: var(--primary-orange); border: 2px solid #fff; pointer-events: auto; cursor: nwse-resize;
      }
    }
    .loading { position: absolute; top: 10px; right: 10px; }
  `],
})
export class ThumbnailCardEditor implements AfterViewInit {
  readonly data = inject<ThumbnailCardEditorData>(MAT_DIALOG_DATA);
  readonly ref = inject<MatDialogRef<ThumbnailCardEditor, CardAdjust>>(MatDialogRef);

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly stage = viewChild.required<ElementRef<HTMLDivElement>>('stage');

  /** The pieces on this card, in the order they are drawn. */
  readonly pieces: Piece[] = [
    'frame',
    ...(this.data.card.text !== null ? ['text' as const] : []),
    ...(this.data.card.photo !== null ? ['photo' as const] : []),
  ];
  readonly adjust = signal<CardAdjust>({ ...this.data.card.adjust });
  readonly selected = signal<Piece>('frame');
  readonly composition = signal<Composition | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly notes = signal<string[]>([]);
  private drag: Drag | null = null;
  private readonly W = this.data.compose.width;
  private readonly H = this.data.compose.height;

  private readonly redrawer = new Redrawer(async () => {
    this.loading.set(true);
    try {
      const drawn = await drawCard(this.canvas().nativeElement, { ...this.data.card, adjust: this.adjust() }, this.data.pieces, this.data.compose);
      this.composition.set(drawn?.composition ?? null);
      this.notes.set(drawn?.notes ?? []);
      this.error.set(null);
    } catch (err) {
      this.error.set(`This thumbnail cannot be drawn: ${(err as Error).message}`);
    } finally {
      this.loading.set(false);
    }
  });

  ngAfterViewInit(): void {
    this.redrawer.request();
  }

  label(p: Piece): string {
    return LABEL[p];
  }

  edited(p: Piece): boolean {
    return this.adjust()[p] !== undefined;
  }

  /** The selected piece's bounds as it is drawn, in percent of the picture (clipped to it), for the outline. */
  readonly shown = computed<Rect | null>(() => {
    const r = this.boundsOf(this.selected());
    if (r === null) return null;
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(this.W, r.x + r.w);
    const y1 = Math.min(this.H, r.y + r.h);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: (x0 / this.W) * 100, y: (y0 / this.H) * 100, w: ((x1 - x0) / this.W) * 100, h: ((y1 - y0) / this.H) * 100 };
  });

  /** Where a piece is drawn now, in output pixels, from the last drawing. */
  private boundsOf(p: Piece): Rect | null {
    const c = this.composition();
    if (c === null) return null;
    if (p === 'frame') return c.frame ?? { x: 0, y: 0, w: this.W, h: this.H };
    if (p === 'text') return c.plan?.patch ?? null;
    return c.reaction === null ? null : { x: c.reaction.x, y: c.reaction.y, w: c.reaction.w, h: c.reaction.h };
  }

  // ── each piece's place, as an edit (the automatic place turned into one on first touch) ──

  private frameNow(): FrameView {
    return this.adjust().frame ?? { x: 0, y: 0, scale: 1 };
  }

  private textNow(): TextBoxEdit | null {
    const a = this.adjust().text;
    if (a !== undefined) return a;
    const plan = this.composition()?.plan ?? null;
    return plan === null ? null : textBoxOf(plan, this.W, this.H);
  }

  private photoNow(): PhotoPlaceEdit | null {
    const a = this.adjust().photo;
    if (a !== undefined) return a;
    const r = this.composition()?.reaction ?? null;
    return r === null ? null : clampPhoto({ cx: (r.x + r.w / 2) / this.W, cy: (r.y + r.h / 2) / this.H, h: r.h / this.H });
  }

  private put(p: Piece, value: FrameView | TextBoxEdit | PhotoPlaceEdit): void {
    this.adjust.set({ ...this.adjust(), [p]: value });
    this.redrawer.request();
  }

  reset(p: Piece): void {
    const next = { ...this.adjust() };
    delete next[p];
    this.adjust.set(next);
    this.redrawer.request();
  }

  // ── size: slider and wheel ─────────────────────────────────────────────────

  readonly range = computed(() => {
    const p = this.selected();
    return p === 'frame' ? { min: 25, max: 500 } : p === 'text' ? { min: 3, max: 100 } : { min: 5, max: 200 };
  });

  /** The selected piece's size in percent: the frame's zoom, the text box's or the photo's height of the picture's. */
  sizeValue(): number {
    const p = this.selected();
    if (p === 'frame') return Math.round(this.frameNow().scale * 100);
    if (p === 'text') return Math.round((this.textNow()?.h ?? 0) * 100);
    return Math.round((this.photoNow()?.h ?? 0) * 100);
  }

  setSize(percent: number): void {
    const now = this.sizeValue();
    if (!(now > 0) || !(percent > 0)) return;
    this.resize(this.selected(), percent / now, null);
  }

  /** Make piece `p` `factor` times bigger, about a point of the picture (fractions) or its own centre. */
  private resize(p: Piece, factor: number, at: { x: number; y: number } | null): void {
    if (p === 'frame') {
      const f = this.frameNow();
      this.put('frame', zoomFrame(f, factor, at?.x ?? f.x + f.scale / 2, at?.y ?? f.y + f.scale / 2));
    } else if (p === 'text') {
      const b = this.textNow();
      if (b !== null) this.put('text', scaleBox(b, factor));
    } else {
      const ph = this.photoNow();
      if (ph !== null) this.put('photo', clampPhoto({ ...ph, h: ph.h * factor }));
    }
  }

  wheel(event: WheelEvent): void {
    event.preventDefault();
    const at = this.point(event);
    this.resize(this.selected(), Math.exp(-event.deltaY * 0.0015), { x: at.x / this.W, y: at.y / this.H });
  }

  // ── dragging ───────────────────────────────────────────────────────────────

  /** A pointer's place on the picture, in output pixels. */
  private point(event: MouseEvent): { x: number; y: number } {
    const r = this.stage().nativeElement.getBoundingClientRect();
    return { x: ((event.clientX - r.left) / r.width) * this.W, y: ((event.clientY - r.top) / r.height) * this.H };
  }

  private inside(r: Rect | null, p: { x: number; y: number }): boolean {
    return r !== null && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  }

  /** Press on the picture (picks the piece under it, topmost first) or on the corner handle (resizes the selected one). */
  down(event: PointerEvent, handle = false): void {
    event.stopPropagation();
    event.preventDefault();
    const at = this.point(event);
    let piece = this.selected();
    if (!handle) {
      piece = this.pieces.includes('photo') && this.inside(this.boundsOf('photo'), at) ? 'photo'
        : this.pieces.includes('text') && this.inside(this.boundsOf('text'), at) ? 'text'
        : 'frame';
      this.selected.set(piece);
    }
    const mode = handle ? 'size' : 'move';
    if (piece === 'frame') this.drag = { mode, piece, start: at, from: this.frameNow() };
    else if (piece === 'text') {
      const from = this.textNow();
      this.drag = from === null ? null : { mode, piece, start: at, from };
    } else {
      const from = this.photoNow();
      const r = this.composition()?.reaction ?? null;
      this.drag = from === null || r === null ? null : { mode, piece, start: at, from, aspect: r.w / r.h };
    }
    if (this.drag !== null) this.stage().nativeElement.setPointerCapture(event.pointerId);
  }

  move(event: PointerEvent): void {
    const d = this.drag;
    if (d === null) return;
    const at = this.point(event);
    const dx = (at.x - d.start.x) / this.W;
    const dy = (at.y - d.start.y) / this.H;
    if (d.piece === 'frame') {
      const f = d.from;
      this.put('frame', d.mode === 'move' ? clampFrame({ ...f, x: f.x + dx, y: f.y + dy }) : clampFrame({ ...f, scale: f.scale + Math.max(dx, dy) }));
    } else if (d.piece === 'text') {
      const b = d.from;
      this.put('text', d.mode === 'move' ? clampBox({ ...b, x: b.x + dx, y: b.y + dy }) : clampBox({ ...b, w: b.w + dx, h: b.h + dy }));
    } else {
      const p = d.from;
      if (d.mode === 'move') this.put('photo', clampPhoto({ ...p, cx: p.cx + dx, cy: p.cy + dy }));
      else {
        // The top-left corner stays; the photo keeps its shape.
        const h = Math.max(0.01, p.h + dy);
        const wFrac = (hh: number) => (hh * this.H * d.aspect) / this.W;
        const left = p.cx - wFrac(p.h) / 2;
        const top = p.cy - p.h / 2;
        this.put('photo', clampPhoto({ h, cx: left + wFrac(h) / 2, cy: top + h / 2 }));
      }
    }
  }

  up(event: PointerEvent): void {
    if (this.drag === null) return;
    this.drag = null;
    const el = this.stage().nativeElement;
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
  }

  done(): void {
    this.ref.close(this.adjust());
  }
}
