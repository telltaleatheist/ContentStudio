import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';

export interface VideoRecord {
  id?: number;
  file_path: string;
  file_hash: string;
  file_size: number;
  duration?: number;
  transcript_text?: string;
  created_at: string;
  updated_at: string;
}

export interface SRTSegment {
  id?: number;
  video_id: number;
  sequence: number;
  start_time: string;
  end_time: string;
  text: string;
}

export interface TranscriptChunk {
  id: number;
  time: string;
  text: string;
}

export interface Chapter {
  id?: number;
  video_id: number;
  timestamp: string;
  title: string;
  sequence: number;
  created_at: string;
}

export interface MetadataRecord {
  id?: number;
  video_id?: number;
  job_id: string;
  platform: string;
  prompt_set: string;
  titles: string; // JSON array
  thumbnail_text: string; // JSON array
  description: string;
  tags: string;
  hashtags: string;
  chapters?: string; // JSON array
  created_at: string;
}

export class DatabaseService {
  private db: Database.Database;
  private dbPath: string;

  constructor() {
    // Store database in user data directory
    const userDataPath = app.getPath('userData');
    const dbDir = path.join(userDataPath, '.contentstudio');

    // Ensure directory exists
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.dbPath = path.join(dbDir, 'contentstudio.db');
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');

    this.initializeTables();
  }

  private initializeTables(): void {
    // Create videos table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL UNIQUE,
        file_hash TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        duration INTEGER,
        transcript_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Create SRT segments table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS srt_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        text TEXT NOT NULL,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_srt_video_id ON srt_segments(video_id);
      CREATE INDEX IF NOT EXISTS idx_srt_sequence ON srt_segments(video_id, sequence);
    `);

    // Create chapters table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chapters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        title TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chapters_video_id ON chapters(video_id);
      CREATE INDEX IF NOT EXISTS idx_chapters_sequence ON chapters(video_id, sequence);
    `);

    // Create metadata table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id INTEGER,
        job_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        prompt_set TEXT NOT NULL,
        titles TEXT,
        thumbnail_text TEXT,
        description TEXT,
        tags TEXT,
        hashtags TEXT,
        chapters TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_metadata_job_id ON metadata(job_id);
      CREATE INDEX IF NOT EXISTS idx_metadata_video_id ON metadata(video_id);
    `);

    // Create FTS5 virtual tables for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
        file_path,
        transcript_text,
        content='videos',
        content_rowid='id'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chapters_fts USING fts5(
        title,
        content='chapters',
        content_rowid='id'
      );
    `);

    // Create triggers to keep FTS tables in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS videos_ai AFTER INSERT ON videos BEGIN
        INSERT INTO videos_fts(rowid, file_path, transcript_text)
        VALUES (new.id, new.file_path, new.transcript_text);
      END;

      CREATE TRIGGER IF NOT EXISTS videos_ad AFTER DELETE ON videos BEGIN
        DELETE FROM videos_fts WHERE rowid = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS videos_au AFTER UPDATE ON videos BEGIN
        UPDATE videos_fts SET file_path = new.file_path, transcript_text = new.transcript_text
        WHERE rowid = new.id;
      END;

      CREATE TRIGGER IF NOT EXISTS chapters_ai AFTER INSERT ON chapters BEGIN
        INSERT INTO chapters_fts(rowid, title)
        VALUES (new.id, new.title);
      END;

      CREATE TRIGGER IF NOT EXISTS chapters_ad AFTER DELETE ON chapters BEGIN
        DELETE FROM chapters_fts WHERE rowid = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS chapters_au AFTER UPDATE ON chapters BEGIN
        UPDATE chapters_fts SET title = new.title WHERE rowid = new.id;
      END;
    `);
  }

  // ==================== VIDEO OPERATIONS ====================

  saveVideo(video: VideoRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO videos (file_path, file_hash, file_size, duration, transcript_text, created_at, updated_at)
      VALUES (@file_path, @file_hash, @file_size, @duration, @transcript_text, @created_at, @updated_at)
      ON CONFLICT(file_path) DO UPDATE SET
        file_hash = @file_hash,
        file_size = @file_size,
        duration = @duration,
        transcript_text = @transcript_text,
        updated_at = @updated_at
      RETURNING id
    `);

    const result = stmt.get(video) as { id: number };
    return result.id;
  }

  getVideoByPath(filePath: string): VideoRecord | undefined {
    const stmt = this.db.prepare('SELECT * FROM videos WHERE file_path = ?');
    return stmt.get(filePath) as VideoRecord | undefined;
  }

  getVideoById(id: number): VideoRecord | undefined {
    const stmt = this.db.prepare('SELECT * FROM videos WHERE id = ?');
    return stmt.get(id) as VideoRecord | undefined;
  }

  deleteVideo(id: number): void {
    const stmt = this.db.prepare('DELETE FROM videos WHERE id = ?');
    stmt.run(id);
  }

  // ==================== SRT SEGMENT OPERATIONS ====================

  saveSRTSegments(videoId: number, segments: Omit<SRTSegment, 'id' | 'video_id'>[]): void {
    const deleteStmt = this.db.prepare('DELETE FROM srt_segments WHERE video_id = ?');
    const insertStmt = this.db.prepare(`
      INSERT INTO srt_segments (video_id, sequence, start_time, end_time, text)
      VALUES (@video_id, @sequence, @start_time, @end_time, @text)
    `);

    const transaction = this.db.transaction(() => {
      deleteStmt.run(videoId);
      for (const segment of segments) {
        insertStmt.run({
          video_id: videoId,
          ...segment
        });
      }
    });

    transaction();
  }

  getSRTSegments(videoId: number): SRTSegment[] {
    const stmt = this.db.prepare(
      'SELECT * FROM srt_segments WHERE video_id = ? ORDER BY sequence ASC'
    );
    return stmt.all(videoId) as SRTSegment[];
  }

  // ==================== CHAPTER OPERATIONS ====================

  saveChapters(videoId: number, chapters: Omit<Chapter, 'id' | 'video_id' | 'created_at'>[]): void {
    const deleteStmt = this.db.prepare('DELETE FROM chapters WHERE video_id = ?');
    const insertStmt = this.db.prepare(`
      INSERT INTO chapters (video_id, timestamp, title, sequence, created_at)
      VALUES (@video_id, @timestamp, @title, @sequence, @created_at)
    `);

    const transaction = this.db.transaction(() => {
      deleteStmt.run(videoId);
      const createdAt = new Date().toISOString();
      for (const chapter of chapters) {
        insertStmt.run({
          video_id: videoId,
          created_at: createdAt,
          ...chapter
        });
      }
    });

    transaction();
  }

  getChapters(videoId: number): Chapter[] {
    const stmt = this.db.prepare(
      'SELECT * FROM chapters WHERE video_id = ? ORDER BY sequence ASC'
    );
    return stmt.all(videoId) as Chapter[];
  }

  // ==================== METADATA OPERATIONS ====================

  saveMetadata(metadata: MetadataRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO metadata (video_id, job_id, platform, prompt_set, titles, thumbnail_text, description, tags, hashtags, chapters, created_at)
      VALUES (@video_id, @job_id, @platform, @prompt_set, @titles, @thumbnail_text, @description, @tags, @hashtags, @chapters, @created_at)
      RETURNING id
    `);

    const result = stmt.get(metadata) as { id: number };
    return result.id;
  }

  getMetadataByJobId(jobId: string): MetadataRecord[] {
    const stmt = this.db.prepare('SELECT * FROM metadata WHERE job_id = ?');
    return stmt.all(jobId) as MetadataRecord[];
  }

  getMetadataByVideoId(videoId: number): MetadataRecord[] {
    const stmt = this.db.prepare('SELECT * FROM metadata WHERE video_id = ? ORDER BY created_at DESC');
    return stmt.all(videoId) as MetadataRecord[];
  }

  deleteMetadata(id: number): void {
    const stmt = this.db.prepare('DELETE FROM metadata WHERE id = ?');
    stmt.run(id);
  }

  // ==================== SEARCH OPERATIONS ====================

  searchVideos(query: string): VideoRecord[] {
    const stmt = this.db.prepare(`
      SELECT v.* FROM videos v
      JOIN videos_fts fts ON v.id = fts.rowid
      WHERE videos_fts MATCH ?
      ORDER BY rank
    `);
    return stmt.all(query) as VideoRecord[];
  }

  searchChapters(query: string): (Chapter & { video_path: string })[] {
    const stmt = this.db.prepare(`
      SELECT c.*, v.file_path as video_path FROM chapters c
      JOIN chapters_fts fts ON c.id = fts.rowid
      JOIN videos v ON c.video_id = v.id
      WHERE chapters_fts MATCH ?
      ORDER BY rank
    `);
    return stmt.all(query) as (Chapter & { video_path: string })[];
  }

  // ==================== EXPORT OPERATIONS ====================

  exportTranscriptToTxt(videoId: number): string | null {
    const video = this.getVideoById(videoId);
    if (!video || !video.transcript_text) {
      return null;
    }

    const segments = this.getSRTSegments(videoId);
    const chapters = this.getChapters(videoId);

    let output = '';
    output += '='.repeat(80) + '\n';
    output += `TRANSCRIPT: ${path.basename(video.file_path)}\n`;
    output += `Generated: ${new Date().toISOString()}\n`;
    output += '='.repeat(80) + '\n\n';

    if (chapters.length > 0) {
      output += 'CHAPTERS:\n';
      output += '-'.repeat(80) + '\n';
      for (const chapter of chapters) {
        output += `${chapter.timestamp} - ${chapter.title}\n`;
      }
      output += '\n';
    }

    output += 'TRANSCRIPT:\n';
    output += '-'.repeat(80) + '\n';
    output += video.transcript_text + '\n\n';

    if (segments.length > 0) {
      output += 'TIMESTAMPED SEGMENTS:\n';
      output += '-'.repeat(80) + '\n';
      for (const segment of segments) {
        output += `[${segment.start_time} --> ${segment.end_time}]\n`;
        output += `${segment.text}\n\n`;
      }
    }

    output += '='.repeat(80) + '\n';
    return output;
  }

  // ==================== UTILITY OPERATIONS ====================

  getAllVideos(): VideoRecord[] {
    const stmt = this.db.prepare('SELECT * FROM videos ORDER BY created_at DESC');
    return stmt.all() as VideoRecord[];
  }

  getDatabaseStats(): {
    videos: number;
    transcripts: number;
    chapters: number;
    metadata: number;
    dbSize: number;
  } {
    const videos = this.db.prepare('SELECT COUNT(*) as count FROM videos').get() as { count: number };
    const transcripts = this.db.prepare('SELECT COUNT(*) as count FROM videos WHERE transcript_text IS NOT NULL').get() as { count: number };
    const chapters = this.db.prepare('SELECT COUNT(*) as count FROM chapters').get() as { count: number };
    const metadata = this.db.prepare('SELECT COUNT(*) as count FROM metadata').get() as { count: number };

    let dbSize = 0;
    try {
      const stats = fs.statSync(this.dbPath);
      dbSize = stats.size;
    } catch (e) {
      // Ignore errors
    }

    return {
      videos: videos.count,
      transcripts: transcripts.count,
      chapters: chapters.count,
      metadata: metadata.count,
      dbSize
    };
  }

  clearAllData(): void {
    const transaction = this.db.transaction(() => {
      this.db.exec('DELETE FROM metadata');
      this.db.exec('DELETE FROM chapters');
      this.db.exec('DELETE FROM srt_segments');
      this.db.exec('DELETE FROM videos');
    });
    transaction();
  }

  close(): void {
    this.db.close();
  }
}

// Singleton instance
let dbInstance: DatabaseService | null = null;

export function getDatabaseService(): DatabaseService {
  if (!dbInstance) {
    dbInstance = new DatabaseService();
  }
  return dbInstance;
}
