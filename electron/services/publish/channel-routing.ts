/**
 * Channel Routing
 *
 * Which YouTube channel does a generated item belong to? The answer already exists in
 * the analytics channel registry — each channel lists the prompt sets that feed it — but
 * nothing on the publish side ever asked it, which is why all 44 live selections have a
 * null channelId while three real channels sit in channels.json.
 *
 * PURE. The channel list is passed IN, exactly as `readGenerated` is injected into
 * publish-ipc: this directory does not import from services/analytics, so the whole
 * publish feature stays liftable into another host by supplying data rather than by
 * bringing a dependency graph along. The IPC layer reads analyticsStore.listChannels()
 * and hands the result here.
 *
 * The three outcomes are deliberately NOT the same kind of thing:
 *
 *   one match   -> the channel. The answer.
 *   zero        -> null, WITH A REASON naming the prompt set. An unrouted item is a
 *                  normal state (a new prompt set nobody has mapped yet), and the reason
 *                  is what the panel shows so the operator can go fix channels.json.
 *                  It does NOT default to Telltale: guessing the channel is how a video
 *                  ends up on the wrong one, and Telltale is only "the obvious default"
 *                  until the day it isn't.
 *   two or more -> THROW. Two channels claiming one prompt set is a contradiction in
 *                  config, not a choice to make at routing time. Picking either one
 *                  would make the registry's contradiction invisible forever.
 */

/**
 * The shape this needs out of a channel registry entry.
 *
 * Structurally satisfied by analytics' ChannelRegistryEntry, declared here so the import
 * doesn't have to exist. Narrow on purpose: routing has no business seeing anything else
 * about a channel.
 */
export interface RoutableChannel {
  channelId: string;
  name: string;
  /** Prompt-set names mapped to this channel. */
  promptSets: string[];
}

/**
 * The outcome of routing one prompt set.
 *
 * `reason` is present on BOTH branches and is written for the operator, not the log: it
 * is the "from prompt set X" line under the channel picker, and the explanation of why
 * the picker is empty when it is.
 */
export interface ChannelResolution {
  /** The routed channel, or null when no channel claims this prompt set. */
  channelId: string | null;
  /** The routed channel's display name, or null alongside a null channelId. */
  name: string | null;
  /** Plain-language account of what happened. Always set. */
  reason: string;
}

/**
 * Resolve the channel for a prompt set.
 *
 * Throws on an ambiguous registry (see the module note) and on inputs that are not a
 * prompt-set name and a channel list — a routing question asked with no prompt set is a
 * caller bug, and answering "no channel" would disguise it as an unmapped prompt set.
 */
export function resolveChannelForPromptSet(
  promptSet: string,
  channels: RoutableChannel[]
): ChannelResolution {
  if (typeof promptSet !== 'string' || !promptSet.trim()) {
    throw new Error(
      `resolveChannelForPromptSet requires a prompt-set name; got ${JSON.stringify(promptSet)}`
    );
  }
  if (!Array.isArray(channels)) {
    throw new Error(
      `resolveChannelForPromptSet requires the channel registry; got ${JSON.stringify(channels)}`
    );
  }

  const name = promptSet.trim();
  const matches = channels.filter(
    (c) => Array.isArray(c?.promptSets) && c.promptSets.includes(name)
  );

  if (matches.length > 1) {
    const named = matches.map((c) => `${c.name} (${c.channelId})`).join(', ');
    throw new Error(
      `Prompt set "${name}" is mapped to ${matches.length} channels: ${named}. ` +
      `A prompt set routes to exactly one channel — fix the channel registry ` +
      `(analytics/channels.json) so only one claims it.`
    );
  }

  if (matches.length === 0) {
    return {
      channelId: null,
      name: null,
      reason:
        channels.length === 0
          ? `No channels are registered, so prompt set "${name}" cannot be routed. ` +
            `Connect a channel first.`
          : `No channel claims prompt set "${name}". Add it to a channel's prompt sets ` +
            `to route items generated with it.`,
    };
  }

  const channel = matches[0];
  return {
    channelId: channel.channelId,
    name: channel.name,
    reason: `Prompt set "${name}" is mapped to ${channel.name}.`,
  };
}

/**
 * The registry entry for an id, or null.
 *
 * Exists so the channelId validator asks the registry rather than pattern-matching a
 * `UC…` string: the rule is "this is one of Owen's channels", not "this looks like a
 * YouTube id".
 */
export function findChannelById(
  channelId: string,
  channels: RoutableChannel[]
): RoutableChannel | null {
  if (!Array.isArray(channels)) {
    throw new Error(`findChannelById requires the channel registry; got ${JSON.stringify(channels)}`);
  }
  return channels.find((c) => c?.channelId === channelId) ?? null;
}
