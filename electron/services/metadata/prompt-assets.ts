/**
 * Prompt assets — the loader for electron/assets/prompts/
 *
 * WHAT CHANGED. Every model-facing string this app sends used to live in one of three places:
 * a per-channel YAML in userData, a string constant in a .ts file, or a template literal
 * inside the service that sent it. Reading "what do we actually ask the model" meant opening
 * eight files and knowing which of them were live. There is now ONE directory —
 * `prompts/` under the prompt-sets directory — and this module is the only thing that reads it.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE (no fallbacks). A missing file, a missing key, an
 * empty string, a channel id nothing defines: every one of them THROWS, naming the file and
 * the key. There is no built-in copy of any prompt anywhere in the codebase to fall back to,
 * which is the point — a fallback prompt produces output that looks generated and was written
 * to no brief, and nothing downstream can tell the difference.
 *
 * LOADED ONCE. `initPromptAssets` is called at startup (ipc-handlers, right after the assets
 * are installed into userData) and by AIManagerService's constructor, which is the entry point
 * for every code path that reaches a model. It is idempotent for the same root and re-reads on
 * a different one, so the prompt harness and the pure-check tool can point it at the repo's
 * own `electron/assets/prompts`.
 *
 * WHAT IS NOT HERE. The CHANNEL PERFORMANCE DATA block. That block is DATA — derived at run
 * time from the analytics store, with its own provenance (analytics/insights-prompt.ts) — and
 * a copy of it sitting in an asset file would be a snapshot pretending to be a measurement.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as log from 'electron-log';

/** The subdirectory of the prompt-sets directory that holds the whole tree. */
export const PROMPTS_SUBDIR = 'prompts';

/** A channel file: pure data, no instructions. See electron/assets/prompts/channels/*.yml. */
export interface ChannelData {
  /** The stored prompt-set id, e.g. `youtube-telltale`. Unchanged from the yml this replaced. */
  id: string;
  name: string;
  editorialVariant: string;
  fieldVariant: string;
  channelFocus: string;
  /** Which fields this channel publishes, in emission order. */
  fields: string[];
  counts: Record<string, number>;
  /** Replaces the shared titles length/format line where the channel has its own convention. */
  titleFormat?: string;
  /**
   * The creator's search surfaces, filled into the TAGS instruction's `{brand_terms}` slot.
   *
   * DISTINCT FROM `channelTags`, which are appended verbatim by code after the model answers.
   * These are named to the model so the "include channel brand terms" line is followable at
   * all: nothing else in a tags call names the channel, and the genericised line produced tag
   * lists with no brand term in them and, once, an invented one ("O. Morgan").
   */
  brandTerms?: string[];
  channelTags?: string[];
  descriptionLinks: string;
  /** Where this channel was loaded from, for error messages. */
  sourcePath: string;
}

/** One shared field-instruction block, already resolved to the channel's field variant. */
export interface FieldAsset {
  /** The canonical `## ` section name, e.g. TITLES. */
  section: string;
  instructions: string;
  selfCheck: string[];
  /** Self-check lines that need a SECOND field present in the same group to be followable. */
  selfCheckWith: Record<string, string[]>;
  defaultTitleFormat?: string;
  /**
   * `[min, max]` words, on the fields that declare one. Only the description does today.
   *
   * DATA, so the range the prompt asks for and the range the code measures are one value —
   * description-unit.ts substitutes both ends into its body prompt and warns against the same
   * pair. Absent where the field declares none, and the reader that wants it says so.
   */
  wordRange?: [number, number];
  /**
   * Extra rules that apply only when the transcript this field is written from carries speaker
   * attribution. Appended to the section by the caller, beneath the rules it qualifies.
   *
   * Absent on every field but the description today, and absent is a legitimate answer rather
   * than a gap: a field whose rules say nothing different about a tagged transcript declares
   * nothing here. The one caller that needs it says so itself if it is missing.
   */
  taggedAddendum?: string;
}

/** Field id -> the file under prompts/shared/fields/ that carries its instructions. */
const FIELD_FILES: Record<string, string> = {
  titles: 'titles.yml',
  description: 'description.yml',
  tags: 'tags.yml',
  thumbnail_text: 'thumbnail-text.yml',
  hashtags: 'hashtags.yml',
  pinned_comment: 'pinned-comment.yml',
  clip_suggestions: 'clip-suggestions.yml',
  spoken_keywords: 'spoken-keywords.yml',
};

/**
 * The variant marker that DELETES a shared editorial block for one channel rather than
 * replacing it. Shorts has no "WHAT YOU'RE ALLOWED TO DO" block and no internal-analysis step;
 * saying so explicitly is what keeps "this channel drops that block" distinguishable from "that
 * block went missing".
 */
const OMIT = 'omit';

interface EditorialBlock {
  id: string;
  text: string;
}

export class PromptAssets {
  private readonly channels = new Map<string, ChannelData>();
  private readonly editorialBlocks: EditorialBlock[];
  private readonly editorialVariants: Record<string, Record<string, string>>;
  private readonly fieldFiles = new Map<string, any>();
  private readonly pipelineFiles = new Map<string, any>();
  private readonly selfCheckFile: any;

  private constructor(readonly root: string) {
    this.editorialBlocks = [];
    const core = this.readYaml(path.join(root, 'shared', 'editorial-core.yml'));
    const blocks = core.blocks;
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new Error(
        `Prompt asset "shared/editorial-core.yml" has no "blocks" list, so there is no editorial ` +
          `prompt to assemble (${path.join(root, 'shared', 'editorial-core.yml')})`
      );
    }
    for (const block of blocks) {
      if (!block || typeof block.id !== 'string' || typeof block.text !== 'string') {
        throw new Error(
          `Prompt asset "shared/editorial-core.yml" has a block that is not {id, text}: ` +
            `${JSON.stringify(block).slice(0, 120)}`
        );
      }
      this.editorialBlocks.push({ id: block.id, text: block.text });
    }
    this.editorialVariants = (core.variants || {}) as Record<string, Record<string, string>>;

    this.selfCheckFile = this.readYaml(path.join(root, 'shared', 'fields', 'self-check.yml'));

    const channelDir = path.join(root, 'channels');
    if (!fs.existsSync(channelDir)) {
      throw new Error(`Prompt assets have no channels directory: ${channelDir}`);
    }
    for (const file of fs.readdirSync(channelDir).filter((f) => /\.ya?ml$/.test(f))) {
      const channel = this.readChannel(path.join(channelDir, file));
      const existing = this.channels.get(channel.id);
      if (existing) {
        throw new Error(
          `Two channel files declare the same id "${channel.id}": ${existing.sourcePath} and ${channel.sourcePath}`
        );
      }
      this.channels.set(channel.id, channel);
    }
    if (this.channels.size === 0) {
      throw new Error(`Prompt assets define no channels at all: ${channelDir}`);
    }
    log.info(
      `[PromptAssets] loaded ${this.channels.size} channel(s) from ${root}: ` +
        Array.from(this.channels.keys()).join(', ')
    );
  }

  static load(root: string): PromptAssets {
    if (!fs.existsSync(root)) {
      throw new Error(
        `Prompt assets directory not found: ${root}. It ships in the app at ` +
          `electron/assets/${PROMPTS_SUBDIR} and is installed into the prompt-sets directory at startup; ` +
          `if it is absent the install is broken rather than merely out of date.`
      );
    }
    return new PromptAssets(root);
  }

  // ------------------------------------------------------------------ raw reads

  private readYaml(filePath: string): any {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Prompt asset not found: ${filePath}`);
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Prompt asset is not valid YAML (${filePath}): ${reason}`);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Prompt asset is empty or is not a mapping: ${filePath}`);
    }
    return parsed;
  }

  /** A non-empty string at `key`, or a throw naming the file and the key. */
  private requireString(file: any, filePath: string, key: string): string {
    const value = key.split('.').reduce((acc: any, part) => (acc == null ? acc : acc[part]), file);
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(
        `Prompt asset "${filePath}" is missing the "${key}" prompt` +
          (value === undefined ? '' : ` (found ${JSON.stringify(value).slice(0, 80)} instead of a non-empty string)`)
      );
    }
    return value;
  }

  // ------------------------------------------------------------------ pipeline prompts

  /**
   * One prompt out of prompts/shared/pipeline/<file>.
   *
   * `key` may be dotted (`youtube.system`). Missing file, missing key or an empty string all
   * throw naming both — which is the whole contract this module offers its callers.
   */
  pipeline(file: string, key: string): string {
    const filePath = path.join(this.root, 'shared', 'pipeline', file);
    let loaded = this.pipelineFiles.get(file);
    if (!loaded) {
      loaded = this.readYaml(filePath);
      this.pipelineFiles.set(file, loaded);
    }
    return this.requireString(loaded, filePath, key);
  }

  /** A pipeline mapping (e.g. the adapter wire-task table), required to be a string map. */
  pipelineMap(file: string, key: string): Record<string, string> {
    const filePath = path.join(this.root, 'shared', 'pipeline', file);
    let loaded = this.pipelineFiles.get(file);
    if (!loaded) {
      loaded = this.readYaml(filePath);
      this.pipelineFiles.set(file, loaded);
    }
    const value = key.split('.').reduce((acc: any, part) => (acc == null ? acc : acc[part]), loaded);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Prompt asset "${filePath}" is missing the "${key}" mapping`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw new Error(`Prompt asset "${filePath}" key "${key}.${k}" is not a non-empty string`);
      }
    }
    return value as Record<string, string>;
  }

  // ------------------------------------------------------------------ channels

  private readChannel(filePath: string): ChannelData {
    const raw = this.readYaml(filePath);
    const id = this.requireString(raw, filePath, 'id');
    const fields = raw.fields;
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new Error(
        `Channel "${id}" (${filePath}) declares no "fields" list, so nothing says which metadata ` +
          `this channel publishes`
      );
    }
    for (const field of fields) {
      if (!FIELD_FILES[field]) {
        throw new Error(
          `Channel "${id}" (${filePath}) publishes a field "${field}" that has no instruction file ` +
            `(known fields: ${Object.keys(FIELD_FILES).join(', ')})`
        );
      }
    }
    if (raw.brand_terms !== undefined) {
      const valid =
        Array.isArray(raw.brand_terms) &&
        raw.brand_terms.every((t: unknown) => typeof t === 'string' && t.trim().length > 0);
      if (!valid) {
        throw new Error(
          `Channel "${id}" (${filePath}) has a brand_terms key that is not a list of non-empty strings ` +
            `(got: ${JSON.stringify(raw.brand_terms)}). Write it as a YAML list, e.g. ` +
            `brand_terms: ["owen morgan", "telltale"]`
        );
      }
    }
    if (raw.channel_tags !== undefined) {
      const valid =
        Array.isArray(raw.channel_tags) &&
        raw.channel_tags.every((t: unknown) => typeof t === 'string' && t.trim().length > 0);
      if (!valid) {
        throw new Error(
          `Channel "${id}" (${filePath}) has a channel_tags key that is not a list of non-empty strings ` +
            `(got: ${JSON.stringify(raw.channel_tags)}). Write it as a YAML list, e.g. ` +
            `channel_tags: ["Telltale", "Owen Morgan"]`
        );
      }
    }
    return {
      id,
      name: this.requireString(raw, filePath, 'name'),
      editorialVariant: this.requireString(raw, filePath, 'editorial_variant'),
      fieldVariant: this.requireString(raw, filePath, 'field_variant'),
      channelFocus: this.requireString(raw, filePath, 'channel_focus'),
      fields: fields as string[],
      counts: (raw.counts || {}) as Record<string, number>,
      titleFormat: typeof raw.title_format === 'string' ? raw.title_format : undefined,
      brandTerms: raw.brand_terms as string[] | undefined,
      channelTags: raw.channel_tags as string[] | undefined,
      descriptionLinks: this.requireString(raw, filePath, 'description_links'),
      sourcePath: filePath,
    };
  }

  channelIds(): string[] {
    return Array.from(this.channels.keys()).sort();
  }

  hasChannel(id: string): boolean {
    return this.channels.has(id);
  }

  channel(id: string): ChannelData {
    const found = this.channels.get(id);
    if (!found) {
      throw new Error(
        `No channel "${id}" in the prompt assets (${path.join(this.root, 'channels')}). ` +
          `Known channels: ${this.channelIds().join(', ')}`
      );
    }
    return found;
  }

  // ------------------------------------------------------------------ assembly

  /**
   * The editorial prompt for one channel: the shared blocks in order, the channel's variant
   * applied, its focus paragraph substituted, and `{subject}` LEFT ALONE for the per-item fill.
   */
  editorialPrompt(channel: ChannelData): string {
    const overrides = this.editorialVariants[channel.editorialVariant] || {};
    if (channel.editorialVariant !== 'default' && !this.editorialVariants[channel.editorialVariant]) {
      throw new Error(
        `Channel "${channel.id}" asks for editorial variant "${channel.editorialVariant}", which ` +
          `shared/editorial-core.yml does not define ` +
          `(known variants: ${Object.keys(this.editorialVariants).join(', ') || 'none'})`
      );
    }

    const parts: string[] = [];
    for (const block of this.editorialBlocks) {
      const override = overrides[block.id];
      if (override === OMIT) continue;
      const text = override !== undefined ? override : block.text;
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error(
          `Editorial block "${block.id}" resolved to nothing for channel "${channel.id}" ` +
            `(variant "${channel.editorialVariant}")`
        );
      }
      parts.push(text);
    }
    // Function replacer: channel focus is free text and could contain $-patterns.
    return parts.join('\n\n').replace(/\{channel_focus\}/g, () => channel.channelFocus);
  }

  /** One field's instruction block, resolved to the channel's field variant. */
  field(channel: ChannelData, fieldId: string): FieldAsset {
    const file = FIELD_FILES[fieldId];
    if (!file) {
      throw new Error(`No instruction file is registered for the metadata field "${fieldId}"`);
    }
    const filePath = path.join(this.root, 'shared', 'fields', file);
    let loaded = this.fieldFiles.get(file);
    if (!loaded) {
      loaded = this.readYaml(filePath);
      this.fieldFiles.set(file, loaded);
    }

    const variant = channel.fieldVariant;
    const override = variant !== 'default' ? (loaded.overrides || {})[variant] : undefined;
    const source = override || loaded;
    const instructions = this.requireString(
      source,
      `${filePath}${override ? ` (overrides.${variant})` : ''}`,
      'instructions'
    );

    const selfCheck = this.stringList(source.self_check, filePath, `${fieldId} self_check`);
    const selfCheckWithRaw = (source.self_check_with || loaded.self_check_with || {}) as Record<string, unknown>;
    const selfCheckWith: Record<string, string[]> = {};
    for (const [other, lines] of Object.entries(selfCheckWithRaw)) {
      selfCheckWith[other] = this.stringList(lines, filePath, `${fieldId} self_check_with.${other}`);
    }

    const defaultTitleFormat =
      typeof source.default_title_format === 'string'
        ? source.default_title_format
        : typeof loaded.default_title_format === 'string'
          ? loaded.default_title_format
          : undefined;

    // `body_words` falls back to the FILE's value where the variant declares none, exactly as
    // `default_title_format` does — a variant that does not restate a shared number is taking
    // the shared number, not losing it. A value that is present and malformed throws.
    const rawRange = source.body_words !== undefined ? source.body_words : loaded.body_words;
    let wordRange: [number, number] | undefined;
    if (rawRange !== undefined) {
      if (
        !Array.isArray(rawRange) ||
        rawRange.length !== 2 ||
        rawRange.some((n: unknown) => typeof n !== 'number') ||
        rawRange[0] > rawRange[1]
      ) {
        throw new Error(
          `Prompt asset "${filePath}" key "${fieldId} body_words" must be [min, max] with min <= max ` +
            `(got: ${JSON.stringify(rawRange)})`
        );
      }
      wordRange = [rawRange[0], rawRange[1]];
    }

    // Falls back to the FILE's value where the variant declares none, for the same reason
    // `default_title_format` and `body_words` do: a variant that does not restate a shared rule
    // is taking the shared rule, not dropping it. The Shorts and Spreaker description variants
    // both say nothing about speaker tags, and both mean the shared paragraph.
    const taggedAddendum =
      typeof source.tagged_addendum === 'string'
        ? source.tagged_addendum
        : typeof loaded.tagged_addendum === 'string'
          ? loaded.tagged_addendum
          : undefined;

    return {
      section: this.requireString(loaded, filePath, 'section'),
      instructions,
      selfCheck,
      selfCheckWith,
      defaultTitleFormat,
      wordRange,
      taggedAddendum,
    };
  }

  private stringList(value: unknown, filePath: string, what: string): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      throw new Error(`Prompt asset "${filePath}" key "${what}" must be a list of strings`);
    }
    return value as string[];
  }

  /**
   * One field's `## SECTION` block, with the channel's data slots filled.
   *
   * Slots are CHANNEL DATA, never instructions: how many options to ask for, and the title
   * format convention. `{subject}` is not touched here — it belongs to the editorial prompt and
   * is filled per item.
   */
  fieldSection(channel: ChannelData, fieldId: string): string {
    const asset = this.field(channel, fieldId);
    let text = asset.instructions;

    if (text.includes('{title_format}')) {
      const format = channel.titleFormat || asset.defaultTitleFormat;
      if (!format) {
        throw new Error(
          `Channel "${channel.id}" needs a title format line: its titles instructions carry a ` +
            `{title_format} slot and neither the channel nor shared/fields/titles.yml ` +
            `(field variant "${channel.fieldVariant}") provides one`
        );
      }
      text = text.replace(/\{title_format\}/g, () => format.replace(/\s+$/, ''));
    }

    // `{brand_terms}` — the creator's own search surfaces, named in the TAGS instruction so
    // "include channel brand terms" is a line the model can follow. Channel DATA, so the shared
    // instruction never names one channel's terms to another. A channel whose section asks for
    // the slot and declares none throws, exactly as {title_format} does: shipping the literal
    // brace, or quietly blanking it back to the unfollowable line, is what this replaced.
    if (text.includes('{brand_terms}')) {
      const terms = (channel.brandTerms || []).map((t) => t.trim()).filter((t) => t.length > 0);
      if (terms.length === 0) {
        throw new Error(
          `Channel "${channel.id}" declares no brand_terms, which its "${fieldId}" instructions ask ` +
            `for through a {brand_terms} slot (add it to ${channel.sourcePath}, e.g. ` +
            `brand_terms: ["owen morgan", "telltale"])`
        );
      }
      text = text.replace(/\{brand_terms\}/g, () => terms.join(', '));
    }

    // `{<field id>_count}` — how many of that field's options to ask for. Channel data, so the
    // instruction block itself never names a number.
    for (const [field, count] of Object.entries(channel.counts)) {
      text = text.replace(new RegExp(`\\{${field}_count\\}`, 'g'), () => String(count));
    }
    // Count slots follow the `{<field>_count}` convention; an unfilled one means the channel
    // declared a field but not how many of it to ask for, which would ship the literal brace.
    const unfilled = text.match(/\{[a-z_]+_count\}/);
    if (unfilled) {
      throw new Error(
        `Channel "${channel.id}" declares no count for ${unfilled[0]}, which its "${fieldId}" ` +
          `instructions ask for (add it under "counts:" in ${channel.sourcePath})`
      );
    }
    return text;
  }

  /**
   * The FINAL SELF-CHECK block for ONE CALL.
   *
   * This is the fix for a real defect: the self-check used to travel as one verbatim block with
   * whichever call held the titles, so a titles-only call was told "thumbnail options don't
   * repeat core words from the top 3 titles" about thumbnail text it would never write. Lines
   * are assembled from the fields the call ACTUALLY HAS — global lines always, each field's own
   * lines when that field is present, and a cross-field line only when its other field is there
   * to compare against.
   *
   * `alsoAvailable` is what keeps the cross-field lines alive under one call per field. A field
   * listed there is not WRITTEN by this call and contributes no lines of its own — it is handed
   * to the call as INPUT DATA (metadata-tasks.ts `inputFields`), which is all a cross-field
   * check needs: the thumbnail call is given the titles, so "cover angles the titles don't
   * lead with" is a rule it can perform. Without it, splitting titles and thumbnails into separate calls
   * would have silently deleted the one line that ties them together.
   */
  selfCheckBlock(channel: ChannelData, fields: string[], alsoAvailable: string[] = []): string {
    const filePath = path.join(this.root, 'shared', 'fields', 'self-check.yml');
    const header = this.requireString(this.selfCheckFile, filePath, 'header');
    const present = new Set([...fields, ...alsoAvailable]);
    const lines: string[] = [];

    for (const field of fields) {
      if (!FIELD_FILES[field]) continue;
      const asset = this.field(channel, field);
      lines.push(...asset.selfCheck);
      for (const [other, withLines] of Object.entries(asset.selfCheckWith)) {
        if (present.has(other)) lines.push(...withLines);
      }
    }
    lines.push(...this.stringList(this.selfCheckFile.global, filePath, 'global'));

    if (lines.length === 0) {
      throw new Error(
        `The self-check for channel "${channel.id}" came out empty for fields ${fields.join(', ') || 'none'}; ` +
          `shared/fields/self-check.yml must at minimum define "global" lines`
      );
    }
    return [header, '', ...lines.map((l) => `- ${l}`)].join('\n');
  }
}

// ---------------------------------------------------------------------------
// The one instance
// ---------------------------------------------------------------------------

let loaded: PromptAssets | undefined;

/**
 * Load (or reload) the prompt assets from `promptsRoot`.
 *
 * Idempotent for a root already loaded, so the several entry points that legitimately want to
 * guarantee initialization can all call it. A DIFFERENT root re-reads — that is the prompt
 * harness and the pure-check tool pointing at the repo's own assets rather than userData.
 */
export function initPromptAssets(promptsRoot: string): PromptAssets {
  if (loaded && loaded.root === promptsRoot) return loaded;
  loaded = PromptAssets.load(promptsRoot);
  return loaded;
}

/** The loaded assets, or a throw naming who was supposed to have loaded them. */
export function promptAssets(): PromptAssets {
  if (!loaded) {
    throw new Error(
      'The prompt assets have not been loaded. initPromptAssets(<promptSetsDir>/prompts) runs at ' +
        'startup in ipc-handlers and in the AIManagerService constructor; a caller reaching a prompt ' +
        'before either of those has run is running outside the app, and must call it itself.'
    );
  }
  return loaded;
}

/** Test/tooling seam: forget the loaded assets so the next init re-reads from disk. */
export function resetPromptAssets(): void {
  loaded = undefined;
}
