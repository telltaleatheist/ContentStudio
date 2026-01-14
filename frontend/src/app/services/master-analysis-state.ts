import { Injectable, signal, effect } from '@angular/core';

export interface VideoItem {
  path: string;
  displayName: string;
  selected: boolean;
}

export interface MasterJob {
  id: string;
  name: string;
  videoPath: string;
  promptSet: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  message: string;
  error?: string;
}

const STORAGE_KEY = 'contentstudio-master-analysis';

@Injectable({
  providedIn: 'root'
})
export class MasterAnalysisStateService {
  // Video items list
  videoItems = signal<VideoItem[]>([]);

  // Selected prompt set
  selectedPromptSet = signal<string>('master-unfiltered');

  // Job queue
  jobs = signal<MasterJob[]>([]);
  isProcessing = signal(false);

  constructor() {
    // Load persisted state from sessionStorage
    this.loadFromStorage();

    // Auto-save when state changes
    effect(() => {
      const state = {
        videoItems: this.videoItems(),
        selectedPromptSet: this.selectedPromptSet(),
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
        if (state.videoItems) this.videoItems.set(state.videoItems);
        if (state.selectedPromptSet) this.selectedPromptSet.set(state.selectedPromptSet);
        if (state.jobs) this.jobs.set(state.jobs);
        if (state.isProcessing !== undefined) this.isProcessing.set(state.isProcessing);
      }
    } catch (error) {
      console.error('Failed to load master analysis state from storage:', error);
    }
  }

  // Video management
  addVideo(video: VideoItem) {
    const exists = this.videoItems().some(v => v.path === video.path);
    if (!exists) {
      this.videoItems.update(items => [...items, video]);
    }
  }

  removeVideo(index: number) {
    this.videoItems.update(items => items.filter((_, i) => i !== index));
  }

  clearVideos() {
    this.videoItems.set([]);
  }

  toggleVideoSelection(index: number) {
    this.videoItems.update(items => {
      const updated = [...items];
      updated[index] = { ...updated[index], selected: !updated[index].selected };
      return updated;
    });
  }

  toggleSelectAll(selectAll: boolean) {
    this.videoItems.update(items => items.map(item => ({ ...item, selected: selectAll })));
  }

  // Job management
  addJob(job: MasterJob) {
    this.jobs.update(jobs => [...jobs, job]);
  }

  updateJob(jobId: string, updates: Partial<MasterJob>) {
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

  getNextPendingJob(): MasterJob | undefined {
    return this.jobs().find(j => j.status === 'pending');
  }

  getPendingJobsCount(): number {
    return this.jobs().filter(j => j.status === 'pending').length;
  }

  getCompletedJobsCount(): number {
    return this.jobs().filter(j => j.status === 'completed' || j.status === 'failed').length;
  }
}
