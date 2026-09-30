// electron/services/editor/story-routing.ts
import {
  MetadataRoutingOption,
  migrateStoredRouting,
  resolveChapterModelOption,
  resolveMetadataRouting,
  ResolvedMetadataRouting,
  routedModelString,
  RoutingModels,
} from '../metadata/metadata-routing';

/**
 * Which model the editor's Stories analyzer runs on: the CHAPTERS row of the metadata routing
 * table, and nothing else.
 *
 * The analyzer used to have its own picker — a dropdown of whatever Ollama had pulled, saved
 * under `editor.ollamaModel.v2` in the editor window's localStorage — which made it the one
 * model call in the app that the routing table did not choose. Owen, 2026-09-24 (LEDGER
 * #204): "it should never call something i didnt expect it to call"; and 2026-09-25 (#205):
 * the Stories analyzer follows the chapters routing now, its picker goes, and
 * `story:suggest-title` follows the same selection.
 *
 * Resolved EXACTLY as the transcript episode splitter resolves it (ipc-handlers.ts
 * `analyze-transcript-split`): the stored routing is migrated, resolved against the table,
 * and the chapters entry is read through `resolveChapterModelOption`. Same three functions,
 * same order, so the editor cannot name one model while a generation run uses another.
 *
 * PURE — no electron, no store access. The caller hands in whatever the store holds under
 * `metadataRouting`, and the call's routed models bound on its server (RoutingModels, read by the
 * caller from that server's catalog), so the pure checks (tools/) can assert every outcome without
 * a window. The chapters row names a MODEL; the server's catalog names the build (2026-09-29).
 * A stored selection this build cannot honour THROWS from `resolveMetadataRouting`, naming
 * the entry (Law 1): the analyzer refuses rather than running on a default the operator
 * never saw. An ABSENT store is not that case — it resolves to the table's shipped default,
 * which is the row the routing dialog shows, exactly as every generation run treats it.
 */
export interface StoryModel {
  /** The routing option the chapters row names. */
  option: MetadataRoutingOption;
  /** What AIManagerService's makeRequest routes on: a Crucible id, or `claude-cli:<alias>`. */
  model: string;
  /** The option's label, for the editor's read-only line ("Stories run on <label>"). */
  label: string;
  kind: MetadataRoutingOption['kind'];
}

/** The stored routing, migrated and resolved against the table: what the story calls read. */
export function storyRouting(storedRouting: unknown): ResolvedMetadataRouting {
  return resolveMetadataRouting(migrateStoredRouting(storedRouting).selections);
}

export function resolveStoryModel(storedRouting: unknown, models: RoutingModels): StoryModel {
  const option = resolveChapterModelOption(storyRouting(storedRouting), models);
  return { option, model: routedModelString(option), label: option.label, kind: option.kind };
}
