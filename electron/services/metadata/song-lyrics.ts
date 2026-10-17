/**
 * A SONG'S LYRICS, read from the video itself (LEDGER #308, Little Goose Productions).
 *
 * Owen's songs are made in his app Storyboard, which embeds the timed lyrics in the MP4 as a
 * mov_text subtitle track ("he confirmed this will always be there"). That track IS the transcript
 * of a song: exact words, exact times, nothing to transcribe. A channel whose file says
 * `transcript_source: embedded_subtitles` is read through here instead of the Transcription row,
 * and a video of that channel with no subtitle track FAILS by name. It is never sent to ASR
 * instead: a lyric heard by a speech model is a different, worse lyric, and the description and
 * the captions would both carry it.
 *
 * THE LABEL CUES. Storyboard sometimes leaves a section label in the track as a cue of its own
 * ("Verse", 0.16 s, at 0:29.86 of "The Hollow Tree Inn"). It is not a lyric: it is dropped from the
 * description, the captions and the transcript alike, and the item records what was dropped.
 *
 * THE STANZAS. The description prints the lyrics in stanzas, so the cues have to be grouped. Two
 * facts mark the end of a stanza, measured on "The Hollow Tree Inn" (45 cues, eleven quatrains):
 *   - the line ends a sentence (. ! ? or …, before any closing quote): every stanza's last line
 *     does, and no other line does, in that song and in both songs Owen supplied by hand;
 *   - the next line starts after a gap of STANZA_GAP_SECONDS or more: the gaps between stanzas
 *     there run 3.1 to 4.2 s where they are long, and the gaps inside one never pass 1.65 s.
 *   A dropped label marks one too: it sat at a section's start.
 * Timing alone could not do it: four of that song's stanza breaks have gaps of 0 to 1.6 s, the
 * same as the gaps inside a stanza (the singer goes straight on).
 */
import { execFile } from 'child_process';
import type { SRTSegment } from './transcription.service';

/** One timed lyric line. Seconds. */
export interface LyricCue {
  start: number;
  end: number;
  text: string;
}

/** What one video's embedded track gave, after the label cues were taken out. */
export interface SongLyrics {
  /** The lyric lines, in order. Never empty. */
  cues: LyricCue[];
  /** The label cues that were dropped, with their times, for the item's record. */
  dropped: LyricCue[];
  /** The lines grouped into stanzas (see the header). */
  stanzas: string[][];
}

/** A gap this long before a line starts a new stanza (see the header for the measurement). */
export const STANZA_GAP_SECONDS = 2.5;

/** The heading code puts above the lyrics in the description (the approved exemplar's). */
export const LYRICS_HEADING = '🎵 Lyrics';

/**
 * A cue that is only a section label: Verse, Chorus, Pre-Chorus, Post-Chorus, Bridge, Intro, Outro,
 * Refrain or Hook, in any case, optionally numbered ("Verse 2"), optionally in brackets
 * ("[Chorus]", "(Bridge)") and optionally ending in a colon.
 */
const SECTION_LABEL = /^[[(]?\s*(verse|chorus|pre[- ]?chorus|post[- ]?chorus|bridge|intro|outro|refrain|hook)(\s*\d+)?\s*:?\s*[\])]?$/i;

export function isSectionLabel(text: string): boolean {
  return SECTION_LABEL.test(text.trim());
}

function seconds(stamp: string, where: string): number {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(stamp.trim());
  if (!m) throw new Error(`${where}: "${stamp}" is not an SRT time`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

/**
 * The cues of an SRT document. A cue's several text lines are one lyric line, joined with a space
 * (the track holds one sung line per cue; a wrapped one is still that line). A block that is not a
 * cue is refused by name: nothing in a subtitle track is skipped quietly.
 */
export function parseSrt(text: string, what: string): LyricCue[] {
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b.length > 0);
  return blocks.map((block, i) => {
    const lines = block.split('\n');
    const timeLine = /-->/.test(lines[0]) ? 0 : 1;
    const m = /^(.+?)\s*-->\s*(.+?)(\s+.*)?$/.exec(lines[timeLine] ?? '');
    if (!m) throw new Error(`${what}: block ${i + 1} has no "start --> end" line: ${JSON.stringify(block.slice(0, 80))}`);
    const where = `${what}, cue ${i + 1}`;
    const cueText = lines.slice(timeLine + 1).map((l) => l.replace(/<[^>]+>/g, '').trim()).filter((l) => l.length > 0).join(' ');
    return { start: seconds(m[1], where), end: seconds(m[2], where), text: cueText };
  });
}

/** Does this lyric line end a sentence (. ! ? or …, before any closing quote or bracket)? */
export function endsSentence(line: string): boolean {
  return /[.!?…]["'”’)\]]*$/.test(line.trim());
}

/**
 * The lyrics of a parsed track: label cues out, empty cues refused, stanzas drawn. A track with no
 * lyric line left is refused by name.
 */
export function songLyricsOf(cues: LyricCue[], what: string): SongLyrics {
  const kept: LyricCue[] = [];
  const dropped: LyricCue[] = [];
  // Index into `kept` of each line a dropped label stood right before: a stanza starts there.
  const labelBefore = new Set<number>();
  cues.forEach((cue, i) => {
    if (cue.text.length === 0) throw new Error(`${what}: cue ${i + 1} (at ${cue.start.toFixed(2)} s) has no text`);
    if (isSectionLabel(cue.text)) {
      dropped.push(cue);
      labelBefore.add(kept.length);
      return;
    }
    kept.push(cue);
  });
  if (kept.length === 0) {
    throw new Error(`${what}: the subtitle track holds no lyric line (${cues.length} cue(s), all of them section labels or none at all)`);
  }
  const stanzas: string[][] = [[kept[0].text]];
  for (let i = 1; i < kept.length; i++) {
    const prev = kept[i - 1];
    const breaks = endsSentence(prev.text) || kept[i].start - prev.end >= STANZA_GAP_SECONDS || labelBefore.has(i);
    if (breaks) stanzas.push([kept[i].text]);
    else stanzas[stanzas.length - 1].push(kept[i].text);
  }
  return { cues: kept, dropped, stanzas };
}

/** The lyrics as plain text: one line per lyric line, a blank line between stanzas. */
export function lyricsText(lyrics: SongLyrics): string {
  return lyrics.stanzas.map((s) => s.join('\n')).join('\n\n');
}

/** The block code puts in the description under the summary: the heading, then the lyrics. */
export function lyricsBlock(lyrics: SongLyrics): string {
  return `${LYRICS_HEADING}\n\n${lyricsText(lyrics)}`;
}

function srtStamp(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

/** The kept cues as an SRT document, renumbered: the caption track YouTube is given. */
export function lyricsSrt(lyrics: SongLyrics): string {
  return lyrics.cues.map((c, i) => `${i + 1}\n${srtStamp(c.start)} --> ${srtStamp(c.end)}\n${c.text}\n`).join('\n');
}

/** The kept cues in the pipeline's segment shape, so the rest of the item is built as any video's is. */
export function lyricsSegments(lyrics: SongLyrics): SRTSegment[] {
  return lyrics.cues.map((c, i) => ({ index: i + 1, start: srtStamp(c.start), end: srtStamp(c.end), text: c.text }));
}

/**
 * The video's first subtitle track, as SRT text, through ffmpeg. A video with no subtitle track is
 * refused by name (the transcript of a song is its embedded lyrics, never ASR).
 */
export function extractSubtitleSrt(ffmpeg: string, videoPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      ['-hide_banner', '-nostdin', '-v', 'error', '-i', videoPath, '-map', '0:s:0', '-f', 'srt', 'pipe:1'],
      { maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const said = String(stderr || error.message).trim();
          if (/matches no streams/i.test(said)) {
            reject(new Error(
              `${videoPath} has no subtitle track. This channel reads its lyrics from the timed subtitle track ` +
                `Storyboard embeds in the video (transcript_source: embedded_subtitles), and it is never transcribed ` +
                `instead. Export the song from Storyboard with its lyrics track.`
            ));
            return;
          }
          reject(new Error(`ffmpeg could not read the subtitle track of ${videoPath}: ${said}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/** Read, parse and clean one video's embedded lyrics. */
export async function readEmbeddedLyrics(ffmpeg: string, videoPath: string): Promise<SongLyrics> {
  const srt = await extractSubtitleSrt(ffmpeg, videoPath);
  return songLyricsOf(parseSrt(srt, `the subtitle track of ${videoPath}`), `the subtitle track of ${videoPath}`);
}
