/**
 * WHERE THE THUMBNAIL TEXT GOES AND HOW BIG IT IS. Deterministic arithmetic, no model.
 *
 * The inputs are the frame size, the face boxes a deterministic detector found (Apple Vision,
 * through canvas-page.ts; never the vision model's boxes, which are imprecise), the reserved
 * spaces (Owen's reaction cut-out, bottom right, and the logo, top right: each its real drawn
 * bounds when drawn, or its whole space when not), the style, and the phrase's measurements at a
 * reference size. The output is always a placement the renderer draws exactly.
 *
 * THE RULES (Owen, 2026-09-28, phase 2: "text will never be way too long ... if it does I'll
 * change the prompt"). When Owen picks words they are drawn; nothing is refused:
 *   - THE TEXT BOX runs from the left margin to where the reaction photo begins (its drawn bounds,
 *     outline included; its whole space when no photo is drawn), and from the top margin to the
 *     bottom margin. The text never leaves it.
 *   - one or two lines (MAX_LINES), left-aligned, fitted by shrinking from large (the largest
 *     letters are `maxCapFraction` of the height);
 *   - faces (and the logo, if its space reaches into the box) are kept clear WHERE POSSIBLE: the
 *     largest placement in the box that avoids them all is used when its capitals are at least
 *     `minCapFraction` of the height (7%);
 *   - otherwise the words go in the whole box, no bigger than that 7%, shrunk further until they
 *     fit, at the top or the bottom of the box, whichever covers less of a face, and the plan's
 *     note says so. There is no smallest size: a phrase always fits.
 *   - the size chosen is then drawn at `textScale` of itself (85% by default since 2026-09-29,
 *     Owen: "make the text slightly smaller"); the choice of place is made at the full size.
 *   (Until phase 2 a phrase that could not keep the 7% floor clear of the faces was refused, and
 *   the text could sit anywhere on the picture, on up to three lines.)
 *
 * HOW. The clear space is searched exhaustively: every rectangle in the box whose edges lie on the
 * box's edges or on an obstacle's edges, and which no obstacle cuts into, is a candidate (a handful
 * of obstacles gives a few thousand rectangles, all cheap). The phrase is fitted into each (every
 * split into one or two lines, largest size that fits both ways), and the candidate giving the
 * LARGEST letters wins; equal sizes prefer the lower, then the more left-hand, space: Owen's usual
 * bottom-left placement. The text sits against the box edge its space touches.
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
  /**
   * Owen's border overlay (the PNG kept in the app, border.ts) drawn over the whole picture before
   * the words, the photo and the logo. On by default; with no border file kept nothing is drawn
   * (said in the record's lines). It replaced the procedural "dark edges" vignette (2026-09-29).
   */
  border: boolean;
  /**
   * Owen's reaction cut-out's space. With a photo chosen, the trimmed photo is fitted into it,
   * right side and bottom anchored, and the text avoids the photo's real drawn bounds; with none,
   * the whole space is kept clear.
   */
  reactionSlot: SlotFractions;
  /** The white outline around the cut-out, in pixels at 1080p (scaled to the output); 0 is none. */
  reactionOutlinePx: number;
  /** How much of the photo's height may run off the bottom of the picture (0 = none). */
  reactionBleed: number;
  /**
   * The logo's space. With a logo drawn, the logo file is fitted inside it (aspect kept, top and
   * right edges anchored) and the text avoids the logo's drawn bounds; with none, the whole space
   * stays clear.
   */
  logoSlot: SlotFractions;
  /**
   * The smallest capital-letter height the text is kept OFF THE FACES at, as a fraction of the frame
   * height. Below it the words go over the faces rather than shrinking further (planText). Not a
   * refusal: a phrase that does not fit the box at this size is drawn smaller.
   */
  minCapFraction: number;
  /** The largest capital-letter height used, as a fraction of the frame height. */
  maxCapFraction: number;
  /**
   * How big the words are drawn, as a fraction of the largest size that fits their space (and
   * `maxCapFraction`): 1 fills the space, 0.85 (the default since 2026-09-29, Owen: "make the text
   * slightly smaller") draws them 15% smaller wherever they sit. Whether the words are kept off the
   * faces is decided before this scale, so a smaller size never moves them onto a face.
   */
  textScale: number;
}

export const DEFAULT_STYLE: ThumbnailStyle = {
  font: 'Impact',
  fill: '#FF8000',
  stroke: '#000000',
  strokeRatio: 0.09,
  patch: true,
  patchDarken: 0.45,
  border: true,
  // Measured off Owen's layout mock (roof.png, 1920x1080): the box at 1330-1880 x 600-1060.
  reactionSlot: { x: 0.69, y: 0.55, w: 0.29, h: 0.43 },
  // Owen's hand-made thumbnails: a white outline about 10 px at 1080p (f2 - the rapture.png), and
  // the cut-out running off the bottom edge.
  reactionOutlinePx: 10,
  reactionBleed: 0.1,
  // Owen's round badge on his hand-made thumbnail (f2 - the rapture.png, 1920x1080): x 1770-1870,
  // y 50-150, so about 100 px across (5.2% of the width) with 50 px to the top and right edges.
  logoSlot: { x: 0.922, y: 0.046, w: 0.052, h: 0.0925 },
  // 7% since 2026-09-28 (was 12%): text shrinks to fit rather than being refused (Owen).
  minCapFraction: 0.07,
  maxCapFraction: 0.2,
  // 85% since 2026-09-29 (Owen: "make the text slightly smaller"): the largest letters come out
  // at 17% of the height instead of 20%, and every fitted size is 15% smaller.
  textScale: 0.85,
};

/** The most lines a phrase is broken into (Owen, 2026-09-28 phase 2: one or two; it was three for a day). */
export const MAX_LINES = 2;

/** The size the page measures the phrase at; everything else is scaled from it. */
export const REFERENCE_SIZE = 100;

/** The space kept between the picture's edge and anything placed on it, as a fraction of its height. */
export const MARGIN_FRACTION = 0.035;

/** The gap between lines, as a fraction of the capital height. */
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
  /** The patch's outer bounds (block plus its pad): what must stay clear of faces and slots. */
  patch: Rect;
  /** The patch as drawn: one padded box per line, so a short line leaves the picture beside it clear. */
  linePatches: Rect[];
  /** The space the text was placed in (a face-free space in the box, or the whole box). */
  space: Rect;
  /** The text box: left margin to the reaction photo, top margin to bottom margin. */
  box: Rect;
  /** 'clear' kept off every face; 'over-faces': no face-free space held the words at the floor. */
  placement: 'clear' | 'over-faces';
}

/** A placement, and a plain note when the words could not be kept off the faces. */
export interface PlanResult {
  plan: TextPlan;
  note: string | null;
}

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
  if (typeof v.border !== 'boolean') throw new Error(`The thumbnail style's border setting must be on or off, got ${JSON.stringify(v.border)}.`);
  const style: ThumbnailStyle = {
    font: v.font.trim(),
    fill: colour(v.fill, 'letter colour'),
    stroke: colour(v.stroke, 'outline colour'),
    strokeRatio: num(v.strokeRatio, 'outline thickness', 0, 0.3),
    patch: v.patch,
    patchDarken: num(v.patchDarken, 'patch darkness', 0, 1),
    border: v.border,
    reactionSlot: slot(v.reactionSlot, 'reaction slot'),
    reactionOutlinePx: num(v.reactionOutlinePx, 'photo outline (px at 1080p)', 0, 40),
    reactionBleed: num(v.reactionBleed, 'photo bleed off the bottom', 0, 0.5),
    logoSlot: slot(v.logoSlot, 'logo slot'),
    minCapFraction: num(v.minCapFraction, 'smallest letter height', 0.05, 0.4),
    maxCapFraction: num(v.maxCapFraction, 'largest letter height', 0.05, 0.5),
    textScale: num(v.textScale, 'text size (of the largest that fits)', 0.5, 1),
  };
  if (style.maxCapFraction < style.minCapFraction) {
    throw new Error(`The thumbnail style's largest letter height (${style.maxCapFraction}) is below its smallest (${style.minCapFraction}).`);
  }
  return style;
}

/**
 * A look as the app's settings hold it. A look saved before 2026-09-29 has no `textScale` and no
 * `border`, and has the retired `vignette` ("dark edges", replaced by the border overlay): it is
 * read with the new defaults (text at 85% of the largest that fits, the border on), and `line`
 * says so wherever the look is used (a declared upgrade, Law 8), so Owen's saved look gets the
 * smaller text and his border too. Nothing is written back; "Save look" in Thumbnail look stores
 * the values.
 */
export function readStoredStyle(stored: unknown): { style: ThumbnailStyle; line: string | null } {
  const v = stored as (Partial<ThumbnailStyle> & { vignette?: unknown; vignetteStrength?: unknown }) | null;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { style: validateStyle(stored), line: null };
  const said: string[] = [];
  const read: Record<string, unknown> = { ...v };
  if (v.textScale === undefined) {
    read.textScale = DEFAULT_STYLE.textScale;
    said.push(`its text is drawn at the default ${Math.round(DEFAULT_STYLE.textScale * 100)}% of the largest that fits`);
  }
  if (v.border === undefined) {
    read.border = DEFAULT_STYLE.border;
    said.push('your border is drawn over the picture');
  }
  if ('vignette' in read || 'vignetteStrength' in read) {
    delete read.vignette;
    delete read.vignetteStrength;
    said.push('its "dark edges" setting is gone (the border replaced it)');
  }
  const style = validateStyle(read);
  if (said.length === 0) return { style, line: null };
  return { style, line: `The saved thumbnail look is from before 2026-09-29, so ${said.join('; ')}. Change or save it in Thumbnail look.` };
}

export function slotRect(fractions: SlotFractions, width: number, height: number): Rect {
  return { x: fractions.x * width, y: fractions.y * height, w: fractions.w * width, h: fractions.h * height };
}

/** Where a trimmed reaction photo is drawn, and the outline width, in output pixels. */
export interface ReactionPlacement {
  x: number;
  y: number;
  w: number;
  h: number;
  outlinePx: number;
  /** What the text must avoid: the part of the photo inside the picture, outline included. */
  avoid: Rect;
}

/**
 * Fit a trimmed photo (photoW x photoH) into the reaction space: as large as fits the space's width
 * and the height from the space's top to the picture's bottom, with `reactionBleed` of the photo
 * allowed below the bottom edge; right side on the space's right edge, bottom running off the
 * picture's bottom edge.
 */
export function placeReaction(photoW: number, photoH: number, style: ThumbnailStyle, width: number, height: number): ReactionPlacement {
  if (!(photoW > 0 && photoH > 0)) throw new Error(`placeReaction: a ${photoW}x${photoH} photo has nothing to place.`);
  const slot = slotRect(style.reactionSlot, width, height);
  const visible = 1 - style.reactionBleed;
  const scale = Math.min(slot.w / photoW, (height - slot.y) / (photoH * visible));
  const w = photoW * scale;
  const h = photoH * scale;
  const x = slot.x + slot.w - w;
  const y = height - h * visible;
  const outlinePx = (style.reactionOutlinePx * height) / 1080;
  const ax = Math.max(0, x - outlinePx);
  const ay = Math.max(0, y - outlinePx);
  const avoid = { x: ax, y: ay, w: Math.min(width, x + w + outlinePx) - ax, h: height - ay };
  return { x, y, w, h, outlinePx, avoid };
}

/**
 * Where the logo is drawn: the file's picture (logoW x logoH, already trimmed to its visible
 * pixels) fitted inside the logo space with its aspect kept, against the space's top and right
 * edges. Sizes are whole pixels so the downscaled logo lands on the pixel grid (crisp).
 */
export function placeLogo(logoW: number, logoH: number, style: ThumbnailStyle, width: number, height: number): Rect {
  if (!(logoW > 0 && logoH > 0)) throw new Error(`placeLogo: a ${logoW}x${logoH} logo has nothing to place.`);
  const slot = slotRect(style.logoSlot, width, height);
  const scale = Math.min(slot.w / logoW, slot.h / logoH);
  const w = Math.max(1, Math.floor(logoW * scale));
  const h = Math.max(1, Math.floor(logoH * scale));
  const x = Math.round(slot.x + slot.w - w);
  const y = Math.round(slot.y);
  return { x, y, w, h };
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
 * THE TEXT BOX: from the left margin to where the reaction photo begins (`reactionAvoid`, its drawn
 * bounds with the outline; its whole space when no photo is drawn), from the top margin to the
 * bottom margin. A reaction space that leaves no room is a setting to fix, said by name.
 */
export function textBox(style: ThumbnailStyle, width: number, height: number, reactionAvoid: Rect | null): Rect {
  const m = MARGIN_FRACTION * height;
  const right = Math.min(width - m, (reactionAvoid ?? slotRect(style.reactionSlot, width, height)).x);
  if (!(right - m > 0)) {
    throw new Error(`The reaction photo starts ${Math.round(right)} px from the left edge, which leaves no room for words beside it. Move its space to the right in Thumbnail look.`);
  }
  return { x: m, y: m, w: right - m, h: height - 2 * m };
}

/**
 * Every rectangle inside `box` whose edges lie on the box's edges or on obstacle edges and that no
 * obstacle cuts into. Degenerate and duplicate rectangles are left out.
 */
export function clearSpaces(box: Rect, obstacles: readonly Rect[]): Rect[] {
  const inner = { x0: box.x, y0: box.y, x1: box.x + box.w, y1: box.y + box.h };
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

/** Every way to lay the words, in order, on one to MAX_LINES lines. */
export function splits(words: readonly string[], maxLines: number = MAX_LINES): string[][][] {
  const out: string[][][] = [];
  const walk = (from: number, lines: string[][]): void => {
    if (from === words.length) {
      out.push(lines);
      return;
    }
    if (lines.length === maxLines) return;
    for (let end = from + 1; end <= words.length; end++) walk(end, [...lines, words.slice(from, end)]);
  };
  walk(0, []);
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
    // Larger wins; at an equal size fewer lines, then the more even split, reads better.
    const tie = best !== null && Math.abs(size - best.size) <= 1e-6;
    if (
      best === null || size > best.size + 1e-6 ||
      (tie && (lines.length < best.lines.length || (lines.length === best.lines.length && evenness(candidate) < evenness(best))))
    ) best = candidate;
  }
  return best;
}

/** A fit drawn at `scale` of its size (the look's text size): the same lines, smaller. */
function scaled(fit: Fit, scale: number): Fit {
  return { size: fit.size * scale, lines: fit.lines, lineWidths: fit.lineWidths.map((w) => w * scale) };
}

function evenness(fit: Fit): number {
  return Math.max(...fit.lineWidths) - Math.min(...fit.lineWidths);
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The plan for a fit in a space: against the box edge the space touches (bottom first, then top, else centred), or as told. */
function placeFit(metrics: PhraseMetrics, style: ThumbnailStyle, fit: Fit, space: Rect, box: Rect, anchor: 'edge' | 'top' | 'bottom', placement: TextPlan['placement']): TextPlan {
  const capPerSize = metrics.capHeight / REFERENCE_SIZE;
  const size = fit.size;
  const capPx = size * capPerSize;
  const strokePx = size * style.strokeRatio;
  const pad = PATCH_PAD_OF_CAP * capPx;
  const blockW = Math.max(...fit.lineWidths) + strokePx;
  const n = fit.lines.length;
  const blockH = capPx * (n + (n - 1) * LINE_GAP_OF_CAP) + strokePx;
  const atBottom = anchor === 'bottom' || (anchor === 'edge' && Math.abs(space.y + space.h - (box.y + box.h)) < 0.5);
  const atTop = anchor === 'top' || (anchor === 'edge' && !atBottom && Math.abs(space.y - box.y) < 0.5);
  const top = atBottom ? space.y + space.h - pad - blockH : atTop ? space.y + pad : space.y + (space.h - blockH) / 2;
  const left = space.x + pad;
  const lines: PlacedLine[] = fit.lines.map((words, i) => ({
    text: words.join(' '),
    x: left + strokePx / 2,
    y: top + strokePx / 2 + capPx * (i + 1) + capPx * LINE_GAP_OF_CAP * i,
  }));
  const block = { x: left, y: top, w: blockW, h: blockH };
  const linePatches = lines.map((line, i) => ({
    x: left - pad,
    y: line.y - capPx - strokePx / 2 - pad,
    w: fit.lineWidths[i] + strokePx + 2 * pad,
    h: capPx + strokePx + 2 * pad,
  }));
  return {
    size,
    capPx,
    strokePx,
    lines,
    block,
    patch: { x: block.x - pad, y: block.y - pad, w: block.w + 2 * pad, h: block.h + 2 * pad },
    linePatches,
    space,
    box,
    placement,
  };
}

/**
 * Place a phrase in the text box. Always places it (see the header): off the faces when a
 * face-free space holds it at the floor, else in the whole box at the floor or smaller, where it
 * covers the least of a face, with a note. `faces` are the detector's boxes (unpadded).
 */
export function planText(
  metrics: PhraseMetrics,
  faces: readonly Rect[],
  style: ThumbnailStyle,
  width: number,
  height: number,
  /** The chosen photo's drawn bounds (placeReaction `avoid`); null: the box ends at the reaction space. */
  reactionAvoid: Rect | null = null,
  /** The logo's drawn bounds (placeLogo); null keeps the whole logo space clear where it reaches the box. */
  logoAvoid: Rect | null = null,
): PlanResult {
  if (metrics.words.length === 0) throw new Error('planText: the phrase has no words.');
  if (metrics.wordWidths.length !== metrics.words.length) throw new Error('planText: the page measured a different number of words than the phrase has.');
  if (!(metrics.capHeight > 0)) throw new Error(`planText: the font's capital height measured ${metrics.capHeight}; the font did not load.`);
  const capPerSize = metrics.capHeight / REFERENCE_SIZE;
  const minCap = style.minCapFraction * height;
  const maxSize = (style.maxCapFraction * height) / capPerSize;
  const box = textBox(style, width, height, reactionAvoid);
  const obstacles = [
    ...faces.map((f) => paddedFace(f, width, height)),
    logoAvoid ?? slotRect(style.logoSlot, width, height),
  ].filter((o) => overlaps(o, box));
  let best: { fit: Fit; space: Rect } | null = null;
  for (const space of clearSpaces(box, obstacles)) {
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
  if (best !== null && best.fit.size * capPerSize >= minCap - 1e-6) {
    return { plan: placeFit(metrics, style, scaled(best.fit, style.textScale), best.space, box, 'edge', 'clear'), note: null };
  }
  // No face-free space holds the words at the floor: the whole box, no bigger than the floor, shrunk
  // until the phrase fits, at the top or the bottom, whichever covers less of a face.
  const largest = fitPhrase(metrics, style, box.w, box.h, Math.min(maxSize, minCap / capPerSize));
  if (largest === null) throw new Error(`planText: "${metrics.words.join(' ')}" has no size at which it fits a ${Math.round(box.w)}x${Math.round(box.h)} px box.`);
  const fit = scaled(largest, style.textScale);
  const covered = (plan: TextPlan) => obstacles.reduce((sum, o) => sum + plan.linePatches.reduce((t, p) => t + overlapArea(o, p), 0), 0);
  const bottom = placeFit(metrics, style, fit, box, box, 'bottom', 'over-faces');
  const top = placeFit(metrics, style, fit, box, box, 'top', 'over-faces');
  const plan = covered(top) < covered(bottom) - 0.5 ? top : bottom;
  const clear = best === null ? 0 : Math.floor(best.fit.size * capPerSize);
  const note =
    `No space in the text box clear of the faces holds these words at ${Math.ceil(minCap)} px` +
    (best === null ? '' : ` (the largest clear space held them at ${clear} px)`) +
    `, so they were drawn ${Math.round(plan.capPx)} px tall at the ${plan === top ? 'top' : 'bottom'} of the box` +
    (covered(plan) > 0.5 ? ', where they cover the least of a face.' : '.');
  return { plan, note };
}

/** The words of a phrase as they are drawn: capitals, single spaces. */
export function phraseWords(phrase: string): string[] {
  const words = phrase.toUpperCase().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) throw new Error('The thumbnail text is empty.');
  return words;
}
