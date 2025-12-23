/**
 * Chapter Generator Service
 * Handles chapter generation using phrase-based timestamp mapping
 */

import { SRTSegment } from './whisper.service';

export interface Chapter {
  timestamp: string;
  title: string;
  sequence: number;
  endTimestamp?: string;
}

export interface AIChapter {
  start_phrase: string;
  title: string;
}

/**
 * Utility class for SRT time conversions
 */
export class TimeUtils {
  /**
   * Convert SRT time format (hh:mm:ss,ms) to seconds
   */
  static srtTimeToSeconds(srtTime: string): number {
    const [timePart, msPart] = srtTime.split(',');
    const [hours, minutes, seconds] = timePart.split(':').map(Number);
    const milliseconds = Number(msPart) || 0;
    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000.0;
  }

  /**
   * Convert seconds to YouTube chapter format (M:SS or H:MM:SS)
   */
  static secondsToYoutubeTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
  }

  /**
   * Convert YouTube time format to seconds
   */
  static youtubeTimeToSeconds(timeStr: string): number {
    const parts = timeStr.split(':').map(Number);

    if (parts.length === 3) {
      const [hours, minutes, seconds] = parts;
      return hours * 3600 + minutes * 60 + seconds;
    } else if (parts.length === 2) {
      const [minutes, seconds] = parts;
      return minutes * 60 + seconds;
    } else {
      return parts[0];
    }
  }
}

/**
 * Build timestamped transcript for AI consumption
 * Adds minute markers for context
 */
export function buildTimestampedTranscript(srtSegments: SRTSegment[]): string {
  const lines: string[] = [];
  let currentMinute = -1;

  for (const segment of srtSegments) {
    const seconds = TimeUtils.srtTimeToSeconds(segment.start);
    const minute = Math.floor(seconds / 60);

    // Add minute marker when entering a new minute
    if (minute > currentMinute) {
      currentMinute = minute;
      const timeStr = TimeUtils.secondsToYoutubeTime(seconds);
      lines.push(`\n[${timeStr}]`);
    }

    lines.push(segment.text.trim());
  }

  return lines.join(' ').trim();
}

/**
 * Find the timestamp for a phrase in the transcript
 * Uses 3-tier matching: exact → normalized → fuzzy
 */
export function findPhraseTimestamp(
  phrase: string,
  srtSegments: SRTSegment[],
  threshold: number = 0.5
): number | null {
  if (!phrase || !srtSegments || srtSegments.length === 0) {
    return null;
  }

  const searchPhrase = phrase.toLowerCase().trim();
  if (searchPhrase.length === 0) {
    return null;
  }

  // Build full transcript with character position to timestamp mapping
  let fullText = '';
  const charToTimestamp: { pos: number; timestamp: number }[] = [];

  for (const segment of srtSegments) {
    const segmentText = (segment.text || '').trim();
    if (segmentText.length > 0) {
      const timestampSeconds = TimeUtils.srtTimeToSeconds(segment.start);
      charToTimestamp.push({ pos: fullText.length, timestamp: timestampSeconds });
      fullText += segmentText + ' ';
    }
  }

  const fullTextLower = fullText.toLowerCase();

  // Try exact substring match first
  let matchPos = fullTextLower.indexOf(searchPhrase);

  // If no exact match, try matching with normalized whitespace
  if (matchPos === -1) {
    const normalizedSearch = searchPhrase.replace(/\s+/g, ' ');
    const normalizedText = fullTextLower.replace(/\s+/g, ' ');
    matchPos = normalizedText.indexOf(normalizedSearch);
  }

  // If still no match, try word-based fuzzy matching
  if (matchPos === -1) {
    const phraseWords = searchPhrase.split(/\s+/).filter(w => w.length > 2);

    if (phraseWords.length > 0) {
      let bestPos = -1;
      let bestWordCount = 0;

      // Slide a window across the transcript looking for best match
      for (let i = 0; i < fullTextLower.length - 20; i += 10) {
        const window = fullTextLower.substring(i, i + searchPhrase.length + 50);
        let wordCount = 0;
        for (const word of phraseWords) {
          if (window.includes(word)) wordCount++;
        }
        if (wordCount > bestWordCount) {
          bestWordCount = wordCount;
          bestPos = i;
        }
      }

      // Accept if we found enough matching words
      if (bestWordCount >= phraseWords.length * threshold) {
        matchPos = bestPos;
      }
    }
  }

  if (matchPos === -1) {
    return null;
  }

  // Find the timestamp for this character position
  let timestamp = charToTimestamp[0]?.timestamp ?? 0;
  for (const entry of charToTimestamp) {
    if (entry.pos <= matchPos) {
      timestamp = entry.timestamp;
    } else {
      break;
    }
  }

  return timestamp;
}

/**
 * Maps AI-identified chapters to timestamps using phrase matching
 */
export class ChapterMapper {
  private srtSegments: SRTSegment[];
  private videoDuration: number;

  constructor(srtSegments: SRTSegment[]) {
    this.srtSegments = srtSegments;

    // Calculate video duration from last segment
    if (srtSegments.length > 0) {
      const lastSegment = srtSegments[srtSegments.length - 1];
      this.videoDuration = TimeUtils.srtTimeToSeconds(lastSegment.end);
    } else {
      this.videoDuration = 0;
    }
  }

  /**
   * Map AI-identified chapters to timestamps
   */
  mapChapters(aiChapters: AIChapter[]): Chapter[] {
    const mappedChapters: Chapter[] = [];

    for (let i = 0; i < aiChapters.length; i++) {
      const chapter = aiChapters[i];
      const startPhrase = chapter.start_phrase || '';
      const title = chapter.title?.trim();

      if (!title) {
        continue;
      }

      // Find timestamp for start phrase
      const startSeconds = findPhraseTimestamp(startPhrase, this.srtSegments);

      if (startSeconds !== null) {
        // Calculate end time (next chapter's start or video end)
        let endSeconds = this.videoDuration;

        if (i < aiChapters.length - 1) {
          const nextPhrase = aiChapters[i + 1].start_phrase || '';
          const nextStart = findPhraseTimestamp(nextPhrase, this.srtSegments);
          if (nextStart !== null) {
            endSeconds = nextStart;
          }
        }

        mappedChapters.push({
          timestamp: TimeUtils.secondsToYoutubeTime(startSeconds),
          title,
          sequence: i,
          endTimestamp: TimeUtils.secondsToYoutubeTime(endSeconds),
        });
      }
    }

    // Sort by timestamp
    mappedChapters.sort(
      (a, b) => TimeUtils.youtubeTimeToSeconds(a.timestamp) - TimeUtils.youtubeTimeToSeconds(b.timestamp)
    );

    // Update sequence numbers after sorting
    mappedChapters.forEach((chapter, i) => {
      chapter.sequence = i;
    });

    // Validate YouTube chapter requirements
    return this.validateYoutubeChapters(mappedChapters);
  }

  /**
   * Validate YouTube chapter requirements
   */
  private validateYoutubeChapters(chapters: Chapter[]): Chapter[] {
    if (chapters.length === 0) {
      return [];
    }

    // Ensure first chapter starts at 0:00
    const firstTimestamp = TimeUtils.youtubeTimeToSeconds(chapters[0].timestamp);
    if (firstTimestamp > 0) {
      // Insert a chapter at 0:00 using the first chapter's title
      // (better than generic "Introduction")
      chapters.unshift({
        timestamp: '0:00',
        title: chapters[0].title,
        sequence: 0,
        endTimestamp: chapters[0].timestamp,
      });

      // The original first chapter now becomes the second
      // Update its title to reflect it's a continuation
      chapters[1].sequence = 1;

      // Update all sequence numbers
      chapters.forEach((chapter, i) => {
        chapter.sequence = i;
      });
    }

    // Filter out chapters that are too short (< 10 seconds)
    const validChapters: Chapter[] = [];

    for (let i = 0; i < chapters.length; i++) {
      const currentSeconds = TimeUtils.youtubeTimeToSeconds(chapters[i].timestamp);

      // Check if chapter is long enough
      if (i < chapters.length - 1) {
        const nextSeconds = TimeUtils.youtubeTimeToSeconds(chapters[i + 1].timestamp);
        const duration = nextSeconds - currentSeconds;

        if (duration < 10) {
          // Chapter too short, skip it
          continue;
        }
      }

      validChapters.push(chapters[i]);
    }

    // Update sequence numbers
    validChapters.forEach((chapter, i) => {
      chapter.sequence = i;
    });

    // YouTube requires at least 3 chapters
    if (validChapters.length < 3) {
      return [];
    }

    return validChapters;
  }
}
