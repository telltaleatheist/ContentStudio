# titlecheck: data extracted read-only from ContentStudio (2026-09-23)

The build script is at `../titlecheck_build.py`. No models were run and no ContentStudio files were changed.

## Sources
- Generated jobs: `/Volumes/Callisto/ContentStudio/.contentstudio/metadata/*.json` (261 files: 230 `job-*` from the app, 31 `cli-*` from the headless CLI; 236 items). The path is `<outputDirectory>/.contentstudio/metadata/<jobId>.json` (output-handler.service.ts:151), and `outputDirectory` is set in `~/Library/Application Support/contentstudio/config.json`.
- Scrub receipts: the `scrubbed` key is on 40 items and `scrubbed_earlier` on 1. The after-text of an older receipt is the before-text of the next receipt that changed the same field. Otherwise it is the item's current text.
- CLI chapter caches: `.contentstudio/cli-cache/*.chapters.json` (7 files). Titles come from `result.chapters`, and 9 judge warnings come from `warnings`.
- Judge warnings: `~/Library/Logs/contentstudio/main.log` + `main.old.log` (82 `[Chapters] ... is titled "..."` lines, from 2026-08-30 on). A log line doesn't name its video, so `video` is filled only when the title also appears in a job or cache (74 of 91).
- Owen's manual edits: `~/Library/Application Support/contentstudio/publish/selections/items/*.json` (235). This covers `chapterEdits`, `descriptionOverride`, `chosenTitles`, `titleEdits` and `videoId`.
- A/B tests: `~/Library/Application Support/contentstudio/analytics/<channelId>/ab-tests.json`. Video metadata comes from `videos.json`, and the channel names come from `channels.json`.
- Exporter CSVs: none were found in ~/Downloads, ~/Desktop or ~/Documents, and no file anywhere in ~/Downloads contains `variantTitle` or `isWinner`.

## Files and counts
- `chapters.jsonl`: 1528 unique chapter titles.
  - Flag counts: unflagged 1159, scrub_kept 224 (the scrub saw the title and left it), judge_warned 91 (56 narrates_actor, 35 ungrounded_name), scrub_changed 33 (+33 scrub_output), owen_edited_from/to 15/15.
  - Overlaps: 18 titles are both judge_warned and scrub_changed. 17 judge_warned titles were kept by the scrub, and most of those are ungrounded-name warnings, which the scrub doesn't target.
- `descriptions.jsonl`: 571 unique texts (fields description, description_hook, description_options).
  - Flag counts: scrub_changed 21 (7 description, 8 hook, 6 options) with 21 scrub_output, scrub_kept 123, owen_override 9, unflagged 397.
  - Full descriptions still include the shared link block.
- `titles.jsonl`: 210 jobs with a candidate list (2090 candidates, usually 10 per job).
  - 142 have `chosen` (Owen's A/B picks, as edited), 105 have a YouTube `youtube_video_id`, and 26 link to a decided A/B test (`ab_winner`).
- `ab.jsonl`: 177 decided tests (all `method: test-compare`, all with a winner).
  - By channel: Fireside Chat 129, Owen Morgan (Telltale) 32, Unfiltered 16. One Unfiltered test has only 2 variants.
  - Shares are the watch-time share per variant, in percent.
  - 26 tests were on ContentStudio-generated videos (`contentstudio_generated`).

## Notes and surprises
- Only 19 items had their chapters changed by the scrub (33 titles) and 7 had their main description changed. On 18 items the scrub saw the chapters and changed nothing.
- On the 26 linked A/B tests, only 58 of 78 variant titles exactly match Owen's `chosenTitles`, and just 18 winners appear verbatim among the generated candidates. Titles are often edited again after they are chosen.
- Two older A/B backups (`_backup-ab-purge-20260821-152403/`, `*.bak-20260821-final-purge`) hold no tests that are missing from the current files.
- Excluded:
  - the prompt-campaign outputs in `.contentstudio/chapter-campaign/` (experimental prompt variants, not production)
  - the chapter `detail` text (it is full of "The speaker…", which could be a useful extra negative-framing set)
  - `analytics/*/descriptions.json` (live YouTube descriptions, not generated ones)
- Unflagged does not mean clean. Items generated before the scrub (2026-09-04) and before the judges were never checked, so some unflagged rows are narrator-framed.
