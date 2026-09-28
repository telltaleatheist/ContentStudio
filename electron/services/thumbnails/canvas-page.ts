/**
 * THE THUMBNAIL CANVAS: a hidden, offscreen Chromium page that does the three things this feature
 * needs a browser engine for, all deterministic and all on the CPU/OS, never a model:
 *
 *   1. FACE BOXES. Chromium's FaceDetector (the Shape Detection API). On macOS it is Apple Vision's
 *      face detector underneath (the GPU helper logs `VNFaceDetectorRevision2` when it runs), so
 *      this is "Apple Vision via a small helper" without shipping a helper binary: Electron already
 *      carries it. It is behind Chromium's experimental-features flag, which is switched on for THIS
 *      window only (`experimentalFeatures`), never app-wide. A page without the API is refused by
 *      name; nothing guesses a face.
 *   2. MEASURING the phrase in the chosen font (canvas measureText), after checking the font is
 *      really installed: a family the system lacks silently renders in a default face, so the
 *      page compares against two generic families and refuses a font that matches both.
 *   3. DRAWING the thumbnail: the frame, the vignette, the soft blurred and darkened patch, and the
 *      outlined letters, exactly where layout.ts placed them. The reserved slots are left EMPTY.
 *
 * The page functions below are injected as source (`fn.toString()`), so each is SELF-CONTAINED:
 * no imports, no helpers from this module, nothing but its argument. They run in the page.
 *
 * Images cross as data URLs (bytes read in the main process), so the page never reads the disk and
 * its canvas is never tainted.
 */
import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { PhraseMetrics, Rect, TextPlan, ThumbnailStyle } from './layout';

// ── in the page ─────────────────────────────────────────────────────────────

async function pageDetectFaces(arg: { image: string }): Promise<Array<{ x: number; y: number; w: number; h: number }> | { error: string }> {
  const g = globalThis as any;
  const Detector = g.FaceDetector;
  if (Detector === undefined) return { error: 'this Chromium has no FaceDetector (the Shape Detection API is not available in the thumbnail canvas)' };
  const img = new g.Image();
  img.src = arg.image;
  await img.decode();
  const faces: any[] = await new Detector({ fastMode: false, maxDetectedFaces: 10 }).detect(img);
  return faces.map((f: any) => ({ x: f.boundingBox.x, y: f.boundingBox.y, w: f.boundingBox.width, h: f.boundingBox.height }));
}

function pageMeasure(arg: { font: string; words: string[]; size: number }): { wordWidths: number[]; spaceWidth: number; capHeight: number } | { error: string } {
  const g = globalThis as any;
  const ctx = g.document.createElement('canvas').getContext('2d');
  if (ctx === null) return { error: 'the canvas has no 2D context' };
  const probe = 'WWWiiiMMMlll0123';
  const width = (font: string) => { ctx.font = font; return ctx.measureText(probe).width; };
  const family = `"${arg.font}"`;
  if (width(`${arg.size}px ${family}, monospace`) === width(`${arg.size}px monospace`) && width(`${arg.size}px ${family}, serif`) === width(`${arg.size}px serif`)) {
    return { error: `the font "${arg.font}" is not installed on this computer` };
  }
  ctx.font = `${arg.size}px ${family}`;
  const wordWidths = arg.words.map((w) => ctx.measureText(w).width);
  const spaceWidth = ctx.measureText('H H').width - ctx.measureText('HH').width;
  const capHeight = ctx.measureText('H').actualBoundingBoxAscent;
  return { wordWidths, spaceWidth, capHeight };
}

async function pageDraw(arg: {
  image: string;
  width: number;
  height: number;
  style: { font: string; fill: string; stroke: string; patch: boolean; patchDarken: number; vignette: boolean; vignetteStrength: number };
  plan: { size: number; capPx: number; strokePx: number; lines: Array<{ text: string; x: number; y: number }>; patches: Array<{ x: number; y: number; w: number; h: number }> } | null;
  reaction: { image: string; x: number; y: number; w: number; h: number; outlinePx: number } | null;
  jpegQuality: number | null;
}): Promise<string> {
  const g = globalThis as any;
  const img = new g.Image();
  img.src = arg.image;
  await img.decode();
  const W = arg.width;
  const H = arg.height;
  const canvas = g.document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, W, H);

  if (arg.style.vignette && arg.style.vignetteStrength > 0) {
    const r = Math.hypot(W, H) / 2;
    const grad = ctx.createRadialGradient(W / 2, H / 2, r * 0.55, W / 2, H / 2, r);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, `rgba(0,0,0,${arg.style.vignetteStrength})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  const plan = arg.plan;
  if (plan !== null && arg.style.patch) {
    const feather = Math.max(2, plan.capPx * 0.3);
    const soft = g.document.createElement('canvas');
    soft.width = W;
    soft.height = H;
    const sctx = soft.getContext('2d');
    sctx.filter = `blur(${Math.max(2, plan.capPx * 0.22)}px) brightness(${1 - arg.style.patchDarken})`;
    sctx.drawImage(canvas, 0, 0);
    sctx.filter = 'none';
    const mask = g.document.createElement('canvas');
    mask.width = W;
    mask.height = H;
    const mctx = mask.getContext('2d');
    mctx.filter = `blur(${feather / 2}px)`;
    mctx.fillStyle = '#000';
    const inset = feather / 2;
    mctx.beginPath();
    for (const p of plan.patches) {
      const rx = p.x + inset;
      const ry = p.y + inset;
      const rw = Math.max(1, p.w - 2 * inset);
      const rh = Math.max(1, p.h - 2 * inset);
      const radius = Math.min(rw, rh) * 0.2;
      mctx.moveTo(rx + radius, ry);
      mctx.arcTo(rx + rw, ry, rx + rw, ry + rh, radius);
      mctx.arcTo(rx + rw, ry + rh, rx, ry + rh, radius);
      mctx.arcTo(rx, ry + rh, rx, ry, radius);
      mctx.arcTo(rx, ry, rx + rw, ry, radius);
      mctx.closePath();
    }
    mctx.fill();
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(mask, 0, 0);
    ctx.drawImage(soft, 0, 0);
  }

  if (plan !== null) {
    ctx.font = `${plan.size}px "${arg.style.font}"`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    for (const line of plan.lines) {
      if (plan.strokePx > 0) {
        ctx.lineWidth = plan.strokePx;
        ctx.strokeStyle = arg.style.stroke;
        ctx.strokeText(line.text, line.x, line.y);
      }
      ctx.fillStyle = arg.style.fill;
      ctx.fillText(line.text, line.x, line.y);
    }
  }
  const r = arg.reaction;
  if (r !== null) {
    const photo = new g.Image();
    photo.src = r.image;
    await photo.decode();
    if (r.outlinePx > 0) {
      // The outline: the silhouette stamped around a circle of the outline's radius (two rings,
      // so no gap opens at the diagonals), filled white, under the photo itself.
      const ring = g.document.createElement('canvas');
      ring.width = W;
      ring.height = H;
      const rctx = ring.getContext('2d');
      for (const radius of [r.outlinePx, r.outlinePx / 2]) {
        for (let k = 0; k < 36; k++) {
          const a = (k / 36) * Math.PI * 2;
          rctx.drawImage(photo, r.x + Math.cos(a) * radius, r.y + Math.sin(a) * radius, r.w, r.h);
        }
      }
      rctx.globalCompositeOperation = 'source-in';
      rctx.fillStyle = '#ffffff';
      rctx.fillRect(0, 0, W, H);
      ctx.drawImage(ring, 0, 0);
    }
    ctx.drawImage(photo, r.x, r.y, r.w, r.h);
  }
  return arg.jpegQuality === null ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', arg.jpegQuality);
}

// ── in the main process ─────────────────────────────────────────────────────

/** The page this module drives: electron/assets/thumbnails/canvas.html, found from the app root. */
export function canvasPagePath(appRoot: string): string {
  return path.join(appRoot, 'electron', 'assets', 'thumbnails', 'canvas.html');
}

export function dataUrlOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const type = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : null;
  if (type === null) throw new Error(`${file} is not a PNG or JPEG.`);
  return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
}

export function bytesOfDataUrl(url: string): Buffer {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:image/') || comma < 0) throw new Error('The canvas returned something that is not an image.');
  return Buffer.from(url.slice(comma + 1), 'base64');
}

/**
 * One hidden page, made on first use and kept until `close()`. Calls are serialised by the page
 * itself (each is one executeJavaScript), so two renders never share a canvas.
 */
export class ThumbnailCanvas {
  private window: BrowserWindow | null = null;
  private ready: Promise<BrowserWindow> | null = null;

  constructor(private readonly pagePath: string) {}

  private page(): Promise<BrowserWindow> {
    if (this.ready !== null) return this.ready;
    if (!fs.existsSync(this.pagePath)) throw new Error(`The thumbnail canvas page is missing: ${this.pagePath}`);
    this.ready = (async () => {
      const win = new BrowserWindow({
        show: false,
        width: 320,
        height: 180,
        webPreferences: { offscreen: true, experimentalFeatures: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      win.on('closed', () => {
        this.window = null;
        this.ready = null;
      });
      await win.loadFile(this.pagePath);
      this.window = win;
      return win;
    })();
    return this.ready;
  }

  private async call<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
    const win = await this.page();
    return (await win.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg)})`, true)) as R;
  }

  /** The faces Apple Vision finds in the image, in the image's own pixels. */
  async detectFaces(image: string): Promise<Rect[]> {
    const out = await this.call(pageDetectFaces, { image });
    if (!Array.isArray(out)) throw new Error(`The face detector could not run: ${out.error}.`);
    return out;
  }

  /** The phrase's words measured at `size` px in the style's font, or a refusal naming a missing font. */
  async measure(font: string, words: string[], size: number): Promise<Omit<PhraseMetrics, 'words'>> {
    const out = await this.call(pageMeasure, { font, words, size });
    if ('error' in out) throw new Error(`The thumbnail text cannot be measured: ${out.error}.`);
    return out;
  }

  /** Draw one thumbnail; PNG when `jpegQuality` is null. Returns a data URL. */
  async draw(input: {
    image: string;
    width: number;
    height: number;
    style: ThumbnailStyle;
    plan: TextPlan | null;
    reaction: { image: string; x: number; y: number; w: number; h: number; outlinePx: number } | null;
    jpegQuality: number | null;
  }): Promise<string> {
    return this.call(pageDraw, {
      image: input.image,
      width: input.width,
      height: input.height,
      style: {
        font: input.style.font,
        fill: input.style.fill,
        stroke: input.style.stroke,
        patch: input.style.patch,
        patchDarken: input.style.patchDarken,
        vignette: input.style.vignette,
        vignetteStrength: input.style.vignetteStrength,
      },
      plan: input.plan === null ? null : { size: input.plan.size, capPx: input.plan.capPx, strokePx: input.plan.strokePx, lines: input.plan.lines, patches: input.plan.linePatches },
      reaction: input.reaction,
      jpegQuality: input.jpegQuality,
    });
  }

  close(): void {
    this.window?.destroy();
    this.window = null;
    this.ready = null;
  }
}
