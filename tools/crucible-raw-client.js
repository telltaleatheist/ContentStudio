/**
 * THE PAIRED SERVER'S VENUE for P5's acceptance runs (tools/asr-acceptance.js), NOT the app's.
 *
 * It began as a raw-fetch client because P1 had not vendored the SDK yet. Since Crucible 1.0.76
 * every asr job runs inside a QUEUE SESSION (LEDGER #255; electron/crucible/asr.ts `AsrVenue.session`),
 * so the venue is now built on the vendored SDK itself (`@crucible/client`): its `CrucibleClient`
 * is the plain client (`/v1/info`, the upload), and `session()` opens a queue session whose
 * `CrucibleSession` sends `X-Crucible-Session` on every request. The client name is this install's
 * own (`contentstudio@<host>`, client-factory.ts `clientNameFor`), so a run made while the app holds
 * a session on the same server joins it rather than queueing behind it.
 *
 *   const { pairedVenue } = require('./crucible-raw-client');
 *   const venue = pairedVenue();            // ~/.crucible/pairing: the Mac's own server
 *
 * Needs the compiled main process (`npm run build:electron`) for the client name.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CrucibleClient } = require('@crucible/client');

/** `idle_s` of the run's session, as the app's (session.ts JOB_SESSION_IDLE_S). */
const SESSION_IDLE_S = 900;

/** The install's client name, read from the compiled app so the two never disagree. */
function installClientName() {
  const factory = require(path.join(__dirname, '..', 'dist', 'main', 'crucible', 'client-factory.js'));
  return factory.clientNameFor(os.hostname());
}

/**
 * This Mac's own server, from its pairing file (`crucible://<name>@<host>:<port>/#<token>`).
 * The venue's name is the machine part of the server name (`owens-mac-studio`), which is what
 * the sidecar records as `crucible:<name>:qwen3-asr-1.7b`.
 */
function pairedVenue(pairingPath = path.join(os.homedir(), '.crucible', 'pairing')) {
  const raw = fs.readFileSync(pairingPath, 'utf8').trim();
  const m = raw.match(/^crucible:\/\/([^@]*(?:%40[^@]*)?)@([^/]+)\/#(.+)$/);
  if (!m) throw new Error(`${pairingPath} is not a crucible:// pairing line`);
  const serverName = decodeURIComponent(m[1]);
  const name = serverName.includes('@') ? serverName.split('@').pop() : serverName;
  const client = new CrucibleClient({ url: `http://${m[2]}`, token: m[3], clientName: installClientName() });
  return {
    server: name,
    client,
    /** The queue session the asr job runs in: waits in the server's line, closed by `release`. */
    async session({ onQueue, signal } = {}) {
      const session = await client.session({
        act: 'asr',
        idleS: SESSION_IDLE_S,
        ...(onQueue === undefined ? {} : { onQueue }),
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        client: session,
        release: async () => {
          await session.close().catch((err) => {
            console.error(`[acceptance] could not close queue session ${session.id}: ${err && err.message}; the server ends it after ${SESSION_IDLE_S} s idle`);
          });
        },
      };
    },
  };
}

module.exports = { pairedVenue };
