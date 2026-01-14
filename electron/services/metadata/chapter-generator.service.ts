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
 * Build plain text transcript without timestamps
 * Saves tokens - timestamps are recovered via phrase matching
 */
export function buildPlainTranscript(srtSegments: SRTSegment[]): string {
  const lines: string[] = [];

  for (const segment of srtSegments) {
    const text = segment.text.trim();
    if (text.length > 0) {
      lines.push(text);
    }
  }

  return lines.join(' ').trim();
}

/**
 * Build transcript with sparse timestamps (every N minutes)
 * Balances token savings with temporal context for AI
 */
export function buildSparseTimestampTranscript(
  srtSegments: SRTSegment[],
  intervalMinutes: number = 15
): string {
  const lines: string[] = [];
  let lastMarkerMinute = -intervalMinutes; // Ensure first marker at 0

  for (const segment of srtSegments) {
    const seconds = TimeUtils.srtTimeToSeconds(segment.start);
    const minute = Math.floor(seconds / 60);

    // Add marker every N minutes
    if (minute >= lastMarkerMinute + intervalMinutes) {
      lastMarkerMinute = Math.floor(minute / intervalMinutes) * intervalMinutes;
      const timeStr = TimeUtils.secondsToYoutubeTime(lastMarkerMinute * 60);
      lines.push(`\n[${timeStr}]`);
    }

    const text = segment.text.trim();
    if (text.length > 0) {
      lines.push(text);
    }
  }

  return lines.join(' ').trim();
}

/**
 * Build full transcript with timestamp for every segment
 * Format: [0:00] text [0:05] text [0:10] text...
 */
export function buildFullTimestampTranscript(srtSegments: SRTSegment[]): string {
  const lines: string[] = [];

  for (const segment of srtSegments) {
    const seconds = TimeUtils.srtTimeToSeconds(segment.start);
    const timeStr = TimeUtils.secondsToYoutubeTime(seconds);
    const text = segment.text.trim();

    if (text.length > 0) {
      lines.push(`[${timeStr}] ${text}`);
    }
  }

  return lines.join('\n');
}

/**
 * Normalize text for comparison: lowercase, remove punctuation, normalize whitespace
 */
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')  // Remove punctuation
    .replace(/\s+/g, ' ')      // Normalize whitespace
    .trim();
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;

  // Create DP matrix
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  // Initialize base cases
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Fill the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],     // deletion
          dp[i][j - 1],     // insertion
          dp[i - 1][j - 1]  // substitution
        );
      }
    }
  }

  return dp[m][n];
}

/**
 * Calculate string similarity (0-1 scale)
 */
function stringSimilarity(str1: string, str2: string): number {
  if (str1.length === 0 && str2.length === 0) return 1;
  if (str1.length === 0 || str2.length === 0) return 0;

  const distance = levenshteinDistance(str1, str2);
  const maxLength = Math.max(str1.length, str2.length);
  return 1 - (distance / maxLength);
}

// Common words to filter out when doing distinctive word matching
const COMMON_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'i', 'me', 'my', 'so', 'if', 'then', 'than', 'as', 'just', 'also',
  'like', 'well', 'now', 'here', 'there', 'when', 'where', 'what', 'who',
  'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'not', 'only', 'own', 'same', 'very', 'just',
  'about', 'into', 'over', 'after', 'before', 'between', 'under', 'again',
  'going', 'know', 'think', 'right', 'really', 'actually', 'gonna', 'yeah'
]);

/**
 * Find the timestamp for a phrase in the transcript
 * Uses 5-strategy matching (like ClipChimp):
 * 1. Direct substring match
 * 2. Shorter prefix match
 * 3. Fuzzy matching with Levenshtein
 * 4. Distinctive word matching
 * 5. Cross-segment matching
 */
export function findPhraseTimestamp(
  phrase: string,
  srtSegments: SRTSegment[],
  threshold: number = 0.5,
  minTimestamp: number = 0
): number | null {
  if (!phrase || !srtSegments || srtSegments.length === 0) {
    return null;
  }

  const normalizedPhrase = normalizeForComparison(phrase);
  if (normalizedPhrase.length === 0) {
    return null;
  }

  // Build segment index for matching
  interface SegmentEntry {
    text: string;
    normalizedText: string;
    timestamp: number;
  }
  const segments: SegmentEntry[] = [];

  for (const segment of srtSegments) {
    const timestampSeconds = TimeUtils.srtTimeToSeconds(segment.start);
    if (timestampSeconds < minTimestamp) continue;

    const text = (segment.text || '').trim();
    if (text.length > 0) {
      segments.push({
        text,
        normalizedText: normalizeForComparison(text),
        timestamp: timestampSeconds
      });
    }
  }

  if (segments.length === 0) return null;

  // Use first ~50 chars for matching
  const searchPhrase = normalizedPhrase.substring(0, 50);

  // STRATEGY 1: Direct substring match
  for (const seg of segments) {
    if (seg.normalizedText.includes(searchPhrase)) {
      return seg.timestamp;
    }
  }

  // STRATEGY 2: Shorter prefix match (first 25 chars)
  if (searchPhrase.length > 25) {
    const shortPhrase = normalizedPhrase.substring(0, 25);
    for (const seg of segments) {
      if (seg.normalizedText.includes(shortPhrase)) {
        return seg.timestamp;
      }
    }
  }

  // STRATEGY 3: Fuzzy matching with Levenshtein (65% threshold)
  const FUZZY_THRESHOLD = 0.65;
  let bestFuzzyMatch: { segment: SegmentEntry; score: number } | null = null;

  for (const seg of segments) {
    // Compare against a window of similar length
    const compareText = seg.normalizedText.substring(0, searchPhrase.length + 10);
    const similarity = stringSimilarity(searchPhrase, compareText);

    if (similarity > FUZZY_THRESHOLD) {
      if (!bestFuzzyMatch || similarity > bestFuzzyMatch.score) {
        bestFuzzyMatch = { segment: seg, score: similarity };
      }
    }
  }

  if (bestFuzzyMatch) {
    return bestFuzzyMatch.segment.timestamp;
  }

  // STRATEGY 4: Distinctive word matching
  const phraseWords = normalizedPhrase
    .split(/\s+/)
    .filter(w => w.length > 2 && !COMMON_WORDS.has(w));

  if (phraseWords.length > 0) {
    let bestMatch: { segment: SegmentEntry; score: number } | null = null;

    for (const seg of segments) {
      const segWords = seg.normalizedText.split(/\s+/);
      let matchCount = 0;

      for (const phraseWord of phraseWords) {
        // Exact match
        if (segWords.includes(phraseWord)) {
          matchCount++;
          continue;
        }
        // Fuzzy word match (75% similarity)
        for (const segWord of segWords) {
          if (stringSimilarity(phraseWord, segWord) > 0.75) {
            matchCount += 0.75;
            break;
          }
        }
      }

      const score = matchCount / phraseWords.length;
      if (score > 0.4 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { segment: seg, score };
      }
    }

    if (bestMatch) {
      return bestMatch.segment.timestamp;
    }
  }

  // STRATEGY 5: Cross-segment matching (for quotes spanning segments)
  for (let i = 0; i < segments.length - 1; i++) {
    const combinedText = segments[i].normalizedText + ' ' + segments[i + 1].normalizedText;

    // Try exact match on combined
    if (combinedText.includes(searchPhrase)) {
      return segments[i].timestamp;
    }

    // Try fuzzy match on combined
    const compareText = combinedText.substring(0, searchPhrase.length + 20);
    if (stringSimilarity(searchPhrase, compareText) > FUZZY_THRESHOLD) {
      return segments[i].timestamp;
    }
  }

  return null;
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
