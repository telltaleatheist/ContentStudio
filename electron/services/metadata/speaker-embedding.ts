/**
 * Speaker embeddings — turning a stretch of audio into a vector that says WHO is talking.
 *
 * This is the measurement half of speaker tagging. Nothing here knows about transcripts,
 * segments or the pipeline; it reads 16 kHz mono PCM, runs it through a speaker-verification
 * network, and returns a unit vector. speaker-tagging.service.ts is what turns those vectors
 * into HOST / CLIP / UNSURE.
 *
 * WHY THIS RUNTIME. The prototype that proved the idea was Python — speechbrain's ECAPA-TDNN
 * under a venv — and a venv is not something a packaged Electron app can depend on. sherpa-onnx
 * ships the same class of model as ONNX with an N-API node binding, so the whole thing is an
 * npm dependency and a model file, in process, no interpreter and no child process.
 *
 * WHICH MODEL, AND WHY THAT ONE. Four English speaker-embedding models from the sherpa-onnx
 * release were scored against the SAME 297 captions the Python prototype scored, with the same
 * enrolled reference, and compared on the one number that matters — the distance between the
 * worst caption everybody agrees is the host and the best caption everybody agrees is footage:
 *
 *   nemo_en_titanet_small          worst HOST 0.740   best CLIP 0.354   gap  0.386   38 MB
 *   3dspeaker_campplus_sv_en       worst HOST 0.411   best CLIP 0.432   gap -0.021   28 MB
 *   wespeaker_en_voxceleb_CAM++    worst HOST 0.438   best CLIP 0.864   gap -0.426   28 MB
 *   wespeaker_en_voxceleb_res34_LM worst HOST 0.652   best CLIP 0.816   gap -0.164   25 MB
 *
 * Three of the four do not separate this material AT ALL — their host and footage distributions
 * overlap, so no pair of thresholds exists that would call them correctly. TitaNet-small does,
 * with a third of the scale to spare. That is the only reason it is the one here.
 *
 * THE ELECTRON TRAP, recorded because it cost an hour and is invisible until you hit it:
 * `extractor.compute(stream)` defaults to handing back an EXTERNAL ArrayBuffer, and Electron's
 * V8 refuses those outright ("External buffers are not allowed"). The same call works in plain
 * node, so a node-side test proves nothing about the app. Every compute here passes the
 * binding's second argument as false, which copies instead. Verified under Electron 30.0.0.
 *
 * PACKAGING. sherpa-onnx ships a `.node` addon beside three dylibs, and dlopen cannot read out
 * of an asar archive — so package.json's `build.asarUnpack` names the sherpa packages. Without
 * that entry the app runs perfectly in development and fails to load the addon the first time
 * anybody enables tagging in a packaged build, which is the worst shape a packaging bug takes.
 */

import * as fs from 'fs';

/**
 * The audio format everything on this path is already in.
 *
 * Whisper transcription extracts 16 kHz mono signed-16-bit PCM (ffmpeg-bridge.ts
 * `extractAudio`), which is exactly what a speaker-embedding model wants, so tagging reads
 * THE SAME FILE whisper.cpp read rather than decoding the video a second time.
 */
export const EMBEDDING_SAMPLE_RATE = 16000;

/**
 * The similarity above which a caption is the enrolled speaker, and the one below which it is
 * somebody else. Between them is UNSURE, which is a real answer and not a missing one.
 *
 * CALIBRATED, not guessed, and calibrated for THIS model — a cosine score means nothing without
 * the embedding space it was measured in. Against the 297-caption ground truth (u1, "jesse
 * watters commies"), TitaNet-small put every caption that is unambiguously the host at 0.740 or
 * above and every caption that is unambiguously footage at 0.354 or below. These two lines sit
 * in the empty channel between those masses with roughly equal margin on each side: 0.090 clear
 * of the worst host caption, 0.096 clear of the best footage caption.
 *
 * The design brief proposed 0.65 / 0.35 from the ECAPA prototype's scale. The HOST line survives
 * that proposal unchanged; the CLIP line moved up to 0.45 because on TitaNet's scale a single
 * unambiguous footage caption scores 0.354, which 0.35 would have left one thousandth outside
 * the band. 0.45 costs nothing — the next footage caption up is at 0.442 in the same run's
 * mixed-caption group, which BELONGS in the band — and buys a real margin.
 *
 * What the band actually catches is captions that straddle a cut. 18 of the 297 land in it, and
 * reading them back every one contains an audible speaker change inside a single caption:
 * "Are we ready for a green New Deal? What's the problem here?" is the clip asking and the host
 * answering, in one line, and neither side owns it.
 */
export const HOST_SIMILARITY = 0.65;
export const CLIP_SIMILARITY = 0.45;

/**
 * The shortest caption worth scoring.
 *
 * A speaker-verification network needs enough voiced audio to characterise a voice; under about
 * half a second it is describing one phoneme. A caption that short is not measurable, so it is
 * reported as UNSURE — which is the honest answer, since UNSURE means "these words are
 * attributed to nobody" and nobody is exactly who can be attributed a sound too short to
 * identify. It is counted separately in the run log so an operator can see if it is happening a
 * lot. (In the 297-caption ground truth it happens zero times.)
 */
export const MIN_SCOREABLE_SECONDS = 0.5;

/** What a caption's score resolved to. */
export type SpeakerVerdict = 'host' | 'clip' | 'unsure';

export function verdictFor(similarity: number): SpeakerVerdict {
  if (similarity >= HOST_SIMILARITY) return 'host';
  if (similarity <= CLIP_SIMILARITY) return 'clip';
  return 'unsure';
}

/** The label that goes on the transcript line, and into the prompts. */
export function verdictLabel(verdict: SpeakerVerdict): string {
  return verdict.toUpperCase();
}

/**
 * Read a 16 kHz mono 16-bit WAV into normalised float samples.
 *
 * Hand-rolled rather than taken from a library, and that is deliberate. The Python prototype hit
 * the same wall from the other side: torchaudio.load is broken on this machine, and it read the
 * WAV through the stdlib `wave` module instead. A RIFF chunk walk is thirty lines, has no
 * dependency to break, and REFUSES anything that is not the exact format this path produces
 * rather than resampling it quietly — a 44.1 kHz file scored against a 16 kHz enrollment would
 * produce numbers that look like similarities and are not.
 */
export function readPcm16Mono(wavPath: string): Float32Array {
  const pcm = openPcm16Mono(wavPath);
  return pcm.slice(0, pcm.sampleCount);
}

/**
 * The same file, kept as its ON-DISK 16-bit bytes, converted to float one slice at a time.
 *
 * FOR THE PER-CAPTION PASS, where the whole-file version is a real cost: a 90-minute export is
 * 172 MB of PCM and 345 MB as Float32, and that 345 MB would sit there for the length of the
 * scoring pass beside whatever Ollama has resident. Slicing on demand keeps only the caption
 * being scored — a few hundred kilobytes — in float form.
 *
 * `readPcm16Mono` above is the whole-file read, and it stays for the two callers that want the
 * whole file anyway: the enrollment recording, which is a minute, and the validation script.
 */
export function openPcm16Mono(wavPath: string): {
  sampleCount: number;
  /** Samples `[from, to)` as normalised floats. Bounds are the caller's to get right. */
  slice(from: number, to: number): Float32Array;
} {
  const { data } = readWavData(wavPath);
  const sampleCount = Math.floor(data.length / 2);
  return {
    sampleCount,
    slice(from: number, to: number): Float32Array {
      const start = Math.max(0, Math.min(sampleCount, Math.floor(from)));
      const end = Math.max(start, Math.min(sampleCount, Math.floor(to)));
      const out = new Float32Array(end - start);
      for (let i = 0; i < out.length; i++) {
        out[i] = data.readInt16LE((start + i) * 2) / 32768;
      }
      return out;
    },
  };
}

/** The RIFF walk itself: the `data` chunk of a file that is exactly the expected format. */
function readWavData(wavPath: string): { data: Buffer } {
  const buffer = fs.readFileSync(wavPath);
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${wavPath} is not a RIFF/WAVE file`);
  }

  let offset = 12;
  let format: { channels: number; sampleRate: number; bits: number } | null = null;
  let data: Buffer | null = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      format = {
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
    }
    // Chunks are word-aligned: an odd-length chunk is followed by a pad byte.
    offset = body + size + (size % 2);
  }

  if (!format) throw new Error(`${wavPath} has no fmt chunk`);
  if (!data) throw new Error(`${wavPath} has no data chunk`);
  if (format.channels !== 1 || format.sampleRate !== EMBEDDING_SAMPLE_RATE || format.bits !== 16) {
    throw new Error(
      `${wavPath} is ${format.channels}-channel ${format.sampleRate} Hz ${format.bits}-bit; ` +
      `speaker embedding reads mono ${EMBEDDING_SAMPLE_RATE} Hz 16-bit only`
    );
  }

  return { data };
}

/** Cosine similarity of two vectors that are already unit length — i.e. their dot product. */
export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Cannot compare a ${a.length}-dimension embedding with a ${b.length}-dimension one`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * The loaded model, held open for the length of a run.
 *
 * Construction reads a 38 MB ONNX graph and takes on the order of a second, so the tagger builds
 * one and scores every caption of a video through it. There is no module-level singleton: the
 * enrollment can change between runs, and a process-lifetime model would keep the file handle of
 * a model the operator has since replaced.
 */
export class SpeakerEmbeddingModel {
  /** Embedding width, as the loaded graph reports it (192 for TitaNet-small). */
  readonly dim: number;

  private readonly extractor: any;

  constructor(modelPath: string, options?: { numThreads?: number }) {
    if (!fs.existsSync(modelPath)) {
      throw new Error(`Speaker embedding model not found at: ${modelPath}`);
    }

    // Required lazily so that merely importing this module — which the pipeline does whether or
    // not tagging is on — does not load a native addon and its 28 MB of onnxruntime.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sherpa = require('sherpa-onnx-node');

    this.extractor = new sherpa.SpeakerEmbeddingExtractor({
      model: modelPath,
      numThreads: options?.numThreads ?? 2,
      debug: false,
      provider: 'cpu',
    });
    this.dim = this.extractor.dim;
  }

  /**
   * The unit-length embedding of one stretch of audio.
   *
   * Normalised here so every comparison downstream is a plain dot product and no caller can
   * forget: an un-normalised pair would still return a number, just not a cosine.
   */
  embed(samples: Float32Array): Float32Array {
    if (samples.length === 0) {
      throw new Error('Cannot embed an empty audio slice');
    }

    const stream = this.extractor.createStream();
    stream.acceptWaveform({ sampleRate: EMBEDDING_SAMPLE_RATE, samples });
    // `false` disables the external-ArrayBuffer return path, which Electron's V8 rejects. See
    // the note at the top of this file.
    const raw: Float32Array = this.extractor.compute(stream, false);

    let norm = 0;
    for (const value of raw) norm += value * value;
    norm = Math.sqrt(norm);
    if (!(norm > 0)) {
      throw new Error('Speaker embedding model returned a zero vector');
    }

    const unit = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) unit[i] = raw[i] / norm;
    return unit;
  }
}
