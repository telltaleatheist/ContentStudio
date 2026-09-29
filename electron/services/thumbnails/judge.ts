/**
 * THE THUMBNAILS TAB'S TWO TEXT DECISIONS (Owen, 2026-09-28), both Crucible decide calls on the
 * `thumbnail_judge` routing row (a local text model; a distribution needs logprobs, so no cloud):
 *
 *   1. TONE: one choice question, "What is the tone of this video?", over a fixed list kept in
 *      thumbnails.yml `tone.options` (one per line, Owen edits it; at most 26, the letter limit).
 *      The state is the report's description hook and description plus the transcript's opening.
 *   2. PHOTO: once per variant, "Which reaction photo fits this thumbnail?", the answers being
 *      Owen's photo names. The state is the video's summary, the tone just read, that variant's
 *      words (or none) and a legend of every photo with its note. The probabilities ARE the
 *      ranking: the tab pre-selects the top one and lists the rest in order. No photo is ever
 *      hidden or blocked; Owen picks.
 *
 * Both run as ONE lane job holding ONE lease, like the frame scorer (frame-scorer.ts). When the
 * tab holds the model for its text steps (lab-service.ts `textJob`: the words and the tone/photo
 * both on the 8-bit 27B by default), that held job is passed in and the questions run as one
 * standalone GPU step under it, like the words call: the model stays loaded between the words and
 * the photos, and the tab releases it, not this call (a lane job's end would give back what was
 * held inside it).
 */
import type { DecideResponse } from '@crucible/client';
import type { JobLeases } from '../../crucible/lease';
import { promptAssets } from '../metadata/prompt-assets';
import { plainScoringError, ThumbnailJobWaiting, type ScorerDeps } from './frame-scorer';
import { THUMBNAILS_PROMPT_FILE } from './prompts';

/** The judge's load context: a description, a transcript opening and a 13-line legend. */
export const JUDGE_LOAD_CONTEXT = 8192;

/** How many caption lines of the transcript's opening go into the tone state. */
export const TONE_TRANSCRIPT_LINES = 60;

function asset(key: string): string {
  return promptAssets().pipeline(THUMBNAILS_PROMPT_FILE, key);
}

function fill(template: string, values: Record<string, string>, where: string): string {
  return template.replace(/\{([a-z_]+)\}/g, (_whole, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`thumbnails.yml "${where}" has a slot {${name}} that nothing fills.`);
    return value;
  });
}

function lines(key: string): string[] {
  return asset(key).split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/** The tone list, checked: unique names, 2 to 26 of them. */
export function toneOptions(): string[] {
  const tones = lines('tone.options');
  if (tones.length < 2 || tones.length > 26) throw new Error(`thumbnails.yml "tone.options" lists ${tones.length} tones; a choice question takes 2 to 26.`);
  if (new Set(tones).size !== tones.length) throw new Error('thumbnails.yml "tone.options" lists a tone twice.');
  return tones;
}

/** The drafted note per photo name, from thumbnails.yml `photo.drafts` (`name: note` lines). */
export function draftNotes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines('photo.drafts')) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error(`thumbnails.yml "photo.drafts" has a line that is not "name: note": ${line}`);
    out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return out;
}

/** The report's description as the summary: its prose paragraph, without the links appended below it. */
export function summaryOf(description: string): string {
  return description.split(/\n\s*\n/)[0].trim();
}

export function toneState(input: { channel: string; creator: string; hook: string; description: string; transcript: readonly string[] }): string {
  if (input.hook.trim() === '' && input.description.trim() === '') throw new Error('The tone is read from the report\'s description, and this report has none.');
  return fill(asset('tone.state'), {
    channel: input.channel,
    creator: input.creator,
    hook: input.hook.trim(),
    description: summaryOf(input.description),
    transcript: input.transcript.slice(0, TONE_TRANSCRIPT_LINES).join('\n'),
  }, 'tone.state');
}

/** One legend line per photo: `name: note`, or the name alone when it has no note yet. */
export function legendLines(photos: ReadonlyArray<{ name: string; note: string | null }>): string[] {
  return photos.map((p) => (p.note && p.note.trim() !== '' ? `${p.name}: ${p.note.trim()}` : p.name));
}

export function photoState(input: { channel: string; creator: string; summary: string; tone: string; text: string | null; photos: ReadonlyArray<{ name: string; note: string | null }> }): string {
  return fill(asset('photo.state'), {
    channel: input.channel,
    creator: input.creator,
    summary: input.summary,
    tone: input.tone,
    text: input.text ?? asset('photo.no_text'),
    legend: legendLines(input.photos).join('\n'),
  }, 'photo.state');
}

export interface Ranked {
  name: string;
  /** The renormalised probability, or null when the engine did not return that option's letter. */
  p: number | null;
}

/**
 * A choice answer as a ranking: most probable first; an option the engine did not return (null in
 * report mode) comes after every rated one, in the question's order. Nothing is dropped.
 */
export function rankingOf(answer: unknown, options: readonly string[], what: string): Ranked[] {
  const probs = (answer as { probabilities?: Record<string, number | null> } | undefined)?.probabilities;
  if (!probs || typeof probs !== 'object') throw new Error(`${what}: the answer has no probabilities.`);
  const rows = options.map((name, i) => {
    const p = probs[name];
    if (p !== null && p !== undefined && (typeof p !== 'number' || !(p >= 0 && p <= 1))) throw new Error(`${what}: "${name}" came back as ${JSON.stringify(p)}.`);
    return { name, p: p ?? null, i };
  });
  rows.sort((a, b) => (a.p === null ? (b.p === null ? a.i - b.i : 1) : b.p === null ? -1 : b.p - a.p || a.i - b.i));
  if (rows[0].p === null) throw new Error(`${what}: the engine rated none of the options.`);
  return rows.map(({ name, p }) => ({ name, p }));
}

export interface JudgeOutcome {
  tone: Ranked[];
  photos: Record<string, Ranked[]>;
  server: string;
  model: string;
}

/**
 * Read the tone, then rank the photos for each variant, in one lane job on the judge model.
 * `photos` must hold at least two (a question needs two answers) and at most 26.
 */
export async function judgeThumbnails(input: {
  deps: ScorerDeps;
  jobId: string;
  model: string;
  tone: { channel: string; creator: string; hook: string; description: string; transcript: readonly string[] };
  photos: ReadonlyArray<{ name: string; note: string | null }>;
  variants: ReadonlyArray<{ letter: string; text: string | null }>;
  signal?: AbortSignal;
  /** The tab's held job for this model (kept loaded across its text steps); absent, this call takes and releases its own lease. */
  job?: JobLeases;
}): Promise<JudgeOutcome> {
  const { deps, model } = input;
  const tones = toneOptions();
  const names = input.photos.map((p) => p.name);
  if (names.length < 2) throw new Error(`Ranking reaction photos needs at least two in the folder; it has ${names.length}.`);
  if (names.length > 26) throw new Error(`A photo question takes at most 26 answers, and the folder has ${names.length} photos.`);
  const toneStateText = toneState(input.tone);
  // The summary is the hook and the description's paragraph together, whichever the report has.
  const summary = [input.tone.hook.trim(), summaryOf(input.tone.description)].filter((t) => t !== '').join(' ');
  const controller = new AbortController();
  input.signal?.addEventListener('abort', () => controller.abort(input.signal?.reason), { once: true });

  const questions = async (job: JobLeases, signal: AbortSignal, beat: () => void): Promise<Omit<JudgeOutcome, 'server'>> => {
    const ask = async (state: string, question: string, options: Record<string, string>, what: string): Promise<DecideResponse> => {
      const answer = await deps.transport.decide({
        model, state, questions: { pick: { type: 'choice', instructions: question, options } }, missing: 'report',
        loadContext: JUDGE_LOAD_CONTEXT, job, signal, what, trace: null,
      });
      beat();
      return answer;
    };
    const toneAnswer = await ask(toneStateText, asset('tone.question'), Object.fromEntries(tones.map((t) => [t, t])), 'thumbnail tone');
    const tone = rankingOf(toneAnswer.answers['pick'], tones, 'The tone answer');
    const photos: Record<string, Ranked[]> = {};
    for (const v of input.variants) {
      const state = photoState({ channel: input.tone.channel, creator: input.tone.creator, summary, tone: tone[0].name, text: v.text, photos: input.photos });
      const options = Object.fromEntries(input.photos.map((p) => [p.name, p.note && p.note.trim() !== '' ? p.note.trim() : p.name]));
      const answer = await ask(state, asset('photo.question'), options, `reaction photo for thumbnail ${v.letter}`);
      photos[v.letter] = rankingOf(answer.answers['pick'], names, `The photo answer for ${v.letter}`);
    }
    return { tone, photos, model };
  };

  if (input.job !== undefined) {
    // The tab's held job: a standalone GPU step, as the words call is (queueAITask), so the hold
    // is not tied to a lane job whose end would give it back. The tab releases it.
    const job = input.job;
    const value = await deps.lanes.aiCall({ lane: 'gpu', model }, `Thumbnail tone and photos (${input.jobId})`, () =>
      questions(job, controller.signal, () => undefined),
    ).catch((err) => {
      throw plainScoringError(err, model);
    });
    if (job.server === null) throw new Error('The tone and photo calls ran, and the held job names no server.');
    return { ...value, server: job.server };
  }

  const outcome = await deps.lanes.runJob({ jobId: input.jobId, fast: false, stage: 'fields', controller }, (run) =>
    deps.lanes.aiCall({ lane: 'gpu', model }, `Thumbnail tone and photos (${input.jobId})`, () =>
      deps.transport.withJobLease(run.server, model, async (job) => ({
        ...(await questions(job, run.controller.signal, () => run.beat())),
        server: run.server,
      }), { what: 'thumbnail tone and photos', act: 'decide', loadContext: JUDGE_LOAD_CONTEXT, signal: run.controller.signal }),
    ),
  ).catch((err) => {
    throw plainScoringError(err, model);
  });
  if (outcome.kind === 'parked') {
    await deps.lanes.stopJob(input.jobId, 'thumbnails do not wait for a busy server');
    const server = outcome.result.server ?? 'no server';
    throw new ThumbnailJobWaiting(server, `${outcome.result.server === null ? 'No Crucible server can take the job' : `"${server}" cannot take the job now`}: ${outcome.result.holderLine}. Press Suggest again when it is free.`);
  }
  return outcome.value;
}
