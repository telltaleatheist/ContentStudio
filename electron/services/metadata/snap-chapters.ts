/**
 * Snap chaptering, wired: the pure service (chaptering/, LEDGER #199, #208) over the Crucible
 * transport, for its three consumers — the metadata pipeline's chapters (metadata-generator's
 * `chapterEngine: 'snap'`), the editor's Stories (story-ipc.ts) and the in-queue split of a
 * stream (ipc-handlers.ts `analyze-transcript-split`).
 *
 * THE ROLES (Owen, #199: "9b -> outline, outline -> snap, final chapter -> 27b -> chapter title"):
 *
 *   outline + decide  CHAPTER_SCORER_MODEL (the 9B), a fixed role declared in metadata-routing.ts,
 *                     always on a Crucible server: decide needs a distribution and no upstream
 *                     returns one. Loaded at SCORER_LOAD_CONTEXT under the job's lease.
 *   titles            the CHAPTERS routing row: a local model (the 27B) through the transport at
 *                     TITLE_LOAD_CONTEXT, or a cloud row (Anthropic through Crucible, or claude -p
 *                     outside it) through the caller's `cloudPlain` door, which strips <think> and
 *                     takes no lane.
 *
 * EVERY LOCAL CALL TAKES ITS LANE ITSELF (queueAITask, P3), call by call, as the field calls do:
 * a caller never wraps a whole run in a lane step, because a claude -p title inside a held GPU
 * slot would hold the card for nothing, and a GPU call nested inside another deadlocks the slot.
 * The job's lease (one per server per job, plan 13.3) keeps the model resident between them.
 *
 * THE TWO DECLARED READINGS OF THE DOOR'S REFUSALS (Law 10: by code, never by sentence):
 *   - `truncated` on a title is a run-out of its budget: the service ships that chapter with its
 *     outline label and a warning (Law 3), so the door's refusal is handed back as `length`;
 *   - `truncated` on an outline is the same `length`, which outline.ts refuses by name.
 * Every other refusal (busy, over_context, lease_lost, decide_not_served…) passes through as itself.
 */

import * as log from 'electron-log';
import { crucibleTransport, type PromptTraceRecord } from '../../crucible/transport';
import { isCrucibleCallError } from '../../crucible/errors';
import type { JobLeases } from '../../crucible/lease';
import { gpuCall, queueAITask } from '../queue-manager.service';
import { stripThinking } from './plain-call';
import type { MetadataRoutingOption, SnapChapterModels } from './metadata-routing';
import type { ChapterPipelineResult } from './chapter-transcript';
import type { Chapter as PublishedChapter } from './chapter-generator.service';
import { TimeUtils } from './chapter-generator.service';
import type { ChapteringResult, ChatFn, ChatOptions, DecideFn } from './chaptering/types';

/** The 9B's load context: a snap state is ≤12k tokens plus its questions (plan 7.3, chunks.ts). */
export const SCORER_LOAD_CONTEXT = 16384;

/**
 * The title model's load context when it is local: a 6,000-token chapter window + the ~1,000-token
 * body + the 16,384-token thinking budget (#208) is ~23.4k (summarize.ts), so 24,576. The Mac's
 * 27B-4bit takes up to 131,072 (its capability row, Crucible 1.0.38); the PC's 27B loads at 16,384
 * (plan 0 #11), where a thinking-on title is refused `over_context` by name before sending, never cut.
 */
export const TITLE_LOAD_CONTEXT = 24576;

/** The shape of every cloud title call: the caller's door (AIManagerService.runPlainRequest). */
export type CloudPlain = (prompt: string, model: string, what: string, shape: { thinking: boolean }) => Promise<string | null>;

export interface SnapTitleDeps {
  /** The chapters routing row: it writes every title and summary. */
  titles: MetadataRoutingOption;
  /** The job's leases (the pipeline's JobModelLifecycle.leases, or one the caller releases). Required for a local row. */
  job?: JobLeases;
  /** Where every call records itself (Law 8); null for a caller with no run trace. */
  trace: PromptTraceRecord[] | null;
  /** Required when the chapters row is cloud. */
  cloudPlain?: CloudPlain;
  signal?: AbortSignal;
  /** Where a declared reading goes besides the log (the run's warnings). */
  warn?: (message: string) => void;
  /** A name for the lane log lines ("chapters-job-3", "story analysis"). */
  laneName: string;
}

export interface SnapTransportDeps extends Omit<SnapTitleDeps, 'titles' | 'job'> {
  models: SnapChapterModels;
  /** The job's leases: the scorer is always local, so a snap run always has one. */
  job: JobLeases;
}

/** The sampling keys the title call must have had honoured as sent (the Crucible agent's check, 1.0.38). */
const REQUESTED_KEYS = [['thinking', 'enable_thinking'], ['max_tokens']] as const;

/** One local chat on its lane, under the job's lease; a run-out comes back as `length` (the header's reading). */
async function localChat(
  deps: Omit<SnapTitleDeps, 'titles' | 'cloudPlain' | 'job'> & { job: JobLeases },
  model: string,
  loadContext: number,
  prompt: string,
  o: ChatOptions,
  onSampling: (sampling: Record<string, string>, server: string) => void,
): Promise<{ text: string; finishReason: string }> {
  try {
    const answer = await queueAITask(gpuCall(model), deps.laneName, `snap ${o.role}: ${o.what}`, () =>
      crucibleTransport().chat({
        model,
        prompt,
        act: 'generate',
        thinking: o.thinking,
        maxTokens: o.maxTokens,
        ...(o.temperature === undefined ? {} : { temperature: o.temperature }),
        loadContext,
        job: deps.job,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        what: o.what,
        trace: deps.trace,
      }),
    );
    if (answer.sampling !== null) onSampling(answer.sampling, answer.server);
    // The PC answers thinking inside the content (vLLM without a reasoning parser); stripped,
    // an unclosed block included, as every other plain call is (plain-call.ts).
    return { text: stripThinking(answer.text), finishReason: answer.finishReason };
  } catch (err) {
    if (isCrucibleCallError(err, 'truncated')) return { text: '', finishReason: 'length' };
    throw err;
  }
}

/**
 * The 'summarize' role alone: the chapters row writing a title and summary. snapTransports uses
 * it, and so does the editor's story title (story-ipc.ts `story:suggest-title`), which needs no
 * scorer and so no Crucible server when the row is claude -p.
 */
export function titleChat(deps: SnapTitleDeps): ChatFn {
  if (deps.titles.kind === 'cloud' && deps.cloudPlain === undefined) {
    throw new Error(`the chapters row is ${deps.titles.label}, a cloud option, and no cloud door was handed to the snap wiring`);
  }
  let samplingWarned = false;
  const onSampling = (sampling: Record<string, string>, server: string) => {
    if (samplingWarned) return;
    const off = REQUESTED_KEYS.flatMap((names) => {
      const key = names.find((k) => k in sampling);
      return key !== undefined && sampling[key] !== 'request' ? [`${key}: ${sampling[key]}`] : [];
    });
    if (off.length === 0) return;
    samplingWarned = true;
    const message =
      `the title model on "${server}" did not take the title call's own ${off.join(', ')} (X-Crucible-Sampling); ` +
      `thinking and its budget were the server's`;
    log.warn(`[SnapChapters] ${message}`);
    deps.warn?.(message);
  };
  return async (prompt, o) => {
    if (o.role !== 'summarize') throw new Error(`the title door was asked for the ${o.role} role (${o.what})`);
    if (deps.titles.kind === 'local') {
      if (deps.job === undefined) throw new Error(`the chapters row is the local ${deps.titles.model}, and no job lease was handed to the snap wiring`);
      return localChat({ ...deps, job: deps.job }, deps.titles.model, TITLE_LOAD_CONTEXT, prompt, o, onSampling);
    }
    try {
      const text = await deps.cloudPlain!(prompt, deps.titles.model, o.what, { thinking: o.thinking });
      // An empty answer is the one-decision cost the service warns about (Law 3).
      return { text: text ?? '', finishReason: 'stop' };
    } catch (err) {
      if (isCrucibleCallError(err, 'truncated')) return { text: '', finishReason: 'length' };
      throw err;
    }
  };
}

/**
 * The service's `chat` and `decide` over the Crucible transport, per the roles above. Nothing
 * here picks a model: `models` was resolved by resolveSnapChapterModels.
 */
export function snapTransports(deps: SnapTransportDeps): { chat: ChatFn; decide: DecideFn } {
  const { models } = deps;
  // Built on the first title call: a boundaries-only run (the in-queue split) never titles, so it
  // needs no cloud door even when the chapters row is cloud.
  let titles: ChatFn | null = null;
  const chat: ChatFn = (prompt, o) => {
    if (o.role === 'outline') return localChat(deps, models.scorer.model, SCORER_LOAD_CONTEXT, prompt, o, () => undefined);
    titles ??= titleChat({ ...deps, titles: models.titles });
    return titles(prompt, o);
  };
  const decide: DecideFn = (request, o) =>
    queueAITask(gpuCall(models.scorer.model), deps.laneName, `snap decide: ${o.what}`, () =>
      crucibleTransport().decide({
        model: models.scorer.model,
        state: request.state,
        questions: request.questions,
        missing: request.missing,
        loadContext: SCORER_LOAD_CONTEXT,
        job: deps.job,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        what: o.what,
        trace: deps.trace,
      }),
    ) as ReturnType<DecideFn>;
  return { chat, decide };
}

/**
 * A snap result in the shape every downstream stage of the metadata pipeline is written against
 * (chapter-transcript.ts ChapterPipelineResult), so promo exclusion, the chapter digest, the tag
 * pools and the report read it exactly as they read the whole-transcript engine's.
 *
 * A chapter the model did not name publishes under its outline label: the service already warned
 * that it did (Law 3's delivered-and-flagged), and a blank chapter title is not publishable. A
 * chapter the ad check confirmed carries `isPromo` (Law 10: typed, so promo-chapters.ts excludes it
 * without matching its words).
 */
export function toChapterPipelineResult(result: ChapteringResult, titleThinking: boolean): ChapterPipelineResult {
  const s = result.stats;
  const chapters: PublishedChapter[] = result.chapters.map((c, i) => ({
    timestamp: TimeUtils.secondsToYoutubeTime(c.startSec),
    title: c.title || c.label,
    sequence: i,
    endTimestamp: TimeUtils.secondsToYoutubeTime(c.endSec),
    detail: c.summary,
    ...(c.isAd ? { isPromo: true } : {}),
  }));
  const durationSeconds = result.chapters.length ? result.chapters[result.chapters.length - 1].endSec : 0;
  return {
    chapters,
    subjects: chapters.map((c) => c.title),
    subjectDetails: chapters.map((c) => ({ about: c.title, detail: c.detail ?? '' })),
    warnings: [...s.warnings],
    stats: {
      engine: 'snap',
      durationSeconds,
      chaptersClaimed: result.chapters.length,
      chaptersMapped: result.chapters.length,
      chaptersDropped: 0,
      // Structurally zero: every time is a sentence unit's (Law 6), never a guess.
      approxStarts: 0,
      speakerTagged: s.speakerTagged,
      calls: s.chatCalls + s.decideCalls,
      snap: {
        granularity: result.granularity,
        switchCost: result.switchCost,
        units: s.unitCount,
        chunks: s.chunkCount,
        refinedSections: s.refinedSections,
        decideCalls: s.decideCalls,
        streamOutline: s.streamOutline,
        adBaseline: s.adBaseline,
        plugVerdicts: result.plugVerdicts.map((v) => ({ ...v })),
        titleThinking,
        titleMs: [...s.titleMs],
        outlineMs: s.outlineMs,
        assignMs: s.assignMs,
        plugMs: s.plugMs,
        summarizeMs: s.summarizeMs,
      },
    },
  };
}
