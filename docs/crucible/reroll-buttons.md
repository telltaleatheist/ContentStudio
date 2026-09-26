# Cleanup failures never cost the item, and a re-roll button per section (LEDGER #223)

## 1. A cleanup failure never discards the item

The incident: a 60-minute run finished every field. Then the always-on cleanup (the scrub,
#183) sent the 26 chapter titles to Opus and got 27 lines back. The throw failed the whole
item, and 20+ minutes of finished output were lost.

Owen's ruling: a scrub failure never discards the item. This supersedes #183's "failure is the
item's failure".

- Each part of the cleanup is applied or not on its own. The parts are the description's
  opening line, the description, each alternate description, and the chapter titles
  (`scrubGeneratedItem`, `electron/services/metadata/scrub.ts`).
- If a part's call fails, or its answer cannot be read, that field stays exactly as generated.
  Nothing of it is applied: a miscounted list is still never matched back partially.
- A part that cannot even be planned counts as a failed part. Examples: a description whose
  link block cannot be found, or a chapter with no title.
- The item is saved as usual. It carries `scrubbed.failed`: one entry per field with
  `field`, `item_key`, a plain `reason` and the full `detail`. For example: "Chapter titles
  were not cleaned up: the model returned 27 lines for 26 titles." The numbered Sent/Returned
  lists from 3cf7150 stay in `detail`.
- Every failure is logged as a warn line. In a run, each one is also added to the run's
  warnings.
- A cancel still stops the pass. So does an item with no `_prompt_trace` array, which is a
  bug in the calling code.
- `readRewrittenAnswer` now throws a typed `RewriteShapeError` (Law 10), and the plain
  sentence is built from its fields. Soften's policy is unchanged: when one of its fields
  fails, it writes nothing.

**On the reports page**, the warning shows beside its section: under the description for the
opening line, the description and the alternates, and under the chapter list for the chapter
titles. The **Clean up again** button runs the cleanup on just the failed parts
(`metadata:scrub-item` with `onlyKeys`), on the model in the "Scrub narration" picker. On
write, the older receipt's failures for the other sections are carried forward. A clean
re-run therefore clears only its own warning (`mergeScrubReceipt`, `output-handler.service.ts`).

## 2. Re-roll buttons

| Section | Where | Routing row |
|---|---|---|
| Description (opening line and body) | Description block header: **Re-roll**, **Put back** | description |
| Chapter titles and summaries | Chapters sub-block header | chapters (thinking on) |
| Thumbnail text | Assets › Thumbnail text, top of the open list | thumbnail_text |
| Pinned comment | Assets › Pinned comment, top of the open list | pinned_comment |

"10 more titles" is unchanged. Tags and hashtags are built in code and have no button of their
own.

**What a re-roll sends.** It sends the run's own stored prompt for that section, read from
`_prompt_trace`, which is the same approach as "10 more titles" (#179). The inputs are the ones
the run used. It goes to the model the routing table names now; there is no picker. Two things
are changed before sending:

- The system turn is removed. Crucible records an upstream call as `<system>\n\n<prompt>`, and
  it is removed only when the record starts with it.
- For chapters, each call's two context lines are re-pointed at the titles this re-roll has
  just written: "Previous chapter" and "The chapters just before this one are titled". The
  lines are rendered by the run's own `contextLines`.

Chapters keep the same boundaries; nothing finds them again. A long chapter is re-titled by
its "from its N parts" call, using the parts the run already read.

A report made before prompts were stored is refused in plain words. The message tells Owen to
regenerate the item.

**After the answer.**

1. The cleanup runs over the new text, as it does in a run: the description and opening line,
   or the chapter titles. Thumbnail text and pinned comment are not cleaned up in a run either.
   If the cleanup fails, the re-rolled text is kept and the failure is shown like any other.
2. For chapters, the tags and hashtags are rebuilt by the run's own code: `chapterPools`, then
   `codeOwnedTagFields` (now shared with `metadata-tasks.ts`), then `finalizeTagFields`
   (channel tags and spacing). The text the tags are checked against is read again by
   `finished-item-content.ts`: the video's saved transcript, or the linked editor story. If it
   cannot be read, the tags are left alone and the result says so.

**Previous versions.** Every replacement pushes the version it replaced onto the item as
`reroll_history.<section>[]`, newest last, with the time, the model and any notes.
**Put back** swaps the newest kept version with the one on screen, and the one on screen is
kept in its place. Pressing it twice returns to the start, and no version ever leaves the
record. This is the simplest store that loses nothing, and it lives on the item in the job
file. The .txt and the publish record are not touched.

**Safety.**

- Only one re-roll, put-back or cleanup runs per item at a time. The page disables the buttons,
  and the main process refuses a second request by name.
- The write happens on the output handler's queue. It is refused if the section on disk
  changed while the calls were out.
- A failed re-roll writes nothing, and the page shows the error in red under the section.
- Chapters are the one partial case. A chapter that runs out its budget, or whose answer
  cannot be read, keeps its current title, and the result names it. If no chapter came back
  usable, nothing is written.
- Over a hand edit (a description override, or renamed or deleted chapters), the first press
  arms the button: "Your edit stays in front — re-roll?". The second press sends. The arm
  lapses after 4 s. There are no browser dialogs.

Checked by `tools/scrub-reroll-checks.js` (12 checks, part of `check:pure`). Nothing was run
live.

## HANDOFF: left undone, or for Owen to decide

- **Queue-row notes are not in the tag check.** The notes typed on the queue row ("Additional
  context") were part of the run's content text but are not stored on the report. After a
  chapter re-roll, a tag that came only from those notes is not rebuilt. The result says so
  every time.
- **Chapter thinking on a re-roll is always on.** This is #208's declared default. The run's
  own setting is not stored on the report.
- **Old reports.** Reports from the whole-transcript chapter engine, or from before prompts
  were stored, have no per-chapter prompts. Their chapter re-roll is refused. The description
  re-roll needs the one-call description (`the description primary description for …`), so
  reports from the older two-call design are refused too.
- **The re-roll gate's flags are not re-judged after a re-roll.** They are only shown on
  titles, which are not re-rolled here.
- **A put-back leaves the cleanup receipt alone.** After Put back, a cleanup warning about the
  re-rolled text can still show. "Clean up again" handles it.
- Not live-tested (by rule). Owen tests.
