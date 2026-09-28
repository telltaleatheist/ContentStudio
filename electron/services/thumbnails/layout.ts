/**
 * WHERE THE THUMBNAIL TEXT GOES AND HOW BIG IT IS. Deterministic arithmetic, no model.
 *
 * The inputs are the frame size, the face boxes a deterministic detector found (Apple Vision,
 * through canvas-page.ts; never the vision model's boxes, which are imprecise), the reserved slots
 * (Owen's reaction cut-out, bottom right, and the logo, top right: both reserved and rendered EMPTY
 * for now), the style, and the phrase's measurements at a reference size. The output is either a
 * placement the renderer draws exactly, or a plain refusal saying the phrase is too long.
 *
 * THE RULES (Owen, 2026-09-28):
 *   - the text never covers a face or a reserved slot;
 *   - left-aligned, at most two lines, fitted by shrinking from large;
 *   - the capital letters are never shorter than `minCapFraction` of the frame height (about 12%).
 *     A phrase that cannot fit at that size is TOO LONG: this says so and places nothing. It never
 *     shrinks below the floor and never truncates; the operator picks another option.
 *
 * HOW. The clear space is searched exhaustively: every rectangle whose edges lie on the frame's
 * margins or on an obstacle's edges, and which no obstacle cuts into, is a candidate (a handful of
 * obstacles gives a few thousand rectangles, all cheap). The phrase is fitted into each (every
 * one- and two-line split, largest size that fits both ways), and the candidate giving the
 * LARGEST letters wins; equal sizes prefer the lower, then the more left-hand, space — Owen's
 * usual bottom-left placement. The text sits against the frame edge its space touches.
 *
 * Measurements are taken ONCE by the page at REFERENCE_SIZE (canvas `measureText`) and scaled
 * linearly, so this module needs no canvas and tools/thumbnail-lab-checks.js runs it in plain Node.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A slot as fractions of the frame (0-1), so one setting fits any output size. */
export interface SlotFractions {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Everything about the look the operator can change. Stored under `thumbnailLab.style`. */
export interface ThumbnailStyle {
  /** A font family installed on this Mac. Checked before drawing; a missing font is refused. */
  font: string;
  /** Letter colour, `#RRGGBB`. */
  fill: string;
  /** Outline colour, `#RRGGBB`. */
  stroke: string;
  /** Outline thickness as a fraction of the font size. 0 draws no outline. */
  strokeRatio: number;
  /** The soft blurred, darkened patch behind the text (Owen's idea): on or off. */
  patch: boolean;
  /** How dark the patch is: 0 leaves the picture's brightness, 1 is black. */
  patchDarken: number;
  /** The dark border around the picture (Owen's current style has one). */
  vignette: boolean;
  /** How dark the vignette's edge gets, 0-1. */
  vignetteStrength: number;
  /** Owen's reaction cut-out: reserved and left empty until his photos exist. */
  reactionSlot: SlotFractions;
  /** The logo: reserved and left empty. */
  logoSlot: SlotFractions;
  /** The smallest capital-letter height allowed, as a fraction of the frame height. */
  minCapFraction: number;
  /** The largest capital-letter height used, as a fraction of the frame height. */
  maxCapFraction: number;
}

export const DEFAULT_STYLE: ThumbnailStyle = {
  font: 'Impact',
  fill: '#FF8000',
  stroke: '#000000',
  strokeRatio: 0.09,
  patch: true,
  patchDarken: 0.45,
  vignette: true,
  vignetteStrength: 0.6,
  // Measured off Owen's layout mock (roof.png, 1920x1080): the box at 1330-1880 x 600-1060.
  reactionSlot: { x: 0.69, y: 0.55, w: 0.29, h: 0.43 },
  // Where Owen's channel mark sits on his hand-made thumbnail (f2 - the rapture.png).
  logoSlot: { x: 0.9, y: 0.03, w: 0.075, h: 0.13 },
  minCapFraction: 0.12,
  maxCapFraction: 0.2,
};

/** The size the page measures the phrase at; everything else is scaled from it. */
export const REFERENCE_SIZE = 100;

/** The space kept between the picture's edge and anything placed on it, as a fraction of its height. */
export const MARGIN_FRACTION = 0.035;

/** The gap between the two lines, as a fraction of the capital height. */
export const LINE_GAP_OF_CAP = 0.18;

/** The patch reaches this far beyond the letters, as a fraction of the capital height. */
export const PATCH_PAD_OF_CAP = 0.25;

/**
 * How far a detected face box is grown before the text must avoid it, as fractions of the box.
 * Vision's box runs from the brows to the chin; the forehead and hair above it, and the ears
 * beside it, are part of the face a viewer sees.
 */
export const FACE_PAD = { left: 0.25, right: 0.25, top: 0.5, bottom: 0.1 } as const;

/** The phrase measured at REFERENCE_SIZE by the page (canvas measureText, in the style's font). */
export interface PhraseMetrics {
  /** The words, as they will be drawn. */
  words: string[];
  wordWidths: number[];
  spaceWidth: number;
  /** The height of a capital letter above the baseline (the ascent of "H"). */
  capHeight: number;
}

export interface PlacedLine {
  text: string;
  /** Left edge of the letters (before the outline). */
  x: number;
  /** The baseline. */
  y: number;
}

export interface TextPlan {
  /** Font size in pixels. */
  size: number;
  /** Capital-letter height in pixels. */
  capPx: number;
  strokePx: number;
  lines: PlacedLine[];
  /** The letters' extent, outline included. */
  block: Rect;
  /** The patch behind the letters (block plus its pad). */
  patch: Rect;
  /** The clear space the text was placed in. */
  space: Rect;
}

export type PlanResult = { ok: true; plan: TextPlan } | { ok: false; reason: string };

function num(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`The thumbnail style's ${what} is ${JSON.stringify(value)}; it must be a number from ${min} to ${max}.`);
  }
  return value;
}

function colour(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`The thumbnail style's ${what} is ${JSON.stringify(value)}; it must be a colour written #RRGGBB.`);
  }
  return value;
}

function slot(value: unknown, what: string): SlotFractions {
  const v = value as SlotFractions;
  if (!v || typeof v !== 'object') throw new Error(`The thumbnail style has no ${what}.`);
  const s = { x: num(v.x, `${what} left`, 0, 1), y: num(v.y, `${what} top`, 0, 1), w: num(v.w, `${what} width`, 0, 1), h: num(v.h, `${what} height`, 0, 1) };
  if (s.x + s.w > 1.0001 || s.y + s.h > 1.0001) throw new Error(`The thumbnail style's ${what} runs off the picture (${JSON.stringify(s)}).`);
  return s;
}

/** A stored or edited style, checked field by field. Any bad field throws naming it. */
export function validateStyle(value: unknown): ThumbnailStyle {
  const v = value as Partial<ThumbnailStyle>;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`The thumbnail style must be an object, got ${JSON.stringify(value)}.`);
  if (typeof v.font !== 'string' || v.font.trim() === '' || /[;{}"]/.test(v.font)) {
    throw new Error(`The thumbnail style's font is ${JSON.stringify(v.font)}; it must be a font family name.`);
  }
  if (typeof v.patch !== 'boolean') throw new Error(`The thumbnail style's patch setting must be on or off, got ${JSON.stringify(v.patch)}.`);
  if (typeof v.vignette !== 'boolean') throw new Error(`The thumbnail style's vignette setting must be on or off, got ${JSON.stringify(v.vignette)}.`);
  const style: ThumbnailStyle = {
    font: v.font.trim(),
    fill: colour(v.fill, 'letter colour'),
    stroke: colour(v.stroke, 'outline colour'),
    strokeRatio: num(v.strokeRatio, 'outline thickness', 0, 0.3),
    patch: v.patch,
    patchDarken: num(v.patchDarken, 'patch darkness', 0, 1),
    vignette: v.vignette,
    vignetteStrength: num(v.vignetteStrength, 'vignette strength', 0, 1),
    reactionSlot: slot(v.reactionSlot, 'reaction slot'),
    logoSlot: slot(v.logoSlot, 'logo slot'),
    minCapFraction: num(v.minCapFraction, 'smallest letter height', 0.05, 0.4),
    maxCapFraction: num(v.maxCapFraction, 'largest letter height', 0.05, 0.5),
  };
  if (style.maxCapFraction < style.minCapFraction) {
    throw new Error(`The thumbnail style's largest letter height (${style.maxCapFraction}) is below its smallest (${style.minCapFraction}).`);
  }
  return style;
}

export function slotRect(fractions: SlotFractions, width: number, height: number): Rect {
  return { x: fractions.x * width, y: fractions.y * height, w: fractions.w * width, h: fractions.h * height };
}

/** A detected face box grown by FACE_PAD, clipped to the frame. */
export function paddedFace(face: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, face.x - face.w * FACE_PAD.left);
  const y0 = Math.max(0, face.y - face.h * FACE_PAD.top);
  const x1 = Math.min(width, face.x + face.w * (1 + FACE_PAD.right));
  const y1 = Math.min(height, face.y + face.h * (1 + FACE_PAD.bottom));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Every rectangle inside the margins whose edges lie on the margins or on obstacle edges and that
 * no obstacle cuts into. Degenerate and duplicate rectangles are left out.
 */
export function clearSpaces(width: number, height: number, obstacles: readonly Rect[]): Rect[] {
  const m = MARGIN_FRACTION * height;
  const inner = { x0: m, y0: m, x1: width - m, y1: height - m };
  const xs = new Set<number>([inner.x0, inner.x1]);
  const ys = new Set<number>([inner.y0, inner.y1]);
  for (const o of obstacles) {
    for (const x of [o.x, o.x + o.w]) if (x > inner.x0 && x < inner.x1) xs.add(x);
    for (const y of [o.y, o.y + o.h]) if (y > inner.y0 && y < inner.y1) ys.add(y);
  }
  const xl = [...xs].sort((a, b) => a - b);
  const yl = [...ys].sort((a, b) => a - b);
  const out: Rect[] = [];
  for (let a = 0; a < xl.length; a++) {
    for (let b = a + 1; b < xl.length; b++) {
      for (let c = 0; c < yl.length; c++) {
        for (let d = c + 1; d < yl.length; d++) {
          const r = { x: xl[a], y: yl[c], w: xl[b] - xl[a], h: yl[d] - yl[c] };
          if (!obstacles.some((o) => overlaps(o, r))) out.push(r);
        }
      }
    }
  }
  return out;
}

interface Fit {
  size: number;
  lines: string[][];
  lineWidths: number[];
}

/** Every way to lay the words on one or two lines. */
function splits(words: readonly string[]): string[][][] {
  const out: string[][][] = [[[...words]]];
  for (let k = 1; k < words.length; k++) out.push([words.slice(0, k), words.slice(k)]);
  return out;
}

/**
 * The largest size (capped at `maxSize`) at which the phrase fits inside `inner` (width, height),
 * outline and patch pad included, over every split; null when no split fits at any positive size.
 */
function fitPhrase(metrics: PhraseMetrics, style: ThumbnailStyle, innerW: number, innerH: number, maxSize: number): Fit | null {
  const capPerSize = metrics.capHeight / REFERENCE_SIZE;
  const widthOf = new Map(metrics.words.map((w, i) => [w, metrics.wordWidths[i]]));
  let best: Fit | null = null;
  for (const lines of splits(metrics.words)) {
    const lineRef = lines.map((line) => line.reduce((sum, w) => sum + (widthOf.get(w) ?? 0), 0) + metrics.spaceWidth * (line.length - 1));
    const widest = Math.max(...lineRef) / REFERENCE_SIZE;
    const n = lines.length;
    // Per unit of font size: the block's width and height, outline and patch pad included.
    const wPer = widest + style.strokeRatio + 2 * PATCH_PAD_OF_CAP * capPerSize;
    const hPer = capPerSize * (n + (n - 1) * LINE_GAP_OF_CAP) + style.strokeRatio + 2 * PATCH_PAD_OF_CAP * capPerSize;
    const size = Math.min(maxSize, innerW / wPer, innerH / hPer);
    if (!(size > 0)) continue;
    const candidate = { size, lines, lineWidths: lineRef.map((r) => (r * size) / REFERENCE_SIZE) };
    // Larger wins; at an equal size the more even split reads better.
    if (best === null || size > best.size + 1e-6 || (Math.abs(size - best.size) <= 1e-6 && evenness(candidate) < evenness(best))) best = candidate;
  }
  return best;
}

function evenness(fit: Fit): number {
  return fit.lineWidths.length === 1 ? 0 : Math.abs(fit.lineWidths[0] - fit.lineWidths[1]);
}

/**
 * Place a phrase, or refuse it as too long. `faces` are the detector's boxes (unpadded).
 */
export function planText(
  metrics: PhraseMetrics,
  faces: readonly Rect[],
  style: ThumbnailStyle,
  width: number,
  height: number,
): PlanResult {
  if (metrics.words.length === 0) throw new Error('planText: the phrase has no words.');
  if (metrics.wordWidths.length !== metrics.words.length) throw new Error('planText: the page measured a different number of words than the phrase has.');
  if (!(metrics.capHeight > 0)) throw new Error(`planText: the font's capital height measured ${metrics.capHeight}; the font did not load.`);
  const capPerSize = metrics.capHeight / REFERENCE_SIZE;
  const minCap = style.minCapFraction * height;
  const maxSize = (style.maxCapFraction * height) / capPerSize;
  const obstacles = [
    ...faces.map((f) => paddedFace(f, width, height)),
    slotRect(style.reactionSlot, width, height),
    slotRect(style.logoSlot, width, height),
  ];
  const spaces = clearSpaces(width, height, obstacles);
  let best: { fit: Fit; space: Rect } | null = null;
  let widest: Rect | null = null;
  for (const space of spaces) {
    if (widest === null || space.w * space.h > widest.w * widest.h) widest = space;
    const fit = fitPhrase(metrics, style, space.w, space.h, maxSize);
    if (fit === null) continue;
    if (
      best === null ||
      fit.size > best.fit.size + 0.25 ||
      (Math.abs(fit.size - best.fit.size) <= 0.25 &&
        (space.y + space.h > best.space.y + best.space.h + 0.5 ||
          (Math.abs(space.y + space.h - (best.space.y + best.space.h)) <= 0.5 && space.x < best.space.x - 0.5)))
    ) {
      best = { fit, space };
    }
  }
  const phrase = metrics.words.join(' ');
  if (best === null || best.fit.size * capPerSize < minCap - 1e-6) {
    const biggest = best === null ? 0 : Math.floor(best.fit.size * capPerSize);
    return {
      ok: false,
      reason:
        `"${phrase}" is too long for the space beside the faces: the letters would be ${biggest} px tall, and the ` +
        `smallest allowed is ${Math.ceil(minCap)} px (${Math.round(style.minCapFraction * 100)}% of the picture's height). ` +
        `Pick a shorter option, or no text.`,
    };
  }
  const { fit, space } = best;
  const size = fit.size;
  const capPx = size * capPerSize;
  const strokePx = size * style.strokeRatio;
  const pad = PATCH_PAD_OF_CAP * capPx;
  const blockW = Math.max(...fit.lineWidths) + strokePx;
  const n = fit.lines.length;
  const blockH = capPx * (n + (n - 1) * LINE_GAP_OF_CAP) + strokePx;
  const m = MARGIN_FRACTION * height;
  // Against the frame edge the space touches: bottom first (Owen's usual), then top, else centred.
  let top: number;
  if (Math.abs(space.y + space.h - (height - m)) < 0.5) top = space.y + space.h - pad - blockH;
  else if (Math.abs(space.y - m) < 0.5) top = space.y + pad;
  else top = space.y + (space.h - blockH) / 2;
  const left = space.x + pad;
  const lines: PlacedLine[] = fit.lines.map((words, i) => ({
    text: words.join(' '),
    x: left + strokePx / 2,
    y: top + strokePx / 2 + capPx * (i + 1) + capPx * LINE_GAP_OF_CAP * i,
  }));
  const block = { x: left, y: top, w: blockW, h: blockH };
  return {
    ok: true,
    plan: {
      size,
      capPx,
      strokePx,
      lines,
      block,
      patch: { x: block.x - pad, y: block.y - pad, w: block.w + 2 * pad, h: block.h + 2 * pad },
      space,
    },
  };
}

/** The words of a phrase as they are drawn: capitals, single spaces. */
export function phraseWords(phrase: string): string[] {
  const words = phrase.toUpperCase().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) throw new Error('The thumbnail text is empty.');
  return words;
}
