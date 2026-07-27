/**
 * Description Composer
 *
 * Turns a generated item's separate `description`, `hashtags` and `chapters` fields into
 * the single block of text that actually goes in YouTube's description box.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE: this used to live only in the reports page, so the
 * app displayed a composed description (chapters at the top, hashtags before the links)
 * while the extension filled Studio with the RAW `item.description` — no chapters, no
 * hashtags. Two implementations of "the description" is one too many; the one that reaches
 * YouTube has to be the one on screen. This is now the only implementation, and the
 * renderer reads its output back over `publish-get-resolved` rather than composing again.
 *
 * Pure, synchronous, no I/O — the report shapes are all it knows.
 *
 * Report field shapes are TOLERANT because reports written by older versions are still on
 * disk: `description` may be a string or an object, `chapters` entries may use several key
 * names. That is reading a real historical format, not guessing at missing data.
 */

/** Chapter timestamps must start at 00:00 for YouTube to accept the list at all. */
export interface ComposableItem {
  description?: unknown;
  hashtags?: unknown;
  chapters?: unknown;
  tags?: unknown;
}

/** The main body text, from either the string or the object form. */
export function descriptionText(description: unknown): string {
  if (typeof description === 'string') return description;
  if (description && typeof description === 'object') {
    const obj = description as Record<string, unknown>;
    for (const key of ['text', 'description', 'value', 'content']) {
      if (typeof obj[key] === 'string') return obj[key] as string;
    }
  }
  return '';
}

export function chapterTimestamp(chapter: unknown): string {
  if (typeof chapter === 'string') {
    const match = chapter.match(/^(\d{1,2}:\d{2}(?::\d{2})?)/);
    return match ? match[1] : '';
  }
  if (chapter && typeof chapter === 'object') {
    const obj = chapter as Record<string, unknown>;
    for (const key of ['timestamp', 'time', 'start', 'startTime']) {
      if (typeof obj[key] === 'string') return obj[key] as string;
    }
  }
  return '';
}

export function chapterTitle(chapter: unknown): string {
  if (typeof chapter === 'string') {
    return chapter.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*[-–—]?\s*/, '').trim();
  }
  if (chapter && typeof chapter === 'object') {
    const obj = chapter as Record<string, unknown>;
    for (const key of ['title', 'name', 'text', 'label']) {
      if (typeof obj[key] === 'string') return obj[key] as string;
    }
  }
  return '';
}

/**
 * Markers for where the boilerplate link block starts.
 *
 * Hashtags go BEFORE the links, not at the very end, because YouTube only shows the first
 * three hashtags above the title and burying them under a wall of links loses them.
 *
 * ORDER IS SIGNIFICANT and matches the reports page this was extracted from: the first
 * marker in THIS list that appears anywhere wins, not the one that appears earliest in the
 * text. That is deliberate — 🔥 heads the real link block ("🔥 Support the Show:"), while
 * 📖 and 🎥 label individual entries inside it and also show up in body copy. Reordering
 * this list, or switching to earliest-position, changes where hashtags land in every
 * description that has ever been generated.
 */
const LINK_BLOCK_MARKERS = ['🔥', '📖', '🎥', 'Support the Channel', 'Become a YouTube Member'];

/**
 * The full description as it should be typed into YouTube.
 *
 * Order: chapters (YouTube requires them at the top to build the chapter bar), body,
 * hashtags before the link block, then the links.
 */
export function composeDescription(item: ComposableItem): string {
  let result = '';

  const chapters = Array.isArray(item.chapters) ? item.chapters : [];
  if (chapters.length > 0) {
    const lines = chapters
      .map((c) => `${chapterTimestamp(c)} - ${chapterTitle(c)}`)
      // A chapter with neither a timestamp nor a title would render as a bare " - ".
      .filter((line) => line.trim() !== '-');
    if (lines.length > 0) result = `${lines.join('\n')}\n\n`;
  }

  result += descriptionText(item.description);

  const hashtags = typeof item.hashtags === 'string' ? item.hashtags.trim() : '';
  if (!hashtags) return result;

  // Some prompt sets already embed the hashtags in the description body. Adding them a
  // second time is the visible failure this check prevents.
  if (result.includes(hashtags)) return result;

  const insertAt = firstMarkerIndex(result);
  if (insertAt !== -1) {
    const beforeLinks = result.substring(0, insertAt).trimEnd();
    const linksSection = result.substring(insertAt);
    return `${beforeLinks}\n\n${hashtags}\n\n${linksSection}`;
  }

  return `${result.trimEnd()}\n\n${hashtags}`;
}

/**
 * Position of the highest-priority marker present, or -1 when there is no link block.
 * Priority is LINK_BLOCK_MARKERS order — see the comment there.
 */
function firstMarkerIndex(text: string): number {
  for (const marker of LINK_BLOCK_MARKERS) {
    const pos = text.indexOf(marker);
    if (pos !== -1) return pos;
  }
  return -1;
}

/** Tags as a comma-separated string, from either the string or the array form. */
export function composeTags(item: ComposableItem): string {
  const tags = item.tags;
  if (Array.isArray(tags)) {
    return tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean).join(', ');
  }
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .join(', ');
  }
  return '';
}
