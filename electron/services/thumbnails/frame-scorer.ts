/**
 * SCORING THE KEPT FRAMES with the routed vision model, through Crucible's decide door.
 *
 * Owen's shape (2026-09-28): ONE image per decide call (a question about several images is
 * ambiguous about which one it means), each frame downscaled first (the 640x360 sample, so image
 * tokens stay low), the five fixed-answer questions as ITEMS of that one call (Crucible 1.0.55
 * `decideItems`: the frame is read once, each item answered as if asked alone; measured on the Mac,
 * one 640x360 frame and five questions: 1.9 s against 4.3 s asked one by one). ONE job on the
 * card at a time: this is a lane job like a metadata run (lanes.ts `runJob`), so it waits behind a
 * running metadata job on the same server and a metadata job waits behind it. Inside the job the
 * calls may use the engine's width: as many in flight as the engine STATES it admits
 * (`activity().chat.maxInFlight`); an engine that states none gets one at a time, because the SDK
 * says a null limit "never means unlimited".
 *
 * Nothing here picks a model: the `thumbnail_frames` routing row does (the routing table is the
 * sole authority). A model the server does not have, a text-only model, a server whose engine does
 * not serve images: each is Crucible's own refusal, surfaced with the model and the server named,
 * and the run stops. A frame whose answer came back with a missing option letter is set aside,
 * counted and named (Law 8), and the rest are ranked.
 */
import * as fs from 'fs';
import type { CrucibleClient, DecideItemsResponse } from '@crucible/client';
import type { CrucibleLanes } from '../../crucible/lanes';
import type { CrucibleTransport } from '../../crucible/transport';
import { FrameAnswerUnreadable, readFrameAnswers, type ScoredFrame } from './frame-ranking';
import { frameAnswersOfItems, frameDecideItems } from './prompts';
import { clock } from './frame-sampler';

/** The context the vision model is loaded at: one small state, one 640x360 frame, five questions. */
export const FRAME_LOAD_CONTEXT = 8192;

/** The most calls in flight at once, whatever the engine states. */
export const MAX_FRAME_WIDTH = 8;

export interface ScorerDeps {
  lanes: Pick<CrucibleLanes, 'runJob' | 'stopJob' | 'aiCall'>;
  transport: Pick<CrucibleTransport, 'withJobLease' | 'decide' | 'decideItems' | 'job'>;
  clientFor(server: string): Promise<Pick<CrucibleClient, 'activity'>>;
}

export interface FrameToScore {
  id: string;
  t: number;
  /** The downscaled frame the model reads (JPEG). */
  image: string;
}

export interface ScoreOutcome {
  scored: ScoredFrame[];
  unreadable: Array<{ id: string; t: number; reason: string }>;
  server: string;
  model: string;
  /** How many calls ran at once, and why that many. */
  width: number;
  widthBasis: string;
}

/**
 * Crucible refused the frames for a reason about the MODEL OR THE SERVER (never one frame), said in
 * plain words with both named. `code` is the server's own code, unrenamed (Law 10).
 */
export class ThumbnailScoringRefused extends Error {
  constructor(readonly code: string, readonly server: string | null, message: string, readonly cause: unknown) {
    super(message);
    this.name = 'ThumbnailScoringRefused';
  }
}

/** The image refusals in the tab's words; anything else passes through as the door wrote it. */
export function plainScoringError(err: unknown, model: string): unknown {
  const e = err as { serverCode?: unknown; server?: unknown; message?: unknown };
  const code = typeof e?.serverCode === 'string' ? e.serverCode : null;
  const server = typeof e?.server === 'string' ? e.server : null;
  const where = server === null ? 'the server' : `"${server}"`;
  const said = typeof e?.message === 'string' ? e.message : String(err);
  if (code === 'model_text_only') {
    // Crucible names the models that CAN read images there (`details.image_models`); say them.
    const details = (e as { cause?: { details?: { image_models?: unknown } } }).cause?.details;
    const able = Array.isArray(details?.image_models) ? (details!.image_models as unknown[]).filter((m): m is string => typeof m === 'string') : [];
    const offer = able.length > 0 ? ` ${where} can read pictures with: ${able.join(', ')}.` : '';
    return new ThumbnailScoringRefused(code, server, `${model} reads text only on ${where}, so it cannot look at frames.${offer} Pick a vision model on the Routing dialog's "Thumbnail frames" row. (${said})`, err);
  }
  if (code === 'refuse_images_not_served') {
    return new ThumbnailScoringRefused(code, server, `${where} cannot show pictures to ${model} yet. Pick another server for the routing, or another model on the "Thumbnail frames" row. (${said})`, err);
  }
  if (code === 'too_many_images') {
    return new ThumbnailScoringRefused(code, server, `${where} refused more than one picture per question for ${model}. (${said})`, err);
  }
  return err;
}

/** The job waited on a busy server instead of running. Typed so the IPC reads the code (Law 10). */
export class ThumbnailJobWaiting extends Error {
  readonly code = 'thumbnail_job_waiting';
  constructor(readonly server: string, message: string) {
    super(message);
    this.name = 'ThumbnailJobWaiting';
  }
}

async function engineWidth(deps: ScorerDeps, server: string): Promise<{ width: number; basis: string }> {
  const activity = await deps.clientFor(server).then((c) => c.activity());
  const stated = activity.chat?.maxInFlight ?? null;
  if (stated === null) return { width: 1, basis: `"${server}" states no admission limit for its engine, so one call at a time` };
  const width = Math.max(1, Math.min(MAX_FRAME_WIDTH, stated));
  return { width, basis: `"${server}" admits ${stated} at once${stated > MAX_FRAME_WIDTH ? `, capped at ${MAX_FRAME_WIDTH}` : ''}` };
}

export async function scoreFrames(input: {
  deps: ScorerDeps;
  jobId: string;
  /** The Crucible id the routing row resolved to. */
  model: string;
  frames: readonly FrameToScore[];
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}): Promise<ScoreOutcome> {
  const { deps, model } = input;
  if (input.frames.length === 0) throw new Error('There are no frames to score.');
  const controller = new AbortController();
  input.signal?.addEventListener('abort', () => controller.abort(input.signal?.reason), { once: true });

  const outcome = await runScoringJob(deps, input, controller).catch((err) => {
    throw plainScoringError(err, model);
  });
  if (outcome.kind === 'parked') {
    // The tab does not queue: it says who holds the card and the operator presses Score again.
    await deps.lanes.stopJob(input.jobId, 'the Thumbnails tab does not wait for a busy server');
    const server = outcome.result.server ?? 'no server';
    const where = outcome.result.server === null ? 'No Crucible server can take the job' : `"${server}" cannot take the job now`;
    throw new ThumbnailJobWaiting(server, `${where}: ${outcome.result.holderLine}. Press Score again when it is free.`);
  }
  return outcome.value;
}

function runScoringJob(deps: ScorerDeps, input: { jobId: string; model: string; frames: readonly FrameToScore[]; onProgress?: (done: number, total: number) => void }, controller: AbortController) {
  const { model } = input;
  return deps.lanes.runJob({ jobId: input.jobId, fast: false, stage: 'fields', controller }, (run) =>
    deps.lanes.aiCall({ lane: 'gpu', model }, `Thumbnail frames (${input.jobId})`, () =>
      deps.transport.withJobLease(run.server, model, async (job) => {
        const { width, basis } = await engineWidth(deps, run.server);
        const scored: ScoredFrame[] = [];
        const unreadable: ScoreOutcome['unreadable'] = [];
        let next = 0;
        let done = 0;
        // The first refusal stops every worker: a server refusal is about the model or the
        // server, never one frame, so the frames after it would be refused the same way.
        let failed = false;
        const worker = async () => {
          for (;;) {
            if (failed) return;
            if (run.controller.signal.aborted) throw run.controller.signal.reason ?? new Error('Stopped.');
            const i = next++;
            if (i >= input.frames.length) return;
            const frame = input.frames[i];
            const body = frameDecideItems(fs.readFileSync(frame.image).toString('base64'));
            const answer: DecideItemsResponse = await deps.transport.decideItems({
              model,
              ...body,
              loadContext: FRAME_LOAD_CONTEXT,
              job,
              signal: run.controller.signal,
              what: `thumbnail frame at ${clock(frame.t)}`,
              trace: null,
            });
            try {
              scored.push({ id: frame.id, t: frame.t, reading: readFrameAnswers(frameAnswersOfItems(answer.answers)) });
            } catch (err) {
              if (!(err instanceof FrameAnswerUnreadable)) throw err;
              unreadable.push({ id: frame.id, t: frame.t, reason: err.message });
            }
            done += 1;
            run.beat();
            input.onProgress?.(done, input.frames.length);
          }
        };
        const workers = Array.from({ length: Math.min(width, input.frames.length) }, () =>
          worker().catch((err) => {
            failed = true;
            throw err;
          }),
        );
        const settled = await Promise.allSettled(workers);
        const refusal = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
        if (refusal) throw refusal.reason;
        scored.sort((a, b) => a.t - b.t);
        unreadable.sort((a, b) => a.t - b.t);
        return { scored, unreadable, server: run.server, model, width, widthBasis: basis };
      }, { what: `thumbnail frame scoring (${input.frames.length} frames)`, act: 'decide', loadContext: FRAME_LOAD_CONTEXT, signal: run.controller.signal }),
    ),
  );
}
