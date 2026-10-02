/**
 * WHERE TRANSCRIPTION RUNS: P5's one seam (`setAsrVenueResolver`, docs/crucible/P5.md §2),
 * wired to the registry, the client factory and P3's in-flight ledger.
 *
 * The server is the current queue job's venue when there is one (the fast pin's server or the
 * selected one, LEDGER #205, read off P3's lane), else the selected server. Never another one:
 * `selected()` throws its own named refusal when nothing is selected, which P5 passes through.
 *
 * The client is the SDK's `CrucibleClient` for the ENGINE behind that server. The factory
 * resolves the engine asynchronously (an orchestrator's one hop, P1), and P5's resolver is
 * synchronous, so the venue's client is a thin face whose every method first awaits the
 * factory's client and then calls the SDK's own method: the SDK client "passes as it is"
 * (P5 §2), one await later. The token stays in the factory.
 *
 * Every asr job is written to the in-flight ledger when the server admits it and settled when it
 * ends (P3), so a kill mid-transcription leaves the sweep a job to cancel.
 *
 * Every asr job runs inside a queue session (LEDGER #255): the lanes' `sessionOn` hands back the
 * queue job's own session when the transcription is part of one, else this install's open session
 * on that server joined, else a new one (session.ts). Its client is the SDK's `CrucibleSession`,
 * which sends `X-Crucible-Session` on every request.
 */
import type { CrucibleClient } from '@crucible/client';
import type { AsrCrucibleClient, AsrVenue } from './asr';
import type { CrucibleClientFactory } from './client-factory';
import type { InFlightLedger } from './in-flight-ledger';
import { currentJobVenue } from './lanes';
import type { SessionSource } from './session';
import type { CrucibleServers } from './servers';

/** The ASR model every job names (LEDGER #206; the official id, never `-mlx`, #205). */
const ASR_MODEL = 'qwen3-asr-1.7b';

function engineClient(get: () => Promise<CrucibleClient>): AsrCrucibleClient {
  return {
    info: async () => (await get()).info(),
    upload: async (data, options) => (await get()).upload(data, options),
    submit: async (request) => (await get()).submit(request as Parameters<CrucibleClient['submit']>[0]),
    events: async function* (jobId, options) {
      yield* (await get()).events(jobId, options ?? {});
    },
    artifact: async (jobId, name) => (await get()).artifact(jobId, name),
    cancel: async (jobId) => (await get()).cancel(jobId),
    job: async (jobId) => (await get()).job(jobId),
    activity: async () => (await get()).activity(),
  };
}

/** The resolver P5's `setAsrVenueResolver` takes. */
export function crucibleAsrVenue(deps: {
  servers: Pick<CrucibleServers, 'selected'>;
  factory: Pick<CrucibleClientFactory, 'clientFor'>;
  ledger: InFlightLedger;
  sessions: SessionSource;
}): () => AsrVenue {
  return () => {
    const job = currentJobVenue();
    const server = job?.server ?? deps.servers.selected();
    const jobId = job?.jobId ?? '';
    return {
      server,
      client: engineClient(() => deps.factory.clientFor(server)),
      session: async ({ onQueue, signal }) => {
        const hold = await deps.sessions.sessionOn(server, {
          act: 'asr',
          what: jobId === '' ? 'a transcription' : `the transcription of ${jobId}`,
          ...(onQueue === undefined ? {} : { onQueue }),
          ...(signal === undefined ? {} : { signal }),
        });
        const session = hold.card.session;
        return { client: engineClient(async () => session), release: () => hold.release() };
      },
      ledger: {
        record: (id) => deps.ledger.record({ server, kind: 'job', id, jobType: 'asr', model: ASR_MODEL, jobId }),
        settle: (id) => deps.ledger.settle(server, 'job', id),
      },
    };
  };
}
