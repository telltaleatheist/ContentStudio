/**
 * HOW THE THUMBNAILS TAB ORDERS FRAMES once the vision model has looked at them.
 *
 * Owen's ruling (2026-09-28): "RANK by the probabilities, never a hard threshold, except the
 * desktop question, which is the one filter." So:
 *
 *   - ONE FILTER. A frame the model reads as a computer screen (a desktop, a browser, an app) is
 *     rejected: Owen's masters are screen captures that sometimes show his own desktop, and that
 *     is never a thumbnail. It is rejected when the screen answer is the more probable one
 *     (P(screen) > 0.5), which is the answer the model gave, not a tuned threshold.
 *   - EVERYTHING ELSE RANKS. A clear face, a strong expression, open eyes and "this would make a
 *     strong thumbnail" each raise the frame; nothing drops it. Two faces side by side (a split
 *     screen) are fine, and burned-in branding does not matter (it gets covered).
 *
 * The weights below are a declared starting point, not a measurement: nothing has been scored for
 * real yet (no live runs without Owen's approval). They are in one place so a real run can tune
 * them, and the tab shows each frame's parts so the ordering can be read.
 *
 * PURE: the decide answers in (as the SDK returns them), numbers out.
 */

/** The question names the frame decide call asks (thumbnails.yml `frames.*` holds their words). */
export const FRAME_QUESTIONS = ['screen', 'face', 'expression', 'eyes', 'strong'] as const;
export type FrameQuestionName = (typeof FRAME_QUESTIONS)[number];

/** The screen question's two options, in the order the letters are assigned (A = video). */
export const SCREEN_OPTIONS = ['video', 'screen'] as const;

/** The expression scale's size: level 1 is a blank face, level 5 an extreme reaction. */
export const EXPRESSION_LEVELS = 5;

/**
 * The rank weights. The face answer MULTIPLIES the rest (a frame without a clear face cannot be a
 * reaction thumbnail however "strong" the model calls it); the other three add up to 1.
 */
export const RANK_WEIGHTS = { expression: 0.45, eyes: 0.2, strong: 0.35 } as const;

/** One frame's readings, each a probability in [0, 1] (expression rescaled from 1-5). */
export interface FrameReading {
  pScreen: number;
  pFace: number;
  /** The expected expression level, 1-5, as the answer's `score`. */
  expression: number;
  pEyesOpen: number;
  pStrong: number;
}

export interface ScoredFrame {
  id: string;
  t: number;
  reading: FrameReading;
}

export interface RankedFrame extends ScoredFrame {
  score: number;
}

/** An answer as the SDK hands it back (camelCase), only the fields read here. */
interface ChoiceLike { type?: string; probabilities: Record<string, number | null>; missingLabels?: readonly string[] | null }
interface ScoreLike { type?: string; score: number; missingLabels?: readonly string[] | null }
interface YesNoLike { type?: string; p: number; missingLabels?: readonly string[] | null }

/** A frame the model's answer could not be read for, and which question said so. */
export class FrameAnswerUnreadable extends Error {
  readonly code = 'frame_answer_unreadable';
  constructor(readonly question: string, message: string) {
    super(message);
    this.name = 'FrameAnswerUnreadable';
  }
}

function missingOf(answer: { missingLabels?: readonly string[] | null }): readonly string[] {
  return answer.missingLabels ?? [];
}

function probability(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new FrameAnswerUnreadable(what, `${what} came back as ${JSON.stringify(value)}, which is not a probability.`);
  }
  return value;
}

/**
 * Read one frame's decide answer. The call asks with `missing: 'report'`, so an option letter the
 * engine did not return comes back named in `missingLabels` rather than failing the whole run; a
 * frame with ANY missing label is unreadable and is set aside by the caller with the question named
 * (a counted, listed outcome, Law 8), because a one-sided reading ("1.0 because No was missing")
 * would rank it on nothing.
 */
export function readFrameAnswers(answers: Record<string, unknown>): FrameReading {
  for (const name of FRAME_QUESTIONS) {
    const answer = answers[name] as { missingLabels?: readonly string[] | null } | undefined;
    if (answer === undefined || answer === null || typeof answer !== 'object') {
      throw new FrameAnswerUnreadable(name, `the answer has no "${name}" reading.`);
    }
    const missing = missingOf(answer);
    if (missing.length > 0) {
      throw new FrameAnswerUnreadable(name, `the model's "${name}" answer did not include ${missing.join(' and ')} among its top choices.`);
    }
  }
  const screen = answers['screen'] as ChoiceLike;
  const expression = answers['expression'] as ScoreLike;
  const level = expression.score;
  if (typeof level !== 'number' || !(level >= 1 && level <= EXPRESSION_LEVELS)) {
    throw new FrameAnswerUnreadable('expression', `the expression answer's score is ${JSON.stringify(level)}, outside 1-${EXPRESSION_LEVELS}.`);
  }
  return {
    pScreen: probability(screen.probabilities?.[SCREEN_OPTIONS[1]], 'the screen answer'),
    pFace: probability((answers['face'] as YesNoLike).p, 'the face answer'),
    expression: level,
    pEyesOpen: probability((answers['eyes'] as YesNoLike).p, 'the eyes answer'),
    pStrong: probability((answers['strong'] as YesNoLike).p, 'the strong-thumbnail answer'),
  };
}

/** Is this frame a computer screen? The one filter: the model's more probable answer. */
export function isScreen(reading: FrameReading): boolean {
  return reading.pScreen > 0.5;
}

/** The frame's rank score, in [0, 1]. */
export function rankScore(reading: FrameReading): number {
  const expression = (reading.expression - 1) / (EXPRESSION_LEVELS - 1);
  return reading.pFace * (RANK_WEIGHTS.expression * expression + RANK_WEIGHTS.eyes * reading.pEyesOpen + RANK_WEIGHTS.strong * reading.pStrong);
}

export interface RankResult {
  /** Every non-screen frame, best first. */
  ranked: RankedFrame[];
  /** Frames rejected as a computer screen, in time order. */
  screens: ScoredFrame[];
}

/**
 * The frames ranked, best first, with the computer screens set aside. How the best are SHOWN (one
 * row per scene, its top few) is frame-scenes.ts `sceneRows`.
 */
export function rankFrames(frames: readonly ScoredFrame[]): RankResult {
  const screens: ScoredFrame[] = [];
  const ranked: RankedFrame[] = [];
  for (const frame of frames) {
    if (isScreen(frame.reading)) {
      screens.push(frame);
      continue;
    }
    ranked.push({ ...frame, score: rankScore(frame.reading) });
  }
  // Best first; equal scores keep time order, so the ordering is fully determined.
  ranked.sort((a, b) => b.score - a.score || a.t - b.t);
  screens.sort((a, b) => a.t - b.t);
  return { ranked, screens };
}
