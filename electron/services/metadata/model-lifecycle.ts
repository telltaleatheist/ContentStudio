/**
 * One job's model residence: its Crucible queue sessions
 *
 * WHY THIS FILE EXISTS. Every stage of a metadata job used to release its model in its own
 * `finally`: the chapter pipeline when chaptering finished, each field unit and the description
 * unit when runMetadataTasks finished. The next stage (usually the SAME model) then re-streamed
 * ~17GB of weights into unified memory, and the operator's machine froze for the length of
 * every one of those loads (LEDGER #110: NO UNIT RELEASES A MODEL).
 *
 * So residence is a JOB-scoped fact and it is held here. Since Crucible 1.0.76 (LEDGER #255) it
 * is held inside the job's QUEUE SESSION on its server: opened (or joined) by the first call that
 * needs the server, holding whatever the job loads in it, and let go of ONCE, in a `finally` at
 * the end of the job, on the cancelled and failed paths as well as the finished one (a lane job's
 * session is the lane's, closed when the lane run ends). The mechanics are
 * electron/crucible/session.ts (`JobSessions`); this is the face the metadata stages were already
 * threaded with, so none of them learns a second object. Nothing here decides WHICH models a job
 * uses (the routing does), and nothing here unloads one: closing the session settles the card.
 *
 * THE SECOND RELOAD TRIGGER IS THE CONTEXT. Loading a model at a different context is a full
 * reload (it was num_ctx on Ollama, LEDGER #111; it is `load-model`'s `params.context` on
 * Crucible). Until P4 this file kept a ratchet (`contextFloor` / `recordContext`): the largest
 * window a job had asked a model for was the floor for every later call on it. P4 (LEDGER #209)
 * moved every call to its own smallest step, and the protection the ratchet gave now lives in
 * the session's residency (electron/crucible/session.ts `CardSession.ensure`): a later call that
 * needs more grows the load once, a later call that needs less runs on the window already loaded.
 * GROWTH is legitimate; SHRINKAGE within a job never is. No floor is carried anywhere.
 */

import * as log from 'electron-log';
import { crucibleTransport } from '../../crucible/transport';
import type { JobSessions } from '../../crucible/session';

/**
 * One job's model residence. Created by the orchestrator, threaded to the stages, let go of once.
 *
 * Explicitly threaded and never a module-level singleton: two jobs are two objects.
 */
export class JobModelLifecycle {
  private jobSessions: JobSessions | null = null;

  constructor(
    /** What the job is, for every session log line. */
    private readonly what: string = 'the metadata job'
  ) {}

  /**
   * The job's Crucible sessions, made on first use, so a job that never reaches a local model
   * (every row on `claude -p`) never needs a server at all.
   */
  get sessions(): JobSessions {
    if (this.jobSessions === null) this.jobSessions = crucibleTransport().job(this.what);
    return this.jobSessions;
  }

  /**
   * Let go of the job's sessions, once, at the end of the job. Never throws (it runs in the job's
   * `finally`). A session the server ended mid-job already failed the call that met it, by name.
   */
  async releaseAll(): Promise<void> {
    if (this.jobSessions === null) {
      log.info('[ModelLifecycle] this job held no Crucible session, so there is nothing to let go of');
      return;
    }
    await this.jobSessions.releaseAll();
  }
}
