/**
 * THE THUMBNAIL CANVAS: a hidden, offscreen Chromium page that does the three things this feature
 * needs a browser engine for, all deterministic and all on the CPU/OS, never a model:
 *
 *   1. FACE BOXES. Chromium's FaceDetector (the Shape Detection API). On macOS it is Apple Vision's
 *      face detector underneath (the GPU helper logs `VNFaceDetectorRevision2` when it runs), so
 *      this is "Apple Vision via a small helper" without shipping a helper binary: Electron already
 *      carries it. It is behind Chromium's experimental-features flag, which is switched on for THIS
 *      window only (`experimentalFeatures`), never app-wide. A page without the API is refused by
 *      name; nothing guesses a face. The Thumbnails window asks for a frame's faces here too, so its
 *      live preview places the words where the final render will.
 *   2. MEASURING the phrase in the chosen font (shared/thumbnail-draw.ts `measurePhrase`).
 *   3. DRAWING the thumbnail (shared/thumbnail-draw.ts `paintThumbnail`), exactly where
 *      shared/thumbnail-layout.ts `composeThumbnail` placed everything.
 *
 * Measuring and drawing are shared with the Thumbnails window's live preview (2026-09-29, the card
 * editor): the SAME functions, injected here as source (`fn.toString()`) and called there directly,
 * so a card and its saved PNG are drawn by one piece of code. Every function run in the page is
 * SELF-CONTAINED: no imports, no helpers from any module, nothing but its argument.
 *
 * Images cross as data URLs (bytes read in the main process), so the page never reads the disk and
 * its canvas is never tainted.
 */
import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { measurePhrase, paintThumbnail } from '../../shared/thumbnail-draw';
import type { PhraseMetrics, Rect, TextPlan, ThumbnailStyle } from '../../shared/thumbnail-layout';

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
 * How long one page call (a face search, a measure, a drawing) may take before it is refused. A
 * drawing takes well under a second; Owen's Generate hung with no end (2026-09-29), so a call that
 * never answers now fails by name and the page is thrown away (the next call makes a new one).
 */
export const CANVAS_CALL_SECONDS = 45;

/** The script that runs `fn` (self-contained) on `arg` in the page, then `then` on its result. */
function script(fn: (...args: any[]) => unknown, arg: unknown, then = 'out => out'): string {
  return `Promise.resolve((${fn.toString()})(${JSON.stringify(arg)})).then(${then})`;
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
        // backgroundThrottling off: a hidden page's image decoding and timers may otherwise be held back.
        // NOT `offscreen`: the page only draws on its own canvas and reads it back (toDataURL), so it
        // never needs its frames painted for us. An offscreen page closed after a save is the suspect in
        // the app crashing after thumbnails were made (2026-09-30, and 2026-10-04 21 s after "saved
        // the cards": EXC_BAD_ACCESS in objc_release on the main thread, LEDGER #257).
        webPreferences: { experimentalFeatures: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
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

  private async call<R>(name: string, source: string): Promise<R> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const win = this.window;
        this.window = null;
        this.ready = null;
        if (win !== null && !win.isDestroyed()) win.destroy();
        reject(new Error(`The thumbnail drawing page did not answer within ${CANVAS_CALL_SECONDS} s (${name}); it was closed, and the next try opens a new one.`));
      }, CANVAS_CALL_SECONDS * 1000);
    });
    try {
      return await Promise.race([
        (async () => {
          const win = await this.page();
          return (await win.webContents.executeJavaScript(source, true)) as R;
        })(),
        limit,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The faces Apple Vision finds in the image, in the image's own pixels. */
  async detectFaces(image: string): Promise<Rect[]> {
    const out = await this.call<Rect[] | { error: string }>('faces', script(pageDetectFaces, { image }));
    if (!Array.isArray(out)) throw new Error(`The face detector could not run: ${out.error}.`);
    return out;
  }

  /** The phrase's words measured at `size` px in the style's font, or a refusal naming a missing font. */
  async measure(font: string, words: string[], size: number): Promise<Omit<PhraseMetrics, 'words'>> {
    const out = await this.call<Omit<PhraseMetrics, 'words'> | { error: string }>('measure', script(measurePhrase, { font, words, size }));
    if ('error' in out) throw new Error(`The thumbnail text cannot be measured: ${out.error}.`);
    return out;
  }

  /** Draw one thumbnail; PNG when `jpegQuality` is null. Returns a data URL. */
  async draw(input: {
    image: string;
    /** Where the frame is drawn (composeThumbnail `frame`); null: over the whole picture. */
    frame: Rect | null;
    width: number;
    height: number;
    style: ThumbnailStyle;
    /** The border overlay as a data URL, or null for none. */
    border: string | null;
    plan: TextPlan | null;
    reaction: { image: string; x: number; y: number; w: number; h: number; outlinePx: number } | null;
    logo: { image: string; x: number; y: number; w: number; h: number } | null;
    jpegQuality: number | null;
  }): Promise<string> {
    const arg = {
      image: input.image,
      frame: input.frame,
      width: input.width,
      height: input.height,
      style: {
        font: input.style.font,
        fill: input.style.fill,
        stroke: input.style.stroke,
        patch: input.style.patch,
        patchDarken: input.style.patchDarken,
      },
      border: input.border,
      plan: input.plan === null ? null : { size: input.plan.size, capPx: input.plan.capPx, strokePx: input.plan.strokePx, lines: input.plan.lines, patches: input.plan.linePatches },
      reaction: input.reaction,
      logo: input.logo,
    };
    const encode = input.jpegQuality === null ? `canvas => canvas.toDataURL('image/png')` : `canvas => canvas.toDataURL('image/jpeg', ${JSON.stringify(input.jpegQuality)})`;
    return this.call<string>('draw', script(paintThumbnail, arg, encode));
  }

  close(): void {
    this.window?.destroy();
    this.window = null;
    this.ready = null;
  }
}
