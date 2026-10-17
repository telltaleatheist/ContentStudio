/**
 * A channel file, read as the publish profile publish/ consumes (publish/youtube-profile.ts,
 * LEDGER #308). The host calls this and hands the plain object across, so publish/ never reads the
 * prompt assets itself.
 */
import { promptAssets, type ChannelData } from './prompt-assets';
import type { ChannelPublishProfile } from '../publish/youtube-profile';

export function publishProfileOf(channel: ChannelData): ChannelPublishProfile {
  return {
    promptSet: channel.id,
    titleSource: channel.titleSource,
    thumbnailMode: channel.thumbnailMode,
    upload: channel.upload,
    captions: channel.captions,
  };
}

/**
 * The profile of the prompt set a report recorded, or null when there is nothing to read it from:
 * no prompt set on the report, or one no channel file defines any more (a report from a retired
 * set). Null is the behaviour every item had before profiles existed, and the caller says which of
 * the two it was in its own log line.
 */
export function publishProfileForPromptSet(promptSet: string | null): ChannelPublishProfile | null {
  if (promptSet === null) return null;
  const assets = promptAssets();
  if (!assets.hasChannel(promptSet)) return null;
  return publishProfileOf(assets.channel(promptSet));
}
