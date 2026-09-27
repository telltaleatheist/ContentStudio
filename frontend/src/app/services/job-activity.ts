/**
 * What a running queue row SAYS it is doing, read off main's `generation-progress` events.
 *
 * Pure, and the only place the queue turns an event into words or into an item's status, so
 * the rules are checked in `npm run check:pure` against this very file (LEDGER #225).
 *
 * WHY IT EXISTS. On 2026-09-26 Owen watched a job that was working the whole time and saw
 * nothing moving: main sent a progress event every ~17 s ("Transcribing on crucible@… 40:33
 * of 45:46", "Chapters (assign 128/469) 1/1..."), but the row never showed any of them. The
 * row's only words were "Transcribed" or "Generating..." and a bar that crept 50 → 54 % over
 * four minutes, and a 1 s timer overwrote the event's message with "Processing... (Ns)" in a
 * field no template read. A row now shows the stage line this module makes, a spinner, and a
 * clock (`elapsedClock`), from Start until the job ends.
 *
 * An event this module has no words for is shown as main wrote it (trailing dots trimmed):
 * main's own sentence is still the truth about what is happening, and hiding it would be the
 * silence this module exists to end.
 */
import type { ItemProgress } from './job-queue';

/** One `generation-progress` event, as ipc-handlers.ts sends it. */
export interface GenerationProgressEvent {
  jobId?: string;
  phase: string;
  message?: string;
  percent?: number;
  filename?: string;
  itemIndex?: number;
}

/** The phase main sends while it prepares the channel's lessons (metadata-generator.service.ts). */
export const LESSONS_PHASE = 'lessons';

/** The chapter stages, in the words a row shows. A stage not listed is shown by its own name. */
const CHAPTER_STAGE_WORDS: Record<string, string> = {
  units: 'splitting the transcript into sentences',
  outline: 'outlining the topics',
  assign: 'sorting sentences',
  plugs: 'checking for ads',
  refine: 'refining the outline',
  junctions: 'finding where the stories change',
  place: 'placing the stories',
  consolidate: 'joining story pieces',
  summarize: 'naming the chapters',
  chapters: 'reading the whole transcript',
  detail: 'describing each chapter',
  done: 'done',
};

/** Stages whose done/total counts mean something to a person (outline's are chunk counts). */
const COUNTED_STAGES = new Set(['assign', 'plugs', 'junctions', 'place', 'consolidate', 'summarize', 'detail']);

/** "1:05", "12:00", "1:02:03". A negative or non-finite span reads 0:00. */
export function elapsedClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const trimDots = (text: string): string => text.replace(/(\.\.\.|…)\s*$/, '').trim();

/** " (video 2 of 3)" when a job has more than one video, else nothing. */
function videoOf(index: string, count: string): string {
  return Number(count) > 1 ? ` (video ${index} of ${count})` : '';
}

/** Is this the event that says the saved transcript was used instead of transcribing? */
export function isSavedTranscriptEvent(event: GenerationProgressEvent): boolean {
  const message = event.message ?? '';
  return (event.phase === 'preparing' && /^Reading saved transcript\b/.test(message))
    || (event.phase === 'transcription' && /^Reused saved transcript\b/.test(message));
}

function transcriptionLine(message: string): string {
  let m: RegExpMatchArray | null;
  if (/^Reused saved transcript\b/.test(message)) return 'Using the saved transcript';
  if (/^Extracting audio\b/.test(message)) return 'Taking the audio out of the video';
  if ((m = message.match(/^Uploading the audio to Crucible on (\S+?)\.\.\. (.+)$/))) return `Sending the audio to ${m[1]}: ${m[2]}`;
  if ((m = message.match(/^Queued on Crucible on (\S+) \(position (\d+)\)/))) return `In line for transcription on ${m[1]} (number ${m[2]})`;
  if ((m = message.match(/^Reading the audio on (\S+?)\.\.\. (.+)$/))) return `Reading the audio: ${m[2]}`;
  if ((m = message.match(/^Transcribing on (\S+?)\.\.\. (.+)$/))) return `Transcribing: ${m[2]}`;
  if ((m = message.match(/^Timing the words on (\S+?)\.\.\. (.+)$/))) return `Timing the words: ${m[2]}`;
  if ((m = message.match(/^Crucible on (\S+): loading\b/))) return `Loading the transcription model on ${m[1]}`;
  if ((m = message.match(/^Crucible on (\S+): \S+ ready\b/))) return `Transcription model ready on ${m[1]}`;
  if ((m = message.match(/^Crucible on (\S+): /))) return `Getting transcription ready on ${m[1]}`;
  if (/^Transcription complete\b/.test(message)) return 'Transcription done';
  return trimDots(message);
}

function generatingLine(message: string): string {
  let m: RegExpMatchArray | null;
  if ((m = message.match(/^Finding chapters (\d+)\/(\d+)/))) return `Finding chapters${videoOf(m[1], m[2])}`;
  // "Chapters (assign 128/469) 1/1..." and the stall notice "Chapters (outline) 1/1 — no progress for 60s, …".
  if ((m = message.match(/^Chapters \((\w+)(?: (\d+)\/(\d+))?\) (\d+)\/(\d+)(.*)$/))) {
    const [, stage, done, total, index, count, rest] = m;
    const words = CHAPTER_STAGE_WORDS[stage] ?? stage;
    const counts = done !== undefined && total !== undefined && COUNTED_STAGES.has(stage) ? ` ${done} of ${total}` : '';
    const stall = rest.match(/no progress for (\d+)s/);
    const still = stall ? ` · still on one step after ${elapsedClock(Number(stall[1]) * 1000)}` : '';
    return `Finding chapters${videoOf(index, count)} · ${words}${counts}${still}`;
  }
  if ((m = message.match(/^Analyzing content (\d+)\/(\d+)/))) return `Reading the content${videoOf(m[1], m[2])}`;
  if ((m = message.match(/^Generating metadata (\d+)\/(\d+)/))) return `Writing titles, description and tags${videoOf(m[1], m[2])}`;
  if ((m = message.match(/^Completed (\d+)\/(\d+)/))) return `Finishing up${videoOf(m[1], m[2])}`;
  if (/^Assembling prompt\b/.test(message)) return 'Putting the prompt together';
  return trimDots(message);
}

/**
 * The row's stage line for an event, in plain words. Null for the events that end a job
 * ('complete', 'error') and for 'parked', whose row says what it waits for itself (`parkedText`).
 */
export function stageLine(event: GenerationProgressEvent): string | null {
  const message = event.message ?? '';
  switch (event.phase) {
    case 'complete':
    case 'error':
    case 'parked':
      return null;
    case 'starting':
      return 'Starting';
    case 'preparing':
      if (/^Reading saved transcript\b/.test(message)) return 'Reading the saved transcript';
      if (/^Preparing\b/.test(message)) return 'Getting the video ready';
      return trimDots(message);
    case LESSONS_PHASE:
      return trimDots(message) || 'Preparing channel lessons';
    case 'transcription':
      return transcriptionLine(message);
    case 'generating':
      return generatingLine(message);
    default:
      return trimDots(message) || event.phase;
  }
}

/**
 * The item's status and bar after an event (the bar is 0-50 for transcription and 50-100 for
 * generation), or null when the event does not move the item.
 *
 * A reused saved transcript goes STRAIGHT to generating: there is no transcription to show,
 * and the next minute of work (the channel's lessons, then chapters) is generation.
 */
export function itemAfter(event: GenerationProgressEvent, current: ItemProgress | undefined): ItemProgress | null {
  if (isSavedTranscriptEvent(event)) return { status: 'generating', progress: 50 };
  switch (event.phase) {
    case 'preparing':
      return { status: 'transcribing', progress: 0 };
    case 'transcription': {
      if (event.percent === undefined) return null;
      if (event.percent >= 100) {
        // Already past transcription (a saved transcript): never step back to "Transcribed".
        return current?.status === 'generating' ? null : { status: 'transcribed', progress: 50 };
      }
      return { status: 'transcribing', progress: Math.floor(event.percent / 2) };
    }
    case 'generating': {
      if (event.percent === undefined) return null;
      if (event.percent >= 100) return { status: 'completed', progress: 100 };
      return { status: 'generating', progress: 50 + Math.floor(event.percent / 2) };
    }
    default:
      return null;
  }
}

/** A parked row's line: what it waits for, and why, in the holder's own words. */
export function parkedText(venue: string | null | undefined, line: string | null | undefined): string {
  const why = (line ?? '').trim();
  if (venue) return why ? `Waiting for ${venue} — ${why}` : `Waiting for ${venue}`;
  return why ? `Waiting — ${why}` : 'Waiting for a Crucible server';
}

/**
 * A lane chip's words for a card that is busy while no job of this queue is on it. Another
 * app's hold is named as the server names it. ContentStudio's own name there is work this
 * queue did not start here (a run from before a restart still finishing, or the metadata CLI),
 * and it is said that way rather than as "busy: contentstudio, asr 100% done".
 */
export function laneBusyText(busyLine: string | null): string {
  if (busyLine === null) return 'Busy';
  const own = busyLine.match(/^busy: contentstudio\b,?\s*(.*)$/i);
  if (own === null) return busyLine;
  const what = own[1].replace(/^asr\b/, 'transcription').trim();
  return `Busy with other ContentStudio work${what ? ` (${what})` : ''}`;
}

/**
 * A lane chip's state words plus, when the read behind them is old and nothing is re-reading it
 * (nothing queued, LEDGER #234), when it was read: "Idle (checked 3:14 PM)". A chip never looks
 * live when it is not.
 */
export function laneReadAge(text: string, readAt: number | null, polling: boolean, now: number): string {
  if (polling || readAt === null || now - readAt < 60_000) return text;
  const time = new Date(readAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${text} (checked ${time})`;
}

// ── waiting its turn (LEDGER #234) ────────────────────────────────────────────

/** Crucible job types in plain words. A type not listed is named as the server names it. */
const JOB_TYPE_WORDS: Record<string, string> = {
  rvc: 'a voice conversion (rvc)',
  tts: 'a speech render (tts)',
  asr: 'a transcription (asr)',
  align: 'a word timing pass (align)',
  denoise: 'a noise cleanup (denoise)',
  'load-model': 'a model load',
  'unload-model': 'a model unload',
};

/** Another client's hold on a card, as main's lane chip carries it (wire.ts `CardHolder`). */
export interface HolderFacts {
  kind: 'job' | 'lease' | 'claim' | 'card';
  client: string | null;
  what: string | null;
  model: string | null;
  id: string | null;
  progress: number | null;
  secondsLeft: number | null;
  leftUnknown: 'no-progress' | 'measuring' | null;
}

/** "crucible-cli/1.0.43" → "crucible-cli": the app, without its version. */
function clientName(client: string | null): string | null {
  const name = (client ?? '').trim().split('/')[0].trim();
  return name === '' ? null : name;
}

/** "about 12 min left", "less than a minute left", "about 1 h 5 min left". Null seconds say why. */
export function timeLeftText(secondsLeft: number | null, leftUnknown: HolderFacts['leftUnknown']): string {
  if (secondsLeft === null || !Number.isFinite(secondsLeft)) {
    return leftUnknown === 'measuring' ? 'time left not known yet' : 'time left unknown';
  }
  if (secondsLeft < 60) return 'less than a minute left';
  const minutes = Math.round(secondsLeft / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `about ${h} h left` : `about ${h} h ${m} min left`;
}

/**
 * The row at the bottom of the queue while a job waits for another app's work: who is on the
 * card, doing what, how far along, and about how long it has left (Owen, 2026-09-26: "itll show
 * the job that's currently running on crucible and how long it has until it's done").
 */
export function holderWaitLine(server: string, holder: HolderFacts): string {
  const who = clientName(holder.client);
  let doing: string;
  switch (holder.kind) {
    case 'job': {
      const what = holder.what === null ? 'a job' : (JOB_TYPE_WORDS[holder.what] ?? `a ${holder.what} job`);
      doing = `${who ?? 'Another app'} is running ${what}`;
      break;
    }
    case 'lease':
      doing = `${who ?? 'Another app'} has ${holder.model ?? 'the model'} reserved${holder.what ? ` for ${holder.what} work` : ''}`;
      break;
    case 'claim':
      doing = `${who ?? 'Another app'} is holding the card for a live session`;
      break;
    default:
      doing = 'the card is not taking work, and the server does not say who has it';
  }
  const pct = holder.progress === null ? '' : ` — ${Math.round(holder.progress * 100)}%`;
  return `Waiting for ${server}: ${doing}${pct} · ${timeLeftText(holder.secondsLeft, holder.leftUnknown)}`;
}

/**
 * The waiting-its-turn rows: one per server that a PARKED job of this queue waits on while
 * another client holds its card. None while nothing is parked, and none for a card our own work
 * holds (main leaves `holder` null there: that is the running row).
 */
export function waitingTurnRows(
  jobs: ReadonlyArray<{ status: string; venue?: string | null }>,
  lanes: ReadonlyArray<{ server: string; holder: HolderFacts | null }>,
): Array<{ server: string; line: string }> {
  const waitedOn = new Set(jobs.filter((job) => job.status === 'parked' && job.venue).map((job) => job.venue as string));
  return lanes
    .filter((lane) => lane.holder !== null && waitedOn.has(lane.server))
    .map((lane) => ({ server: lane.server, line: holderWaitLine(lane.server, lane.holder as HolderFacts) }));
}
