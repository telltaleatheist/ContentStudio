/**
 * Episode Audio Validation
 *
 * Everything the app knows about an episode audio FILE ON DISK: is it a file Spreaker
 * will take, what does it actually contain, and — separately — where would the audio for
 * this item be if the workflow exported one.
 *
 * The audio counterpart of thumbnail-validate.ts, deliberately built to the same two
 * properties:
 *
 * 1. It NEVER fixes anything. No transcode, no re-mux, no "close enough". A file that
 *    fails a rule is refused with a message naming the actual value and the rule, because
 *    the fix is Owen re-exporting the audio.
 *
 * 2. It is RE-RUNNABLE, so it runs again at push time. The path points at Callisto, an
 *    external volume: "it validated when I picked it" says nothing about the file that is
 *    about to be streamed into an HTTP request.
 *
 * The one structural difference from the thumbnail validator: this one is ASYNC and takes
 * an injected probe. A PNG's dimensions are in its first 24 bytes; an MP3's duration is
 * not anywhere cheap, and the app already owns an ffprobe (lib/bridges/ffprobe-bridge).
 * Injecting it rather than importing keeps publish/ liftable and — the reason that
 * actually matters — lets every rule here be exercised against a fixture without spawning
 * a subprocess.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AudioMeta } from './publish-types';

/**
 * Spreaker's hard upload ceiling. Refused above this, never split or re-encoded.
 *
 * Source: help.spreaker.com "What kind of files can I upload to the platform?" —
 * "no more than 300MB", read 2026-08-22. The API guide does not state a size limit at
 * all, so this number comes from the help centre and is stated here rather than being
 * left for the server to discover after a 300 MB upload has already been sent.
 */
export const MAX_EPISODE_BYTES = 300 * 1024 * 1024;

/**
 * The extensions Spreaker documents as accepted, lower-cased and with the dot.
 *
 * Source: developers.spreaker.com/guides/upload-an-episode/ — "MP3, MP4, WAV, 3GP, AAC,
 * AMR, FLAC, OGG, RA, WMA, ASF" — and the identical list on the help centre page above.
 * Checked by EXTENSION, and separately by ffprobe: the extension is what Spreaker's
 * uploader looks at, and the streams are what says the file is really audio.
 */
export const SPREAKER_AUDIO_EXTENSIONS: readonly string[] = [
  '.3gp', '.aac', '.amr', '.asf', '.flac', '.mp3', '.mp4', '.ogg', '.ra', '.wav', '.wma',
];

/**
 * `.m4a` — accepted here, with a warning, and NOT in the list above.
 *
 * It is an MP4 container by another name and Spreaker's documented list names `.mp4` but
 * not `.m4a`, so this app has no basis for either claim: refusing it would invent a rule,
 * and accepting it silently would let a documented-unsupported extension reach a live
 * upload with nobody told. It is accepted and the warning says exactly that.
 */
export const UNDOCUMENTED_AUDIO_EXTENSIONS: readonly string[] = ['.m4a'];

/**
 * The extensions the sibling proposal will look for, in order.
 *
 * The workflow exports one MP3 beside the .mov (`podcast 1.mp3` next to `podcast 1.mov`),
 * so mp3 is first and the other two are here because they are the plausible alternatives
 * out of the same export step — not because anything has been seen using them.
 */
export const PROPOSED_AUDIO_EXTENSIONS: readonly string[] = ['.mp3', '.m4a', '.wav'];

/** What one probe of a media file has to answer for this module to decide. */
export interface AudioProbe {
  /** Seconds. Whatever ffprobe read off the container or the stream. */
  durationSec: number;
  hasAudio: boolean;
  hasVideo: boolean;
  /** The audio stream's codec name, or null when there is no audio stream. */
  audioCodec: string | null;
}

/**
 * An accepted audio file: what it measured, plus anything worth saying about it.
 *
 * WARNINGS ARE NOT FAILURES, exactly as in thumbnail-validate: an `.m4a`, or an `.mp4`
 * that still has its video stream, is uploaded and used. What it must not do is go
 * through silently.
 */
export interface AudioValidation {
  meta: AudioMeta;
  warnings: string[];
}

function describeStat(st: fs.Stats): string {
  if (st.isDirectory()) return 'a directory';
  if (st.isSymbolicLink()) return 'a symbolic link';
  if (st.isFIFO()) return 'a pipe';
  if (st.isSocket()) return 'a socket';
  if (st.isBlockDevice() || st.isCharacterDevice()) return 'a device';
  return 'not a regular file';
}

/** MB to one decimal, for messages about a 300 MB ceiling. */
function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `1:04:12` / `12:07`. Seconds are always two digits; hours appear only when there are any. */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0
    ? `${h}:${mm}:${String(s).padStart(2, '0')}`
    : `${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * Validate one audio file, or throw naming the file, the value and the rule.
 *
 * ORDER IS DELIBERATE: the cheap filesystem facts are checked before ffprobe is spawned,
 * so a path that is a directory, or a 4 GB .mov somebody picked by mistake, is refused
 * without a subprocess and without reading a byte.
 */
export async function validateAudioFile(
  absPath: string,
  probe: (file: string) => Promise<AudioProbe>
): Promise<AudioValidation> {
  if (typeof absPath !== 'string' || !absPath.trim()) {
    throw new Error(`An audio file path is required; got ${JSON.stringify(absPath)}.`);
  }
  if (!path.isAbsolute(absPath)) {
    throw new Error(
      `Episode audio must be named by an absolute path; got ${JSON.stringify(absPath)}. ` +
      `A relative path means a different file depending on where this process happens ` +
      `to be running.`
    );
  }

  if (!fs.existsSync(absPath)) {
    throw new Error(
      `Episode audio ${absPath} does not exist. If the volume is unmounted, mount it; if ` +
      `the file moved, choose it again.`
    );
  }
  const st = fs.statSync(absPath);
  if (!st.isFile()) {
    throw new Error(`Episode audio ${absPath} is ${describeStat(st)}, not a file.`);
  }

  const extension = path.extname(absPath).toLowerCase();
  const documented = SPREAKER_AUDIO_EXTENSIONS.includes(extension);
  const undocumented = UNDOCUMENTED_AUDIO_EXTENSIONS.includes(extension);
  if (!documented && !undocumented) {
    throw new Error(
      `Episode audio ${absPath} has extension ${JSON.stringify(extension || '(none)')}, ` +
      `which Spreaker does not accept. It takes: ` +
      `${SPREAKER_AUDIO_EXTENSIONS.join(' ')}.`
    );
  }

  if (st.size === 0) {
    throw new Error(`Episode audio ${absPath} is empty (0 bytes).`);
  }
  if (st.size > MAX_EPISODE_BYTES) {
    throw new Error(
      `Episode audio ${absPath} is ${mb(st.size)}; Spreaker's limit is ` +
      `${mb(MAX_EPISODE_BYTES)}. Export it again at a lower bitrate — nothing here will ` +
      `re-encode it for you.`
    );
  }

  const probed = await probe(absPath);
  if (!probed || typeof probed !== 'object') {
    throw new Error(`Probing ${absPath} returned ${JSON.stringify(probed)}, which says nothing about it.`);
  }
  if (!probed.hasAudio) {
    throw new Error(
      `${absPath} has no audio stream. Its extension says audio and its contents do not — ` +
      `uploading it would publish a silent episode.`
    );
  }
  if (!Number.isFinite(probed.durationSec) || probed.durationSec <= 0) {
    throw new Error(
      `ffprobe reported duration ${probed.durationSec} for ${absPath}. An episode with no ` +
      `readable length is not one to upload.`
    );
  }

  const warnings: string[] = [];
  if (undocumented) {
    warnings.push(
      `${extension} is not on Spreaker's documented list of accepted extensions ` +
      `(${SPREAKER_AUDIO_EXTENSIONS.join(' ')}). It is an MP4 container under another ` +
      `name and will most likely be accepted, but this app cannot promise that.`
    );
  }
  if (probed.hasVideo) {
    warnings.push(
      `This file also carries a video stream, so the whole of it is uploaded and only the ` +
      `audio is ever heard. If that is the ${mb(st.size)} .mov rather than the exported ` +
      `audio, choose the audio instead.`
    );
  }

  return {
    meta: {
      bytes: st.size,
      durationSec: probed.durationSec,
      extension,
      audioCodec: probed.audioCodec ?? 'unknown',
      hasVideo: probed.hasVideo,
    },
    warnings,
  };
}

/**
 * Where this item's episode audio would be, by the naming convention — the candidates, in
 * the order they should be tried.
 *
 * PURE, and it touches no filesystem: it returns paths, and the caller decides which of
 * them exists. That split is what makes the convention testable without a volume mounted.
 *
 * The convention, from the live export folder (2026-08-16):
 *
 *   .../complete/podcast 1.mov     the item's source
 *   .../complete/podcast 1.mp3     the episode audio
 *
 * Same directory, same basename, an audio extension. Nothing about weeks or slots, unlike
 * the thumbnail proposal — the audio is a sibling, so no layout knowledge is needed and
 * none is assumed.
 */
export function deriveProposedAudioPaths(sourcePath: string | null | undefined): string[] {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) return [];

  const dir = path.dirname(sourcePath);
  const extension = path.extname(sourcePath);
  const stem = path.basename(sourcePath, extension);
  if (!stem) return [];

  return PROPOSED_AUDIO_EXTENSIONS
    // A source that IS one of the audio extensions would propose itself, which is not a
    // proposal — it is the file the operator already has.
    .filter((candidate) => candidate !== extension.toLowerCase())
    .map((candidate) => path.join(dir, `${stem}${candidate}`));
}
