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
 */
import type { CrucibleClient } from '@crucible/client';
import type { AsrCrucibleClient, AsrVenue } from './asr';
import type { CrucibleClientFactory } from './client-factory';
import type { InFlightLedger } from './in-flight-ledger';
import { currentJobVenue } from './lanes';
import type { CrucibleServers } from './servers';

/** The ASR model every job names (LEDGER #206; the official id, never `-mlx`, #205). */
const ASR_MODEL = 'qwen3-asr-1.7b';

function engineClient(factory: Pick<CrucibleClientFactory, 'clientFor'>, server: string): AsrCrucibleClient {
  const get = (): Promise<CrucibleClient> => factory.clientFor(server);
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
}): () => AsrVenue {
  return () => {
    const job = currentJobVenue();
    const server = job?.server ?? deps.servers.selected();
    const jobId = job?.jobId ?? '';
    return {
      server,
      client: engineClient(deps.factory, server),
      ledger: {
        record: (id) => deps.ledger.record({ server, kind: 'job', id, jobType: 'asr', model: ASR_MODEL, jobId }),
        settle: (id) => deps.ledger.settle(server, 'job', id),
      },
    };
  };
}
