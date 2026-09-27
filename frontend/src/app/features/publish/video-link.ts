/**
 * The Video row's rules, as pure functions (Owen, 2026-09-26: "i expected a video linking
 * accordion to exist under the thumbnail accordion but it doesnt").
 *
 * What the LINK tick says, which setup row it opens, and how the channel's recent uploads
 * are listed under "Find on YouTube". No Angular and no IPC, so tools/routing-publish-checks.js
 * transpiles this file and checks it offline.
 */
import type { DraftCandidate, FindDraftResult, VideoSource } from './publish.types';

/**
 * Which setup row the LINK tick opens. A Spreaker episode's link IS its audio; a YouTube
 * item's link is the upload the Video row finds and links.
 */
export function linkFactFor(isPodcast: boolean): 'audio' | 'video' {
  return isPodcast ? 'audio' : 'video';
}

export interface LinkTickText {
  state: 'set' | 'unset' | 'warn';
  value: string;
  hint: string;
}

/**
 * The LINK tick for a YouTube item.
 *
 * "no video" used to be the value for an unlinked item, which read as "this report has no
 * video". An unlinked item HAS its video (the file it was made from); what it lacks is the
 * link to its YouTube upload, and that is what the tick now says. A report that has lost
 * track of its own video is a fault and is amber.
 */
export function youtubeLinkTick(videoId: string | null, source: VideoSource | null): LinkTickText {
  if (source?.problem) {
    return { state: 'warn', value: 'video file lost', hint: source.problem };
  }
  if (videoId) {
    return {
      state: 'set',
      value: videoId,
      hint: `Linked to YouTube video ${videoId}. Pushes write to that video.`,
    };
  }
  return {
    state: 'unset',
    value: 'not on YouTube yet',
    hint: 'Not linked to a YouTube upload yet. Open Video to find it on the channel.',
  };
}

/** One row of the uploads list: the upload, whether it is the proposed match, and its facts. */
export interface UploadRow {
  video: DraftCandidate;
  proposed: boolean;
  /** "Draft · uploaded 2026-09-21 · 41:12" */
  facts: string;
}

/** m:ss or h:mm:ss, or null when the length is unknown. */
export function clockOf(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The privacy word the row shows: what the operator would be linking to. */
export function privacyWord(video: DraftCandidate): string {
  if (video.privacyStatus === 'private') {
    return video.publishAt ? `Scheduled ${video.publishAt.slice(0, 10)}` : 'Draft (private)';
  }
  return video.privacyStatus === 'public' ? 'Public' : 'Unlisted';
}

export function uploadFacts(video: DraftCandidate): string {
  const parts = [privacyWord(video)];
  if (video.publishedAt) parts.push(`uploaded ${video.publishedAt.slice(0, 10)}`);
  const clock = clockOf(video.durationSec);
  parts.push(clock ?? 'length unknown');
  return parts.join(' · ');
}

/**
 * The proposed match first, then every other recent upload in the channel's own order
 * (newest first). The proposed one is never listed twice.
 */
export function uploadRows(result: FindDraftResult): UploadRow[] {
  const proposedId = result.candidate?.videoId ?? null;
  const rows: UploadRow[] = [];
  if (result.candidate) {
    rows.push({ video: result.candidate, proposed: true, facts: uploadFacts(result.candidate) });
  }
  for (const video of result.alternatives) {
    if (video.videoId === proposedId) continue;
    rows.push({ video, proposed: false, facts: uploadFacts(video) });
  }
  return rows;
}

/** Where a linked video opens: its page in YouTube Studio. */
export function studioUrl(videoId: string): string {
  return `https://studio.youtube.com/video/${encodeURIComponent(videoId)}/edit`;
}
