/**
 * What crosses from the main process to the renderer about Crucible: the server
 * list, a probe's answer, a server's own settings, adding a server, the local
 * engine, and readiness. Type-only: nothing here may import a Node module.
 *
 * MIRRORED in frontend/src/app/features/crucible/crucible.types.ts, the way
 * publish.types.ts mirrors publish-types.ts: the renderer is a separate
 * compilation unit and cannot import from electron/. tools/test-crucible-wire-mirror.js
 * asserts the two files are the same bytes below their header, so the contract
 * is a TYPE that cannot drift (LEDGER Law 10), not two prose descriptions.
 *
 * NOTHING HERE CARRIES A TOKEN. A row has `tokenMasked` (`****abcd`), a settings
 * document has `keyHint`, a connect code comes back elided, and a device-code
 * pairing crosses as a request id and the short user code. That is a boundary
 * the renderer never gets to cross (Briefcase and BookForge's rule).
 */

// ── the registry and the choice ─────────────────────────────────────────────

/** One registered server, as the row draws it. Local and remote are one kind. */
export interface CrucibleServerRow {
  name: string;
  url: string;
  tokenMasked: string;
  /** ISO 8601. */
  added: string;
}

/** One registered server, and its place in the choice. */
export interface ServerChoiceRow {
  name: string;
  /** The one server all work goes to (LEDGER #205: no automatic hand-off). */
  selected: boolean;
  /** The server a queue item's "fast" pin sends it to (LEDGER #195). */
  fast: boolean;
  /** The Running/Paused switch: a paused server takes no new work, and its work waits (never moves). */
  paused: boolean;
}

export interface RoutingView {
  /** Every registered server, in the order they were added. */
  servers: ServerChoiceRow[];
  /** The one server all work goes to; null when none is (the reason is `missing`, or nothing chosen). */
  selected: string | null;
  /** A selected server the registry no longer has. Reported, never swapped for another. */
  missing: string | null;
  /** The "fast" server, or null when none is pinned: a fast item then has nowhere to go and says so. */
  fastServer: string | null;
}

/** The Crucible on this computer, as an offer to add, or the named reason there is none. */
export type DiscoveredCrucibleRow =
  | {
      present: true;
      /** What the server calls itself, from its pairing file. */
      serverName: string;
      url: string;
      tokenMasked: string;
      /** The pairing file it was read from. */
      file: string;
      /** The registry row already at that address, or null when the offer is open. */
      registeredAs: string | null;
    }
  | { present: false; code: string; reason: string };

/** `crucible:servers`: everything the pane draws before it probes anything. */
export interface CrucibleServersView {
  servers: CrucibleServerRow[];
  routing: RoutingView;
  discovered: DiscoveredCrucibleRow;
}

/** The push on `crucible:servers-changed`. */
export interface CrucibleServersChangedPayload {
  /** What changed, for a log line; the pane re-reads the whole view either way. */
  reason: 'added' | 'removed' | 'selected' | 'fast' | 'paused' | 'resumed';
  server: string | null;
}

// ── a probe's answer ────────────────────────────────────────────────────────

/**
 * What a reachable server says about itself: `/v1/info` plus `/v1/activity`
 * plus `/v1/capability`. The descriptive fields are null where the server did
 * not state them, and are shown as unknown or left out, never guessed.
 */
export interface ServerFacts {
  serverName: string;
  version: string | null;
  apiVersion: number;
  platform: string | null;
  arch: string | null;
  backend: string | null;
  gpu: { vendor: string | null; name: string | null; vramBytes: number | null } | null;
  jobTypes: string[];
  /** The card's holder, in one sentence, or null when the lane accepts work (or `activityUnread` says it could not be read). */
  busyLine: string | null;
  /** The resident model id, or null. */
  resident: string | null;
  /**
   * Why `/v1/activity` could not be read, or null when it was. The activity is
   * a display, so a server that cannot answer it is still a server, but its
   * "free" is then UNKNOWN, and this says so rather than letting a null
   * `busyLine` read as a free card.
   */
  activityUnread: string | null;
  /** True when the server STATES a version older than the floor (`MIN_CRUCIBLE`); false when it states none. */
  needsUpdate: boolean;
  /** Set when the registered address is an orchestrator and this is its engine. */
  engineUrl: string | null;
  /**
   * The capability rows ContentStudio reads, per class. Null when they could
   * not be read, and `capabilitiesUnread` then says why.
   */
  capabilities: CapabilityFact[] | null;
  /**
   * Why the capability rows are null: the server has not decided them yet
   * (`crucible capability --write` not run, `503 capability_undecided`), or the
   * read failed. Null when they were read.
   */
  capabilitiesUnread: string | null;
  /**
   * Which generation act this server takes (plan section 6.4, detected per server,
   * never version-sniffed): `generate` when `capability()` lists that class,
   * `analysis` on a server that predates it. Null when the capabilities are undecided.
   */
  generationAct: 'generate' | 'analysis' | null;
}

/** One capability class's verdict on one server. A disabled class is an answer, not an error. */
export interface CapabilityFact {
  capability: string;
  enabled: boolean;
  /** The model that serves it (an upstream id when routed), or '' when none does. */
  selected: string;
  route: 'local' | 'upstream';
  /** Why, in the server's own words; null when it gave none. */
  reason: string | null;
}

/**
 * A probe's answer. Every failure is a named outcome, because each has its own
 * fix. The five plan section 4 names: nothing there (`unreachable`), something
 * that is not a Crucible, a Crucible that refused the token, a Crucible on
 * another API version, and the probe's own 3 s clock running out (`timeout`:
 * a sleeping PC answers nothing, which is a different fix from a wrong
 * address). `refused` carries any other named refusal in its own words (an
 * orchestrator with no engine, an unknown registry name).
 */
export type CrucibleProbeResult =
  | { outcome: 'ok'; facts: ServerFacts }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'not_a_crucible'; message: string }
  | { outcome: 'wrong_token'; message: string }
  | { outcome: 'version_mismatch'; message: string }
  | { outcome: 'timeout'; message: string }
  | { outcome: 'refused'; message: string };

/** The one word a row's reach chip shows. */
export type ServerReach = 'ready' | 'busy' | 'unreachable' | 'timeout' | 'bad_token' | 'not_crucible' | 'version_mismatch' | 'refused';

export interface CrucibleProbeAnswer {
  server: string;
  reach: ServerReach;
  probe: CrucibleProbeResult;
  /** When this answer was taken (epoch ms); a cached one is up to 15 s old. */
  at: number;
}

// ── a server's own settings ─────────────────────────────────────────────────

export type UpstreamName = 'anthropic' | 'openai' | 'ollama';

/** The engine's settings document, as the renderer may see it. Keys never; hints only. */
export interface CrucibleSettingsView {
  routes: Record<string, { route: 'local' | 'upstream'; model: string | null }>;
  /** One card per upstream; null for one this server does not offer (the pane leaves it out). */
  upstreams: {
    anthropic: { configured: boolean; keyHint: string | null } | null;
    openai: { configured: boolean; keyHint: string | null } | null;
    ollama: { configured: boolean; url: string | null } | null;
  };
  /** Class → explicit local model (null = the engine's own choice); the whole map null when the server did not state it. */
  localModels: Record<string, string | null> | null;
  /** Null when the server did not state it. */
  backendKind: string | null;
}

/** The patch the pane may send: upstream keys and URLs only. Unknown keys are refused, not dropped. */
export interface CrucibleSettingsPatch {
  upstreams?: Partial<Record<UpstreamName, { key?: string; url?: string } | null>>;
}

export type UpstreamTestAnswer =
  | { ok: true; models: string[] }
  | { ok: false; code: string; message: string };

/**
 * What "copy my key to <server>" came to. The app's own Claude key (api-keys.json,
 * until P2 migrates it) is written to that server's settings and confirmed by
 * the server's own hint. Nothing is ever pushed without this call (LEDGER #194).
 */
export interface KeyCopyOutcome {
  server: string;
  /** The key was written and the server's hint confirms it. */
  copied: boolean;
  /** The server already held this same key: nothing written. */
  alreadyThere: boolean;
  /** Why it was not copied, when it was not. */
  skipped: string | null;
}

// ── adding a server ─────────────────────────────────────────────────────────

/** Only the short matching code crosses into the renderer. */
export interface CruciblePairingPrompt {
  requestId: string;
  /** What the server calls itself, e.g. `crucible@owens-pc`. */
  name: string;
  url: string;
  userCode: string;
  expiresIn: number;
  interval: number;
  /** False on an engine with open pairing (the default): the first poll approves. */
  approvalRequired: boolean;
}

export type CruciblePairingDecision =
  | { status: 'pending' | 'denied' | 'expired' }
  | { status: 'approved'; name: string };

/** A pasted connect code, read back with the token masked. */
export type ConnectCodeReading =
  | { ok: true; name: string; url: string; tokenMasked: string }
  | { ok: false; code: 'invalid_pairing'; message: string };

/** What `crucible:add` takes. Exactly one of the two. */
export type AddServerRequest =
  /** A `crucible://name@host:port/#token` line, pasted. `name` renames it here. */
  | { connectCode: string; name?: string }
  /** The Crucible on this computer, adopted from its pairing file. */
  | { discovered: true; name?: string };

/** What a copy-connect-code call answers: the line it copied, token elided. */
export interface CopiedConnectCode {
  copied: string;
}

/**
 * The Crucible on this computer as another machine would reach it: one line per
 * address it lists (LAN, tailnet), each with its token elided. The pane shows
 * these and asks main to copy the one the person picks, by its `url`.
 */
export interface LocalConnectCodes {
  /** What the server calls itself. */
  server: string;
  lines: Array<{ url: string; elided: string }>;
}

// ── the local engine: presence, install, the setup face ─────────────────────

/** The SDK's eight local states. */
export type CrucibleLocalState =
  | 'absent' | 'running' | 'stopped' | 'unreachable' | 'wrong_service' | 'unauthorized' | 'unhealthy' | 'broken';

/** The local engine as its own control says, plus what to tell a person. */
export interface CrucibleEnginePresence {
  state: CrucibleLocalState;
  detail: string;
  /** One sentence for a person, or null when there is nothing worth saying. */
  message: string | null;
  /** True when pressing Start is the actual repair. */
  offerStart: boolean;
}

export interface CrucibleEngineStartOutcome {
  started: boolean;
  detail: string;
  /** The registry row the engine was adopted as after it started, or null. */
  connectedAs: string | null;
}

/** A named install refusal, in the bootstrap package's own shape. */
export interface CrucibleHostRefusal {
  code: string;
  message: string;
  /** The exact line to run, or null when nothing can be typed. Never a guess. */
  command: string | null;
  /** Verbatim evidence (a stderr tail, a status line), or null. */
  detail: string | null;
}

/** Could a Crucible live here. `unknown` is drawn as the install face. */
export type CrucibleHostability = 'yes' | 'no' | 'unknown';

/** One step of the sequence, for a screen that lists them before they run. */
export interface CrucibleInstallStep {
  title: string;
  detail: string;
  /** True only where this app has verified it (a pairing file already here). */
  done: boolean;
}

/** Everything the install face draws, in one read. Composing it installs nothing. */
export interface CrucibleInstallPlan {
  platform: 'win32' | 'darwin' | 'linux' | 'other';
  /** One sentence about this machine, from what was measured and nothing else. */
  machine: string;
  hostable: CrucibleHostability;
  /** Why, whichever way it went. Always set. */
  hostableWhy: string;
  steps: CrucibleInstallStep[];
  /** Is there already a Crucible on this computer (its pairing file), and is it registered? */
  discovered: DiscoveredCrucibleRow;
  /** One named refusal per thing that stops an install here. */
  refusals: CrucibleHostRefusal[];
  /** Crucible's README, the argument behind the sequence. */
  readme: string;
}

/** One event of a running install, on `crucible:install-progress`. The package's own shapes, forwarded. */
export type CrucibleInstallProgress =
  | { kind: 'step'; step: string; index: number | null; total: number | null; status: string; detail: string }
  | { kind: 'progress'; file: string; done: number; total: number | null }
  | { kind: 'state'; code: string; sentence: string; action: string }
  | { kind: 'line'; step: string; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'done'; server: { name: string; url: string }; release: string; backend: string; connectedAs: string | null }
  | { kind: 'failed'; refusal: CrucibleHostRefusal };

/** Is one running in this process, and what did the last one come to? */
export interface CrucibleInstallStatus {
  running: boolean;
  /** The release the running (or last) install chose, once the gate spoke. */
  release: string | null;
  /** True when a recorded install did not finish in a previous run of the app. */
  interrupted: boolean;
  /** Every event of the install in this process, oldest first (capped), for a pane opened late. */
  events: CrucibleInstallProgress[];
}

/** The never-older gate's answer, asked without installing anything. */
export type CrucibleReleaseCheck =
  | { action: 'install'; latest: string; running: null }
  | { action: 'upgrade'; latest: string; running: string }
  | { action: 'none'; code: 'crucible_already_latest' | 'install_older_than_running'; latest: string; running: string; message: string }
  | { action: 'unknown'; refusal: CrucibleHostRefusal };

/**
 * The ONE face the doors show (crucible docs/INTEGRATING-AN-APP.md section 4.5):
 *  - `connected`: the registry has at least one server;
 *  - `adopt`: no registry row for it, but a Crucible is on this computer;
 *  - `install`: nothing here, and this machine can host one;
 *  - `connect-only`: nothing here, and it cannot (Intel Mac, Linux without NVIDIA).
 */
export type CrucibleSetupFace = 'connected' | 'adopt' | 'install' | 'connect-only';

/** `crucible:setup`: everything the doors draw, in one read. */
export interface CrucibleSetupView {
  face: CrucibleSetupFace;
  /** Registered server names, in the order they were added. */
  servers: string[];
  plan: CrucibleInstallPlan;
  install: CrucibleInstallStatus;
}

// ── readiness ───────────────────────────────────────────────────────────────

/**
 *   ready           the selected server answers: AI actions run.
 *   starting        the app is starting (or installing) the Crucible on this computer.
 *   unreachable     a server is registered (or installed here) and none answers.
 *   not-installed   nothing is registered, nothing is installed here, and this
 *                   computer can host a Crucible: offer the install door.
 *   not-configured  nothing is registered and this computer cannot host one, or
 *                   no registered server is selected: offer "connect".
 */
export type CrucibleReadinessState = 'ready' | 'starting' | 'unreachable' | 'not-installed' | 'not-configured';

/**
 * The one door that repairs a state that is not `ready`:
 *   start    the Crucible on this computer is installed and stopped: start it;
 *   install  nothing is installed and this computer can host one;
 *   connect  connect (or select) a Crucible server in Settings.
 * Null when ready, or while starting.
 */
export type CrucibleReadinessAction = 'start' | 'install' | 'connect' | null;

export interface CrucibleReadinessView {
  state: CrucibleReadinessState;
  /** One sentence for a person: why AI actions are (not) available. */
  reason: string;
  action: CrucibleReadinessAction;
  /** The server that answers, when ready. */
  server: string | null;
  /**
   * When ready but the card is someone else's right now (a job, a lease, an
   * engine claim): the holder's sentence. AI work still queues; it parks for the card.
   */
  busy: string | null;
  /** While starting: the latest line of the start or install. */
  progress: string | null;
  /** The user said "Not now" to bringing Crucible up, this session. Nothing prompts again until restart. */
  declined: boolean;
  /** ISO time this answer was derived. */
  at: string;
}

// ── the IPC envelope ────────────────────────────────────────────────────────

/**
 * Every `crucible:*` channel answers this. A refusal carries its `code` (the
 * registry's, the SDK's, or a probe outcome) and a sentence with the fix, so
 * the pane acts on the code and the person reads the message (Law 10: a typed
 * contract, not an Error whose message the renderer would have to parse).
 */
export type CrucibleIpcResult<T> =
  | { success: true; data: T }
  | { success: false; code: string; error: string };
