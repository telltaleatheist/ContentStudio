/**
 * LANES FOR A COMMAND-LINE TOOL: what scripts/generate-metadata-cli.js and
 * prompt-harness/run.js install before they drive the compiled pipeline, and
 * the Ctrl-C that gives back what they hold.
 *
 * Why a CLI needs this at all: every local model call goes through
 * `queueAITask`, which runs on the process's installed lanes (lanes.ts). The
 * app installs them in main.ts; a CLI is its own process and installs its own,
 * over the same registry and routing record (the real userData), so a CLI run
 * goes to the server the app would use.
 *
 * WHY ITS OWN LEDGER FILE. The app's ledger (`crucible-in-flight.json`) is read
 * and swept by the app at every start; a CLI running while the app starts would
 * have its live lease released under it, and two processes writing one file
 * lose rows. So each CLI process writes `crucible-in-flight-<tool>-<pid>.json`,
 * and at start sweeps the ledgers of any earlier run of the same tool whose
 * process is gone (a `kill -9`, a closed terminal).
 *
 * INTERRUPT (plan sections 0a, 13.4; Briefcase's lesson: a Ctrl-C'd eval left
 * its lease held until the TTL and the card was stuck for everyone). SIGINT and
 * SIGTERM abort the run, cancel its Crucible jobs and release its leases (its
 * whole ledger), then exit 130 or 143. A second signal exits at once.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createCrucibleContext, type CrucibleContext } from './context';
import { InFlightLedger } from './in-flight-ledger';
import { JOB_SWEEP_DEADLINE_MS, STARTUP_SWEEP_DEADLINE_MS, sweepCrucibleInFlight } from './in-flight-sweep';
import { installLanes, type CrucibleLanes } from './lanes';
import { installCrucibleTransport } from './transport';
import { setAsrVenueResolver } from '../services/transcription/crucible-transcription';

export interface CliLanes {
  context: CrucibleContext;
  lanes: CrucibleLanes;
  /** Aborted by SIGINT/SIGTERM. Hand it to the run (`cancelSignal`). */
  signal: AbortSignal;
  /** The run finished normally: give back anything still recorded and remove this process's ledger file. */
  close(): Promise<void>;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function openCliLanes(options: {
  stateDir: string;
  tool: string;
  say?: (line: string) => void;
  /**
   * Send THIS run to another registered server than the one the app has selected
   * (`--server`), without writing the routing record (P2). Refused by name when it is
   * not registered.
   */
  server?: string;
}): CliLanes {
  const say = options.say ?? ((line: string) => console.error(`[crucible] ${line}`));
  const prefix = `crucible-in-flight-${options.tool}-`;
  const ledgerFile = `${prefix}${process.pid}.json`;
  const context = createCrucibleContext({
    stateDir: options.stateDir,
    // A CLI never pairs or copies a code, and never moves api-keys.json (that is the app's,
    // once, plan 6.6: no `legacyKeys` here). These seams are refused, never faked.
    clipboard: () => { throw new Error(`${options.tool} does not write the clipboard.`); },
    ledgerFile,
    ...(options.server === undefined ? {} : { serverOverride: options.server }),
  });
  const clientFor = (server: string) => context.factory.clientFor(server);

  // Earlier runs of this tool that were killed: their holds are still on a card somewhere.
  const stale = fs.existsSync(options.stateDir)
    ? fs.readdirSync(options.stateDir).filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .filter((name) => {
        const pid = Number.parseInt(name.slice(prefix.length, -'.json'.length), 10);
        return Number.isInteger(pid) && pid !== process.pid && !alive(pid);
      })
    : [];
  const swept = Promise.all(stale.map(async (name) => {
    const ledger = new InFlightLedger(path.join(options.stateDir, name), say);
    const report = await sweepCrucibleInFlight({ ledger, clientFor, log: say }, { reason: `an earlier ${options.tool} run (${name}) that did not finish`, deadlineMs: STARTUP_SWEEP_DEADLINE_MS });
    if (report.kept.length === 0) fs.rmSync(ledger.file, { force: true });
  }));
  context.lanes.setAdmissionGate(swept);
  installLanes(context.lanes);
  // The one door, over the same registry, the same choice and the same lanes (P2), and the
  // transcription venue on the same choice and ledger (P5's seam).
  installCrucibleTransport(context.transport);
  setAsrVenueResolver(context.asrVenue);

  const controller = new AbortController();
  const giveBack = async (reason: string): Promise<void> => {
    await sweepCrucibleInFlight({ ledger: context.ledger, clientFor, log: say }, { reason, deadlineMs: JOB_SWEEP_DEADLINE_MS });
    if (context.ledger.read().length === 0) fs.rmSync(context.ledger.file, { force: true });
  };

  let interrupted = false;
  const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    const code = signal === 'SIGINT' ? 130 : 143;
    if (interrupted) process.exit(code);
    interrupted = true;
    say(`${signal}: stopping ${options.tool}, cancelling its Crucible jobs and releasing its leases (press again to exit at once)`);
    controller.abort(new Error(`${options.tool} was interrupted (${signal})`));
    void giveBack(`${options.tool} was interrupted (${signal})`).finally(() => process.exit(code));
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  return {
    context,
    lanes: context.lanes,
    signal: controller.signal,
    close: () => giveBack(`${options.tool} finished`),
  };
}
