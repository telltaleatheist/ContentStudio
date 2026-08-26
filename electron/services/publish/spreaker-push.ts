/**
 * Spreaker Push
 *
 * Uploads ONE item as an episode of the operator's single Spreaker show: title,
 * description, tags and an audio file, optionally scheduled. Nothing else. It does not
 * pick the audio file — that is proposed and confirmed elsewhere — and it does not touch
 * YouTube.
 *
 * The sibling of youtube-push.ts, and deliberately shaped like it: a PURE planner that
 * every rule lives in, plus a thin orchestration around it that validates the file,
 * makes the one call and writes the receipt. Read that file first if you are new here;
 * the differences from it are the interesting part, and they are all consequences of one
 * fact:
 *
 *   THIS IS A CREATE, NOT AN UPDATE.
 *
 * `videos.update` replaces a part, so the YouTube push reads the video first and hands
 * every field it is not changing back untouched. There is nothing to read here: before
 * this call the episode does not exist. Which removes one class of danger (nothing can be
 * cleared by omission) and introduces a worse one — pushing twice does not overwrite an
 * episode, it publishes a SECOND one into the podcast feed, where the operator's
 * listeners get it. That is why `spreakerEpisodeId` is a refusal and not just a record.
 *
 * ── THE SPREAKER API, AS BUILT AGAINST ────────────────────────────────────────────────
 *
 * Read 2026-08-22. Version: **v2** — every path below is under `https://api.spreaker.com/v2/`.
 * If a maintainer is here because something started failing, these are the pages to
 * re-read, and the facts this file assumes:
 *
 *   https://developers.spreaker.com/guides/overview/
 *     - Base URL `https://api.spreaker.com/v2/`, HTTPS only.
 *     - GET is generally unauthenticated; POST/PUT/DELETE must be authenticated.
 *     - Errors come back as `{"response":{"error":{"messages":[…],"code":N}}}` with a 4xx
 *       or 5xx status. 401 = bad credentials. 429 = rate limited, and "your IP may be
 *       temporarily blacklisted" — so nothing in this file retries.
 *
 *   https://developers.spreaker.com/guides/authentication/
 *     - **OAuth2 ONLY. There is no plain API key and no permanent token.** This was the
 *       first thing checked and the answer shapes the whole config story: what the
 *       operator supplies is an ACCESS TOKEN he minted himself, not an API key a settings
 *       page can generate.
 *     - Register an app under the account's Developer Tools to get a client id + secret.
 *     - Authorize at `https://www.spreaker.com/oauth2/authorize` with
 *       `client_id`, `response_type=code`, `state`, `scope=basic`, `redirect_uri`.
 *       `basic` is the ONLY scope Spreaker offers — there is no narrower upload-only one.
 *     - Exchange at `POST https://api.spreaker.com/oauth2/token` with
 *       `grant_type=authorization_code`, `client_id`, `client_secret`, `redirect_uri`,
 *       `code`. Returns `access_token`, `expires_in`, `token_type` ("Bearer"), `scope`,
 *       `refresh_token`. Refresh with `grant_type=refresh_token`.
 *     - Tokens are sent as `Authorization: Bearer <token>` (or `?oauth2_access_token=`;
 *       this app uses the header, so the token never lands in a URL or a log line).
 *
 *     WHY THIS APP DOES IMPLEMENT THE OAUTH DANCE. This paragraph used to say the
 *     opposite: that a refresh needs the client SECRET and a desktop app cannot hold one,
 *     because anything shipped in the bundle is public. That is true of a secret SHIPPED
 *     IN THE BUNDLE, and it is the right rule for an app with users. It is not the shape
 *     of this app. The reasoning did not survive contact with the Google integration,
 *     where the operator's own Desktop-app client id and secret have sat 0600 in
 *     <userData>/youtube-oauth.json since the analytics collector shipped and refresh
 *     tokens are renewed from them on every call. The Spreaker client is the same thing:
 *     his app, his secret, typed in once, on his machine, never in the bundle.
 *
 *     So Settings → Spreaker holds a client id and secret, opens the authorize URL in the
 *     operator's browser, exchanges the code, and renews the access token before an upload
 *     when it is within a week of expiring. The one step still done by hand is copying the
 *     code out of the address bar, and that is Spreaker's constraint rather than a choice:
 *     the registered callback is exactly `http://localhost`, which cannot be a loopback
 *     server on an ephemeral port the way Google's Desktop-app clients allow.
 *
 *     A pasted access token is still accepted, for someone who already minted one. It
 *     cannot renew itself and the settings page says so. A renewal that FAILS fails the
 *     upload with Spreaker's own words — nothing here proceeds on a token it has reason to
 *     doubt.
 *
 *   https://developers.spreaker.com/guides/upload-an-episode/
 *   https://developers.spreaker.com/api/episodes/
 *     - **`POST /v2/shows/{SHOW_ID}/episodes`**, `multipart/form-data`.
 *     - REQUIRED: `title` (max 140 chars) and `media_file` (the audio).
 *     - Optional and used here: `description` (plain text), `tags` (comma-separated),
 *       `auto_published_at` (schedule).
 *     - Optional and NOT used here, listed so the next person does not have to go
 *       looking: `explicit`, `download_enabled`, `hidden`, `visibility`
 *       (PUBLIC|PRIVATE|LIMITED), `image_file` (≥400x400, ≤5 MB), `image_crop`,
 *       `published_at`, `chapters` (JSON array of `{starts_at, title, external_url}` with
 *       `starts_at` in ms), `autoshares` (FACEBOOK, BLUESKY), `season_number`,
 *       `episode_number`, `season_episode_type` (FULL|TRAILER|BONUS), `rss_guid`,
 *       `ai_generated`, `episode_link`, `location_latitude`, `location_longitude`.
 *     - **An uploaded episode is PUBLISHED IMMEDIATELY by default** and becomes public as
 *       soon as server-side processing finishes. There is no draft-by-default. That is
 *       why the confirmation dialog in front of this says so in those words.
 *     - `auto_published_at` schedules it instead. Format `YYYY-MM-DD HH:MM:SS`, **UTC**,
 *       verified from the worked examples in
 *       https://developers.spreaker.com/guides/working-with-draft-episodes/
 *       (`auto_published_at=2020-04-20 18:00:00`). Note the SPACE, not a `T`, and no zone
 *       suffix — an ISO instant sent verbatim is not this format, so `toSpreakerUtc()`
 *       below exists and is the only place that conversion happens.
 *     - Response: `{"response":{"episode":{…}}}` carrying `episode_id`, `title`,
 *       `show_id`, `site_url`, `download_url`, `playback_url`, `duration` (ms),
 *       `encoding_status` (PENDING|PROCESSING|READY|ERROR) and much else. A fresh upload
 *       comes back PENDING or PROCESSING — **never READY** — because Spreaker re-encodes
 *       everything to 44.1 kHz stereo CBR MP3 first, which takes "a few seconds to a few
 *       minutes". The receipt records the status verbatim so nothing here can be read as
 *       claiming the episode is live.
 *
 *   https://help.spreaker.com/en/articles/3810629-what-kind-of-files-can-i-upload-to-the-platform
 *     - **300 MB per file**, and the accepted extensions. Neither number is in the API
 *       docs at all; both live in audio-validate.ts with this citation, and are enforced
 *       before a single byte is sent.
 *
 * ── What it refuses to do ────────────────────────────────────────────────────────────
 *
 * Nothing here has a fallback. Each of these throws, naming the item and the value:
 *   - the item is not marked as a podcast. `isPodcast` is the operator saying this is an
 *     episode; uploading one he did not mark would put a video's metadata on his podcast
 *     feed.
 *   - no chosen title. Identical rule to the YouTube push and for the identical reason:
 *     chosenTitles[0] IS the title, and reaching for the generator's first suggestion
 *     would publish an episode titled by nobody.
 *   - a title over Spreaker's 140 characters (a DIFFERENT limit from YouTube's 100).
 *   - no audio file chosen, or one that no longer validates. It points at an external
 *     volume; "it was fine when I picked it" is not a claim about now.
 *   - an item that has ALREADY been uploaded. See spreakerEpisodeId above — this is the
 *     one refusal here that has no counterpart in the YouTube push.
 *   - Spreaker not configured. A missing token or show id is named as such, with where to
 *     put them, rather than arriving as a 401 from a request that should not have been
 *     made.
 *
 * ── Structure ────────────────────────────────────────────────────────────────────────
 *
 * `planEpisode` is PURE: record + resolved metadata + the audio file's measurements in,
 * the exact multipart fields out (or a throw). Every rule above lives in it, so all of
 * them are testable without a token and without a network — which is the only way any of
 * this was verified, since the alternative is publishing test episodes to a live podcast.
 */

import {
  AudioMeta,
  ChosenMetadata,
  ResolvedMetadata,
  SPREAKER_MAX_TITLE_LENGTH,
  SpreakerReceipt,
} from './publish-types';
import { AudioProbe, MAX_EPISODE_BYTES, validateAudioFile } from './audio-validate';
import { GeneratedFallback, PublishStoreService, resolveChosenMetadata } from './publish-store.service';
import { firstLineOf, splitTags } from './youtube-push';

/**
 * The show an upload targets, and the assertion that this app can authenticate as its
 * owner.
 *
 * NO TOKEN. The credential never enters publish/ at all — the caller that supplies this
 * has already checked that a token exists (that is what makes "Spreaker is not
 * configured" a refusal here rather than a 401 later), and the transport below is the
 * only thing that ever reads its value. One less place for it to be logged.
 */
export interface SpreakerTarget {
  /** Spreaker's numeric show id, as a string. */
  showId: string;
  /** The operator's label for the show, for confirmation text. null when unlabelled. */
  showName: string | null;
}

/**
 * The multipart request `pushEpisodeToSpreaker` will make.
 *
 * FIELD NAMES ARE SPREAKER'S, verbatim (`media_file`, `auto_published_at`) rather than
 * camel-cased into this app's dialect and translated back at the transport. The whole
 * value of a pure planner is that what it returns can be compared against the API
 * documentation by reading it, and a translation layer in between is one more place for
 * the comparison to be wrong.
 */
export interface SpreakerEpisodeRequest {
  /** The show to create the episode under. Goes in the PATH, not the body. */
  showId: string;
  /** Text fields, exactly as they will be sent. */
  fields: {
    title: string;
    description: string;
    /** Comma-separated. Absent when the item resolves to no tags. */
    tags?: string;
    /** `YYYY-MM-DD HH:MM:SS` in UTC. Absent when the episode publishes immediately. */
    auto_published_at?: string;
  };
  /** The audio file, streamed from disk by the transport under the name `media_file`. */
  mediaFilePath: string;
}

/** The exact request, plus what it decided not to send. */
export interface SpreakerEpisodePlan {
  request: SpreakerEpisodeRequest;
  /** What went into the request, spelled out for the receipt and the confirmation UI. */
  title: string;
  description: string;
  tags: string[];
  /** The file, as it measured when this plan was made. */
  audio: { path: string; meta: AudioMeta };
  showId: string;
  showName: string | null;
  /** The schedule this upload sends, or null when it sends none. */
  autoPublishedAt: string | null;
  /** Why no schedule was sent. Null exactly when autoPublishedAt is set. */
  autoPublishedAtSkipped: string | null;
}

/**
 * What Spreaker replies with, reduced to the fields this app reads.
 *
 * A reduction rather than the whole episode object on purpose: everything named here is
 * something the receipt or an error message uses, and a type that mirrored all forty
 * fields would suggest this app has an opinion about the other thirty-five.
 */
export interface SpreakerEpisodeCreated {
  episodeId: number;
  title: string | null;
  showId: number | null;
  showTitle: string | null;
  siteUrl: string | null;
  /** PENDING | PROCESSING | READY | ERROR. Never READY on a fresh upload. */
  encodingStatus: string | null;
}

/**
 * The one Spreaker call this app makes, as a function.
 *
 * Injected rather than imported for the reason the rest of publish/ injects its readers:
 * this directory stays liftable, and — more immediately — an upload can be exercised end
 * to end against a fixture without a single real request. A mistake here publishes to a
 * live podcast feed, so "testable without the network" is not a convenience.
 */
export interface SpreakerUploadApi {
  createEpisode(request: SpreakerEpisodeRequest): Promise<SpreakerEpisodeCreated>;
}

export interface SpreakerPushDeps {
  store: PublishStoreService;
  /** The generated titles/description/tags for one item, or null when it is gone. */
  readGenerated: (itemId: string) => GeneratedFallback | null;
  api: SpreakerUploadApi;
  /**
   * The configured show, or a thrown refusal naming what is missing and where it goes.
   *
   * Called BEFORE the file is read or probed, so an unconfigured app says so instantly
   * instead of after ffprobe has walked a 132 MB file.
   */
  requireTarget: () => SpreakerTarget;
  /** ffprobe, injected. See audio-validate.ts. */
  probeAudio: (file: string) => Promise<AudioProbe>;
  /** "Now", so the receipt's timestamp and the schedule check are testable. */
  now?: () => Date;
}

/** What a successful upload returns: the updated record and the receipt stored on it. */
export interface SpreakerPushOutcome {
  selection: ChosenMetadata;
  receipt: SpreakerReceipt;
}

/**
 * An ISO instant as Spreaker's `YYYY-MM-DD HH:MM:SS`, in UTC.
 *
 * The conversion is the whole point: the record stores an ISO-8601 instant WITH a zone
 * (publish-types enforces that), and Spreaker wants a space-separated UTC wall time with
 * no zone marker at all. Sending the ISO string verbatim would be sending a different
 * format and, for any non-UTC offset, a different moment.
 */
export function toSpreakerUtc(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) {
    throw new Error(
      `Cannot send ${JSON.stringify(iso)} to Spreaker as a publication time: it is not a ` +
      `date this app can read.`
    );
  }
  // toISOString is always UTC and always `YYYY-MM-DDTHH:MM:SS.sssZ`; Spreaker wants the
  // first 19 characters of that with the T replaced by a space.
  return when.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Build the create-episode request for one item, or throw naming the item and the rule.
 *
 * PURE. Every refusal in the header comment is decided here, against values it was handed
 * — the file's measurements come in as `audio`, so this function never touches a disk and
 * every rule about the file is as testable as the rules about the text.
 */
export function planEpisode(input: {
  record: ChosenMetadata;
  resolved: ResolvedMetadata;
  audio: { path: string; meta: AudioMeta };
  target: SpreakerTarget;
  now: Date;
}): SpreakerEpisodePlan {
  const { record, resolved, audio, target, now } = input;
  const item = record.itemId;

  // ---- the podcast flag --------------------------------------------------------
  // First, because it is the one that says this whole action applies. isPodcast is a
  // strict boolean that is never absent (see publish-types), so this is a real answer
  // rather than a missing field read as false.
  if (record.isPodcast !== true) {
    throw new Error(
      `Item ${item} is not marked as a podcast episode, so it has no business on the ` +
      `Spreaker show. Tick "Publish as podcast" if that is what it is.`
    );
  }

  // ---- the duplicate guard -----------------------------------------------------
  // The difference from the YouTube push, in five lines. There is no update path here:
  // a second push is a second episode in the feed.
  if (record.spreakerEpisodeId !== null) {
    throw new Error(
      `Item ${item} was already uploaded to Spreaker as episode ${record.spreakerEpisodeId}` +
      `${record.spreakerPushedAt ? ` on ${record.spreakerPushedAt}` : ''}. Uploading again ` +
      `would create a SECOND episode in the feed, not replace that one. Delete the episode ` +
      `on Spreaker (or forget the link here) if you mean to upload it again.`
    );
  }

  // ---- the show ----------------------------------------------------------------
  if (!target || typeof target.showId !== 'string' || !target.showId.trim()) {
    throw new Error(
      `No Spreaker show id is configured, so there is nowhere to upload item ${item} to. ` +
      `Set it in Settings → Spreaker.`
    );
  }
  const showId = target.showId.trim();

  // ---- the title ---------------------------------------------------------------
  // chosenTitles[0] IS the title. resolved.titles is NOT used, for the same reason the
  // YouTube push does not use it: it falls back to the generator's top three when nothing
  // is chosen, which is right for showing a starting point and wrong for publishing.
  const chosen = record.chosenTitles ?? [];
  const title = (chosen[0] ?? '').trim();
  if (!title) {
    throw new Error(
      `Item ${item} has no title chosen. chosenTitles[0] is what goes on the episode — pick ` +
      `at least one title before uploading. (Nothing is guessed from the generated list.)`
    );
  }
  if (title.length > SPREAKER_MAX_TITLE_LENGTH) {
    throw new Error(
      `Item ${item}'s chosen title is ${title.length} characters; Spreaker's limit is ` +
      `${SPREAKER_MAX_TITLE_LENGTH}. Edit it before uploading.`
    );
  }

  // ---- description and tags ----------------------------------------------------
  // From the SAME resolver the extension bridge and the YouTube push read, so what is
  // uploaded is what the panel showed. Overrides win over the generated values there, in
  // one place.
  //
  // An empty description is ALLOWED here, where the YouTube push refuses it. That is not
  // an inconsistency: the YouTube rule is about not ERASING a description a live video
  // already has, and a create has nothing to erase. An episode with no description is a
  // poor episode, not a destroyed one.
  const description = resolved.description ?? '';
  const tags = splitTags(resolved.tags ?? '');

  // ---- the audio ---------------------------------------------------------------
  if (!audio || typeof audio.path !== 'string' || !audio.path.trim()) {
    throw new Error(
      `Item ${item} has no episode audio chosen, and an episode is the audio. Pick the ` +
      `exported file (or confirm the one offered) before uploading.`
    );
  }
  if (record.spreakerAudioPath && record.spreakerAudioPath !== audio.path) {
    // The planner is being handed a different file than the record names. One of the two
    // is wrong and there is no way to tell which, so neither is used.
    throw new Error(
      `Item ${item} records episode audio ${record.spreakerAudioPath} but the upload was ` +
      `prepared from ${audio.path}. Nothing was sent.`
    );
  }
  if (!audio.meta || !Number.isFinite(audio.meta.bytes)) {
    throw new Error(
      `Item ${item}'s episode audio ${audio.path} has not been measured, so whether ` +
      `Spreaker will take it is unknown. Nothing was sent.`
    );
  }
  if (audio.meta.bytes > MAX_EPISODE_BYTES) {
    throw new Error(
      `Item ${item}'s episode audio ${audio.path} is ${audio.meta.bytes} bytes; Spreaker's ` +
      `limit is ${MAX_EPISODE_BYTES}. Nothing was sent.`
    );
  }

  // ---- the schedule ------------------------------------------------------------
  // publishAt is the operator's go-live intent for this item, and it is honoured here for
  // the same reason the YouTube push honours it: it is the one statement he has made
  // about when this should be public. A Spreaker upload with no auto_published_at is
  // PUBLISHED IMMEDIATELY, so "no schedule" is a decision with an audience-visible
  // consequence and it is stated in the plan rather than left to be inferred from a
  // missing field.
  let autoPublishedAt: string | null = null;
  let autoPublishedAtSkipped: string | null = null;

  if (record.publishAt) {
    const when = new Date(record.publishAt);
    if (Number.isNaN(when.getTime())) {
      throw new Error(
        `Item ${item}'s schedule ${JSON.stringify(record.publishAt)} is not a date this app ` +
        `can read, so it cannot be converted to Spreaker's UTC format. Nothing was sent.`
      );
    }
    if (when.getTime() <= now.getTime()) {
      // A schedule in the past is not a schedule. Sending it would be sending Spreaker a
      // "future date" that is not one, and quietly dropping it would publish an episode
      // NOW that the operator had scheduled — the loudest possible wrong outcome.
      throw new Error(
        `Item ${item} is scheduled for ${record.publishAt}, which has already passed. ` +
        `Spreaker's auto_published_at must be in the future, and uploading without it ` +
        `would publish the episode immediately. Set a new time, or clear the schedule to ` +
        `publish now on purpose.`
      );
    }
    autoPublishedAt = toSpreakerUtc(record.publishAt);
  } else {
    autoPublishedAtSkipped =
      'This item has no schedule, so the episode publishes as soon as Spreaker finishes ' +
      'encoding it.';
  }

  const fields: SpreakerEpisodeRequest['fields'] = { title, description };
  // Omitted rather than sent empty. On a create, an absent optional field is "Spreaker's
  // default"; an empty one is this app asserting a value. There is no tag set to preserve
  // and nothing to erase, so the honest request for "no tags" is no field.
  if (tags.length > 0) fields.tags = tags.join(',');
  if (autoPublishedAt) fields.auto_published_at = autoPublishedAt;

  return {
    request: { showId, fields, mediaFilePath: audio.path },
    title,
    description,
    tags,
    audio,
    showId,
    showName: target.showName ?? null,
    autoPublishedAt,
    autoPublishedAtSkipped,
  };
}

/**
 * Upload one item as an episode of the configured show.
 *
 * ORDER MATTERS and it is deliberate, exactly as in the YouTube push: everything that can
 * be refused is refused BEFORE anything is sent. The configuration is checked first (it
 * is free), then the file is validated and probed (seconds), then the plan is built (every
 * remaining rule), and only then does one HTTP request happen.
 */
export async function pushEpisodeToSpreaker(
  itemId: string,
  deps: SpreakerPushDeps
): Promise<SpreakerPushOutcome> {
  const { store, readGenerated, api, requireTarget, probeAudio } = deps;
  const now = deps.now ?? (() => new Date());

  const generated = readGenerated(itemId);
  if (!generated) {
    throw new Error(`No generated metadata for item ${itemId} — there is nothing to upload.`);
  }

  // No emptyChosenMetadata fallback, exactly as in the YouTube push: a record that does
  // not exist is an item nobody has chosen anything for, and a blank one would resolve to
  // the generator's suggestions and publish them.
  const record = store.get(itemId);
  if (!record) {
    throw new Error(
      `Nothing has been saved for item ${itemId}, so it has no chosen title, no podcast ` +
      `flag and no episode audio. There is nothing to upload.`
    );
  }

  // First, because it costs nothing and it is the most likely thing to be wrong on a
  // machine that has never done this before.
  const target = requireTarget();

  if (!record.spreakerAudioPath) {
    throw new Error(
      `Item ${itemId} has no episode audio chosen, and an episode is the audio. Pick the ` +
      `exported file (or confirm the one offered) before uploading.`
    );
  }

  // Re-validated NOW, against the file as it is now — not trusted from when it was picked.
  // This throws naming the file and the rule, and it happens before the plan so a vanished
  // volume is reported as a vanished volume rather than as a missing measurement.
  const { meta } = await validateAudioFile(record.spreakerAudioPath, probeAudio);

  const resolved = resolveChosenMetadata(record, generated);
  const plan = planEpisode({
    record,
    resolved,
    audio: { path: record.spreakerAudioPath, meta },
    target,
    now: now(),
  });

  const created = await api.createEpisode(plan.request);

  if (!created || typeof created.episodeId !== 'number' || !Number.isFinite(created.episodeId)) {
    // The upload may well have happened. What did not happen is this app learning the id
    // of what it created, and a receipt without one is a claim it cannot support.
    throw new Error(
      `Spreaker accepted the upload of item ${itemId} but its reply carried no episode id ` +
      `(${JSON.stringify(created)}). Check the show on Spreaker before uploading again — ` +
      `the episode may exist.`
    );
  }

  const receipt: SpreakerReceipt = {
    episodeId: created.episodeId,
    showId: plan.showId,
    showTitle: created.showTitle ?? plan.showName,
    pushedAt: now().toISOString(),
    uploaded: {
      title: plan.title,
      description: { chars: plan.description.length, firstLine: firstLineOf(plan.description) },
      tags: { count: plan.tags.length },
      audio: {
        path: plan.audio.path,
        bytes: plan.audio.meta.bytes,
        durationSec: plan.audio.meta.durationSec,
      },
      ...(plan.autoPublishedAt ? { autoPublishedAt: plan.autoPublishedAt } : {}),
    },
    skipped: {
      ...(plan.autoPublishedAtSkipped ? { autoPublishedAt: plan.autoPublishedAtSkipped } : {}),
    },
    siteUrl: created.siteUrl ?? null,
    // Verbatim, including null. A fresh upload is PENDING or PROCESSING, and recording
    // whatever Spreaker said is what keeps this receipt from reading as "it is live".
    encodingStatus: created.encodingStatus ?? null,
  };

  // Status is NOT advanced to 'published'. The PublishStatus ladder describes the YouTube
  // side of an item, and an episode existing on Spreaker says nothing about whether the
  // video has been filled or published. Claiming otherwise would make the panel state a
  // thing nobody observed — the same rule the YouTube push follows for the same reason.
  const selection = await store.update(itemId, generated, {
    spreakerEpisodeId: receipt.episodeId,
    spreakerPushedAt: receipt.pushedAt,
    spreakerReceipt: receipt,
  });

  return { selection, receipt };
}
