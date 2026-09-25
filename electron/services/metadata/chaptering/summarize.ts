/**
 * The final title and summary of each chapter — `summarize_chapter` on the 'summarize' role
 * (the capable routed model, the 27B: LEDGER #199 "final chapter -> 27b -> chapter title").
 *
 * The prompt, its placeholders and the answer's shape are the ones the whole-transcript
 * service sends today (chapter-whole-transcript.service.ts detailChapters / askDetail), so a
 * chapter titled here reads exactly as one titled there: title on the first line, summary
 * after it, plain text (Law 12).
 *
 * THINKING ON, with a declared budget (Owen, 2026-09-25, LEDGER #208: "i would prefer to turn
 * thinking on if we're doing something that might require it"; a title and summary is a
 * judgment call). The budget is TITLE_MAX_TOKENS, 16,384, and it is also the time cap: there is
 * no server-side thinking budget on either backend (Crucible 1.0.38), so max_tokens is the only
 * lever, and at the Mac 27B's rate 8,192 thinking tokens took ~400 s. P8a measured the cost at
 * 8,192 (37-412 s a title, 4 of 9 ran out); P8b measures it at 16,384 and records it
 * (docs/crucible/P8b.md). A title that runs out its budget carries its outline label and a
 * warning (Law 3), never a block. Thinking OFF stays a declared setting of the run
 * (chaptering.service.ts `titleThinking`).
 *
 * A SPEAKER-TAGGED TRANSCRIPT (the brief's decision 5): when every sentence's speaker resolved to
 * a side (units.ts `speakerRolesOf`), the call is `summarize_chapter_tagged` over HOST:/CLIP:/
 * UNSURE: lines, one per sentence unit, exactly as the whole-transcript engine renders cues.
 *
 * A LONG CHAPTER IS READ IN PARTS (LEDGER #196: every local call under ~12-16k tokens of
 * transcript). A `stories` chapter of a stream can be an hour and a half of speech, ~15k tokens
 * on its own. So a chapter whose own transcript is over SUMMARIZE_TRANSCRIPT_TOKENS is cut at
 * sentence boundaries into equal windows under it; each window is titled and summarised by the
 * same body, and the chapter's title comes from `summarize_chapter_parts` over those parts in
 * order. It is DECLARED: the chapter is listed in stats.titledFromParts and a warning names it
 * (Law 8). Nothing is truncated: every sentence of the chapter is read by some call.
 *
 * An answer that cannot be read costs this ONE chapter (or part) its title and prose, warned
 * about and never re-asked (Law 3); the chapter still exists at the right second and carries
 * its outline label. A transport failure throws out.
 */

import { CHAPTER_PROMPTS } from '../chapter-prompts';
import { parseTitleDetail } from '../plain-call';
import { formatPrompt } from '../system-prompts';
import { ChatFn, SpeakerRole } from './types';
import { SNAP_PROMPTS, promotedItemsLine } from './prompts';
import { CHARS_PER_TOKEN } from './chunks';

/**
 * The title call's output budget with thinking on (#208: start at 16,384 and measure). With
 * thinking off the answer is two lines, and the same number is only a ceiling.
 */
export const TITLE_MAX_TOKENS = 16384;

/**
 * The most transcript one title call reads, in tokens (the declared ~4 characters per token of
 * chunks.ts). 6,000 + the ~1,000-token body + the 16,384 budget is ~23.4k: the transport loads
 * the title model at TITLE_LOAD_CONTEXT to hold it (snap-chapters.ts), and refuses by name before
 * sending on a server whose load is smaller (the PC's 27B loads at 16,384; P2's context check).
 */
export const SUMMARIZE_TRANSCRIPT_TOKENS = 6000;

/** One sentence of the chapter, as the title call needs it. */
export interface SummarizeUnit {
  text: string;
  start: number;
  end: number;
  /** The unit's side when the run is tagged (every unit resolved); absent otherwise. */
  role?: SpeakerRole;
}

export interface SummarizeInput {
  number: number;
  total: number;
  videoTitle: string;
  channelName?: string;
  promotedItems?: readonly string[];
  /** The previous chapter's summary (or its title when it had none): the deleted pipeline's law, kept. */
  previousDetail: string;
  /** The last few titles already written, so this one names what is new (2026-08-30 campaign). */
  previousTitles: readonly string[];
  /** The chapter's own sentences, in order. */
  units: readonly SummarizeUnit[];
  /** Rendered by the caller, may be empty (the whole-video name scaffold is P4's; empty here). */
  entityScaffold: string;
  clock: string;
  /** Thinking on the title call: ON by default (#208), OFF only as a declared setting of the run. */
  thinking: boolean;
  /** The output budget; TITLE_MAX_TOKENS unless the run states another. */
  maxTokens?: number;
  /** Every unit carries a `role`: the call is summarize_chapter_tagged over HOST:/CLIP: lines. */
  tagged?: boolean;
}

export interface SummarizeResult {
  title: string;
  summary: string;
  /** How many parts the chapter was read in (1 = its whole transcript in one call). */
  parts: number;
  /** Wall time of every call this chapter took, in ms (P8b's cost record). */
  callMs: number[];
}

/** The context lines above the transcript, as chapter-whole-transcript.service.ts contextLines renders them. */
export function contextLines(channelName: string | undefined, previousDetail: string, previousTitles: readonly string[]): string {
  const lines: string[] = [];
  if (channelName) lines.push(`Channel: ${channelName}`);
  if (previousDetail) lines.push(`Previous chapter: "${previousDetail}"`);
  if (previousTitles.length > 0) {
    lines.push(
      `The chapters just before this one are titled ${previousTitles.map((t) => `"${t}"`).join(', ')} — ` +
        `this chapter continues from them, so its title names what is NEW in this stretch, not their ` +
        `wording or their angle re-used.`,
    );
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export function summarizePrompt(
  input: Omit<SummarizeInput, 'units' | 'number' | 'thinking'> & { number: number | string; transcript: string },
): string {
  return formatPrompt(input.tagged ? CHAPTER_PROMPTS.SUMMARIZE_CHAPTER_TAGGED : CHAPTER_PROMPTS.SUMMARIZE_CHAPTER, {
    number: input.number,
    video: input.videoTitle || 'untitled',
    promoted_items: promotedItemsLine(input.promotedItems),
    context_lines: contextLines(input.channelName, input.previousDetail, input.previousTitles),
    entity_scaffold: input.entityScaffold,
    transcript: input.transcript,
  });
}

/**
 * The transcript a title call reads: the sentences joined with spaces, or — tagged — one
 * `HOST: …` / `CLIP: …` / `UNSURE: …` line per sentence (chapter-whole-transcript.service.ts
 * transcriptBetween's rendering, which labels every line, the unsure ones included).
 */
export function renderTranscript(units: readonly SummarizeUnit[], tagged: boolean): string {
  if (!tagged) return units.map((u) => u.text).join(' ');
  return units
    .map((u) => {
      if (u.role === undefined) throw new Error(`a tagged title call got a sentence with no side: "${u.text.slice(0, 60)}"`);
      return `${u.role.toUpperCase()}: ${u.text}`;
    })
    .join('\n');
}

/**
 * The windows a chapter is read in: one when its transcript fits the budget, else the fewest
 * equal windows (by characters, at sentence boundaries) that each fit it.
 */
export function summaryWindows(texts: readonly string[], budgetTokens: number = SUMMARIZE_TRANSCRIPT_TOKENS): Array<[number, number]> {
  // +7 per sentence covers a tagged line's "UNSURE: " and its newline.
  const chars = texts.map((t) => t.length + 8);
  const total = chars.reduce((a, b) => a + b, 0);
  const budget = budgetTokens * CHARS_PER_TOKEN;
  if (total <= budget || texts.length < 2) return [[0, texts.length]];
  const count = Math.ceil(total / budget);
  const target = total / count;
  const out: Array<[number, number]> = [];
  let from = 0;
  let acc = 0;
  for (let i = 0; i < texts.length; i++) {
    acc += chars[i];
    const left = count - out.length - 1;
    if (left > 0 && acc >= target * (out.length + 1) && texts.length - (i + 1) >= left) {
      out.push([from, i + 1]);
      from = i + 1;
    }
  }
  out.push([from, texts.length]);
  return out;
}

async function titleCall(
  chat: ChatFn,
  prompt: string,
  what: string,
  warn: (message: string) => void,
  shape: { thinking: boolean; maxTokens: number },
  callMs: number[],
  signal?: AbortSignal,
): Promise<{ title: string; summary: string }> {
  const t = Date.now();
  const result = await chat(prompt, { role: 'summarize', maxTokens: shape.maxTokens, thinking: shape.thinking, what, signal });
  callMs.push(Date.now() - t);
  if (result.finishReason === 'length') {
    warn(
      `${what} ran out its ${shape.maxTokens}-token budget${shape.thinking ? ' (thinking on)' : ''} before answering, so it ` +
        `carries no title or summary from the model`,
    );
    return { title: '', summary: '' };
  }
  try {
    const { title, detail } = parseTitleDetail(result.text, `${what} (chapters)`);
    if (!detail) warn(`${what} could not be described by the model, so it carries no summary`);
    return { title, summary: detail };
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return { title: '', summary: '' };
  }
}

export async function summarizeChapter(
  chat: ChatFn,
  input: SummarizeInput,
  warn: (message: string) => void,
  signal?: AbortSignal,
  clockOf: (seconds: number) => string = (s) => `${Math.floor(s)}s`,
): Promise<SummarizeResult> {
  const what = `chapter ${input.number}/${input.total} (${input.clock})`;
  const shape = { thinking: input.thinking, maxTokens: input.maxTokens ?? TITLE_MAX_TOKENS };
  const tagged = input.tagged === true;
  const callMs: number[] = [];
  const texts = input.units.map((u) => u.text);
  const windows = summaryWindows(texts);
  if (windows.length === 1) {
    const prompt = summarizePrompt({ ...input, transcript: renderTranscript(input.units, tagged) });
    const answer = await titleCall(chat, prompt, what, warn, shape, callMs, signal);
    return { ...answer, parts: 1, callMs };
  }

  warn(
    `${what} is over the title call's ${SUMMARIZE_TRANSCRIPT_TOKENS}-token transcript budget, so it was read in ` +
      `${windows.length} parts and titled from their titles and summaries`,
  );
  const parts: Array<{ clock: string; title: string; summary: string }> = [];
  let previousDetail = input.previousDetail;
  for (let k = 0; k < windows.length; k++) {
    const [a, b] = windows[k];
    const clock = `${clockOf(input.units[a].start)}-${clockOf(input.units[b - 1].end)}`;
    const part = await titleCall(
      chat,
      summarizePrompt({
        ...input,
        number: `${input.number} (part ${k + 1} of ${windows.length})`,
        previousDetail,
        transcript: renderTranscript(input.units.slice(a, b), tagged),
      }),
      `${what} part ${k + 1}/${windows.length} (${clock})`,
      warn,
      shape,
      callMs,
      signal,
    );
    parts.push({ clock, ...part });
    previousDetail = part.summary || part.title || previousDetail;
  }
  const answer = await titleFromParts(chat, { ...input, what: `${what} from its ${windows.length} parts` }, parts, warn, shape, callMs, signal);
  return { ...answer, parts: windows.length, callMs };
}

/** One part of a long chapter (or one chapter of a story), as `summarize_chapter_parts` reads it. */
export interface TitlePart {
  clock: string;
  title: string;
  summary: string;
}

/**
 * `summarize_chapter_parts` over `parts` in order: the title and summary of a whole from its
 * parts' own titles and summaries. The long-chapter path above uses it, and so does the editor's
 * story title (story-ipc.ts `story:suggest-title`: a story is a `stories` chapter, and its parts
 * are the chapters the editor already derived inside it).
 */
export async function titleFromParts(
  chat: ChatFn,
  input: Pick<SummarizeInput, 'number' | 'videoTitle' | 'channelName' | 'promotedItems' | 'previousDetail' | 'previousTitles'> & { what: string },
  parts: readonly TitlePart[],
  warn: (message: string) => void,
  shape: { thinking: boolean; maxTokens: number },
  callMs: number[] = [],
  signal?: AbortSignal,
): Promise<{ title: string; summary: string }> {
  return titleCall(
    chat,
    SNAP_PROMPTS.summarizeParts({
      number: input.number,
      video: input.videoTitle || 'untitled',
      promoted_items: promotedItemsLine(input.promotedItems),
      context_lines: contextLines(input.channelName, input.previousDetail, input.previousTitles),
      parts: parts.map((p, k) => `Part ${k + 1} (${p.clock}): ${p.title || '(untitled)'}\n${p.summary}`.trim()).join('\n\n'),
    }),
    input.what,
    warn,
    shape,
    callMs,
    signal,
  );
}
