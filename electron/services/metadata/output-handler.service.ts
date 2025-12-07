/**
 * Output Handler Service
 * Saves metadata to files in user-friendly formats
 */

import * as fs from 'fs';
import * as path from 'path';
import { MetadataResult } from './ai-manager.service';
import { Chapter } from './chapter-generator.service';

export interface JobMetadata {
  job_id: string;
  job_name: string;
  prompt_set: string;
  created_at: string;
  txt_folder: string;
  items: MetadataResult[];
  status: string;
  source_items?: any[];
}

export interface SaveJobResult {
  json_file: string;
  txt_folder: string;
  txt_files: string[];
  job_id: string;
}

export class OutputHandlerService {
  private userOutputDir: string;
  private metadataDir: string;

  constructor(outputDir: string) {
    this.userOutputDir = outputDir;
    this.metadataDir = path.join(outputDir, '.contentstudio', 'metadata');

    // Create directories
    if (!fs.existsSync(this.userOutputDir)) {
      fs.mkdirSync(this.userOutputDir, { recursive: true });
    }
    if (!fs.existsSync(this.metadataDir)) {
      fs.mkdirSync(this.metadataDir, { recursive: true });
    }

    console.log('[OutputHandler] Initialized');
    console.log('[OutputHandler] User output dir:', this.userOutputDir);
    console.log('[OutputHandler] Metadata dir:', this.metadataDir);
  }

  /**
   * Initialize a new job (creates job metadata with empty items)
   */
  initializeJob(
    jobName: string,
    promptSet: string,
    jobId?: string
  ): { jobId: string; txtFolder: string; jsonPath: string } {
    // Generate job ID if not provided
    if (!jobId) {
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(7);
      jobId = `job-${timestamp}-${randomStr}`;
    }

    // Clean job name for folder
    const cleanFolderName = this.cleanNameWithSpaces(jobName);

    // Create TXT output folder
    const txtFolder = path.join(this.userOutputDir, cleanFolderName);
    if (!fs.existsSync(txtFolder)) {
      fs.mkdirSync(txtFolder, { recursive: true });
    }

    // Prepare initial job metadata
    const jobMetadata: JobMetadata = {
      job_id: jobId,
      job_name: jobName,
      prompt_set: promptSet,
      created_at: new Date().toISOString(),
      txt_folder: txtFolder,
      items: [],
      status: 'processing',
    };

    // Save JSON metadata file
    const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
    this.saveJson(jobMetadata, jsonPath);
    console.log(`[OutputHandler] Job initialized: ${jobId}`);

    return { jobId, txtFolder, jsonPath };
  }

  /**
   * Add a single item to an existing job
   */
  addItemToJob(
    jobId: string,
    metadataItem: MetadataResult
  ): { txtPath: string } | null {
    try {
      // Load existing job
      const job = this.getJobMetadata(jobId);
      if (!job) {
        console.error(`[OutputHandler] Job not found: ${jobId}`);
        return null;
      }

      // Add item to job
      job.items.push(metadataItem);

      // Save updated job metadata
      const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
      this.saveJson(job, jsonPath);

      // Save TXT file for this item
      const cleanName = (metadataItem as any)._title || `item_${job.items.length}`;
      const txtPath = path.join(job.txt_folder, `${cleanName}.txt`);
      this.saveReadable(metadataItem, txtPath, job.prompt_set);

      console.log(`[OutputHandler] Added item to job ${jobId}: ${cleanName}`);

      return { txtPath };
    } catch (error) {
      console.error(`[OutputHandler] Failed to add item to job:`, error);
      return null;
    }
  }

  /**
   * Update job status
   */
  updateJobStatus(jobId: string, status: string): boolean {
    try {
      const job = this.getJobMetadata(jobId);
      if (!job) {
        return false;
      }

      job.status = status;

      const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
      this.saveJson(job, jsonPath);

      console.log(`[OutputHandler] Updated job ${jobId} status to: ${status}`);
      return true;
    } catch (error) {
      console.error(`[OutputHandler] Failed to update job status:`, error);
      return false;
    }
  }

  /**
   * Save metadata for a batch job
   */
  saveJobMetadata(
    jobName: string,
    metadataItems: MetadataResult[],
    promptSet: string,
    jobId?: string,
    sourceItems?: any[]
  ): SaveJobResult {
    if (!metadataItems || metadataItems.length === 0) {
      throw new Error('Metadata items cannot be empty');
    }

    // Generate job ID if not provided
    if (!jobId) {
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(7);
      jobId = `job-${timestamp}-${randomStr}`;
    }

    // Clean job name for folder
    const cleanFolderName = this.cleanNameWithSpaces(jobName);

    // Create TXT output folder
    const txtFolder = path.join(this.userOutputDir, cleanFolderName);
    if (!fs.existsSync(txtFolder)) {
      fs.mkdirSync(txtFolder, { recursive: true });
    }

    // Prepare job metadata
    const jobMetadata: JobMetadata = {
      job_id: jobId,
      job_name: jobName,
      prompt_set: promptSet,
      created_at: new Date().toISOString(),
      txt_folder: txtFolder,
      items: metadataItems,
      status: 'completed',
    };

    if (sourceItems) {
      jobMetadata.source_items = sourceItems;
    }

    // Save JSON metadata file
    const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
    this.saveJson(jobMetadata, jsonPath);
    console.log(`[OutputHandler] Job metadata saved to: ${jsonPath}`);

    // Save TXT files
    const txtFiles: string[] = [];

    for (const item of metadataItems) {
      const cleanName = (item as any)._title || 'metadata';
      const txtPath = path.join(txtFolder, `${cleanName}.txt`);

      this.saveReadable(item, txtPath, promptSet);
      txtFiles.push(txtPath);
    }

    console.log(`[OutputHandler] TXT files saved to: ${txtFolder}`);

    return {
      json_file: jsonPath,
      txt_folder: txtFolder,
      txt_files: txtFiles,
      job_id: jobId,
    };
  }

  /**
   * Save metadata to JSON file
   */
  private saveJson(metadata: any, outputPath: string): void {
    try {
      fs.writeFileSync(outputPath, JSON.stringify(metadata, null, 2), 'utf-8');
      console.log(`[OutputHandler] JSON saved: ${outputPath}`);
    } catch (error) {
      throw new Error(`Failed to save JSON: ${error}`);
    }
  }

  /**
   * Save metadata as human-readable text file
   */
  private saveReadable(metadata: MetadataResult, outputPath: string, promptSet: string): void {
    try {
      const lines: string[] = [];

      // Header
      lines.push('='.repeat(80));
      lines.push(`METADATA - ${promptSet}`);
      lines.push(`Generated: ${new Date().toLocaleString()}`);
      lines.push('='.repeat(80));
      lines.push('');

      // Titles section
      if (metadata.titles && metadata.titles.length > 0) {
        lines.push('TITLES');
        lines.push('-'.repeat(80));
        metadata.titles.forEach((title, i) => {
          lines.push(`${i + 1}. ${title}`);
        });
        lines.push('');
      }

      // Description section
      if (metadata.description) {
        lines.push('DESCRIPTION');
        lines.push('-'.repeat(80));
        lines.push(metadata.description);
        lines.push('');
      }

      // Tags section (after description)
      if (metadata.tags) {
        lines.push('TAGS');
        lines.push('-'.repeat(80));
        lines.push(metadata.tags);
        lines.push('');
      }

      // Thumbnail text section
      if (metadata.thumbnail_text && metadata.thumbnail_text.length > 0) {
        lines.push('THUMBNAIL TEXT OPTIONS');
        lines.push('-'.repeat(80));
        metadata.thumbnail_text.forEach((text, i) => {
          lines.push(`${i + 1}. ${text}`);
        });
        lines.push('');
      }

      // Chapters section
      if (metadata.chapters && metadata.chapters.length > 0) {
        lines.push('CHAPTERS');
        lines.push('-'.repeat(80));
        metadata.chapters.forEach((chapter) => {
          lines.push(`${chapter.timestamp} - ${chapter.title}`);
        });
        lines.push('');
      }

      // Hashtags section
      if (metadata.hashtags) {
        lines.push('HASHTAGS');
        lines.push('-'.repeat(80));
        lines.push(metadata.hashtags);
        lines.push('');
      }

      // Write to file
      fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');
      console.log(`[OutputHandler] TXT saved: ${outputPath}`);
    } catch (error) {
      throw new Error(`Failed to save readable text: ${error}`);
    }
  }

  /**
   * Clean name for filesystem (keep spaces, remove invalid chars and file extensions)
   */
  private cleanNameWithSpaces(name: string): string {
    // Remove file extension if present (video/audio files)
    const nameWithoutExt = name.replace(/\.(mp4|mov|avi|mkv|webm|m4v|mp3|wav|m4a|txt)$/i, '');

    // Remove invalid filesystem characters but keep spaces
    return nameWithoutExt.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim();
  }

  /**
   * Get job metadata from file
   */
  getJobMetadata(jobId: string): JobMetadata | null {
    try {
      const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
      if (!fs.existsSync(jsonPath)) {
        return null;
      }

      const content = fs.readFileSync(jsonPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error(`[OutputHandler] Failed to read job metadata:`, error);
      return null;
    }
  }

  /**
   * List all jobs
   */
  listJobs(): JobMetadata[] {
    try {
      const files = fs.readdirSync(this.metadataDir);
      const jobs: JobMetadata[] = [];

      for (const file of files) {
        if (file.startsWith('job-') && file.endsWith('.json')) {
          const jobId = file.replace('.json', '');
          const job = this.getJobMetadata(jobId);
          if (job) {
            jobs.push(job);
          }
        }
      }

      // Sort by creation date (newest first)
      jobs.sort((a, b) => {
        const dateA = new Date(a.created_at).getTime();
        const dateB = new Date(b.created_at).getTime();
        return dateB - dateA;
      });

      return jobs;
    } catch (error) {
      console.error(`[OutputHandler] Failed to list jobs:`, error);
      return [];
    }
  }

  /**
   * Delete job metadata and files
   */
  deleteJob(jobId: string): boolean {
    try {
      const job = this.getJobMetadata(jobId);
      if (!job) {
        return false;
      }

      // Delete JSON file
      const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
      if (fs.existsSync(jsonPath)) {
        fs.unlinkSync(jsonPath);
      }

      // Delete TXT folder if it exists
      if (job.txt_folder && fs.existsSync(job.txt_folder)) {
        fs.rmSync(job.txt_folder, { recursive: true, force: true });
      }

      console.log(`[OutputHandler] Deleted job: ${jobId}`);
      return true;
    } catch (error) {
      console.error(`[OutputHandler] Failed to delete job:`, error);
      return false;
    }
  }
}
