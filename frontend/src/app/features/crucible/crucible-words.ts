/**
 * The words ContentStudio uses about Crucible, in one place so every screen says the same
 * thing (BookForge's crucible-words.ts, and Briefcase's, trimmed to what the Servers pane
 * draws in P1). Pure functions over the wire types.
 *
 * The rules (crucible docs/INTEGRATING-AN-APP.md section 8): say "GPU engine", name the
 * holder on a wait ("busy: bookforge, tts 62% done", kept verbatim from the server), never
 * say "maybe", and never send a person to Crucible's own page for a normal workflow.
 */
import type {
  CapabilityFact,
  CrucibleInstallProgress,
  CrucibleReadinessView,
  ServerFacts,
  ServerReach,
} from './crucible.types';

/** The one word a row's reach chip shows. */
const REACH_WORDS: Record<ServerReach, string> = {
  ready: 'Ready',
  busy: 'Busy',
  unreachable: 'Not answering',
  timeout: 'No answer in 3 s',
  bad_token: 'Key refused',
  not_crucible: 'Not a Crucible',
  version_mismatch: 'Other API version',
  refused: 'Refused',
};

export function reachWord(reach: ServerReach): string {
  return REACH_WORDS[reach];
}

/** A reach that means something is wrong, not merely occupied. */
export function reachIsProblem(reach: ServerReach): boolean {
  return reach !== 'ready' && reach !== 'busy';
}

/**
 * A reachable server's self-description for its row: `Crucible 1.0.34 · mlx-darwin ·
 * NVIDIA GeForce RTX 3090 Ti (24 GB)`. What the server did not state is left out, except the
 * version, which reads "version unknown" (1.0.25 made it nullable; it is never guessed).
 */
export function serverFactsLine(facts: Pick<ServerFacts, 'version' | 'backend' | 'gpu' | 'engineUrl'>): string {
  const parts = [facts.version === null ? 'Crucible, version unknown' : `Crucible ${facts.version}`];
  if (facts.backend !== null) parts.push(facts.backend);
  const gpu = facts.gpu;
  const size = gpu?.vramBytes == null ? null : `${Math.round(gpu.vramBytes / 1024 ** 3)} GB`;
  const name = gpu?.name ?? null;
  if (name !== null) parts.push(size === null ? name : `${name} (${size})`);
  else if (size !== null) parts.push(size);
  if (facts.engineUrl) parts.push(`engine at ${facts.engineUrl}`);
  return parts.join(' · ');
}

/** What is on the card right now, in the row's words. */
export function residentLine(facts: Pick<ServerFacts, 'resident' | 'activityUnread'>): string {
  if (facts.activityUnread !== null) return `On the GPU: unknown (${facts.activityUnread})`;
  return facts.resident === null ? 'On the GPU: nothing loaded' : `On the GPU: ${facts.resident}`;
}

const CAPABILITY_WORDS: Record<string, string> = {
  generate: 'Generation',
  analysis: 'Analysis',
  decide: 'Snap decisions',
  asr: 'Transcription',
  align: 'Word timing',
  denoise: 'Voice isolation',
};

/** One capability row, as a chip: `Transcription: qwen3-asr-1.7b`, or why it is not here. */
export function capabilityLine(fact: CapabilityFact): string {
  const word = CAPABILITY_WORDS[fact.capability] ?? fact.capability;
  if (!fact.enabled) return `${word}: not on this server${fact.reason ? ` (${fact.reason})` : ''}`;
  if (fact.selected === '') return `${word}: available`;
  return `${word}: ${fact.selected}${fact.route === 'upstream' ? ' (cloud)' : ''}`;
}

/** The readiness banner's headline for a state. The reason sentence follows it verbatim. */
export function readinessHeadline(view: Pick<CrucibleReadinessView, 'state'>): string {
  switch (view.state) {
    case 'ready': return 'Crucible is ready';
    case 'starting': return 'Crucible is starting';
    // Not "not answering": a paused selected server is this state too, and it answers fine.
    case 'unreachable': return 'Crucible is not available';
    case 'not-installed': return 'Crucible is not installed';
    case 'not-configured': return 'No Crucible server to use';
  }
}

/** The one door's label for a readiness action. */
export function readinessDoor(action: CrucibleReadinessView['action']): string | null {
  switch (action) {
    case 'start': return 'Start Crucible';
    case 'install': return 'Install Crucible';
    case 'connect': return 'Add or select a server below';
    case null: return null;
  }
}

/** Readable names for the bootstrap package's install steps. Unknown steps show their own name. */
const STEP_WORDS: Record<string, string> = {
  'host-facts': 'Checking this computer',
  server: 'Installing Crucible',
  init: 'Setting up Crucible',
  service: 'Registering the login service',
  'local-readiness': 'Starting Crucible',
  capability: 'Measuring this computer',
  linger: 'Keeping Crucible running',
};

export function installStepWord(step: string): string {
  return STEP_WORDS[step] ?? step;
}

/** The current headline of a running install, from its events. */
export function installHeadline(events: readonly CrucibleInstallProgress[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.kind === 'done') return `Crucible ${e.release} is installed and running.`;
    if (e.kind === 'failed') return `The install stopped: ${e.refusal.message}`;
    if (e.kind === 'state') return e.sentence;
    if (e.kind === 'step') return `${installStepWord(e.step)}${e.detail ? `: ${e.detail}` : ''}`;
  }
  return 'Starting the install.';
}
