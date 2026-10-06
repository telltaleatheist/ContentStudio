/**
 * Step 8 of chaptering (chaptering.service.ts's header), run on its own: the titles and summaries
 * of a BOUNDARIES-ONLY result (`chapter(…, { summarize: false })`), on the capable model.
 *
 * WHY IT EXISTS (LEDGER #266, stage-major batches). In a batch the boundaries run in the
 * `chapters` stage, on the scorer (the 9B), for every job before anyone's titles, and the titles
 * run in the `fields` stage on the chapters row's model (the 27B) beside the field calls, so
 * neither model is loaded twice per job. A single job keeps the one call, `chapter()` with its
 * own titles, exactly as before.
 *
 * THE SAME LOOP AS chapterUnits's step 8, not a second opinion of it: in time order, each call
 * seeing the summary and the last three titles before it, a long chapter read in parts
 * (summarize.ts), an unnamed chapter keeping its outline label with a warning (Law 3), thinking ON
 * unless the run declares it off (#208). `tools/chaptering-checks.js` holds the two equal: one
 * fake transcript through `chapter()` with titles, and through `chapter({summarize:false})` +
 * this, must give the same chapters, warnings and title calls. chaptering.service.ts is not
 * edited to call this (another change is in that file); when it is, its loop becomes this call.
 */

import * as log from 'electron-log';
import { formatClock } from './chaptering.service';
import { TITLE_MAX_TOKENS, summarizeChapter } from './summarize';
import { Chapter, ChapteringError, ChapteringProgress, ChapteringResult, ChatFn, SentenceUnit, SpeakerRole } from './types';

export interface TitleOptions {
  /** The 'summarize' role: the chapters row (snap-chapters.ts `titleChat`, or snapTransports' chat). */
  chat: ChatFn;
  promotedItems?: string[];
  channelName?: string;
  videoTitle?: string;
  /** Default ON (#208); OFF is a declared setting of the run, warned. */
  titleThinking?: boolean;
  /** Default TITLE_MAX_TOKENS. */
  titleMaxTokens?: number;
  /** Which side each speaker id is (units.ts `speakerRolesOf` over the same transcript the boundaries read). */
  speakerRoles?: ReadonlyMap<string, SpeakerRole>;
  signal?: AbortSignal;
  onProgress?: (p: ChapteringProgress) => void;
}

/**
 * Title every chapter of a boundaries-only result. Answers a new result whose chapters carry
 * their titles and summaries and whose stats and warnings carry the title calls'; the input is not
 * changed. A result that already has titles is refused by name (it would be titled twice).
 */
export async function titleChapters(boundaries: ChapteringResult, options: TitleOptions): Promise<ChapteringResult> {
  if (boundaries.chapters.some((c) => c.title !== '' || c.summary !== '')) {
    throw new ChapteringError('bad_request', 'titleChapters was given chapters that already carry titles; it titles a boundaries-only result (summarize: false)');
  }
  const t0 = Date.now();
  const stats = { ...boundaries.stats, warnings: [...boundaries.stats.warnings], titleMs: [...boundaries.stats.titleMs], titledFromParts: [...boundaries.stats.titledFromParts] };
  const warn = (message: string) => {
    log.warn(`[Chaptering] ${message}`);
    stats.warnings.push(message);
  };
  const titleThinking = options.titleThinking ?? true;
  const titleMaxTokens = options.titleMaxTokens ?? TITLE_MAX_TOKENS;
  log.info(`[Chaptering] titles: thinking ${titleThinking ? 'ON' : 'OFF'}, budget ${titleMaxTokens} tokens`);
  if (!titleThinking) warn('titles were written with thinking OFF on the title model (a declared setting of this run)');

  // The boundaries run decided whether the transcript is tagged (all-or-nothing); the roles map
  // must be the one it decided on.
  const roles = options.speakerRoles;
  if (stats.speakerTagged && roles === undefined) {
    throw new ChapteringError('bad_request', 'the boundaries were read speaker-tagged, and no speaker roles were handed to the titles');
  }
  const roleOf = (u: SentenceUnit): SpeakerRole | undefined => (stats.speakerTagged ? roles!.get(u.speaker!) : undefined);

  const spans = boundaries.chapters;
  const units = boundaries.units;
  const chapters: Chapter[] = [];
  let previousDetail = '';
  for (let i = 0; i < spans.length; i++) {
    if (options.signal?.aborted) throw new ChapteringError('cancelled', 'chaptering was cancelled');
    const s = spans[i];
    options.onProgress?.({ phase: 'summarize', done: i, total: spans.length, fraction: i / spans.length });
    const answered = await summarizeChapter(
      options.chat,
      {
        number: i + 1,
        total: spans.length,
        videoTitle: options.videoTitle || 'untitled',
        channelName: options.channelName,
        promotedItems: options.promotedItems,
        previousDetail,
        previousTitles: chapters.slice(-3).map((c) => c.title).filter((t) => t.length > 0),
        units: units.slice(s.unitRange[0], s.unitRange[1]).map((u) => ({ text: u.text, start: u.start, end: u.end, role: roleOf(u) })),
        entityScaffold: '',
        thinking: titleThinking,
        maxTokens: titleMaxTokens,
        tagged: stats.speakerTagged,
        clock: `${formatClock(s.startSec)}-${formatClock(s.endSec)}`,
      },
      warn,
      options.signal,
      formatClock,
    );
    stats.chatCalls += answered.callMs.length;
    stats.titleMs.push(...answered.callMs);
    if (answered.parts > 1) stats.titledFromParts.push(i + 1);
    if (!answered.title) warn(`the chapter at ${formatClock(s.startSec)} was not named by the model; it carries its outline label "${s.label}"`);
    previousDetail = answered.summary || answered.title;
    chapters.push({ ...s, title: answered.title, summary: answered.summary });
  }
  stats.summarizeMs = Date.now() - t0;
  stats.totalMs = boundaries.stats.totalMs + stats.summarizeMs;
  options.onProgress?.({ phase: 'done', done: chapters.length, total: chapters.length, fraction: 1 });
  return { ...boundaries, chapters, stats };
}
