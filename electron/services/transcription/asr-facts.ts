/**
 * WHERE THE ASR CONTEXT'S FACTS COME FROM (LEDGER #206). asr-context.ts is the pure builder;
 * this file reads the disk for it, once per recording.
 *
 * #206 lists the sources, and each is read here or its absence is stated:
 *
 *   filename title   the recording's own name, as whisper.cpp's `--prompt` seed was.
 *   job name         the queue job's name (the pipeline's `jobName`).
 *   brand terms,     the ACTIVE channel's (its prompt set, `channels/<id>.yml`). A channel
 *   promoted items   the run names that the prompt assets do not know throws (Law 1) — the
 *                    generator would throw on it a minute later anyway.
 *   speaker names    none exist yet: speaker-enrollment.json holds an embedding and a path, not
 *                    a name, and no item carries named speakers. The host's own name reaches the
 *                    context through the channel's brand terms ("owen morgan").
 *   existing title / an EARLIER RUN over the same file (the newest report item whose
 *   description      `source_key` matches: its titles, tags and description), a LINKED EDITOR
 *                    STORY (its title), the operator's NOTES on the input, and in the editor the
 *                    session's STORY TITLES. A transcript import never reaches asr: it arrives
 *                    with its own words.
 *
 * A report file that cannot be read is logged and skipped, never fatal: the facts are a seed
 * for spelling, and a corrupt old report must not stop a new transcription. That skip is
 * declared in the log line (Law 8), with the file's name.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';

import { promptAssets } from '../metadata/prompt-assets';
import { sourceKeyOf } from '../metadata/item-identity';
import { buildAsrContext, titleFromFilename, type AsrContextTemplate, type AsrItemFacts } from './asr-context';

const PIPELINE_FILE = 'transcription.yml';

/** The context's model-facing words, from the installed prompt tree (Law 2). Throws naming the file and key when absent. */
export function asrContextTemplate(): AsrContextTemplate {
  const assets = promptAssets();
  const label = (key: string): string => assets.pipeline(PIPELINE_FILE, `labels.${key}`);
  return {
    instruction: assets.pipeline(PIPELINE_FILE, 'instruction'),
    labels: {
      title: label('title'),
      job: label('job'),
      also_titled: label('also_titled'),
      names: label('names'),
      tags: label('tags'),
      promoted: label('promoted'),
      notes: label('notes'),
      description: label('description'),
    },
  };
}

/** The active channel's spelling facts, or none when the caller has no channel (the episode splitter). */
function channelFacts(promptSet: string | null | undefined): { names: string[]; promotedItems: string[] } {
  if (!promptSet) return { names: [], promotedItems: [] };
  const channel = promptAssets().channel(promptSet);
  return { names: channel.brandTerms ?? [], promotedItems: channel.promotedItems ?? [] };
}

/** What an earlier run wrote about this same file: the newest report item with its source key. */
export interface PriorItemFacts {
  readonly titles: string[];
  readonly tags: string[];
  readonly description: string | null;
  /** Which report it came from, for the log. */
  readonly from: string;
}

function splitTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  if (typeof raw === 'string') return raw.split(',').map((t) => t.trim()).filter((t) => t !== '');
  return [];
}

/**
 * The newest generated item for `videoPath` under `<outputDir>/.contentstudio/metadata/`, or
 * null when no run has written one. The join is the item's recorded `source_key`, the same key
 * carry-forward and the saved transcripts use (item-identity.ts `sourceKeyOf`).
 */
export function findPriorItemFacts(outputDir: string, videoPath: string): PriorItemFacts | null {
  const dir = path.join(outputDir, '.contentstudio', 'metadata');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const key = sourceKeyOf(videoPath);
  let best: { createdAt: string; item: any; file: string } | null = null;
  for (const file of files) {
    let job: any;
    try {
      job = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (error) {
      log.warn(`[ASR facts] skipped report ${file} while looking for earlier titles of ${path.basename(videoPath)}: ${(error as Error).message}`);
      continue;
    }
    const createdAt = typeof job?.created_at === 'string' ? job.created_at : '';
    for (const item of Array.isArray(job?.items) ? job.items : []) {
      if (item?.source_key !== key) continue;
      if (best === null || createdAt > best.createdAt) best = { createdAt, item, file };
    }
  }
  if (best === null) return null;
  const item = best.item;
  const titles = Array.isArray(item.titles) ? item.titles.filter((t: unknown): t is string => typeof t === 'string') : [];
  const hook = typeof item.description_hook === 'string' ? item.description_hook.trim() : '';
  const body = typeof item.description === 'string' ? item.description.trim() : '';
  const description = [hook, body].filter((s) => s !== '').join(' ');
  return { titles, tags: splitTags(item.tags), description: description === '' ? null : description, from: best.file };
}

export interface PipelineItemFactsInput {
  readonly videoPath: string;
  readonly jobName?: string | null;
  /** The run's channel (prompt set id); absent only for a caller that has none. */
  readonly promptSet?: string | null;
  /** The run's output directory, where earlier reports live; absent = do not look. */
  readonly outputDir?: string | null;
  readonly notes?: string | null;
  /** A linked editor story's title, when the input carries a TranscriptRef. */
  readonly storyTitle?: string | null;
}

/** Everything the pipeline knows about one input, as facts. */
export function pipelineItemFacts(input: PipelineItemFactsInput): { facts: AsrItemFacts; prior: PriorItemFacts | null } {
  const channel = channelFacts(input.promptSet);
  const prior = input.outputDir ? findPriorItemFacts(input.outputDir, input.videoPath) : null;
  return {
    facts: {
      title: titleFromFilename(input.videoPath),
      jobName: input.jobName ?? null,
      otherTitles: [input.storyTitle ? titleFromFilename(input.storyTitle) : null, ...(prior?.titles ?? [])],
      names: channel.names,
      tags: prior?.tags ?? [],
      promotedItems: channel.promotedItems,
      notes: input.notes ?? null,
      description: prior?.description ?? null,
    },
    prior,
  };
}

/** The pipeline's context for one input, and a one-line account of what went into it for the log. */
export function pipelineAsrContext(input: PipelineItemFactsInput): { context: string; account: string } {
  const { facts, prior } = pipelineItemFacts(input);
  const context = buildAsrContext(facts, asrContextTemplate());
  const account =
    `title "${facts.title}"` +
    (input.jobName ? `, job "${input.jobName}"` : '') +
    (input.promptSet ? `, channel ${input.promptSet}` : ', no channel') +
    (input.storyTitle ? `, story "${input.storyTitle}"` : '') +
    (prior ? `, an earlier run's titles/tags/description (${prior.from})` : ', no earlier run') +
    (input.notes ? ', operator notes' : '');
  return { context, account };
}

/**
 * The editor's facts for one session track: the session and track names, the story titles in
 * `<session>_edits.json` (what the operator called each part of the stream), and the active
 * channel's terms. A missing edits file is an ordinary state (a session never edited); an
 * unreadable one is logged and skipped, like a report.
 */
export function editorTrackFacts(input: {
  readonly session: string;
  readonly editsPath: string;
  readonly promptSet?: string | null;
}): AsrItemFacts {
  const channel = channelFacts(input.promptSet);
  const storyTitles: string[] = [];
  if (fs.existsSync(input.editsPath)) {
    try {
      const edits = JSON.parse(fs.readFileSync(input.editsPath, 'utf8'));
      for (const story of Array.isArray(edits?.stories) ? edits.stories : []) {
        if (typeof story?.title === 'string') storyTitles.push(titleFromFilename(story.title));
      }
    } catch (error) {
      log.warn(`[ASR facts] skipped ${input.editsPath} while collecting story titles: ${(error as Error).message}`);
    }
  }
  // The track label ("mic audio_processed") names a microphone, not anything said: left out.
  return {
    title: input.session,
    otherTitles: storyTitles,
    names: channel.names,
    promotedItems: channel.promotedItems,
  };
}
