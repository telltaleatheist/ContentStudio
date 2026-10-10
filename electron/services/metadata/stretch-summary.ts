/**
 * THE STRETCH SUMMARY (LEDGER #288): one paragraph for every five minutes of a video, each written
 * from that stretch's own transcript, merged in order.
 *
 * Cut at the outline's sections (Owen: "create a summary for each outline section"), each long
 * section into ~5-minute parts: even coverage, and no paragraph straddling two subjects.
 *
 * WHY (Owen, 2026-10-10, after a side-by-side on u4 and u6: "i think summaries produce better
 * titles"). Titles read a 3-chapter list for a 47-minute video; the summary carries ten paragraphs
 * of names, numbers and exact quotes, and the titles written from it were more specific. It is also
 * a quarter of the transcript's length, so the fields that read it in place of the transcript (the
 * thumbnail text, the pinned comment, the thumbnail words) cost a local model a quarter of the
 * prefill, which is what makes the 27B usable for them again.
 *
 * Routed like every other model call: the `summary` row (metadata-routing.ts), the 9B by default.
 * Each call is one stretch, ~1.2k tokens in and one paragraph out. The stretches go one at a time,
 * in order; a stretch that comes back empty fails the item by name (Law 3: nothing is skipped).
 *
 * Speaker-tagged segments are rendered with their HOST / CLIP / UNSURE labels (buildContentText),
 * and the prompt says what the labels mean: telling the host from the clip he reacts to is the one
 * thing a small model got wrong on untagged input (u4, 2026-10-10).
 *
 * The wording is a prompt asset (Law 2): shared/pipeline/stretch-summary.yml.
 */
import { promptAssets } from './prompt-assets';
import { loadContextFor } from './context-sizing';
import { LOCAL_FIELD_TIMEOUT_MS } from './metadata-tasks';
import type { MetadataRoutingOption } from './metadata-routing';
import type { AIManagerService } from './ai-manager.service';
import type { SRTSegment } from './transcription.service';
import { buildContentText, segmentsCarrySpeakerAttribution } from './transcript-import.service';
import { srtSeconds } from './chaptering/units';

const FILE = 'stretch-summary.yml';

/** Five minutes a paragraph (Owen: "a paragraph for every 5 minutes of text"). */
export const STRETCH_SECONDS = 300;
/** A last stretch shorter than this joins the one before it, so no paragraph is about a sign-off. */
export const SHORT_TAIL_SECONDS = 90;
/** One paragraph of 90-160 words, with room: the 9B ran to ~320 tokens on a dense stretch. */
export const STRETCH_MAX_TOKENS = 700;

export interface Stretch {
  /** Seconds into the video. */
  start: number;
  end: number;
  segments: SRTSegment[];
}

/** What the report stores (`_stretch_summary`) and the field calls read. */
export interface StretchSummary {
  stretchSeconds: number;
  /** The model the paragraphs came from, as routed (`qwen3.5-9b`, `claude-cli:opus`, ...). */
  model: string;
  speakerTagged: boolean;
  paragraphs: Array<{ start: number; text: string }>;
}

/** A chapter timestamp ("8:09", "1:02:03") in seconds. Anything else throws, naming it. */
export function clockSeconds(value: string): number {
  const parts = value.trim().split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) throw new Error(`not a chapter timestamp: "${value}"`);
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function clockOf(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * The video cut into stretches of about STRETCH_SECONDS, never across a section.
 *
 * `sectionStarts` are the outline's section starts in seconds (the chapter boundaries; Owen,
 * 2026-10-10: "a summary for each outline section"). Each section is cut into equal parts of about
 * five minutes (a 38-minute section: 8 parts of ~4:45; a 3-minute one: itself), so a long section
 * is not one paragraph and no paragraph straddles two subjects. With no sections the whole video
 * is one section. Captions are assigned by their start; a stretch with no text is dropped.
 */
export function stretchesOf(segments: readonly SRTSegment[], durationSec: number, sectionStarts: readonly number[] = []): Stretch[] {
  if (!(durationSec > 0)) throw new Error(`the stretch summary needs the video's length, and it is ${durationSec}`);
  const starts = [...new Set([0, ...sectionStarts.filter((t) => t > 0 && t < durationSec)])].sort((x, y) => x - y);
  const bounds: Array<[number, number]> = [];
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : durationSec;
    const parts = Math.max(1, Math.round((end - start) / STRETCH_SECONDS));
    const step = (end - start) / parts;
    for (let k = 0; k < parts; k++) bounds.push([start + k * step, k + 1 === parts ? end : start + (k + 1) * step]);
  });
  const last = bounds.length - 1;
  const out: Stretch[] = [];
  bounds.forEach(([start, end], i) => {
    const inside = segments.filter((s) => {
      const t = srtSeconds(s.start);
      // The last stretch also takes captions past the stated length (a container's rounding).
      return t >= start && (t < end || i === last);
    });
    if (inside.some((s) => s.text.trim() !== '')) out.push({ start, end, segments: inside });
  });
  // With no sections, a last stretch under SHORT_TAIL_SECONDS joins the one before it.
  if (starts.length === 1 && out.length > 1 && out[out.length - 1].end - out[out.length - 1].start < SHORT_TAIL_SECONDS) {
    const tail = out.pop()!;
    const prev = out[out.length - 1];
    out[out.length - 1] = { start: prev.start, end: tail.end, segments: [...prev.segments, ...tail.segments] };
  }
  return out;
}

/** One stretch's prompt, every slot filled with a function replacer (a `$` in a transcript stays a `$`). */
export function stretchPrompt(stretch: Stretch, durationSec: number): string {
  const assets = promptAssets();
  const tagged = segmentsCarrySpeakerAttribution(stretch.segments);
  const values: Record<string, string> = {
    start: clockOf(stretch.start),
    end: clockOf(stretch.end),
    total: clockOf(durationSec),
    tagged: tagged ? ` ${assets.pipeline(FILE, 'tagged')}` : '',
    transcript: buildContentText(stretch.segments),
  };
  return assets.pipeline(FILE, 'instruction').replace(/\{([a-z_]+)\}/g, (whole, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`${FILE} "instruction" has a slot {${name}} that nothing fills.`);
    return value;
  });
}

/** The paragraphs as the field calls show them: numbered, each under its stretch's start time. */
export function summaryParagraphs(summary: StretchSummary): string {
  return summary.paragraphs.map((p, i) => `${i + 1}. ${clockOf(p.start)}\n   ${p.text}`).join('\n\n');
}

/** The block a field call reads in place of the chapter list or the transcript. */
export function summaryBlock(summary: StretchSummary): string {
  return promptAssets().pipeline(FILE, 'block').replace(/\{paragraphs\}/g, () => summaryParagraphs(summary));
}

/**
 * Summarize every stretch on the routed option, in order. `progress` is told each stretch as it
 * starts. Throws naming the stretch when one cannot be written.
 */
export async function summarizeStretches(input: {
  aiManager: Pick<AIManagerService, 'runPlainRequest'>;
  option: MetadataRoutingOption;
  segments: readonly SRTSegment[];
  durationSec: number;
  /** The outline's section starts in seconds; empty for a video with no chapters. */
  sectionStarts: readonly number[];
  sourceLabel: string;
  progress?: (done: number, total: number) => void;
}): Promise<StretchSummary> {
  const stretches = stretchesOf(input.segments, input.durationSec, input.sectionStarts);
  if (stretches.length === 0) throw new Error(`${input.sourceLabel} has no transcript text to summarize`);
  const paragraphs: StretchSummary['paragraphs'] = [];
  for (const [i, stretch] of stretches.entries()) {
    input.progress?.(i, stretches.length);
    const prompt = stretchPrompt(stretch, input.durationSec);
    const what = `the summary of ${input.sourceLabel}, ${clockOf(stretch.start)}-${clockOf(stretch.end)} (${i + 1} of ${stretches.length})`;
    const text = await input.aiManager.runPlainRequest(
      prompt,
      input.option.model,
      what,
      input.option.kind === 'local'
        ? { thinking: false, maxTokens: STRETCH_MAX_TOKENS, loadContext: loadContextFor(prompt.length, STRETCH_MAX_TOKENS), timeoutMs: LOCAL_FIELD_TIMEOUT_MS }
        : { thinking: false },
    );
    const paragraph = (text ?? '').replace(/\s+/g, ' ').trim();
    if (paragraph === '') throw new Error(`${what} came back empty from "${input.option.model}"`);
    paragraphs.push({ start: stretch.start, text: paragraph });
  }
  input.progress?.(stretches.length, stretches.length);
  return {
    stretchSeconds: STRETCH_SECONDS,
    model: input.option.model,
    speakerTagged: stretches.some((s) => segmentsCarrySpeakerAttribution(s.segments)),
    paragraphs,
  };
}

/** A stored summary (`_stretch_summary` on a report), checked; null when the report has none. */
export function storedStretchSummary(value: unknown): StretchSummary | null {
  if (value === undefined || value === null) return null;
  const v = value as Partial<StretchSummary>;
  if (!Array.isArray(v.paragraphs) || v.paragraphs.length === 0 ||
      v.paragraphs.some((p) => typeof p?.text !== 'string' || p.text.trim() === '' || typeof p?.start !== 'number')) {
    throw new Error('the report\'s stretch summary is not a list of timed paragraphs');
  }
  return value as StretchSummary;
}
