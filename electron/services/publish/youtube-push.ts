/**
 * YouTube Push
 *
 * Writes ONE item's chosen metadata onto the YouTube video it is linked to: title,
 * description, tags, optionally a schedule, optionally a thumbnail. Nothing else. It
 * does not upload video, it does not create anything, and it never picks a video — the
 * link is made elsewhere and confirmed by the operator.
 *
 * WHY THERE IS NO UPLOAD HERE. Owen's YouTube API audit is still pending, and until it
 * is granted anything uploaded THROUGH the API is locked private with no way to make it
 * public. Videos uploaded in the BROWSER carry no such restriction, and editing their
 * metadata over the API is not audit-gated. So the flow this file serves is: Owen uploads
 * the draft in Chrome, the extension links its videoId onto the publish record, and this
 * pushes the finished metadata to it. `videos.insert` is deliberately absent — see
 * PUBLISH-PIPELINE-PLAN.md Phase 3.
 *
 * ── The rule that shapes every line below ────────────────────────────────────────────
 *
 *   videos.update REPLACES the whole submitted part.
 *
 * A snippet body carrying only a title CLEARS that video's description, its tags, its
 * categoryId and its defaultLanguage. So the video's current snippet and status are READ
 * first and handed back with exactly the fields this push means to change replaced —
 * every other field, including ones this app has never heard of, travels through
 * untouched because it travels through as the same object. There is no field list here
 * to fall out of date.
 *
 * ── What it refuses to do ────────────────────────────────────────────────────────────
 *
 * Nothing here has a fallback. Each of these throws, naming the item and the value:
 *   - no chosen title. chosenTitles[0] IS the title; an empty set is the operator not
 *     having chosen yet, and quietly reaching for the generator's first suggestion would
 *     put a title on a live video that nobody picked.
 *   - the video's channel is not the record's channel. This is the disaster case —
 *     pushing Telltale's metadata onto a Fireside video — and it is checked against what
 *     YouTube says the video's channel is, not against what the record hoped.
 *   - a schedule for a video that is already public or unlisted. YouTube only accepts
 *     status.publishAt while a video is private and never-published; a published video
 *     cannot be un-published into a schedule, and pretending otherwise would report a
 *     success for something that did not happen.
 *   - a thumbnail path that no longer validates. It points at an external volume; "it
 *     was fine when I picked it" is not a claim about now.
 *   - a push that would CLEAR a description or a tag set the video already has. Emptiness
 *     is a legitimate state, but silently wiping finished work is the exact class of bug
 *     read-modify-write exists to prevent.
 *
 * ── Structure ────────────────────────────────────────────────────────────────────────
 *
 * `planVideoUpdate` is PURE: current video parts + record + resolved metadata in, the
 * exact request body out (or a throw). Every rule above lives in it, so all of them are
 * testable without an access token — which is the only way any of this was verified,
 * since a wrong call here rewrites a real video on a real channel.
 */

import * as fs from 'fs';
import type { VideoParts } from '../youtube/youtube-api.service';
import { PublishStoreService, GeneratedFallback, resolveChosenMetadata } from './publish-store.service';
import { validateThumbnailFile } from './thumbnail-validate';
import {
  ChosenMetadata,
  MAX_TITLE_LENGTH,
  PushReceipt,
  ResolvedMetadata,
} from './publish-types';

/**
 * The slice of the YouTube API this needs, as three functions.
 *
 * Injected rather than imported for the reason the rest of publish/ injects its readers:
 * this directory stays liftable, and — more immediately — a push can be exercised end to
 * end against a fixture without a single real request. YouTubeApiService satisfies this
 * structurally; see the wiring in ipc-handlers.ts.
 */
export interface YouTubePushApi {
  /** videos.list(part=snippet,status). null when the id names no video on that channel. */
  getVideoParts(channelId: string, videoId: string): Promise<VideoParts | null>;
  /** videos.update. `parts` names every part in `body`; each is REPLACED wholesale. */
  updateVideo(
    channelId: string,
    parts: Array<'snippet' | 'status'>,
    body: { id: string; snippet?: Record<string, any>; status?: Record<string, any> }
  ): Promise<VideoParts>;
  /** thumbnails.set. Takes bytes: validating the file is this module's job, not the client's. */
  setThumbnail(
    channelId: string,
    videoId: string,
    image: Buffer,
    mime: 'image/png' | 'image/jpeg'
  ): Promise<{ videoId: string; defaultUrl: string | null }>;
}

export interface PushDeps {
  store: PublishStoreService;
  /** The generated titles/description/tags for one item, or null when it is gone. */
  readGenerated: (itemId: string) => GeneratedFallback | null;
  api: YouTubePushApi;
  /** "Now", so the receipt's timestamp is testable. */
  now?: () => Date;
}

/** The exact request `pushItemToYouTube` will make, plus what it decided not to send. */
export interface VideoUpdatePlan {
  videoId: string;
  channelId: string;
  parts: Array<'snippet' | 'status'>;
  body: { id: string; snippet: Record<string, any>; status?: Record<string, any> };
  /** What went into the body, spelled out for the receipt and the confirmation UI. */
  title: string;
  description: string;
  tags: string[];
  /** The schedule this push sends, or null when it sends none. */
  publishAt: string | null;
  /** Why no schedule was sent. Null exactly when publishAt is set. */
  publishAtSkipped: string | null;
}

/** What a successful push returns: the updated record and the receipt stored on it. */
export interface PushOutcome {
  selection: ChosenMetadata;
  receipt: PushReceipt;
}

/** First line of a description, for a human to recognise it by. Never the whole thing. */
export function firstLineOf(description: string): string {
  const line = description.split('\n')[0].trim();
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/**
 * The comma-separated tag string as YouTube's array.
 *
 * Empty entries are dropped (a trailing comma is a typo, not a tag), and nothing else is
 * changed — no case folding, no dedupe, no length trimming. What the operator wrote is
 * what goes up.
 */
export function splitTags(tags: string): string[] {
  return tags
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Build the videos.update request for one item, or throw naming the item and the rule.
 *
 * PURE. `video` is what videos.list just returned; the body that comes back is that same
 * snippet object with title/description/tags replaced, which is what makes "every field
 * we are not changing survives" true by construction rather than by a checklist.
 */
export function planVideoUpdate(input: {
  record: ChosenMetadata;
  resolved: ResolvedMetadata;
  video: VideoParts;
}): VideoUpdatePlan {
  const { record, resolved, video } = input;
  const item = record.itemId;

  // ---- the link ----------------------------------------------------------------
  const { videoId, channelId } = requireLink(record);
  if (video.id !== videoId) {
    throw new Error(
      `Asked YouTube for video ${videoId} and it answered about ${video.id}. Nothing was sent.`
    );
  }

  // ---- the channel guard -------------------------------------------------------
  // Checked against YouTube's answer, not against the record: the record is the thing
  // that could be wrong. Pushing one channel's metadata onto another's video is the
  // worst thing this file could do, so it is the first thing it refuses.
  const actualChannel = video.snippet?.channelId;
  if (typeof actualChannel !== 'string' || !actualChannel) {
    throw new Error(
      `YouTube returned video ${videoId} with no snippet.channelId, so the channel guard ` +
      `cannot be checked. Nothing was sent.`
    );
  }
  if (actualChannel !== channelId) {
    throw new Error(
      `Video ${videoId} belongs to channel ${actualChannel}, but item ${item} is routed to ` +
      `channel ${channelId}. Refusing to push one channel's metadata onto another ` +
      `channel's video — fix the link or the routing.`
    );
  }

  // ---- the title ---------------------------------------------------------------
  // chosenTitles[0] IS the title. resolved.titles is NOT used here: it falls back to the
  // generator's top three when nothing is chosen, which is right for showing the operator
  // a starting point and wrong for writing to a live video.
  const chosen = record.chosenTitles ?? [];
  const title = (chosen[0] ?? '').trim();
  if (!title) {
    throw new Error(
      `Item ${item} has no title chosen. chosenTitles[0] is what goes on the video — pick ` +
      `at least one title before pushing. (Nothing is guessed from the generated list.)`
    );
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new Error(
      `Item ${item}'s chosen title is ${title.length} characters; YouTube's limit is ` +
      `${MAX_TITLE_LENGTH}. Edit it before pushing.`
    );
  }

  // ---- description and tags ----------------------------------------------------
  // From the SAME resolver the extension bridge reads, so what gets pushed is what the
  // panel showed and what Studio would have been filled with. Overrides win over the
  // generated values there, in one place.
  const description = resolved.description ?? '';
  const tags = splitTags(resolved.tags ?? '');

  const currentDescription = typeof video.snippet.description === 'string' ? video.snippet.description : '';
  if (!description.trim() && currentDescription.trim()) {
    throw new Error(
      `Item ${item} resolves to an empty description, but video ${videoId} currently has ` +
      `${currentDescription.length} characters of one. Refusing to erase it. Fix the item's ` +
      `description (or clear its override) and push again.`
    );
  }
  const currentTags: string[] = Array.isArray(video.snippet.tags) ? video.snippet.tags : [];
  if (tags.length === 0 && currentTags.length > 0) {
    throw new Error(
      `Item ${item} resolves to no tags, but video ${videoId} currently has ` +
      `${currentTags.length}. Refusing to erase them. Fix the item's tags (or clear its ` +
      `override) and push again.`
    );
  }

  // ---- the snippet -------------------------------------------------------------
  // The whole part goes back, with three fields replaced. Everything else — categoryId,
  // defaultLanguage, defaultAudioLanguage, localizations, fields Google adds later —
  // rides through untouched because it is the same object.
  if (typeof video.snippet.categoryId !== 'string' || !video.snippet.categoryId) {
    throw new Error(
      `Video ${videoId} came back with no snippet.categoryId. videos.update requires one ` +
      `on every snippet write, and inventing a category would file the video under a ` +
      `subject nobody chose. Nothing was sent.`
    );
  }
  const snippet: Record<string, any> = { ...video.snippet, title, description, tags };

  const parts: Array<'snippet' | 'status'> = ['snippet'];
  const body: VideoUpdatePlan['body'] = { id: videoId, snippet };

  // ---- the schedule ------------------------------------------------------------
  let publishAt: string | null = null;
  let publishAtSkipped: string | null = null;

  if (record.publishAt) {
    const privacy = video.status?.privacyStatus;
    if (typeof privacy !== 'string' || !privacy) {
      throw new Error(
        `Video ${videoId} came back with no status.privacyStatus, so whether it can still ` +
        `be scheduled cannot be determined. Nothing was sent.`
      );
    }
    if (privacy !== 'private') {
      throw new Error(
        `Item ${item} is scheduled for ${record.publishAt}, but video ${videoId} is ` +
        `${privacy.toUpperCase()} — it is already published, and YouTube only accepts a ` +
        `publish time while a video is private and never-published. A published video ` +
        `cannot be scheduled. Clear the schedule to push the metadata alone.`
      );
    }
    // status is submitted WHOLE for the same reason snippet is: privacyStatus and
    // publishAt replace their values, and selfDeclaredMadeForKids / license /
    // embeddable / publicStatsViewable ride through as they were read.
    body.status = { ...video.status, privacyStatus: 'private', publishAt: record.publishAt };
    parts.push('status');
    publishAt = record.publishAt;
  } else {
    // No schedule on the record means status is NOT SENT AT ALL — not sent as "whatever
    // it already was", which would still be a write, and not sent as public. A schedule
    // already on the video therefore stands, and the receipt says so.
    const existing = video.status?.publishAt;
    publishAtSkipped = existing
      ? `This item has no schedule, so status was left untouched — the video's own ` +
        `schedule of ${existing} still stands.`
      : `This item has no schedule, so status was left untouched.`;
  }

  return {
    videoId,
    channelId,
    parts,
    body,
    title,
    description,
    tags,
    publishAt,
    publishAtSkipped,
  };
}

/**
 * Push one item's metadata to its linked video.
 *
 * ORDER MATTERS and it is deliberate: everything that can be refused is refused BEFORE
 * anything is written. The thumbnail file is validated (and read) before videos.update
 * runs, so an unplugged volume cannot leave a video with new text and no image and no
 * account of why.
 */
export async function pushItemToYouTube(itemId: string, deps: PushDeps): Promise<PushOutcome> {
  const { store, readGenerated, api } = deps;
  const now = deps.now ?? (() => new Date());

  const generated = readGenerated(itemId);
  if (!generated) {
    throw new Error(`No generated metadata for item ${itemId} — there is nothing to push.`);
  }

  // No emptyChosenMetadata fallback here, unlike the read paths: a record that does not
  // exist is an item nobody has chosen anything for, and a blank one would resolve to
  // the generator's suggestions and push them.
  const record = store.get(itemId);
  if (!record) {
    throw new Error(
      `Nothing has been saved for item ${itemId}, so it has no chosen title, no channel ` +
      `and no linked video. There is nothing to push.`
    );
  }

  const resolved = resolveChosenMetadata(record, generated);
  const plan = planVideoUpdate({ record, resolved, video: await requireVideo(record, api) });

  // The thumbnail is validated and READ FIRST — before any write — so a file that has
  // moved, shrunk or been replaced stops the push instead of half-completing it.
  let thumbnail: { path: string; bytes: Buffer; mime: 'image/png' | 'image/jpeg' } | null = null;
  let thumbnailSkipped: string | null = null;
  if (record.thumbnailPath) {
    const { meta } = validateThumbnailFile(record.thumbnailPath);
    thumbnail = {
      path: record.thumbnailPath,
      bytes: fs.readFileSync(record.thumbnailPath),
      mime: meta.mime,
    };
  } else {
    thumbnailSkipped = 'No thumbnail is attached to this item, so none was uploaded.';
  }

  await api.updateVideo(plan.channelId, plan.parts, plan.body);

  if (thumbnail) {
    await api.setThumbnail(plan.channelId, plan.videoId, thumbnail.bytes, thumbnail.mime);
  }

  const receipt: PushReceipt = {
    videoId: plan.videoId,
    channelId: plan.channelId,
    pushedAt: now().toISOString(),
    updated: {
      title: plan.title,
      description: { chars: plan.description.length, firstLine: firstLineOf(plan.description) },
      tags: { count: plan.tags.length },
      ...(plan.publishAt ? { publishAt: plan.publishAt } : {}),
      ...(thumbnail ? { thumbnail: thumbnail.path } : {}),
    },
    skipped: {
      ...(plan.publishAtSkipped ? { publishAt: plan.publishAtSkipped } : {}),
      ...(thumbnailSkipped ? { thumbnail: thumbnailSkipped } : {}),
    },
  };

  // Status is NOT advanced to 'published'. This push put metadata on a video; whether
  // that video is live is YouTube's fact, not ours, and claiming it here would make the
  // panel state a thing nobody observed.
  const selection = await store.update(itemId, generated, {
    pushedAt: receipt.pushedAt,
    pushReceipt: receipt,
  });

  return { selection, receipt };
}

/**
 * The video and channel a push would name, or a refusal.
 *
 * One definition, used by both the pure planner and the orchestration around it — two
 * copies of "is this item linked?" is two chances for them to disagree about what
 * "linked" means.
 */
function requireLink(record: ChosenMetadata): { videoId: string; channelId: string } {
  if (!record.videoId) {
    throw new Error(
      `Item ${record.itemId} is not linked to a YouTube video, so there is nothing to ` +
      `push to. Link it to the uploaded draft first.`
    );
  }
  if (!record.channelId) {
    throw new Error(
      `Item ${record.itemId} has no channel, so a push has no channel to authorize as. ` +
      `Route it to a channel first.`
    );
  }
  return { videoId: record.videoId, channelId: record.channelId };
}

/** The linked video's current parts, or a refusal naming what was asked for. */
async function requireVideo(record: ChosenMetadata, api: YouTubePushApi): Promise<VideoParts> {
  const { videoId, channelId } = requireLink(record);
  const video = await api.getVideoParts(channelId, videoId);
  if (!video) {
    throw new Error(
      `YouTube has no video ${videoId} on channel ${channelId}. The link is stale (the ` +
      `draft may have been deleted) — re-link item ${record.itemId} before pushing.`
    );
  }
  return video;
}

// ======================================================================= schedule only
//
// A SECOND, NARROWER WRITE, and the narrowness is the entire point.
//
// pushItemToYouTube above always sends the whole snippet — that is correct for "publish
// my finished metadata onto this video", and wrong for "this video moved to Thursday".
// Sending a snippet rewrites the video's title, and a title on a video that is running a
// Test & Compare experiment is exactly the thing not to touch as a side effect of moving
// a date. YouTube exposes no API for those experiments, so anything this app does to a
// title it cannot see the consequences of.
//
// So: part=status, nothing else. Title, description, tags and thumbnail are not read, not
// planned and not sent.

/** The exact status-only request `pushScheduleToYouTube` will make. */
export interface ScheduleUpdatePlan {
  videoId: string;
  channelId: string;
  body: { id: string; status: Record<string, any> };
  publishAt: string;
}

/**
 * Build the status-only videos.update for one item's schedule, or throw naming the rule.
 *
 * PURE, and carrying the same three refusals the metadata push has, for the same reasons:
 * the video must be the one asked for, it must belong to the record's channel, and it
 * must still be private — YouTube accepts `status.publishAt` only while a video is
 * private and has never published, so a released video cannot be moved.
 */
export function planScheduleUpdate(input: {
  record: ChosenMetadata;
  video: VideoParts;
}): ScheduleUpdatePlan {
  const { record, video } = input;
  const item = record.itemId;

  const { videoId, channelId } = requireLink(record);
  if (video.id !== videoId) {
    throw new Error(
      `Asked YouTube for video ${videoId} and it answered about ${video.id}. Nothing was sent.`
    );
  }

  const actualChannel = video.snippet?.channelId;
  if (typeof actualChannel !== 'string' || !actualChannel) {
    throw new Error(
      `YouTube returned video ${videoId} with no snippet.channelId, so the channel guard ` +
      `cannot be checked. Nothing was sent.`
    );
  }
  if (actualChannel !== channelId) {
    throw new Error(
      `Video ${videoId} belongs to channel ${actualChannel}, but item ${item} is routed to ` +
      `channel ${channelId}. Refusing to schedule one channel's video from another ` +
      `channel's record — fix the link or the routing.`
    );
  }

  if (!record.publishAt) {
    throw new Error(
      `Item ${item} has no schedule, so there is nothing to send. Clearing a video's ` +
      `schedule is not this call — it would have to decide what privacy the video reverts ` +
      `to, and nobody has said.`
    );
  }

  const privacy = video.status?.privacyStatus;
  if (typeof privacy !== 'string' || !privacy) {
    throw new Error(
      `Video ${videoId} came back with no status.privacyStatus, so whether it can still be ` +
      `scheduled cannot be determined. Nothing was sent.`
    );
  }
  if (privacy !== 'private') {
    throw new Error(
      `Item ${item} is scheduled for ${record.publishAt}, but video ${videoId} is ` +
      `${privacy.toUpperCase()} — it has already been published, and YouTube only accepts a ` +
      `publish time while a video is private and never-published. The calendar's date for ` +
      `it is now a record of intent, not a schedule that can still be set.`
    );
  }

  // Whole status back, two fields replaced — same rule as the snippet push, so
  // selfDeclaredMadeForKids, license, embeddable and anything Google adds later ride
  // through untouched because they ride through as the same object.
  return {
    videoId,
    channelId,
    body: {
      id: videoId,
      status: { ...video.status, privacyStatus: 'private', publishAt: record.publishAt },
    },
    publishAt: record.publishAt,
  };
}

export interface SchedulePushOutcome {
  videoId: string;
  publishAt: string;
  /** What YouTube held before this call, so the caller can say what actually changed. */
  previousPublishAt: string | null;
}

/**
 * Send one item's schedule to its linked video. Reads first, refuses on the read, writes
 * once.
 */
export async function pushScheduleToYouTube(
  itemId: string,
  deps: { store: PublishStoreService; api: YouTubePushApi }
): Promise<SchedulePushOutcome> {
  const { store, api } = deps;

  const record = store.get(itemId);
  if (!record) {
    throw new Error(`Nothing has been saved for item ${itemId}, so it has no schedule to send.`);
  }
  const { videoId, channelId } = requireLink(record);

  const video = await api.getVideoParts(channelId, videoId);
  if (!video) {
    throw new Error(
      `Channel ${channelId} has no video ${videoId} — it was deleted, or the link is wrong. ` +
      `Nothing was sent.`
    );
  }

  const previousPublishAt =
    typeof video.status?.publishAt === 'string' ? video.status.publishAt : null;
  const plan = planScheduleUpdate({ record, video });
  await api.updateVideo(plan.channelId, ['status'], plan.body);

  return { videoId: plan.videoId, publishAt: plan.publishAt, previousPublishAt };
}
