# Thumbnails in the metadata run (phase 1)

Built 2026-09-28 (LEDGER #240). The metadata job now makes the thumbnails while its models are
loaded, so the report opens with **three title and thumbnail pairs** ready for YouTube's Test &
Compare ("title and thumbnail" mode takes up to 3 pairs). Phase 2 (a later build) adds the reports
page's thumbnail pop-up, reordering and swapping, the ordered picks, publishing, and removes the
Thumbnails test tab. This file is the contract phase 2 is written against.

Owen's rulings (2026-09-28):
- Thumbnails are produced during the metadata job, while models are loaded.
- Three titles and three thumbnails go to Test & Compare. Thumbnail n's words COMPLEMENT title n,
  never restate it (YouTube: the title "is often meant to complement the thumbnail — to provide a
  second chance at winning the click").
- One look (font, colours, photos, logo) for all three channels.
- Frame scoring adds about 4 minutes of GPU per video: accepted.
- The old THUMBNAIL TEXT OPTIONS field retires.

Code: `electron/services/thumbnails/pipeline.ts` (the stages), `pipeline-record.ts` (the stored
shape and its reader), `story-match.ts` (the story link), `pipeline-setup.ts` (what the IPC layer
reads at job time), `pipeline-electron.ts` (the renderer in the app). Keeper:
`tools/thumbnail-pipeline-checks.js`, part of `npm run check:thumbnail-lab`.

## Stage order

One metadata job, one job on the card, the job's own leases (`JobLeases`: one hold per server; the
same model is the same hold; a different model replaces it). In `metadata-generator.service.ts`:

| # | Stage | Where | Model (routing row) | When |
|---|-------|-------|---------------------|------|
| 0 | transcription | GPU | ASR | as before (ipc-handlers `runPipeline`) |
| 1 | `story` | CPU | none | every item, before any chapter |
| 2 | `frames` | CPU | none | " |
| 3 | `scoring` | GPU | `thumbnail_frames` (default the 9B with vision) | " |
| - | channel lessons | GPU/cloud | titles row | moved here: after the scoring, before the first chapter (only when the evidence moved) |
| - | chapters, fields, scrub, re-roll gate | GPU/cloud | as routed | per item, as before |
| 4 | `words` | GPU/cloud | `thumbnail_words` (default the 8-bit 27B) | per item, after the gate (the titles are settled and, with the gate on, ranked) |
| 5 | `tone-photos` | GPU | `thumbnail_judge` (default the 8-bit 27B) | " |
| 6 | `render` | CPU | none | " |
| - | save | | | the record rides on the item |

**One swap.** The vision model is loaded once, before the chapters; the chapters' model replaces it
on the card (the job's lease on the vision model is given back first). The channel lessons were
moved from the top of the run to just before the first chapter for this: a local distillation
before the scoring would have loaded the text model, then the vision model, then the text model
again. **No reload of the 27B**: when routing names the same model for the fields and for the words
and the tone/photo, they run on the hold the fields left. The exception is stated, not hidden: with
the re-roll gate ON (it ships off, LEDGER #210) its fixed 9B scorer runs after the fields, so the
27B is loaded again for the words. A words prompt larger than the window the fields loaded grows the
window once (lease.ts: growth is legitimate within a job).

**Timings** (no live run yet; these are the tab's measurements and the maintainer's figures):
- story: reading the week's story transcripts, a second or two.
- frames: about 75 s on the rapture story (749.7 s of screen recording: 757 sampled, 300 kept,
  18 then 12 scenes), CPU only.
- scoring: at most 120 frames, one `decideItems` call each; about 1.9 s a frame on the Mac, so
  about 4 minutes (Owen accepted this).
- words: three calls (one per title) on the 27B; unmeasured.
- tone-photos: one tone decide and three photo decides, text only; seconds.
- render: three renders on the hidden canvas page, about a second each.

Each record carries its own `timings` (seconds per stage). The queue row shows the stages as
"Thumbnails: scored 40 of 120 frames" (phase `thumbnails`, shown as main writes it).

## The story link

`story-match.ts`, three declared methods in order, the method recorded on the link:

1. **manual**: the operator linked the item on the Inputs page (the content link). Used as it is,
   never replaced.
2. **name**: the export's name finds exactly one story of its week (the finder's exact-title or
   label tier) whose transcript is exported. Checked against the transcript: when the transcript
   match finds a clear winner that is a DIFFERENT story, nothing is linked and both are named.
3. **transcript**: the item's transcript against every exported story transcript of the item's week
   (`<week>/files/<session>/<session>_stories_transcripts/*.json`, the sessions the tab's picker
   lists). 24 windows of 12 words spread across the item's transcript, normalised (lower case,
   apostrophes dropped, other non-letters spaces), cut into 5-word n-grams; a window hits a story
   when 2 of its n-grams are in it. A winner needs at least 4 hits and a quarter of the windows,
   and twice the runner-up's hits.

Anything else is **no story**, with the reason and the counts (`evidence`: windows, stories read,
stories not searched and why, the top three). The link lives only on the report's
`thumbnails.story`; it never becomes the item's content link (LEDGER #142, #144) and the publish
record's `transcriptRef` is not written, so no manual link is ever overwritten.

## The pairs

- **Titles.** The re-roll gate's ranking when it ranked the titles (`reroll_gate.ranking.order`),
  else the titles in the order the titles field wrote them; the top three. The order used is
  recorded (`titles.order`: `gate ranking` | `as written`).
- **Words.** One call per title on the `thumbnail_words` row (thumbnails.yml `text`, unchanged: 2-5
  words, capitals, "adds something the title leaves unsaid"), five options each of claim, stakes
  and reaction. All kept.
- **Default of each pair.** Pair 1 starts on its first claim, pair 2 on its first stakes, pair 3 on
  its first reaction (three ideas in the three arms, as the tab does). A kind with no options starts
  on the next kind that has one, said in the pair's `lines`.
- **Frames.** The best frame of a different scene per pair, best scene first; with fewer scenes
  than pairs, the scenes' second (clearly different) frames next; a repeat is said.
- **Tone and photos.** One tone decide, then every reaction photo ranked for each pair's default
  words. Each pair's photo is drawn from its top 3 (photo-draw.ts), a photo already on another pair
  left out while another remains, with ONE seed per item stored as `seed`.
- **Render.** 1280x720 on the saved look (`thumbnailLab.style`, the tab's; the default look when
  none is saved, said), the logo kept in the app (none kept: none drawn, said), the renderer's own
  rules (face-safe text, 7% floor, too long refused for that pair and said).

## Where it is stored

**Files**: `<report folder>/thumbnails/<jobId>-<item number>/`, where the report folder is the job's
`txt_folder` (`<outputDir>/<job name>/`):

```
thumbnails/<jobId>-1/
  frames/f00013.jpg, s00013.jpg ...   the scored frames only (640 and 320 wide; the rest are deleted)
  full/f12.png ...                    the default frames at full size
  Pair 1 - <title>.png                the three defaults (JPEG when the PNG is over 2 MiB)
  Pair 2 - <title>.png
  Pair 3 - <title>.png
```

This is never the week's `thumbnails/` folder: the publish pass proposes only
`<week>/thumbnails/<export name>.png` (thumbnail-validate.ts, LEDGER #219), so nothing is attached,
proposed or uploaded before Owen picks. Starting the same job again (a send-held-prompt retry)
replaces the folder, said. An item that fails and is not saved has its folder removed, logged.

**Record**: the `thumbnails` key on the item in `<outputDir>/.contentstudio/metadata/<jobId>.json`,
read with `readItemThumbnails(value, where)` (refuses another version by name; `null` for an item
from before this build). Version 1:

```jsonc
{
  "version": 1,
  "state": "made",            // made | no-story | off | failed
  "line": "3 title and thumbnail pairs are ready to pick from.",   // the report's one line
  "failure": null,            // { "stage": "scoring", "reason": "\"mac\" cannot show pictures ..." }
  "story": {                  // null only when "off"
    "state": "linked", "method": "transcript",          // manual | name | transcript
    "ref": { "kind": "acs-story", "path": ".../02-f1-the-rapture.json", "via": "transcript-match", ... },
    "line": "The file name matches no story. Linked by the transcript to story 2 ...",
    "evidence": { "probes": 24, "searched": 5, "notSearched": [...], "top": [{ "session", "number", "title", "hits" }] }
  },                          // or { "state": "none", "reason": "...", "evidence": ... }
  "folder": ".../thumbnails/job-123-1",
  "source": { "video": ".../2026-09-24 screen capture.mp4", "lines": ["Story \"f1 - the rapture\" ...", ...] },
  "scenes": [{ "number": 1, "seconds": 182, "label": "Scene 1 · 3:02 on screen", "kept": 84, "scored": 23 }],
  "frames": [{ "id": "f12", "t": 626.7, "clock": "10:26", "scene": 1, "large": ".../frames/f00013.jpg",
               "small": ".../frames/s00013.jpg", "score": 0.61, "reading": { "pScreen", "pFace", "expression", "pEyesOpen", "pStrong" },
               "flag": null }],   // flag: screen | unreadable (then score null)
  "bestScenes": [{ "scene": 1, "ids": ["f12", "f40"], "more": ["f77"], "best": 0.61 }],
  "scoring": { "server": "mac", "model": "qwen3.5-9b-vl", "line": "Scored 120 frames ..." },
  "titles": { "order": "as written", "subjects": ["Title 1", "Title 2", "Title 3"] },
  "tone": { "ranking": [{ "name": "absurd", "p": 0.55 }, ...], "model": "qwen3.8-27b-8bit", "server": "mac" },
  "pairs": [{
    "pair": 1, "title": "Title 1",
    "words": { "claim": [...5], "stakes": [...5], "reaction": [...5], "warnings": [], "model": "qwen3.8-27b-8bit" },
    "photos": [{ "name": "horrified", "p": 0.6 }, ...],     // every photo, for the default words
    "default": { "frameId": "f12", "scene": 1, "kind": "claim", "phrase": "DON'T STAND UNDER A ROOF",
                 "photo": "horrified", "draw": { "name", "p", "chance", "pool", "repeatForced" }, "logo": true,
                 "render": { "ok": true, "file": ".../Pair 1 - Title 1.png", "format": "png", "bytes": 1340000, "notes": [] } },
    "lines": ["Photo: horrified (60%), drawn from the top 3: ..."]
  }, ...],
  "seed": 1234567,
  "look": { ... ThumbnailStyle ... },
  "logo": "<userData>/thumbnail-lab/logo/logo.png",
  "lines": ["Sampled 757 frames ...", "The tone reads as absurd (55%) ...; photos drawn with seed 1234567."],
  "timings": [{ "stage": "story", "seconds": 0.8 }, ...],
  "picks": []                  // phase 2: ordered [{ "title", "file" }], at most 3, no title twice
}
```

**States.** `made`: every stage ran (a pair whose words did not fit carries `render.ok: false` and
its reason; the line says how many were drawn). `no-story`: `story.state` is `none`, its reason in
`line`; nothing written, no model called. `off`: switched off for the run, a channel with
`thumbnails: false`, a channel file that does not say (a locally edited copy), a caller without the
thumbnail setup (the test CLI), a compilation, or the Thumbnails tab's saved settings unreadable;
the reason is the `line`. `failed`: `failure.stage` and `failure.reason` in plain words; the stages
after it did not run; the item's other fields were generated and saved as usual, and the run's
warnings carry the same line (the chapters' and the scrub's convention, LEDGER #148, #223). A stop,
a park or a stall is never a failure: it ends the job through the generator's one exit.

**The one write door**: `OutputHandlerService.updateItemThumbnails(jobId, itemId, update)` (on the
write queue; the record is read and checked, `update` returns the new record, which is checked
again before it is written; a refused write leaves the file byte for byte).

## The per-run switch

`generate-metadata` with `thumbnails: false` makes none, and each record says "Thumbnails were
switched off for this run." Absent or `true` is on. The queue does not send the switch yet (the
inputs page was off-limits for this build); phase 2 may add it to the queue's options.

## What changed for the old THUMBNAIL TEXT OPTIONS field

- `thumbnail_text` was removed from the `fields:` list and `counts:` of `telltale.yml`,
  `unfiltered.yml` and `fireside.yml`: no new report generates it. Every channel file gained
  `thumbnails: true` (those three) or `thumbnails: false` (shorts, spreaker).
- Kept for now, for the reports already written and the UI phase 2 removes: the field definition
  (`metadata-fields.ts`, `thumbnail-text.yml`), the `thumbnail_text` routing row, the section
  re-roll button's field, the scrub/soften/re-roll gate readers. An installed channel file with
  local edits keeps its old list (the startup install withholds edited files), so such a channel
  still writes the field, and its runs make no thumbnails ("its thumbnails key is missing").
- The routing dialog's thumbnails group heading no longer says "Not used by metadata runs".

## What phase 2 needs (IPC to build)

Every write goes through `updateItemThumbnails`. GPU steps outside a metadata job run as their own
lane job (like the tab: `lanes.runJob`, or standalone `queueAITask` steps under one held job so the
words and the tone/photo share a load, `lab-service.ts textJob`).

1. **List candidates**: `thumbnails:item {jobId, itemId}` → the record, plus picture data for the
   frames it shows (`bestScenes` rows first; `more` on demand; `frames[].small`/`large` are paths).
2. **Re-render a pair with swapped pieces**: `thumbnails:render-pair {jobId, itemId, pair, frameId?,
   phrase? (or kind + option index), photo? (a name, or "draw" with a seed), logo: boolean}` → extract
   the frame (`full/`), render with the record's `look` (or the current saved look, said), write a NEW
   file beside the old (`Pair 1 - <title> (2).png`), and set `pairs[n].default` to it. Earlier files
   stay (a pick may point at one). "No text" / "No photo" are Owen's picks only (the tab's rule).
3. **Re-write words for a different title** (Owen reorders or swaps titles): `thumbnails:pair-title
   {jobId, itemId, pair, title}` → the words call for that title (`thumbnail_words` row), the photo
   ranking for the pair's new default words (`thumbnail_judge`; the tone may be reused from
   `tone`), a new draw and a new render; `pairs[n].title/words/photos/default` replaced. When Owen
   reorders the report's titles (the publish record's `chosenTitles`), call it for each pair whose
   title changed. Words already written for a title can be reused when that title moves to another
   pair (look it up in `pairs[].title`).
4. **Save ordered picks**: `thumbnails:save-picks {jobId, itemId, picks: [{title, file}]}` → `picks`
   (index 0 is the first A/B arm; at most 3; no title twice). Publishing reads the picks; nothing
   before that attaches a thumbnail.
5. **No story / failed**: `thumbnails:link {jobId, itemId, projectFolder, storyNumber, storySlug}`
   records a manual link (build the ref with `refFromCandidate(candidate, 'manual')`), then
   `thumbnails:run {jobId, itemId}` runs the stages for that item as its own lane job (the item's
   saved transcript for the words; its `titles`/`reroll_gate`/`description` for the pairs).

**Before the tab goes**: the photo library, photo notes, logo and look are managed only on the tab
(`lab-service.ts`: add/remove photos, notes, logo, style). `pipeline-setup.ts` imports the store
keys `STYLE_STORE_KEY` and `PHOTO_NOTES_STORE_KEY` from `lab-service.ts`; move them (and that UI)
first. Shared modules the pipeline uses and must keep: story-source, story-match, frame-sampler,
frame-metrics, frame-scenes, frame-ranking, frame-scorer, prompts, words-writer, judge,
photo-library, photo-draw, reaction-photos, photo-trim, logo, layout, renderer, canvas-page,
pipeline*. Lab-only: lab-service, thumbnail-lab-ipc, combine, the frontend `components/thumbnails/`.
The tab's own `linkOf` reads the publish record / `content_provenance`; the pipeline's link is
`thumbnails.story`, which the pop-up should show.

## Open questions

- The name method: the tab's rule was "never linked by name" ("f2 - the rapture" is made from "f1 -
  the rapture"); the coordinator's brief was name first. Built as name first, checked against the
  transcript (a disagreement links nothing). Owen may want transcript-only.
- The words prompt was not changed; "adds something the title leaves unsaid" is the complement rule
  already. A line citing "a second chance at winning the click" would be a prompt change for Owen.
- Imported story transcripts (`transcript_file` items) carry their story's identity in `importMeta`
  but no week folder; they get "no story" today.
- Whether a pair should fall back to the next word option when its default is too long for the
  space (today: that pair is not drawn and says why).
- Deleting an item from the reports page does not remove its thumbnails folder yet (phase 2: add it
  to `deleteItem`'s receipt).
- No live run: the stage timings above are not measured in the job.

## Handoff

Built on the agent branch from `crucible` (dcdd0c4), not merged. Commits, in order: shared pieces
out of the tab + the scorer under a caller's job; the story link; the pipeline, record, setup,
channels, keeper; this doc and the ledger. Checks: build:all, check:thumbnail-lab (54 + 11 + 15),
check:pure, check:crucible, check:p4, tools/routing-publish-checks.js.
