/**
 * A CHANNEL'S PUBLISH PROFILE (LEDGER #308): what a channel file declares about how its videos go
 * up, in the shape publish/ reads.
 *
 * WHY IT EXISTS. Until Little Goose Productions (a kids music channel, 2026-10-16) every channel
 * this app uploads to was adult commentary, and the upload said so in code: made-for-kids false,
 * no AI disclosure, the category copied from the channel's latest upload, the title picked by
 * the operator from ten generated ones. Little Goose differs on every one of those, and says so
 * in its channel file (electron/assets/prompts/channels/littlegoose.yml). The host reads the
 * file (services/metadata/channel-profile.ts) and hands publish/ this plain object, so this
 * directory still never imports the generator.
 *
 * NULL `upload` IS THE EXISTING BEHAVIOUR, stated rather than defaulted: a channel file that
 * declares no `upload:` block uploads exactly as every channel did before this existed.
 */

import type { GeneratedFallback } from './publish-store.service';

/** What a channel's videos are uploaded with, when its file declares an `upload:` block. */
export interface ChannelUploadFlags {
  /** status.selfDeclaredMadeForKids. */
  madeForKids: boolean;
  /** status.containsSyntheticMedia: YouTube's altered-or-synthetic-content disclosure. */
  containsSyntheticMedia: boolean;
  /** snippet.categoryId, e.g. "10" (Music). Sent as declared; never read off the channel's uploads. */
  categoryId: string;
}

export interface ChannelPublishProfile {
  /** The channel id the profile was read from (the prompt set id), for messages. */
  promptSet: string;
  /**
   * Where the video's title comes from. `filename`: the song name in the source file's name
   * (songTitleFromFilename), chosen automatically (auto-config.ts). `generated`: picked by the
   * operator from the generated titles, as always.
   */
  titleSource: 'generated' | 'filename';
  /**
   * How the thumbnail is made. `ab_pairs`: the three A/B pairs, picked by hand (thumbnails/
   * pipeline.ts). `still_title`: one still of the video with the title along the bottom, made
   * by the run and attached automatically (thumbnails/still-title.ts).
   */
  thumbnailMode: 'ab_pairs' | 'still_title';
  /** The status and category the upload and the push send, or null: as before (see the header). */
  upload: ChannelUploadFlags | null;
  /** `lyrics`: after an upload, the item's timed lyrics go up as a caption track. null: no captions. */
  captions: 'lyrics' | null;
}

/** The caption track a song's lyrics are inserted as (captions.insert snippet). */
export const LYRICS_CAPTION_TRACK = { language: 'en', name: 'Lyrics' } as const;

/**
 * The song's name in a file name: the stem, with a trailing " - lyrics" (any case) taken off.
 *
 * Storyboard exports a song as "<song name> - lyrics.mp4" (the version with the lyrics burned in),
 * so the suffix names the export, not the song. Only that suffix goes: anything else in the name is
 * the song's own. A name that is empty once the suffix is gone is refused by name.
 */
export function songTitleFromFilename(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  const stem = base.replace(/\.[^./\\]+$/, '');
  const title = stem.replace(/\s*-\s*lyrics\s*$/i, '').trim();
  if (title.length === 0) {
    throw new Error(`The file name "${base}" has no song name in it (once " - lyrics" is taken off nothing is left).`);
  }
  return title;
}

/**
 * The item's publish profile as the host read it (LEDGER #308). A reader that did not say
 * (`undefined`) is a host bug, refused by name: guessing "no profile" would upload a kids' song
 * as adult commentary.
 */
export function requireProfileRead(generated: Pick<GeneratedFallback, 'publishProfile'>, itemId: string): ChannelPublishProfile | null {
  if (generated.publishProfile === undefined) {
    throw new Error(
      `The report reader gave item ${itemId} no publishProfile (null or a profile), so whether its channel ` +
      `declares an audience, a category or captions cannot be told. Nothing was sent.`
    );
  }
  return generated.publishProfile;
}
