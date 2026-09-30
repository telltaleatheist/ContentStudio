/**
 * THE THUMBNAIL DRAWING, in one place for both processes (2026-09-29, the Thumbnails window's card
 * editor). Two functions, each SELF-CONTAINED (no imports, no helpers from this module, nothing but
 * its argument and the browser's globals), so each runs in two places unchanged:
 *
 *   - the final render: the hidden canvas page (services/thumbnails/canvas-page.ts) is handed the
 *     function's own source (`fn.toString()`) and runs it on data URLs;
 *   - the live preview: the Thumbnails window (frontend thumbnails-window/thumbnail-preview.ts,
 *     through thumbnail-shared.ts) calls it directly, handing it images already decoded, and copies
 *     the canvas it returns onto the card.
 *
 * Both draw with the SAME placement (thumbnail-layout.ts composeThumbnail), so what a card shows is
 * what Save thumbnails writes (LEDGER law 10: one drawing, not two copies that agree until they do
 * not). Moved here from canvas-page.ts's `pageMeasure` / `pageDraw` unchanged, with one addition:
 * a frame Owen moved or zoomed (`frame` not null) is drawn at that place on black.
 *
 * The order is the renderer's: the frame, Owen's border overlay (scaled to the picture, normal
 * alpha), the soft blurred and darkened patch, the outlined letters, the reaction photo (white
 * outline under it) and the logo on top.
 *
 * It must stay free of imports on both sides (the electron build has no DOM library, so the browser
 * objects are reached through `globalThis` as `any`).
 */

/** An image the drawing takes: a data URL (the page), or a picture already decoded (the window). */
export type DrawImage = string | object;

/**
 * The phrase's words measured at `size` px in `font` (canvas measureText), after checking the font
 * is really installed: a family the system lacks silently renders in a default face, so the width
 * of a probe is compared against two generic families and a font matching both is refused.
 */
export function measurePhrase(arg: { font: string; words: string[]; size: number }): { wordWidths: number[]; spaceWidth: number; capHeight: number } | { error: string } {
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

export interface PaintInput {
  image: DrawImage;
  /** Where the frame is drawn (composeThumbnail `frame`); null: over the whole picture. */
  frame: { x: number; y: number; w: number; h: number } | null;
  width: number;
  height: number;
  style: { font: string; fill: string; stroke: string; patch: boolean; patchDarken: number };
  border: DrawImage | null;
  plan: { size: number; capPx: number; strokePx: number; lines: Array<{ text: string; x: number; y: number }>; patches: Array<{ x: number; y: number; w: number; h: number }> } | null;
  reaction: { image: DrawImage; x: number; y: number; w: number; h: number; outlinePx: number } | null;
  logo: { image: DrawImage; x: number; y: number; w: number; h: number } | null;
}

/** Draw one thumbnail on a new canvas of width x height and return the canvas. */
export async function paintThumbnail(arg: PaintInput): Promise<any> {
  const g = globalThis as any;
  const load = async (src: unknown): Promise<any> => {
    if (typeof src !== 'string') return src;
    const img = new g.Image();
    img.src = src;
    await img.decode();
    return img;
  };
  const img = await load(arg.image);
  const W = arg.width;
  const H = arg.height;
  const canvas = g.document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  if (arg.frame === null) {
    ctx.drawImage(img, 0, 0, W, H);
  } else {
    // A frame Owen moved or zoomed: on black, where he put it (the canvas clips what runs off).
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, arg.frame.x, arg.frame.y, arg.frame.w, arg.frame.h);
  }

  if (arg.border !== null) {
    // Owen's border, over the whole frame and under everything else, scaled to the picture.
    const border = await load(arg.border);
    ctx.drawImage(border, 0, 0, W, H);
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
    const photo = await load(r.image);
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
  const l = arg.logo;
  if (l !== null) {
    // Already downscaled to exactly w x h in the main process: drawn 1:1 on whole pixels, on top.
    const logo = await load(l.image);
    ctx.drawImage(logo, l.x, l.y, l.w, l.h);
  }
  return canvas;
}
