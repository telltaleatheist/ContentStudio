/**
 * TRIMMING A REACTION CUT-OUT to the person in it (Owen's photos, 2026-09-28).
 *
 * Owen's cut-outs are 1920x1080 PNGs with the person on a mostly transparent canvas, and some carry
 * small stray opaque specks away from the person (selfie horrified.png has dark bars along the
 * bottom edge). Trimming to the canvas's opaque bounds would keep those specks and misplace the
 * person in the slot, so the trim keeps only the person:
 *
 *   1. a pixel is SOLID when its alpha is at least ALPHA_SOLID;
 *   2. solid pixels are grouped by 8-neighbour connection, and the LARGEST group is the person
 *      (everything touching it is part of that group, so a microphone arm or a hand stays);
 *   3. the kept area is that group grown by EDGE_GROW pixels, so the soft, partly transparent edge
 *      around the person (hair, anti-aliasing) survives; every pixel outside it is cleared;
 *   4. the photo is cut to the kept area's bounds.
 *
 * Every other group is a speck and is dropped; how many pixels that removed is returned so the
 * render can say it (Law 8).
 *
 * PURE: an alpha plane in, a mask and a box out. The pixels are read and written by
 * reaction-photos.ts (Electron's nativeImage).
 */

/** Alpha at or above this is part of the person, not a soft edge. */
export const ALPHA_SOLID = 128;

/** How far (pixels) the kept area reaches beyond the solid person, to keep the soft edge. */
export const EDGE_GROW = 3;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TrimResult {
  /** 1 where the pixel is kept, 0 where it is cleared; the full canvas's size. */
  keep: Uint8Array;
  /** The kept area's bounds on the canvas. */
  box: Box;
  /** Solid pixels in the person. */
  personPixels: number;
  /** Solid pixels dropped as specks, and how many separate specks. */
  droppedPixels: number;
  droppedGroups: number;
}

export function trimToPerson(alpha: Uint8Array, width: number, height: number, what: string): TrimResult {
  if (alpha.length !== width * height) throw new Error(`${what}: the alpha plane has ${alpha.length} values for a ${width}x${height} picture.`);
  const n = width * height;
  const label = new Int32Array(n);
  const sizes: number[] = [0];
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (alpha[start] < ALPHA_SOLID || label[start] !== 0) continue;
    const id = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = id;
    let size = 0;
    while (head < tail) {
      const p = queue[head++];
      size++;
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if ((dx === 0 && dy === 0) || xx < 0 || xx >= width) continue;
          const q = yy * width + xx;
          if (label[q] === 0 && alpha[q] >= ALPHA_SOLID) {
            label[q] = id;
            queue[tail++] = q;
          }
        }
      }
    }
    sizes.push(size);
  }
  if (sizes.length === 1) throw new Error(`${what} has no opaque content: nothing in it is at least ${ALPHA_SOLID}/255 opaque.`);
  let person = 1;
  for (let id = 2; id < sizes.length; id++) if (sizes[id] > sizes[person]) person = id;

  // Grow the person by EDGE_GROW (a square neighbourhood), then take the bounds.
  const keep = new Uint8Array(n);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let p = 0; p < n; p++) {
    if (label[p] !== person) continue;
    const x = p % width;
    const y = (p - x) / width;
    for (let yy = Math.max(0, y - EDGE_GROW); yy <= Math.min(height - 1, y + EDGE_GROW); yy++) {
      for (let xx = Math.max(0, x - EDGE_GROW); xx <= Math.min(width - 1, x + EDGE_GROW); xx++) {
        const q = yy * width + xx;
        if (keep[q] === 1) continue;
        // A grown pixel keeps only soft edge, never another group's solid pixels.
        if (label[q] !== 0 && label[q] !== person) continue;
        keep[q] = 1;
        if (xx < x0) x0 = xx;
        if (xx > x1) x1 = xx;
        if (yy < y0) y0 = yy;
        if (yy > y1) y1 = yy;
      }
    }
  }
  let droppedPixels = 0;
  for (let id = 1; id < sizes.length; id++) if (id !== person) droppedPixels += sizes[id];
  return {
    keep,
    box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
    personPixels: sizes[person],
    droppedPixels,
    droppedGroups: sizes.length - 2,
  };
}

/** The name a photo is listed by: the file name without `selfie ` in front and without `.png`. */
export function photoName(fileName: string): string {
  return fileName.replace(/\.png$/i, '').replace(/^selfie\s+/i, '').trim();
}
