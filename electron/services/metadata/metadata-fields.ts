/**
 * Metadata Field Registry
 *
 * Single source of truth for the AI-returned metadata fields. This registry
 * drives both the response normalizer (ai-manager.service.ts) and the
 * human-readable .txt writer (output-handler.service.ts), so adding a future
 * field is a single entry here.
 *
 * NOTE: `chapters` is intentionally NOT in this registry. It is a typed object
 * array handled specially by both consumers (in the .txt it is injected right
 * after `thumbnail_text`).
 *
 * The ORDER of METADATA_FIELDS drives the .txt layout and matches the current
 * output so existing files don't churn.
 */

export interface MetadataFieldDef {
  /** Canonical key in MetadataResult */
  key: string;
  /** Alternate keys models might return */
  aliases: string[];
  /** How the raw value is normalized */
  kind: 'string' | 'stringArray' | 'tags' | 'hashtags';
  /** Section header in the readable .txt */
  txtLabel: string;
  /** numbered list / raw block / comma-joined line */
  txtStyle: 'numbered' | 'block' | 'inline';
  /**
   * When true, a stringArray field that comes out empty becomes `undefined`
   * instead of `[]`. Only applies to 'stringArray' kind.
   */
  emptyToUndefined?: boolean;
}

export const METADATA_FIELDS: MetadataFieldDef[] = [
  {
    key: 'titles',
    aliases: ['titleOptions', 'title_options', 'titleSuggestions'],
    kind: 'stringArray',
    txtLabel: 'TITLES',
    txtStyle: 'numbered',
  },
  {
    /**
     * The description's first line — the ~150 characters YouTube shows as the search snippet
     * and above the fold on mobile (metadata spec §1.1).
     *
     * Its own field rather than the first line of `description` because the composer has to
     * put it ABOVE the chapter block while the body sits below it (§3's ruled order), and
     * splitting one string back apart at compose time would be parsing a field this app
     * already had structured.
     *
     * ABSENT on every item generated before this build, and on every item that took the
     * legacy single call. The composer treats absence as "this item composes the old way",
     * which is the same tolerant-historical-read contract it already had.
     */
    key: 'description_hook',
    aliases: ['descriptionHook', 'hook'],
    kind: 'string',
    txtLabel: 'DESCRIPTION HOOK',
    txtStyle: 'block',
  },
  {
    key: 'description',
    aliases: [
      'episode_description',
      'episodeDescription',
      'show_description',
      'showDescription',
      'podcast_description',
      'podcastDescription',
    ],
    kind: 'string',
    txtLabel: 'DESCRIPTION',
    txtStyle: 'block',
  },
  {
    /**
     * The alternative descriptions, each already flattened to `<hook>\n\n<body>`.
     *
     * DIRECTLY AFTER `description`, because that is where they are read: the operator reads the
     * one this run chose, then the others, and decides. Putting them anywhere else in this list
     * would move them somewhere else in the .txt, which is the only thing this order controls.
     *
     * The label says "alternatives" so the numbering cannot be misread. The list holds the
     * EXTRAS only — the primary is the DESCRIPTION section immediately above — so "1." here is
     * the second description of the item, and a reader who saw "1." next to a description
     * identical to the one above would reasonably wonder which was which.
     *
     * `emptyToUndefined` because a run with no extras (they all failed, declared in the
     * warnings) should print no section at all rather than an empty heading.
     */
    key: 'description_options',
    aliases: ['descriptionOptions', 'description_candidates'],
    kind: 'stringArray',
    txtLabel: 'DESCRIPTION OPTIONS (alternatives to the one above)',
    txtStyle: 'numbered',
    emptyToUndefined: true,
  },
  {
    key: 'tags',
    aliases: [],
    kind: 'tags',
    txtLabel: 'TAGS',
    txtStyle: 'inline',
  },
  {
    key: 'thumbnail_text',
    aliases: ['thumbnailText', 'thumbnailTextOptions', 'thumbnail_text_options', 'thumbnailOptions'],
    kind: 'stringArray',
    txtLabel: 'THUMBNAIL TEXT OPTIONS',
    txtStyle: 'numbered',
  },
  // chapters injected here (between thumbnail_text and hashtags) — handled specially
  {
    key: 'hashtags',
    aliases: [],
    kind: 'hashtags',
    txtLabel: 'HASHTAGS',
    txtStyle: 'block',
  },
  {
    key: 'pinned_comment',
    aliases: ['pinnedComment', 'pinned_comments'],
    kind: 'stringArray',
    txtLabel: 'PINNED COMMENT OPTIONS',
    txtStyle: 'numbered',
    emptyToUndefined: true,
  },
  {
    key: 'spoken_keywords',
    aliases: ['spokenKeywords'],
    kind: 'stringArray',
    txtLabel: 'SPOKEN KEYWORDS (say these aloud in the clip)',
    txtStyle: 'inline',
    emptyToUndefined: true,
  },
];
