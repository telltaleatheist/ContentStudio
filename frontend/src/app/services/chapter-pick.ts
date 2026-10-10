/**
 * What the chapter pipeline detects for a job (LEDGER #213, #280): `auto` (the default) draws
 * chapters on a video up to 20 minutes and stories past it, by the video's own runtime; `chapters`
 * and `stories` are that grain at any length, as the operator set it. The main process reads the
 * same three values (electron/services/metadata/chaptering/granularity.ts `chapterPickOf`).
 */
export type ChapterPick = 'auto' | 'chapters' | 'stories';

/**
 * A pick as this renderer stored it. The retired three-way selector's `detailed` and `broad`
 * (#170) were both single-video chaptering, so they become `chapters`, said once in the console;
 * anything else is a value this code never wrote, refused by name.
 */
export function migrateChapterPick(value: unknown, where: string): ChapterPick {
  if (value === 'auto' || value === 'chapters' || value === 'stories') return value;
  if (value === 'detailed' || value === 'broad') {
    console.info(`[ChapterPick] ${where}: the retired "${value}" pick is now "chapters" (LEDGER #213)`);
    return 'chapters';
  }
  throw new Error(`${where}: unknown chapter pick ${JSON.stringify(value)} (expected auto, chapters or stories)`);
}
