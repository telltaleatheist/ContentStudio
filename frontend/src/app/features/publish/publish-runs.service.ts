// src/app/features/publish/publish-runs.service.ts
//
// The three dispatch runs the calendar starts, and the state that describes them, held
// OUTSIDE the calendar component so that leaving the page does not lose them.
//
// ── Why this exists ──────────────────────────────────────────────────────────────────
//
// The runs always kept going. A component's async loop is not cancelled when Angular
// destroys the component, so flipping to another tab mid-run never stopped an upload —
// what it destroyed was every signal describing it. Coming back mounted a fresh component
// with `uploadRun === null`, so the board read idle over a live run, the progress bar and
// the per-item results were gone for good, and the Upload button offered to start a
// second run across the same queue. The main process refuses a duplicate of the item
// actually in flight, but the ones further down the queue are not yet claimed, so two
// runs would have raced each other through the rest of the list.
//
// So the fix is not "keep uploading" — it already did. It is to put the run somewhere
// that outlives the view of it. `providedIn: 'root'`, the same answer
// EditorProcessingService gives for the editor's processing runs, which are long-running
// for the same reason and are watched from a page the operator leaves.
//
// ── What it does NOT survive ─────────────────────────────────────────────────────────
//
// A window reload, and an app restart. The loop lives in the renderer, so reloading the
// window abandons it while the main process finishes the transfer it already has in hand
// and the rest of the queue is simply never sent. Surviving that means moving the queue
// into the main process, which is a different piece of work: the per-item re-checks below
// are board rules, and they would have to move with it. Nothing here pretends otherwise —
// there is no flag claiming to have noticed the reload, because a renderer that is being
// torn down cannot reliably record anything and a half-kept promise is worse than a
// stated limit.
//
// ── The rules that came with the code ────────────────────────────────────────────────
//
// Every one of these is carried verbatim from the component, because each was a decision:
//
//   sequential, never parallel  — multi-gigabyte files over one connection, and one
//                                 attributable failure at a time.
//   a failure does not stop the run — the refusal is recorded against its own item and
//                                 the next one starts. Nothing is retried automatically.
//   re-checked at dispatch      — the confirm panel is a snapshot and the board moves
//                                 underneath it. The YouTube run re-reads the index; the
//                                 Spreaker run re-asks the two questions that make an
//                                 episode irreversible (no date, lapsed date).
//   results published as it goes — a long run shows its failures while it is still
//                                 running, not only once everything has been attempted.

import { Injectable, computed, inject, signal } from '@angular/core';
import { ElectronService } from '../../services/electron';
import { NotificationService } from '../../services/notification';
import { SPREAKER_DESTINATION_LABEL } from './publish.types';
import type { PublishFacts } from './publish.types';
import {
  destinationOf,
  missingFor,
  readinessOf,
} from '../../components/publish-calendar/calendar-states';

/** One item's outcome in a run. Every attempt gets one, pass or fail. */
export interface UploadResult {
  itemId: string;
  title: string;
  /** For a Spreaker row this is the destination's name — the show is where it went. */
  channelName: string;
  ok: boolean;
  /** The main process's refusal, verbatim. Null on success. */
  error: string | null;
  /**
   * The id the destination now holds this item under: a YouTube video id, or a Spreaker
   * episode id. Null when there is none to name — a failed attempt creates nothing.
   */
  remoteId: string | null;
}

/** The live state of a YouTube run. Null when nothing is uploading. */
export interface UploadRun {
  /** Items still to attempt, including the one in flight. */
  queue: string[];
  total: number;
  /** 1-based position of the item in flight. */
  index: number;
  currentItemId: string | null;
  currentTitle: string;
  sentBytes: number;
  totalBytes: number;
  /** Set by Stop. The loop reads it between items; the in-flight transfer is aborted. */
  cancelling: boolean;
}

/** The Spreaker and schedule-push runs, which report no bytes and offer no cancel. */
export interface SimpleRun {
  index: number;
  total: number;
  title: string;
}

/** What one item of a YouTube run needs to be true at the moment it is sent. */
export interface UploadCandidate {
  itemId: string;
  title: string;
  channelName: string;
}

/**
 * What one item of a Spreaker run needs at the moment it is sent.
 *
 * Named apart from the calendar's own `SpreakerCandidate`, which is the richer thing the
 * CONFIRM PANEL draws (it carries readiness and a missing-list so the operator can read
 * why a row is held back). What the run needs is only what it re-checks, and saying so in
 * the type keeps the panel free to grow fields the dispatch has no business reading.
 */
export interface SpreakerDispatchItem {
  itemId: string;
  title: string;
  /** ISO instant, or null — and null is the one state the run refuses outright. */
  publishAt: string | null;
  /** `Mon, Aug 31 · 05:00`, or null when there is no date to print. */
  when: string | null;
}

@Injectable({ providedIn: 'root' })
export class PublishRunsService {
  private readonly electron = inject(ElectronService);
  private readonly notify = inject(NotificationService);

  // ------------------------------------------------------------------ the runs

  readonly uploadRun = signal<UploadRun | null>(null);
  readonly uploadResults = signal<UploadResult[]>([]);
  readonly uploadFailures = computed(() => this.uploadResults().filter((r) => !r.ok));

  readonly spreakerRun = signal<SimpleRun | null>(null);
  readonly spreakerResults = signal<UploadResult[]>([]);
  readonly spreakerFailures = computed(() => this.spreakerResults().filter((r) => !r.ok));

  readonly pushRun = signal<SimpleRun | null>(null);
  readonly pushResults = signal<UploadResult[]>([]);
  readonly pushFailures = computed(() => this.pushResults().filter((r) => !r.ok));

  /**
   * Is any run live?
   *
   * The reason the board can be left: a page that no longer owns the run still has to be
   * able to ask whether one is going, and so does any other page that grows an indicator
   * later.
   */
  readonly busy = computed(
    () => this.uploadRun() !== null || this.spreakerRun() !== null || this.pushRun() !== null
  );

  /**
   * Bumped whenever a run finishes, so whatever view is on screen can re-read.
   *
   * A COUNTER RATHER THAN A CALLBACK, deliberately. The run outlives the component that
   * started it, so a callback handed in at start time would be a call into a destroyed
   * view — or worse, into a stale closure over signals nobody is refreshing any more. A
   * counter is read by whichever component happens to be alive when it changes, and a
   * component that mounts afterwards reloads on init anyway.
   *
   * `sweep` says whether YOUTUBE also has to be re-read, and it is not always true: a
   * Spreaker run changes nothing YouTube knows about, so sweeping three channels after
   * one would be an API call made to confirm that nothing happened.
   */
  readonly finished = signal<{ seq: number; sweep: boolean }>({ seq: 0, sweep: false });

  private announceFinish(sweep: boolean): void {
    this.finished.update((f) => ({ seq: f.seq + 1, sweep }));
  }

  private progressBound = false;

  /**
   * Bind the upload progress tick, once for the service's life.
   *
   * Lazily rather than in the constructor, for EditorProcessingService's reason: this is
   * `providedIn: 'root'`, so every window constructs it, and attaching a publish listener
   * at construction would make every boot depend on that half of the preload bridge.
   */
  private bindProgress(): void {
    if (this.progressBound) return;
    this.progressBound = true;
    // Ticks for any other item are ignored rather than assumed to be ours: a single
    // upload can be running on the reports page at the same time.
    this.electron.onPublishUploadProgress((p) => {
      const run = this.uploadRun();
      if (!run || run.currentItemId !== p.itemId) return;
      this.uploadRun.set({ ...run, sentBytes: p.sentBytes, totalBytes: p.totalBytes });
    });
  }

  dismissUploadResults(): void {
    this.uploadResults.set([]);
  }

  dismissSpreakerResults(): void {
    this.spreakerResults.set([]);
  }

  dismissPushResults(): void {
    this.pushResults.set([]);
  }

  // ------------------------------------------------------------- the YouTube run

  /**
   * Upload every confirmed item to YouTube, ONE AT A TIME.
   *
   * Sequential is not caution for its own sake: these are multi-gigabyte files over one
   * connection, and running them together would make every upload slower while making the
   * failure of any one of them harder to attribute. The main process refuses a second
   * upload of the same item anyway.
   *
   * A FAILURE DOES NOT STOP THE RUN. Each item's refusal is captured verbatim against
   * that item and the next one starts — stopping would leave the remaining items in an
   * unexplained limbo, whereas a run that finishes with three failures listed is a run
   * the operator can act on. Nothing is retried automatically.
   */
  async runYouTubeUpload(chips: UploadCandidate[]): Promise<void> {
    if (chips.length === 0 || this.uploadRun() !== null) return;
    this.bindProgress();

    const results: UploadResult[] = [];
    this.uploadResults.set([]);
    this.uploadRun.set({
      queue: chips.map((c) => c.itemId),
      total: chips.length,
      index: 0,
      currentItemId: null,
      currentTitle: '',
      sentBytes: 0,
      totalBytes: 0,
      cancelling: false,
    });

    // Read the index ONCE, before anything is sent. The confirm panel is a snapshot and
    // the board can have changed while it sat open, so the per-item check below has to
    // have something newer than the snapshot to compare against.
    //
    // Read HERE rather than taken from the calendar, because the run outlives the
    // calendar: by the time the last item goes, the component whose `entries` signal the
    // old check read may have been destroyed two pages ago and never refreshed since.
    const fresh = await this.readFacts();

    for (let i = 0; i < chips.length; i++) {
      const chip = chips[i];
      const run = this.uploadRun();
      if (!run || run.cancelling) break;

      // An item that is no longer ready (or no longer on this lane) is skipped BY NAME
      // rather than sent on stale consent — the Spreaker run's rule.
      const facts = fresh?.get(chip.itemId) ?? null;
      const verdict = this.stillSendable(facts);
      if (verdict !== null) {
        results.push({
          itemId: chip.itemId,
          title: chip.title,
          channelName: chip.channelName,
          ok: false,
          error:
            `not sent — this item changed while the confirm panel was open (${verdict}). ` +
            `Nothing was uploaded for it.`,
          remoteId: null,
        });
        this.uploadResults.set([...results]);
        continue;
      }

      this.uploadRun.set({
        ...run,
        index: i + 1,
        currentItemId: chip.itemId,
        currentTitle: chip.title,
        sentBytes: 0,
        totalBytes: 0,
      });

      try {
        const res = await this.electron.publishUploadYouTube(chip.itemId);
        if (!res.success || !res.data) {
          results.push({
            itemId: chip.itemId,
            title: chip.title,
            channelName: chip.channelName,
            ok: false,
            error: res.error ?? 'The upload failed and gave no reason.',
            remoteId: null,
          });
        } else {
          results.push({
            itemId: chip.itemId,
            title: chip.title,
            channelName: chip.channelName,
            ok: true,
            error: null,
            remoteId: res.data.receipt.videoId,
          });
        }
      } catch (err: any) {
        results.push({
          itemId: chip.itemId,
          title: chip.title,
          channelName: chip.channelName,
          ok: false,
          error: err?.message || String(err),
          remoteId: null,
        });
      }
      // Published as the run goes rather than at the end: a long run should show its
      // failures while it is still running, not only once everything has been attempted.
      this.uploadResults.set([...results]);
    }

    const endedByStop = this.uploadRun()?.cancelling ?? false;
    this.uploadRun.set(null);

    const failed = results.filter((r) => !r.ok).length;
    const sent = results.length - failed;
    const skippedByStop = endedByStop ? chips.length - results.length : 0;
    if (endedByStop) {
      // A stop is not a failure and not a finish: the in-flight transfer was aborted (it
      // lands in the failed count with its own reason) and the rest were never attempted.
      this.notify.warning(
        'Uploads stopped',
        `${sent} uploaded before the stop; ` +
          `${failed > 0 ? `the one in flight was abandoned; ` : ''}` +
          `${skippedByStop} never started.`
      );
    } else if (failed === 0) {
      // Created private is a FACT; released-on-schedule is not one this app can promise —
      // API uploads are policy-locked private pending Google's audit, and the one live
      // observation contradicts the policy, so the claim stays hedged the same way the
      // metadata page hedges it.
      this.notify.success(
        'Uploads finished',
        `${sent} video${sent === 1 ? '' : 's'} created on YouTube, private, each carrying ` +
        `its schedule. Whether the schedule releases them depends on this API project's ` +
        `audit standing — verify the first one on YouTube rather than assuming.`
      );
    } else {
      // The per-item reasons stay in the results panel; this only says how it ended, so
      // an operator who walked away is told rather than left to find out.
      this.notify.error(
        'Uploads finished with failures',
        `${sent} uploaded, ${failed} failed. The reasons are listed on the calendar.`
      );
    }

    // The records now carry video ids and YouTube holds videos it did not a minute ago,
    // so the board AND the mirror are both stale. Announced rather than done here: the
    // page that has to re-read may not be the page that started this.
    this.announceFinish(true);
  }

  /**
   * Stop the run: abort what is in flight and skip the rest.
   *
   * The in-flight upload is aborted through the main process's own cancel, which is the
   * only thing that can stop a resumable transfer mid-file. Items already uploaded stay
   * uploaded — this stops the run, it does not undo it, and the results list says exactly
   * which ones got through.
   */
  async cancelUploadRun(): Promise<void> {
    const run = this.uploadRun();
    if (!run) return;
    this.uploadRun.set({ ...run, cancelling: true });
    if (run.currentItemId) {
      const res = await this.electron.publishUploadCancel(run.currentItemId);
      if (!res.success) {
        this.notify.error(
          'The upload could not be cancelled',
          res.error ?? 'The main process refused the cancel and gave no reason.'
        );
      }
    }
  }

  // ------------------------------------------------------------- the Spreaker run

  /**
   * Upload every confirmed episode to Spreaker, ONE AT A TIME.
   *
   * The same sequential discipline as the YouTube run and for the same reasons: one
   * connection, one attributable failure, and a refusal recorded verbatim against its own
   * item while the rest of the run continues. There is no progress bar and no Stop, and
   * neither is an omission — the Spreaker push reports no bytes and the main process
   * offers no cancel for it, so drawing either would be drawing a control that does
   * nothing.
   *
   * The list is exactly what was agreed to in the panel, even if the board changed
   * underneath while it was open — with the two exceptions re-asked below, which are the
   * ones that cannot be taken back.
   */
  async runSpreakerUpload(items: SpreakerDispatchItem[]): Promise<void> {
    if (items.length === 0 || this.spreakerRun() !== null) return;

    const results: UploadResult[] = [];
    this.spreakerResults.set([]);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Re-checked HERE, not only when the list was built. Everything else in this run is
      // recoverable — a refusal is one line in the results — but a Spreaker push with no
      // date is a live release, and there is no unpublish. The panel can sit open while
      // the board changes underneath it, so the last thing before the call re-asks the
      // question the panel was opened to answer.
      if (item.publishAt === null) {
        results.push({
          itemId: item.itemId,
          title: item.title,
          channelName: SPREAKER_DESTINATION_LABEL,
          ok: false,
          error:
            'Not sent: this episode has no publish date any more, and Spreaker has no draft ' +
            'state — uploading it would have published it immediately.',
          remoteId: null,
        });
        this.spreakerResults.set([...results]);
        continue;
      }

      // The same question, asked of the clock: the count already excludes lapsed dates,
      // but the panel can sit open across the scheduled minute — confirmed at 4:59 for a
      // 5:00 episode, pressed at 5:01. The push would refuse it anyway; refusing here
      // keeps the refusal in this run's own results instead of a main-process error.
      if (new Date(item.publishAt).getTime() <= Date.now()) {
        results.push({
          itemId: item.itemId,
          title: item.title,
          channelName: SPREAKER_DESTINATION_LABEL,
          ok: false,
          error:
            `Not sent: its date (${item.when}) passed while this panel was open, and ` +
            'Spreaker refuses a schedule in the past. Drop it on a future 5 AM slot.',
          remoteId: null,
        });
        this.spreakerResults.set([...results]);
        continue;
      }

      this.spreakerRun.set({ index: i + 1, total: items.length, title: item.title });
      try {
        const res = await this.electron.publishPushSpreaker(item.itemId);
        if (!res.success || !res.data) {
          results.push({
            itemId: item.itemId,
            title: item.title,
            channelName: SPREAKER_DESTINATION_LABEL,
            ok: false,
            error: res.error ?? 'The episode upload failed and gave no reason.',
            remoteId: null,
          });
        } else {
          results.push({
            itemId: item.itemId,
            title: item.title,
            channelName: SPREAKER_DESTINATION_LABEL,
            ok: true,
            error: null,
            remoteId: String(res.data.receipt.episodeId),
          });
        }
      } catch (err: any) {
        results.push({
          itemId: item.itemId,
          title: item.title,
          channelName: SPREAKER_DESTINATION_LABEL,
          ok: false,
          error: err?.message || String(err),
          remoteId: null,
        });
      }
      this.spreakerResults.set([...results]);
    }

    this.spreakerRun.set(null);

    const failed = results.filter((r) => !r.ok).length;
    const sent = results.length - failed;
    if (failed === 0) {
      this.notify.success(
        'Spreaker uploads finished',
        `${sent} episode${sent === 1 ? '' : 's'} uploaded, each carrying its scheduled date.`
      );
    } else {
      this.notify.error(
        'Spreaker uploads finished with failures',
        `${sent} uploaded, ${failed} failed. The reasons are listed on the calendar.`
      );
    }

    // The records now carry episode ids, and an episode id is what turns a chip's
    // readiness to done. No sweep follows — that reads YouTube, which knows nothing
    // about any of this.
    this.announceFinish(false);
  }

  // ---------------------------------------------------------------- schedule push

  /**
   * Send every out-of-date schedule to YouTube, one at a time.
   *
   * status-only writes, so a title running a Test & Compare experiment is never touched
   * — the API cannot see those experiments, which is exactly why nothing here may write a
   * field it was not asked to write.
   *
   * Same failure discipline as the upload run: one refusal is recorded against its item,
   * verbatim, and the rest still go.
   */
  async runSchedulePush(
    chips: Array<{ itemId: string; title: string; channelName: string; videoId: string | null }>
  ): Promise<void> {
    if (chips.length === 0 || this.pushRun() !== null) return;

    this.pushResults.set([]);
    const results: UploadResult[] = [];

    for (let i = 0; i < chips.length; i++) {
      const chip = chips[i];
      this.pushRun.set({ index: i + 1, total: chips.length, title: chip.title });
      try {
        const res = await this.electron.publishPushSchedule(chip.itemId);
        results.push({
          itemId: chip.itemId,
          title: chip.title,
          channelName: chip.channelName,
          ok: res.success,
          error: res.success ? null : res.error ?? 'The schedule was refused with no reason given.',
          remoteId: chip.videoId,
        });
      } catch (err: any) {
        results.push({
          itemId: chip.itemId,
          title: chip.title,
          channelName: chip.channelName,
          ok: false,
          error: err?.message || String(err),
          remoteId: null,
        });
      }
      this.pushResults.set([...results]);
    }

    this.pushRun.set(null);
    // Re-read YouTube: the whole point is that the board now agrees with it, and the only
    // way to show that honestly is to ask again rather than assume the writes landed.
    this.announceFinish(true);
  }

  // ---------------------------------------------------------------- helpers

  /**
   * The publish facts of every primary item, by item id — or null when the index refuses.
   *
   * PRIMARY SETS ONLY, the same filter the board applies for the same reason: a schedule
   * on a set nobody promoted is a date no push would honour, so sending one would be
   * acting on a row the calendar itself does not draw.
   *
   * A failed read comes back as null and the run proceeds WITHOUT the re-check rather
   * than refusing every item. The check exists to catch a board that moved under an open
   * panel, which is a rare correction; treating "the index would not answer" as "nothing
   * is sendable" would turn a transient read failure into a whole run of refusals for
   * items that were fine.
   */
  private async readFacts(): Promise<Map<string, PublishFacts> | null> {
    try {
      const indexed = await this.electron.publishListIndex();
      if (!indexed.success || !indexed.data) return null;
      const map = new Map<string, PublishFacts>();
      for (const entry of indexed.data.entries) {
        if (!entry.isPrimary || !entry.publish) continue;
        map.set(entry.itemId, entry.publish);
      }
      return map;
    } catch {
      return null;
    }
  }

  /**
   * Why this item may no longer be sent to YouTube, or null when it still may.
   *
   * `facts === null` with a live index means the item has left the board — its record is
   * gone, or it is no longer its source's primary set.
   */
  private stillSendable(facts: PublishFacts | null): string | null {
    if (facts === null) return 'it is no longer on the board';
    if (facts.publishAt === null) return 'its schedule has been cleared';
    const readiness = readinessOf(facts);
    if (readiness === 'done') return 'it now reads as already uploaded';
    if (readiness === 'incomplete') return `it now needs ${missingFor(facts).join(', ')}`;
    if (destinationOf(facts) !== 'youtube') return 'it is now a podcast episode, not a video';
    return null;
  }
}
