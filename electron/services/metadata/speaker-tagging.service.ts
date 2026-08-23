/**
 * Speaker tagging — telling the metadata AI who said which line.
 *
 * THE FAILURE THIS EXISTS TO FIX, in the operator's words: a description that said "Fox News
 * frames the 13th Amendment's prisoner exception as..." when the person who brought the 13th
 * Amendment up was the HOST. A reaction video's transcript is two people's words in one stream —
 * the footage's claim and the host's answer to it — and a model handed that stream flat has no
 * way to tell them apart. It attributes at random, and roughly half the time it hands the host's
 * argument to the people he is arguing with.
 *
 * WHAT THIS DOES. Whisper has already produced the captions and the 16 kHz mono WAV it read them
 * from. Each caption's slice of that WAV is embedded and compared, by cosine similarity, against
 * the operator's enrolled voice (speaker-enrollment.ts). The score becomes one of three tags:
 *
 *   HOST    the enrolled speaker — the creator of the video, talking
 *   CLIP    somebody else — footage being played and reacted to
 *   UNSURE  the score is in the band between them, or the caption is too short to measure
 *
 * UNSURE IS A REAL ANSWER, not a missing one, and it is the piece the earlier HOST/CLIP work did
 * not have. This build tags at CAPTION granularity, and whisper.cpp does not cut its captions on
 * speaker changes — so a caption that straddles a cut contains both voices and its embedding is
 * a blend of the two, which is precisely why it scores in the middle. Measured on the 297-caption
 * ground truth, 18 captions land in the band and every one of them, read back, has an audible
 * speaker change inside it. Those lines are attributed to NOBODY, and the prompts say so.
 *
 * NO FALLBACKS, on either side of the switch:
 *   - No enrollment configured → tagging is OFF. That is a declared MODE: it is printed once per
 *     run and the pipeline does exactly what it did before this feature existed.
 *   - Enrollment configured and anything goes wrong → the item FAILS, naming the cause. Emitting
 *     untagged output after tagging was asked for would give the operator metadata whose
 *     attribution he believes was checked and was not, which is the same bug this feature was
 *     built to remove.
 *
 * WHAT IT COSTS. About 16 seconds of CPU for a 30-minute video (297 captions, 2 threads, Apple
 * silicon), against the minutes whisper.cpp itself takes on the same file. It is not a
 * consideration.
 */

import * as log from 'electron-log';

import { TimeUtils } from './chapter-generator.service';
import {
  CLIP_SIMILARITY,
  EMBEDDING_SAMPLE_RATE,
  HOST_SIMILARITY,
  MIN_SCOREABLE_SECONDS,
  SpeakerEmbeddingModel,
  cosineSimilarity,
  openPcm16Mono,
  verdictFor,
  verdictLabel,
} from './speaker-embedding';
import { loadSpeakerEnrollment, type SpeakerEnrollment } from './speaker-enrollment';
import type { SRTSegment } from './whisper.service';

/**
 * What one run decided about speaker tagging, before any video is touched.
 *
 * Both arms are legitimate outcomes and both are stated out loud. Resolving this ONCE per run,
 * rather than per item, is what makes "printed once" true and what stops half a queue being
 * tagged because the operator changed a setting mid-run.
 */
export type SpeakerTaggingMode =
  | { enabled: false; reason: string }
  | { enabled: true; enrollment: SpeakerEnrollment; modelPath: string };

/** What tagging did to one video, for the log and for the saved-transcript record. */
export interface SpeakerTaggingSummary {
  /** `<basename>@<size>-<mtimeMs>` of the enrollment recording these tags were scored against. */
  enrollmentStamp: string;
  host: number;
  clip: number;
  unsure: number;
  /** Of the unsure, how many were unsure because they were too short to score at all. */
  tooShort: number;
}

/**
 * Resolve this run's tagging mode.
 *
 * `enrollmentPath` is the stored `speakerEnrollmentAudio` setting as the caller read it. Absent
 * or blank is the OFF mode, with a reason the operator can act on; a path that cannot be turned
 * into an embedding THROWS here, before the queue starts, which is the cheapest place for him to
 * find out — the alternative is discovering it on item 7 of 9 after an hour of transcription.
 */
export async function resolveSpeakerTagging(
  enrollmentPath: string | null | undefined,
  modelPath: string
): Promise<SpeakerTaggingMode> {
  const audioPath = typeof enrollmentPath === 'string' ? enrollmentPath.trim() : '';

  if (audioPath.length === 0) {
    return {
      enabled: false,
      reason:
        'no voice enrollment is configured (Settings → Speaker tagging), so captions are not ' +
        'attributed to a speaker and the metadata calls read the transcript flat',
    };
  }

  const enrollment = await loadSpeakerEnrollment(audioPath, modelPath);
  return { enabled: true, enrollment, modelPath };
}

/** Say what mode this run is in, once, in the terms the operator set it in. */
export function announceSpeakerTagging(mode: SpeakerTaggingMode): void {
  if (!mode.enabled) {
    log.info(`[SpeakerTagging] OFF for this run — ${mode.reason}`);
    return;
  }
  log.info(
    `[SpeakerTagging] ON for this run — captions scored against ${mode.enrollment.stamp} ` +
    `(enrolled ${mode.enrollment.computedAt}); HOST at >= ${HOST_SIMILARITY}, CLIP at <= ${CLIP_SIMILARITY}`
  );
}

/**
 * The tagger for one run: one loaded model, one enrolled vector, every video.
 *
 * Held for the run rather than rebuilt per video because loading the ONNX graph costs about a
 * second and the enrollment cannot change mid-run — the mode was resolved before the queue
 * started, deliberately.
 */
export class SpeakerTagger {
  private readonly model: SpeakerEmbeddingModel;
  private readonly reference: Float32Array;

  readonly enrollmentStamp: string;

  constructor(mode: Extract<SpeakerTaggingMode, { enabled: true }>) {
    this.model = new SpeakerEmbeddingModel(mode.modelPath);
    this.reference = mode.enrollment.embedding;
    this.enrollmentStamp = mode.enrollment.stamp;

    if (this.reference.length !== this.model.dim) {
      throw new Error(
        `The enrolled voice is a ${this.reference.length}-dimension embedding and the loaded model ` +
        `produces ${this.model.dim}-dimension ones. The enrollment was taken with a different model; ` +
        `re-select the enrollment recording in Settings to recompute it.`
      );
    }
  }

  /**
   * Tag every caption in place, from the audio Whisper read.
   *
   * IN PLACE, and on the SRTSegment itself, because `speaker`/`speakerLabel` is the one channel
   * every downstream consumer already reads: the saved-transcript record persists the segments
   * verbatim, the content text is built from them, and the chapter pipeline reads them again on
   * its own path. A side-channel would have to be threaded through all three and would go stale
   * against exactly one of them.
   *
   * Throws on any failure. This is only called when the operator asked for tagging.
   */
  tagSegments(segments: SRTSegment[], wavPath: string, label: string): SpeakerTaggingSummary {
    // Opened rather than read whole: a 90-minute export is 345 MB once converted to float, and
    // this pass only ever looks at one caption at a time.
    const audio = openPcm16Mono(wavPath);
    const summary: SpeakerTaggingSummary = {
      enrollmentStamp: this.enrollmentStamp,
      host: 0,
      clip: 0,
      unsure: 0,
      tooShort: 0,
    };

    const started = Date.now();
    for (const segment of segments) {
      const startSec = TimeUtils.srtTimeToSeconds(segment.start);
      const endSec = TimeUtils.srtTimeToSeconds(segment.end);

      let verdict: ReturnType<typeof verdictFor>;
      if (!(endSec > startSec) || endSec - startSec < MIN_SCOREABLE_SECONDS) {
        // Too little audio to characterise a voice. Attributed to nobody, and counted, rather
        // than pushed onto whichever side happens to be nearer.
        verdict = 'unsure';
        summary.tooShort += 1;
      } else {
        const from = Math.max(0, Math.floor(startSec * EMBEDDING_SAMPLE_RATE));
        const to = Math.min(audio.sampleCount, Math.floor(endSec * EMBEDDING_SAMPLE_RATE));
        if (to - from < MIN_SCOREABLE_SECONDS * EMBEDDING_SAMPLE_RATE) {
          // The caption runs past the end of the audio. That is a real mismatch between the SRT
          // and the WAV, not a short caption, so say which one it is.
          throw new Error(
            `Caption ${segment.index} of ${label} covers ${segment.start}–${segment.end} but the ` +
            `extracted audio is only ${(audio.sampleCount / EMBEDDING_SAMPLE_RATE).toFixed(1)}s long`
          );
        }
        const similarity = cosineSimilarity(this.reference, this.model.embed(audio.slice(from, to)));
        verdict = verdictFor(similarity);
      }

      segment.speaker = verdict;
      segment.speakerLabel = verdictLabel(verdict);
      summary[verdict] += 1;
    }

    log.info(
      `[SpeakerTagging] ${label}: ${summary.host} HOST, ${summary.clip} CLIP, ${summary.unsure} UNSURE ` +
      `(${summary.tooShort} of those too short to score) across ${segments.length} captions in ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`
    );

    return summary;
  }
}
