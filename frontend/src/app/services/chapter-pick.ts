/**
 * What the chapter pipeline detects for a job (LEDGER #213): `chapters` for every single video,
 * however long, and `stories` for a weekly podcast compilation. The main process reads the same
 * two values (electron/services/metadata/chaptering/granularity.ts `chapterPickOf`).
 */
export type ChapterPick = 'chapters' | 'stories';

/**
 * A pick as this renderer stored it. The retired three-way selector's `detailed` and `broad`
 * (#170) were both single-video chaptering, so they become `chapters`, said once in the console;
 * anything else is a value this code never wrote, refused by name.
 */
export function migrateChapterPick(value: unknown, where: string): ChapterPick {
  if (value === 'chapters' || value === 'stories') return value;
  if (value === 'detailed' || value === 'broad') {
    console.info(`[ChapterPick] ${where}: the retired "${value}" pick is now "chapters" (LEDGER #213)`);
    return 'chapters';
  }
  throw new Error(`${where}: unknown chapter pick ${JSON.stringify(value)} (expected chapters or stories)`);
}
