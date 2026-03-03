import { Injectable, signal, effect } from '@angular/core';

export interface AudioFileItem {
  path: string;
  displayName: string;
}

export interface EpisodeJob {
  id: string;
  name: string;
  audioPaths: string[];
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  message: string;
  error?: string;
  report?: any;
}

const STORAGE_KEY = 'contentstudio-episode-splitter';

@Injectable({
  providedIn: 'root'
})
export class EpisodeSplitterStateService {
  // Audio files list (order matters - sequential parts of one stream)
  audioFiles = signal<AudioFileItem[]>([]);

  // Job queue
  jobs = signal<EpisodeJob[]>([]);
  isProcessing = signal(false);

  constructor() {
    this.loadFromStorage();

    effect(() => {
      const state = {
        audioFiles: this.audioFiles(),
        jobs: this.jobs(),
        isProcessing: this.isProcessing()
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    });
  }

  private loadFromStorage() {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const state = JSON.parse(stored);
        if (state.audioFiles) this.audioFiles.set(state.audioFiles);
        if (state.jobs) this.jobs.set(state.jobs);
        if (state.isProcessing !== undefined) this.isProcessing.set(state.isProcessing);
      }
    } catch (error) {
      console.error('Failed to load episode splitter state from storage:', error);
    }
  }

  // Audio file management
  addFiles(files: AudioFileItem[]) {
    this.audioFiles.update(items => {
      const newItems = files.filter(f => !items.some(existing => existing.path === f.path));
      return [...items, ...newItems];
    });
  }

  removeFile(index: number) {
    this.audioFiles.update(items => items.filter((_, i) => i !== index));
  }

  clearFiles() {
    this.audioFiles.set([]);
  }

  reorderFiles(previousIndex: number, currentIndex: number) {
    this.audioFiles.update(items => {
      const updated = [...items];
      const [movedItem] = updated.splice(previousIndex, 1);
      updated.splice(currentIndex, 0, movedItem);
      return updated;
    });
  }

  // Job management
  addJob(job: EpisodeJob) {
    this.jobs.update(jobs => [...jobs, job]);
  }

  updateJob(jobId: string, updates: Partial<EpisodeJob>) {
    this.jobs.update(jobs => jobs.map(job =>
      job.id === jobId ? { ...job, ...updates } : job
    ));
  }

  removeJob(jobId: string) {
    this.jobs.update(jobs => jobs.filter(j => j.id !== jobId));
  }

  clearCompletedJobs() {
    this.jobs.update(jobs => jobs.filter(j => j.status !== 'completed' && j.status !== 'failed'));
  }

  getPendingJobsCount(): number {
    return this.jobs().filter(j => j.status === 'pending').length;
  }

  getCompletedJobsCount(): number {
    return this.jobs().filter(j => j.status === 'completed' || j.status === 'failed').length;
  }
}
