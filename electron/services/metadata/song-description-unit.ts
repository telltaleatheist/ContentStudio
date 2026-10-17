/**
 * A SONG'S DESCRIPTION (LEDGER #308, Little Goose Productions): ONE plain-text call that writes the
 * short summary of the song from its lyrics. Everything under the summary is CODE: the lyrics
 * block (song-lyrics.ts, set on the AI manager per item) and the channel's closing line (its
 * `description_links`), appended by `finalizeMetadata` exactly as every channel's links are.
 *
 * WHY NOT DescriptionUnit. That unit writes a search-snippet hook and a body in the commentary
 * channels' register, from a chapter list or a transcript, and its prompt (shared/pipeline/
 * description.yml) is built around debunking: its worked examples are about grifters. A song's
 * description is two or three warm sentences for parents, written from lyrics, and the approved
 * exemplar (2026-10-15, "The Gathering in the Clearing") has no hook line of its own. Planned in
 * its place for a channel whose file says `description_lyrics: true` (planMetadataUnits), on the
 * same `description` routing row.
 *
 * THE ANSWER IS THE PARAGRAPH, judged and never re-asked (Law 3): a summary outside the channel's
 * `body_words`, or not two or three sentences, is kept as written and named in the run's warnings.
 * An empty answer throws: there is nothing to keep.
 */
import { loadContextFor } from './context-sizing';
import { JobModelLifecycle } from './model-lifecycle';
import { MetadataRoutingOption } from './metadata-routing';
import { promptAssets, type ChannelData } from './prompt-assets';
import type { ExpectedLoad, MetadataFieldId, MetadataRunContext, MetadataUnit } from './metadata-tasks';
import type { AIManagerService } from './ai-manager.service';

const SONG_DESCRIPTION_FILE = 'song-description.yml';

/** Answer-sized: the summary is under 100 words. A run-on stops as `length`, a hard failure (LEDGER #112). */
export const SONG_DESCRIPTION_NUM_PREDICT = 1024;

const CALL_TIMEOUT_MS = 600_000;

/** How many sentences the approved summary has: two or three. */
const SENTENCES: [number, number] = [2, 3];

export class SongDescriptionUnit implements MetadataUnit {
  readonly label: string;
  readonly fields: MetadataFieldId[] = ['description'];
  /** It reads the lyrics (the item's content) and nothing another unit writes. */
  readonly inputFields: MetadataFieldId[] = [];
  readonly localModel?: string;
  private readonly local: boolean;

  constructor(
    private readonly aiManager: AIManagerService,
    private readonly option: MetadataRoutingOption,
    private readonly lifecycle: JobModelLifecycle
  ) {
    this.local = option.kind === 'local';
    this.label = `song description (${this.local ? 'local' : 'cloud'} ${option.model})`;
    if (this.local) this.localModel = option.model;
  }

  expectedLoad(ctx: MetadataRunContext): ExpectedLoad | null {
    if (!this.local) return null;
    return { sessions: this.lifecycle.sessions, tokens: loadContextFor(this.buildPrompt(ctx).length, SONG_DESCRIPTION_NUM_PREDICT), calls: 1 };
  }

  describePrompt(ctx: MetadataRunContext): string {
    return `# SONG DESCRIPTION (${this.option.model}, plain text): the summary only; the lyrics and the closing line are added by code\n\n${this.buildPrompt(ctx)}`;
  }

  async generate(ctx: MetadataRunContext): Promise<Record<string, unknown>> {
    const prompt = this.buildPrompt(ctx);
    const what = `the song description for ${ctx.sourceLabel}`;
    const text = await this.aiManager.runPlainRequest(
      prompt,
      this.option.model,
      what,
      this.local
        ? {
            thinking: false,
            maxTokens: SONG_DESCRIPTION_NUM_PREDICT,
            loadContext: loadContextFor(prompt.length, SONG_DESCRIPTION_NUM_PREDICT),
            job: this.lifecycle.sessions,
            timeoutMs: CALL_TIMEOUT_MS,
          }
        : { thinking: false }
    );
    const summary = (text ?? '').trim().replace(/^["“]|["”]$/g, '').trim();
    if (!summary) throw new Error(`${what} on "${this.option.model}" came back empty`);
    for (const fault of judgeSongSummary(summary, this.wordRange(this.channel(ctx)))) {
      ctx.warn(`the song description ${fault}; it is kept exactly as the model wrote it — fix the prompt, not the answer`);
    }
    return { description: summary };
  }

  private channel(ctx: MetadataRunContext): ChannelData {
    return promptAssets().channel(ctx.promptSetName);
  }

  private wordRange(channel: ChannelData): [number, number] {
    const range = promptAssets().field(channel, 'description').wordRange;
    if (!range) {
      throw new Error(
        `The song description for channel "${channel.id}" has no word range: shared/fields/description.yml declares no ` +
          `"body_words" for field variant "${channel.fieldVariant}".`
      );
    }
    return range;
  }

  private buildPrompt(ctx: MetadataRunContext): string {
    const assets = promptAssets();
    const channel = this.channel(ctx);
    const [min, max] = this.wordRange(channel);
    const lyrics = (ctx.content || '').trim();
    if (lyrics.length === 0) {
      throw new Error(`The song description for ${ctx.sourceLabel} has no lyrics to be written from.`);
    }
    const slots: Record<string, string> = {
      channel: assets
        .pipeline(SONG_DESCRIPTION_FILE, 'channel_block')
        .replace(/\{name\}/g, () => channel.name)
        .replace(/\{focus\}/g, () => channel.channelFocus.trim()),
      song: ctx.videoTitle || ctx.sourceLabel,
      lyrics,
      rules: assets.fieldSection(channel, 'description'),
      minWords: String(min),
      maxWords: String(max),
    };
    // One pass, so a lyric that happens to contain "{rules}" is never substituted into.
    return assets
      .pipeline(SONG_DESCRIPTION_FILE, 'summary')
      .replace(/\{(channel|song|lyrics|rules|minWords|maxWords)\}/g, (_m, key: string) => slots[key]);
  }
}

/** What is still off about a summary, in the warning's words; empty when it is the asked-for shape. */
export function judgeSongSummary(summary: string, [min, max]: [number, number]): string[] {
  const faults: string[] = [];
  const words = summary.split(/\s+/).filter(Boolean).length;
  if (words < min || words > max) faults.push(`ran to ${words} words against the ${min}-${max} this channel asks for`);
  if (/\n\s*\n/.test(summary)) faults.push('came back as more than one paragraph');
  const sentences = (summary.match(/[.!?…]+["'”’)]*(\s|$)/g) ?? []).length;
  if (sentences < SENTENCES[0] || sentences > SENTENCES[1]) {
    faults.push(`has ${sentences} sentence(s) where the channel's summary is ${SENTENCES[0]} or ${SENTENCES[1]}`);
  }
  return faults;
}
