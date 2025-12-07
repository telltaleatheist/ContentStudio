/**
 * Chapter Generator Service
 * Handles chunking transcripts and generating chapter markers
 */

import { SRTSegment } from './whisper.service';

export interface TranscriptChunk {
  id: number;
  time: string;
  text: string;
  startSeconds: number;
}

export interface TranscriptSegment {
  id: number;
  time: string;
  topic: string;
  chunkIds: number[];
  startSeconds: number;
}

export interface Chapter {
  timestamp: string;
  title: string;
  sequence: number;
}

export class TranscriptChunker {
  private targetDuration: number;

  constructor(targetDuration: number = 30) {
    this.targetDuration = targetDuration;
  }

  /**
   * Create transcript chunks from SRT segments
   */
  chunkFromSrtSegments(srtSegments: SRTSegment[]): TranscriptChunk[] {
    if (!srtSegments || srtSegments.length === 0) {
      return [];
    }

    const chunks: TranscriptChunk[] = [];
    let currentChunkText: string[] = [];
    let currentChunkStart: string | null = null;
    let currentChunkStartSeconds = 0;
    let chunkId = 1;

    for (const segment of srtSegments) {
      const startSeconds = this.srtTimeToSeconds(segment.start);

      // Initialize first chunk
      if (currentChunkStart === null) {
        currentChunkStart = this.secondsToYoutubeTime(startSeconds);
        currentChunkStartSeconds = startSeconds;
      }

      // Add text to current chunk
      currentChunkText.push(segment.text.trim());

      // Check if we should start a new chunk
      const elapsed = startSeconds - currentChunkStartSeconds;

      if (elapsed >= this.targetDuration) {
        const fullText = currentChunkText.join(' ');
        const sentences = this.splitSentences(fullText);

        if (sentences.length > 1) {
          // Keep most sentences in current chunk, carry over the last one
          const chunkText = sentences.slice(0, -1).join(' ');
          const carryover = sentences[sentences.length - 1];

          chunks.push({
            id: chunkId,
            time: currentChunkStart,
            text: chunkText,
            startSeconds: currentChunkStartSeconds,
          });

          chunkId++;
          currentChunkText = [carryover];
          currentChunkStart = this.secondsToYoutubeTime(startSeconds);
          currentChunkStartSeconds = startSeconds;
        } else {
          // No sentence boundary found, just split here
          chunks.push({
            id: chunkId,
            time: currentChunkStart,
            text: fullText,
            startSeconds: currentChunkStartSeconds,
          });

          chunkId++;
          currentChunkText = [];
          currentChunkStart = this.secondsToYoutubeTime(startSeconds);
          currentChunkStartSeconds = startSeconds;
        }
      }
    }

    // Add final chunk if there's remaining text
    if (currentChunkText.length > 0 && currentChunkStart !== null) {
      chunks.push({
        id: chunkId,
        time: currentChunkStart,
        text: currentChunkText.join(' '),
        startSeconds: currentChunkStartSeconds,
      });
    }

    return chunks;
  }

  /**
   * Split text into sentences
   */
  private splitSentences(text: string): string[] {
    // Split on sentence endings (., !, ?) followed by whitespace and capital letter
    const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
    return sentences.map(s => s.trim()).filter(s => s.length > 0);
  }

  /**
   * Convert SRT time format to seconds
   */
  private srtTimeToSeconds(srtTime: string): number {
    // SRT format: hh:mm:ss,ms
    const [timePart, msPart] = srtTime.split(',');
    const [hours, minutes, seconds] = timePart.split(':').map(Number);
    const milliseconds = Number(msPart);

    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000.0;
  }

  /**
   * Convert seconds to YouTube chapter format
   */
  private secondsToYoutubeTime(seconds: number): string {
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
   * Format chunks for AI consumption
   */
  formatForAI(chunks: TranscriptChunk[]): string {
    const lines = chunks.map(chunk => `${chunk.id}. [${chunk.time}] ${chunk.text}`);
    return lines.join('\n');
  }

  /**
   * Group chunks into hierarchical segments
   */
  createSegments(chunks: TranscriptChunk[], chunksPerSegment: number = 4): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];

    for (let i = 0; i < chunks.length; i += chunksPerSegment) {
      const segmentChunks = chunks.slice(i, i + chunksPerSegment);
      const combinedText = segmentChunks.map(c => c.text).join(' ');

      segments.push({
        id: segments.length + 1,
        time: segmentChunks[0].time,
        topic: '', // Will be filled by AI
        chunkIds: segmentChunks.map(c => c.id),
        startSeconds: segmentChunks[0].startSeconds,
      });
    }

    return segments;
  }

  /**
   * Format segments for AI consumption
   */
  formatSegmentsForAI(segments: TranscriptSegment[]): string {
    const lines = segments.map(segment => `${segment.id}. [${segment.time}] ${segment.topic}`);
    return lines.join('\n');
  }
}

export class ChapterMapper {
  private items: Array<TranscriptChunk | TranscriptSegment>;
  private itemMap: Map<number, TranscriptChunk | TranscriptSegment>;

  constructor(items: Array<TranscriptChunk | TranscriptSegment>) {
    this.items = items;
    this.itemMap = new Map(items.map(item => [item.id, item]));
  }

  /**
   * Map AI-identified chapters to timestamps
   */
  mapChapters(aiChapters: Array<{ chunk_id?: number; segment_id?: number; title: string }>): Chapter[] {
    const mappedChapters: Chapter[] = [];

    for (let i = 0; i < aiChapters.length; i++) {
      const chapter = aiChapters[i];
      const itemId = chapter.chunk_id || chapter.segment_id;
      const title = chapter.title?.trim();

      if (!itemId || !title) {
        continue;
      }

      const item = this.itemMap.get(itemId);
      if (!item) {
        continue;
      }

      mappedChapters.push({
        timestamp: item.time,
        title,
        sequence: i,
      });
    }

    // Sort by timestamp
    mappedChapters.sort((a, b) => this.youtubeTimeToSeconds(a.timestamp) - this.youtubeTimeToSeconds(b.timestamp));

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
    if (chapters[0].timestamp !== '0:00') {
      chapters.unshift({
        timestamp: '0:00',
        title: 'Introduction',
        sequence: 0,
      });

      // Update sequence numbers
      chapters.forEach((chapter, i) => {
        chapter.sequence = i;
      });
    }

    // Filter out chapters that are too short (< 10 seconds)
    const validChapters: Chapter[] = [];

    for (let i = 0; i < chapters.length; i++) {
      const currentSeconds = this.youtubeTimeToSeconds(chapters[i].timestamp);

      // Check if chapter is long enough
      if (i < chapters.length - 1) {
        const nextSeconds = this.youtubeTimeToSeconds(chapters[i + 1].timestamp);
        const duration = nextSeconds - currentSeconds;

        if (duration < 10) {
          // Chapter too short, skip it
          continue;
        }
      }

      validChapters.push(chapters[i]);
    }

    // YouTube requires at least 3 chapters
    if (validChapters.length < 3) {
      return [];
    }

    return validChapters;
  }

  /**
   * Convert YouTube time format to seconds
   */
  private youtubeTimeToSeconds(timeStr: string): number {
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
