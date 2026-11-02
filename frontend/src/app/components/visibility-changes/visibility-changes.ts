import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ElectronService } from '../../services/electron';
import type { ChosenMetadata } from '../../features/publish/publish.types';
import type { SchedulerJob } from '../../features/scheduler/scheduler.types';
import { VISIBILITIES } from '../../features/scheduler/scheduler.types';
import {
  ChangeForm,
  buildCreateRequest,
  buildPatchRequest,
  changeView,
  formFromJob,
  formatLocal,
  sortChanges,
} from '../../features/scheduler/visibility-changes';

/**
 * Visibility changes for ONE video on YouTube (VISIBILITY-SCHEDULER-PLAN.md, "ContentStudio").
 *
 * Lives in the reports page's Video row, under the linked video. Lists that video's changes
 * from the scheduler — pending first by time, then history — with add, edit and cancel for
 * pending ones. Server warnings from a create or an edit (e.g. YouTube's own schedule will be
 * cancelled) are shown before the form closes. Reads the list when it opens; no polling.
 *
 * For an 'unlisted-then-public' item it also says, in red, when the item's change to public
 * does not exist (its create failed after the upload, or never ran), with "Create the change";
 * and editing or cancelling the item's own change brings the record along (main's
 * publish-follow-release-change), emitted as `recordChanged`.
 */
@Component({
  selector: 'app-visibility-changes',
  imports: [FormsModule, MatIconModule],
  templateUrl: './visibility-changes.html',
  styleUrl: './visibility-changes.scss',
})
export class VisibilityChanges {
  private readonly electron = inject(ElectronService);

  readonly videoId = input.required<string>();
  /** The publish item linked to this video, when there is one; its record follows its change. */
  readonly itemId = input<string | null>(null);
  readonly record = input<ChosenMetadata | null>(null);
  readonly recordChanged = output<ChosenMetadata>();

  readonly visibilities = VISIBILITIES;
  readonly jobs = signal<SchedulerJob[] | null>(null);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly busy = signal(false);
  readonly actionError = signal<string | null>(null);
  /** Warnings from the last create/edit; the form stays until they are acknowledged. */
  readonly warnings = signal<string[]>([]);

  /** 'add', a change id being edited, or null for no form. */
  readonly formFor = signal<string | null>(null);
  readonly form = signal<ChangeForm>({ target: 'public', date: '', time: '', note: '' });
  readonly confirmCancel = signal<string | null>(null);

  readonly views = computed(() => {
    const jobs = this.jobs();
    return jobs ? sortChanges(jobs).map((job) => ({ job, view: changeView(job) })) : [];
  });

  /**
   * The red line for an 'unlisted-then-public' item whose change to public does not exist for
   * this video. null when the item is not in that mode, or its change exists.
   */
  readonly releaseProblem = computed<string | null>(() => {
    const r = this.record();
    if (!r || r.releaseMode !== 'unlisted-then-public' || r.videoId !== this.videoId()) return null;
    const link = r.releaseChange;
    if (link && link.jobId && link.videoId === r.videoId) return null;
    const when = r.publishAt ? formatLocal(r.publishAt) : 'its date';
    if (link && link.error) {
      return `Its change to public at ${when} could not be created on the scheduler: ${link.error} The video stays unlisted until a change exists.`;
    }
    return `This item is set to go unlisted now and public at ${when}, but no change to public exists for this video yet.`;
  });

  constructor() {
    // Read when the panel opens and whenever it is pointed at another video. Nothing else.
    effect(() => {
      const id = this.videoId();
      untracked(() => void this.load(id));
    });
  }

  async load(videoId: string = this.videoId()): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const res = await this.electron.schedulerListJobs({ videoId });
      if (videoId !== this.videoId()) return;
      if (!res.success || !res.data) {
        this.jobs.set(null);
        this.loadError.set(res.error ?? 'The scheduler gave no list and no reason.');
        return;
      }
      this.jobs.set(res.data);
    } finally {
      this.loading.set(false);
    }
  }

  setForm(patch: Partial<ChangeForm>): void {
    this.form.set({ ...this.form(), ...patch });
  }

  openAdd(): void {
    this.warnings.set([]);
    this.actionError.set(null);
    this.form.set({ target: 'public', date: '', time: '', note: '' });
    this.formFor.set('add');
  }

  openEdit(job: SchedulerJob): void {
    this.warnings.set([]);
    this.actionError.set(null);
    this.form.set(formFromJob(job));
    this.formFor.set(job.id);
  }

  closeForm(): void {
    this.formFor.set(null);
    this.warnings.set([]);
    this.actionError.set(null);
  }

  async saveForm(): Promise<void> {
    const target = this.formFor();
    if (target === null) return;
    this.actionError.set(null);
    this.busy.set(true);
    try {
      if (target === 'add') {
        let input;
        try {
          input = buildCreateRequest(this.videoId(), this.form());
        } catch (err) {
          this.actionError.set(err instanceof Error ? err.message : String(err));
          return;
        }
        const res = await this.electron.schedulerCreateJob(input);
        if (!res.success || !res.data) {
          this.actionError.set(res.error ?? 'The change was not created, and no reason was given.');
          return;
        }
        this.finishSave(res.data.warnings);
      } else {
        const job = (this.jobs() ?? []).find((j) => j.id === target);
        if (!job) {
          this.actionError.set('That change is no longer in the list. Reload and try again.');
          return;
        }
        let patch;
        try {
          patch = buildPatchRequest(job, this.form());
        } catch (err) {
          this.actionError.set(err instanceof Error ? err.message : String(err));
          return;
        }
        const res = await this.electron.schedulerPatchJob(job.id, patch);
        if (!res.success || !res.data) {
          this.actionError.set(res.error ?? 'The change was not edited, and no reason was given.');
          return;
        }
        await this.follow(res.data.job);
        this.finishSave(res.data.warnings);
      }
      await this.load();
    } finally {
      this.busy.set(false);
    }
  }

  /** With warnings the form stays open showing them, until "Done"; without, it closes. */
  private finishSave(warnings: string[]): void {
    if (warnings.length > 0) {
      this.warnings.set(warnings);
      this.formFor.set('saved');
    } else {
      this.closeForm();
    }
  }

  async cancelChange(job: SchedulerJob): Promise<void> {
    this.actionError.set(null);
    this.busy.set(true);
    try {
      const res = await this.electron.schedulerCancelJob(job.id);
      this.confirmCancel.set(null);
      if (!res.success || !res.data) {
        this.actionError.set(res.error ?? 'The change was not cancelled, and no reason was given.');
        return;
      }
      await this.follow(res.data);
      await this.load();
    } finally {
      this.busy.set(false);
    }
  }

  /** "Create the change" for an 'unlisted-then-public' item whose change does not exist. */
  async createReleaseChange(): Promise<void> {
    const itemId = this.itemId();
    if (!itemId) return;
    this.actionError.set(null);
    this.busy.set(true);
    try {
      const res = await this.electron.publishCreateReleaseChange(itemId);
      if (!res.success || !res.data) {
        this.actionError.set(res.error ?? 'The change was not created, and no reason was given.');
        // The record carries the refusal now; read it back so the red line says the new reason.
        const again = await this.electron.publishGetSelection(itemId);
        if (again.success && again.data) this.recordChanged.emit(again.data);
        return;
      }
      this.recordChanged.emit(res.data.selection);
      if (res.data.warnings.length > 0) {
        this.warnings.set(res.data.warnings);
        this.formFor.set('saved');
      }
      await this.load();
    } finally {
      this.busy.set(false);
    }
  }

  /** The item that links to this change follows it (main decides whether it does). */
  private async follow(job: SchedulerJob): Promise<void> {
    const itemId = this.itemId();
    const r = this.record();
    if (!itemId || !r || r.releaseChange?.jobId !== job.id) return;
    const res = await this.electron.publishFollowReleaseChange(itemId, job);
    if (!res.success || !res.data) {
      this.actionError.set(
        `The change was saved on the scheduler, but this item could not be brought along: ${res.error ?? 'no reason was given.'}`,
      );
      return;
    }
    this.recordChanged.emit(res.data);
  }
}
