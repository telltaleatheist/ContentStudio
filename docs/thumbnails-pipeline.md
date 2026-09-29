# Thumbnails: the metadata run and the reports page

Phase 1 built 2026-09-28 (LEDGER #240): the metadata job makes the thumbnails while its models are
loaded, so the report opens with **three title and thumbnail pairs** ready for YouTube's Test &
Compare ("title and thumbnail" mode takes up to 3 pairs). Phase 2 built the same day (LEDGER #241):
the reports page's **Thumbnails window** (ordered picks, swaps, rewriting words for a title, own
images, screenshots for a report with no story), publishing pick 1, the one **Thumbnail look**, the
new text rules, deleting a report's thumbnails with it, and the Thumbnails test tab removed
(docs/thumbnails-lab.md is kept, marked retired). Phase 2 is described in its own section below.

Owen's rulings (2026-09-28):
- Thumbnails are produced during the metadata job, while models are loaded.
- Three titles and three thumbnails go to Test & Compare. Thumbnail n's words COMPLEMENT title n,
  never restate it (YouTube: the title "is often meant to complement the thumbnail — to provide a
  second chance at winning the click").
- One look (font, colours, photos, logo) for all three channels.
- Frame scoring adds about 4 minutes of GPU per video: accepted. (Superseded 2026-09-29, LEDGER #244:
  the frame scoring was removed; Owen picks the frames. See the last section.)
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
| 2 | `frames` | CPU | none | " (the grid: at most two frames a scene, the sharpest, look-alikes dropped) |
| - | channel lessons | GPU/cloud | titles row | just before the first chapter (only when the evidence moved) |
| - | chapters, fields, scrub, re-roll gate | GPU/cloud | as routed | per item, as before |
| 3 | `words` | GPU/cloud | `thumbnail_words` (default the 8-bit 27B) | per item, after the gate (the titles are settled and, with the gate on, ranked) |
| 4 | `render` | CPU | none | " (only pairs that have a frame: screenshot pairs; a story's pairs wait for Owen's frame picks. No photo: Owen picks them) |
| - | save | | | the record rides on the item |

Removed 2026-09-29: `tone-photos` (the `thumbnail_judge` row, LEDGER #243) and `scoring` (the
`thumbnail_frames` row, the 9B with vision, LEDGER #244). Both are in `RETIRED_STAGES`: an older
record that names them is still read.

**No model before the chapters** (since 2026-09-29). Until then the vision model was loaded once
before the chapters for the frame scoring and the chapters' model replaced it (one swap); the channel
lessons were moved from the top of the run to just before the first chapter for that, and stay there.
**No reload of the 27B**: when routing names the same model for the fields and for the words
(and, until 2026-09-29, the tone/photo), they run on the hold the fields left. The exception is stated, not hidden: with
the re-roll gate ON (it ships off, LEDGER #210) its fixed 9B scorer runs after the fields, so the
27B is loaded again for the words. A words prompt larger than the window the fields loaded grows the
window once (lease.ts: growth is legitimate within a job).

**Timings** (no live run yet; these are the tab's measurements and the maintainer's figures):
- story: reading the week's story transcripts, a second or two.
- frames: about 75 s on the rapture story (749.7 s of screen recording: 757 sampled, 300 kept,
  18 then 12 scenes), CPU only.
- scoring: removed 2026-09-29 (it was at most 120 `decideItems` calls, about 4 minutes on the Mac).
- words: three calls (one per title) on the 27B; unmeasured.
- tone-photos: removed 2026-09-29 (it was one tone decide and three photo decides).
- render: from a story, nothing (no pair has a frame until Owen picks); from screenshots, one render
  per screenshot on the hidden canvas page, about a second each. The window draws the rest on
  Generate thumbnails.

Each record carries its own `timings` (seconds per stage). The queue row shows the stages as
"Thumbnails: sampled 50 of 757 frames..." (phase `thumbnails`, shown as main writes it).

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
- **Frames.** None (since 2026-09-29): the run gives no pair a frame, and each says "No frame picked
  yet: pick one in the Thumbnails window." Owen picks frames 1, 2 and 3 from the grid; pair n is drawn
  on frame n when he presses Generate thumbnails. (Until then: the best-ranked frame of a different
  scene per pair.) Pairs made from his screenshots are drawn on screenshot n.
- **Tone and photos** (removed 2026-09-29: the defaults are drawn with no photo and Owen picks them;
  kept here as the phase-1 record). One tone decide, then every reaction photo ranked for each pair's default
  words. Each pair's photo is drawn from its top 3 (photo-draw.ts), a photo already on another pair
  left out while another remains, with ONE seed per item stored as `seed`.
- **Render.** 1280x720 on the saved look (`thumbnailLab.style`, look.ts; the default look when none
  is saved, said), the logo kept in the app (none kept: none drawn, said), the renderer's own rules
  (phase 2: the text box left of the photo, one or two lines, shrunk to fit, never refused; see
  "The text always fits" below).

## Where it is stored

**Files**: `<report folder>/thumbnails/<jobId>-<item number>/`, where the report folder is the job's
`txt_folder` (`<outputDir>/<job name>/`):

```
thumbnails/<jobId>-1/
  frames/f00013.jpg, s00013.jpg ...   the grid's frames only (640 and 320 wide; the rest are deleted)
  full/f12.png ...                    the frames drawn, at full size
  Pair 1 - <title> (2).png            written by Generate thumbnails (JPEG when the PNG is over 2 MiB);
  ...                                 the run writes none for a story (screenshot pairs: Pair n - <title>.png)
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
  "failure": null,            // { "stage": "words", "reason": "qwen3.5-9b is not downloaded on \"mac\" ..." }
  "story": {                  // null only when "off"
    "state": "linked", "method": "transcript",          // manual | name | transcript
    "ref": { "kind": "acs-story", "path": ".../02-f1-the-rapture.json", "via": "transcript-match", ... },
    "line": "The file name matches no story. Linked by the transcript to story 2 ...",
    "evidence": { "probes": 24, "searched": 5, "notSearched": [...], "top": [{ "session", "number", "title", "hits" }] }
  },                          // or { "state": "none", "reason": "...", "evidence": ... }
  "folder": ".../thumbnails/job-123-1",
  "source": { "video": ".../2026-09-24 screen capture.mp4", "lines": ["Story \"f1 - the rapture\" ...", ...] },
  "scenes": [{ "number": 1, "seconds": 182, "label": "Scene 1 · 3:02 on screen", "kept": 84, "shown": 2 }],
  "frames": [{ "id": "f12", "t": 626.7, "clock": "10:26", "scene": 1, "large": ".../frames/f00013.jpg",
               "small": ".../frames/s00013.jpg" }],   // the grid, in time order
  // Records before 2026-09-29 also carry scenes[].scored, frames[].score/reading/flag, "bestScenes"
  // and "scoring" (the frame scoring): read and ignored.
  "titles": { "order": "as written", "subjects": ["Title 1", "Title 2", "Title 3"] },
  "tone": { "ranking": [{ "name": "absurd", "p": 0.55 }, ...], "model": "qwen3.8-27b-8bit", "server": "mac" },
  "pairs": [{
    "pair": 1, "title": "Title 1",
    "words": { "claim": [...5], "stakes": [...5], "reaction": [...5], "warnings": [], "model": "qwen3.8-27b-8bit" },
    "photos": [{ "name": "horrified", "p": 0.6 }, ...],     // every photo, for the default words
    "default": { "frameId": "f12", "scene": 1, "kind": "claim", "phrase": "DON'T STAND UNDER A ROOF",   // frameId/scene null until Owen picks the frame
                 "photo": "horrified", "draw": { "name", "p", "chance", "pool", "repeatForced" }, "logo": true,
                 "render": { "ok": true, "file": ".../Pair 1 - Title 1.png", "format": "png", "bytes": 1340000, "notes": [] } },
    "lines": ["Photo: horrified (60%), drawn from the top 3: ..."]
  }, ...],
  "seed": 1234567,
  "look": { ... ThumbnailStyle ... },
  "logo": "<userData>/thumbnail-lab/logo/logo.png",
  "lines": ["Sampled 757 frames ...", "The tone reads as absurd (55%) ...; photos drawn with seed 1234567."],
  "timings": [{ "stage": "story", "seconds": 0.8 }, ...],
  "picks": []                  // phase 2: ordered, at most 3 (see "The ordered picks" below)
}
```

**States.** `made`: every stage ran (before phase 2 a pair whose words did not fit carried
`render.ok: false` and its reason; the words are always drawn now; since 2026-09-29 a story's pairs
are `made` with no frame and no render until Owen picks and generates). `no-story`: `story.state` is `none`, its reason in
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

**Phase 2 additions to version 1** (no record had picks before, so the version did not change):
`pairs[].default.phrase`, `.kind`, `.photo` and `.draw` may be null (Owen's "No text", typed words,
"No photo", a photo he chose); `pairs[].rankedFor` says which words the photo ranking was made for
(absent in phase-1 records, where it is the first default's words, and written before the first
swap changes them); `source.video` is null when the backgrounds are screenshots; `picks` is the
shape below.

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

## Phase 2: the reports page (built 2026-09-28, LEDGER #241)

Owen's rulings (2026-09-28): a Thumbnails pop-up from the metadata report; ordered picks 1/2/3
like the titles, pair n = title n + thumbnail n, pick 1 the primary with no A/B test; swaps redrawn
at once on the CPU; "Rewrite words for this title" (27B on demand) when a pair's title changes;
text always drawn (1 or 2 lines, shrink, the box from the left margin to the photo and up to the
top, off faces where possible, never refused); manual upload stays and can be a pick; no story:
1-3 of his screenshots make that many thumbnails; deleting a report removes its thumbnails folder;
one look for all three channels; pick 1 published through the existing thumbnail path, picks 2-3
beside it for Test & Compare in Studio; the test tab and the old THUMBNAIL TEXT OPTIONS UI removed.

### Where things live

| What | Where |
|------|-------|
| The window (MatDialog, like the Inputs page's dialogs) | `frontend/src/app/components/thumbnails-window/thumbnails-window.{ts,html,scss}`, opened by the reports page's **Thumbnails** block (under the titles: the record's line, the picks, "Open thumbnails…") |
| The look (photos, notes, logo, font, colours, spaces) | `thumbnail-look-dialog.ts` (same folder), opened from the window's "Thumbnail look…", the Thumbnails block's "Look…", and **Settings › Thumbnails** — a dialog, because the look is one setting for all three channels and is best edited next to the pictures it changes; Settings reaches the same dialog |
| Main process | `report-thumbnails.ts` (the window's actions), `look.ts` (the look, moved out of the tab's `lab-service.ts`; the store keys keep their `thumbnailLab.*` names so Owen's saved look and notes stay), `thumbnails-ipc.ts` (the `thumbnails:*` channels) |
| Keeper | `tools/thumbnail-pipeline-checks.js` (the phase-2 checks at its end) and `tools/thumbnail-lab-checks.js` (the text rules), both in `npm run check:thumbnail-lab` |

IPC (`thumbnails:*`, each answering `{ ok, value }` or `{ ok: false, error }`): `summary`, `item`,
`frames`, `render-pair`, `pair-title`, `save-picks`, `screenshots`, `choose-own`,
`choose-screenshots`, `release-model`, `show-folder`, and the look's `get-style`, `set-style`,
`photos`, `set-photo-note`, `choose-photos`, `add-photos`, `remove-photo`, `copy-old-photos`, `logo`,
`choose-logo`, `copy-old-logo`; progress on `thumbnails:progress`. Every write goes through
`updateItemThumbnails`. One action per item at a time (a second is refused in plain words while
one runs).

### The ordered picks

`picks` is ordered, at most 3, each `{ kind: 'made', pair, file, wordsFor }` (a pair's current
render and the title its words were written for) or `{ kind: 'own', file }` (Owen's own image, read
in place, checked against YouTube's thumbnail rules, thumbnail-validate.ts). No file twice, no pair
twice. The interaction is the titles' (publish-state.ts `toggleTitle`): the first thumbnail clicked
is pick 1, clicking a picked one removes it and the rest close the gap, a fourth is refused.

**Pairing is by position and read live**: pick n goes with the report's chosen title n (the publish
record's `chosenTitles`). When pick n's words were written for another title (Owen reordered his
titles), the window and the report say so and offer **Rewrite words for this title**
(`thumbnails:pair-title`: the words row for that title and a new render with the pair's photo kept,
on ONE held lease of the 27B; the pair and its pick follow. Until 2026-09-29 it also ran the
tone/photo row and a new draw).

**Copies and publishing.** Every save writes `<folder>/picks/Pick 1.png`, `Pick 2.png`, `Pick 3.png`
(`.jpg` for a JPEG), exactly the picks, in order (the folder is emptied first; no picks, no
folder). **Pick 1's copy is the video's thumbnail**: the window sets it through
`PublishState.setThumbnail` (the same door as the Thumbnail row's Choose…; recorded as a manual
choice, uploaded by the existing publish path, LEDGER #219 limits) whenever pick 1 changes; with no
picks left, a thumbnail that was pick 1's copy is cleared, and one Owen chose himself is left.
Picks 2 and 3 are shown on the Thumbnail row as "For your A/B test" with "Show the picks": YouTube
has no API for Test & Compare, so he uploads them in Studio beside titles 2 and 3.

### Swaps

`thumbnails:render-pair { pair, frameId?, phrase? (null: No text), kind?, photo? (a name, null: No
photo, 'draw': a new draw from the pair's top 3), logo? }` redraws that pair on the CPU with the
**current** saved look, as a NEW file beside the old (`Pair 1 - <title> (2).png`; the old file stays,
a pick or the publish record may point at it). A picked pair's pick follows it. The window shows the
scene strip (two frames per scene, "More" loads the rest), the words per kind (or typed words), the
photos ranked with their percentages (and for which words the ranking was made), the logo switch,
and "Write the words again for another title".

### The text always fits (layout.ts)

The text box runs from the left margin to where the reaction photo begins (its drawn bounds with
the outline; its whole space when no photo is drawn) and from the top margin to the bottom margin.
One or two lines, left-aligned, shrunk from the largest size (`maxCapFraction`) until it fits.
Faces (and the logo, if its space reaches into the box) are kept clear when a face-free space in
the box holds the words at `minCapFraction` (7%); otherwise the words go in the whole box, no bigger
than 7% and smaller until they fit, at the top or the bottom, whichever covers less of a face, and
the render's notes say so. Nothing is refused and nothing is cut. (Until phase 2 a phrase that could
not keep the 7% floor clear of the faces was refused, and the text could sit anywhere on up to three
lines.)

### No story: screenshots

For a report whose record is `no-story` or `failed` (or made from screenshots before), the window
takes 1, 2 or 3 of Owen's screenshots (PNG or JPEG) and makes that many pairs, one per title (his
chosen titles first, then the generated ones): each screenshot is cut to 16:9 around its centre when
it is another shape and scaled to 1920x1080 (said per screenshot), the words, tone and photos run on
the routing table's rows as in the run (pipeline.ts `ItemThumbnailRun.fromScreenshots`), and the
record becomes `made` with `source.video: null`; its story (and why there was none) is kept, his own
picks stay, pair picks are cleared. A report whose pairs came from its story refuses screenshots.
The folder is `<report folder>/thumbnails/<jobId>-<item id>/` (a folder the window creates is named
by the item id, which never collides; the run's are named by the item number).

### Deleting

Deleting an item on the reports page removes the folder its record names, when it sits directly in
`<report folder>/thumbnails/` (and that `thumbnails/` folder once empty); a folder named anywhere
else is left and the page says so (`DeleteItemReceipt.thumbnailsFolderRemoved` /
`thumbnailsReason`). The whole-job cleanup (history delete, the four-week prune,
`deleteJobTxtFiles`) removes each item's folder the same way. The app does not ask before deleting
a report (it never has); the notification says the thumbnails folder went with it. Owen's own image
files are never inside it.

### What went

The Thumbnails tab (route, sidebar entry, component), `lab-service.ts`, `thumbnail-lab-ipc.ts`,
`combine.ts` and every `thumbs:*` channel. The reports page's THUMBNAIL TEXT OPTIONS section (and
its line in the text export); an older report that still has the field shows nothing for it. Still
kept for older reports: the field definition, its routing row, the section re-roll's field and the
scrub/soften/gate readers (no UI reaches the re-roll for it now).

## The window rebuilt as one flow (2026-09-29, LEDGER #242)

Owen tried the phase-2 window: "im clicking things and nothing is doing anything at all ... the
images it gathered from the original section should be at the top. i pick three. the text it
generated. i pick three. it overlays them." His run had stopped at `tone-photos` (the photo library
was empty; the copy-into-app offer had lived in the removed tab), the window let him click the
editor of a stopped record, and every refusal reached only the log.

**The window, top to bottom** (`thumbnails-window.{ts,html,scss}`; the picking rules are pure in
`thumbnails-compose.ts`):

1. One line: "Pick up to three frames, then up to three lines of text. Your thumbnails appear
   below." A sticky status under it: the running step with a spinner and a running clock (and the
   main process's progress line), a red banner for any failure ("Drawing thumbnail 3 failed: ..."),
   a neutral line for a refused click (a fourth pick).
2. **Frames** from the story's section: two per scene, More per scene. Up to three in click order,
   badges 1/2/3; clicking a picked one takes it out and the rest close up. "Start from the suggested
   three" fills frames, words and photos from the run's three pairs; "Clear picks".
3. **Text**: every generated line in one list, each labelled with its kind and the title it was
   written for; "No text"; typed words ("Add as a pick"). Up to three in click order, badges 1/2/3.
4. **Photos** (optional), per thumbnail: "Draw from top 3" (the default), the ranked photos with
   their percentages (the ranking of the pair the words came from, said: "ranked for ..."), the
   library's unranked photos after them, "No photo"; the Logo switch.
5. **Your thumbnails**: thumbnail n = frame n + text n + photo n + logo, large and phone-size, drawn
   on the CPU as soon as both are picked. **Saved as you go** (chosen over a Save button: the drawn
   thumbnails ARE the picks, in order; pick 1 is set as the video's thumbnail through
   `PublishState.setThumbnail` whenever its source changes). Each card: its role, the title it goes
   with (pick k with chosen title k), "Rewrite words for this title" when its words were written for
   another title, "Use my own image..." (his file takes that place; the frames and texts fill the
   others), a missing piece said ("Pick frame 3 above."). A card whose drawing is stale (a failed
   redraw) is dimmed.
6. Screenshots for a no-story record (unchanged) and "Make thumbnails again from scratch".

**How a thumbnail is drawn.** Thumbnail n is drawn into pair n of the record (`wantedChange`: the
fields pair n must change to show place n, or null). `PairChange` gained `wordsFor` (words written
for any title; stored as `default.wordsFor`, and the pick's `wordsFor` comes from it) and
`rankingOf` (the pair whose ranking a draw uses). An auto photo is kept while it was drawn from the
top 3 of that ranking. The window draws, then saves the picks when they differ; a click while it
runs makes it go round again; a draw that still does not match afterwards stops with a banner (no
loop). A redrawn pair's old render is removed once no pick points at it (the published file is the
pick's copy in `picks/`), so clicking through does not pile files up.

**Every failure shows in the window.** Every call goes through one `ActionRunner` (one action at a
time, in order; busy line and clock; a failure becomes "<what> failed: <the main process's
sentence>"). Buttons that cannot act are disabled with the reason written beside them, not only in a
tooltip. Too few reaction photos is a banner at the top with "Thumbnail look...".

**A stopped record.** The banner names the stage and the reason, what is kept and what Finish runs,
and why it cannot finish yet. **Finish making thumbnails** (`thumbnails:finish`,
`ReportThumbnails.finish`): `pipeline.ts resumePlan` keeps each stage whose output is all stored
(story; frames and scoring together, since the scene rows need the frames' colour signatures, which
are not stored; words; tone-photos) and runs every stage from the first missing one;
`ItemThumbnailRun.resume` clears what the later stages write, keeps own-image picks, and says
"Finished in the Thumbnails window after stopping at the X stage: ... kept as stored; ... run." in
the record's lines. The render always runs. **Make thumbnails again from scratch**
(`thumbnails:remake`): `ItemThumbnailRun.start` with the item's folder (the frames stage replaces
it, said), own-image picks kept. Both run on ONE held job (`transport.job`; the window's text hold
is given back first; every model call is its own GPU step on the lanes, as in the run) given back
after. Both are refused before any model call when the library has fewer than two photos or no
Crucible server is selected (`lanes.gpuVenue`); the view carries the reason (`finish.blocked`,
`remake.blocked`). The item's input kind is not stored: a record that linked a story, or a measured
video duration in `content_provenance`, makes it a video.

**The empty library at pipeline time** stays a stated stop (no fallback), now said before the tone
call and naming where photos are added (`photo-library.ts photosMissingReason`): "The app's reaction
photo library has no photos, and ranking them needs at least 2. Add your reaction photos in
Thumbnail look (...)". Rewrite and screenshots check it first too.

**Keeper** (`tools/thumbnail-pipeline-checks.js`, +4): errors reach the window (the empty-library
stop, Finish blocked and refused before any model call, the runner's banner line, every window call
through the runner, every channel answering `{ ok, error }`); Finish resumes only the missing stages
(no frame scored or word written again; 1 tone + 3 photo decides on one lease; a stop at render
draws only; the plans for scoring and screenshots; a render file gone is drawn again); from scratch
runs everything on one job; picking (click order, close up, fourth refused, thumbnail n = frame n +
text n + photo n, words for title 2 on thumbnail 1 said on the pick, drawing each wanted change makes
it match, the picks in order, reopening reads them back, own image in a place). The swap check now
expects the replaced render removed.

**Looked at** on scratch data (`CONTENTSTUDIO_USER_DATA` scratch folder, a fixture from the keeper's
synthetic session, the fake Crucible standalone; no live Crucible call): the stopped banner with the
empty-library reason and Finish disabled, Finish enabled once photos are in, Finish running (clock,
progress) and finishing on the fake, three hand-picked overlays, reopening with the picks read back,
a photo choice, and a draw failure as a banner.

## Photos picked by Owen, Generate at the bottom, the border (2026-09-29, LEDGER #243)

Owen, after the one-flow window: "make the text slightly smaller"; "just let me pick the image of
myself that goes in the corner instead of letting the model pick it. itll be faster"; "for my images,
let me click 1->2->3, same as everything else"; "the thumbnail text should be a list i pick. 1, 2,
3"; "we dont need to separate by scene. just show a list of possible images to use"; "the 'generate
thumbnails' button should be at the bottom"; and his border ("this goes over the thumbnail. it's a
border i always use").

**The model's tone and photo ranking is gone.** The `tone-photos` stage, `judge.ts`, `photo-draw.ts`
(the top-3 draw), the `thumbnail_judge` routing row, thumbnails.yml `tone.*` / `photo.*` and the photo
notes (they only fed the ranking) are removed. A stored `thumbnail_judge` selection is dropped with a
logged notice and written back (`REMOVED_ROUTING_TASKS`, the routing file's retirement pattern); Owen's
saved notes stay in the settings under `thumbnailLab.reactionNotes`, unread. The stages are now story,
frames, scoring, words, render; after the frame scoring the run asks no decide at all.

**What the run draws now (the simpler of the two options):** the three defaults are still drawn, with
**no reaction photo**, and each pair's `lines` says "No photo picked yet: pick one in the Thumbnails
window." (the record's line ends "; no photo picked yet."). Keeping the render stage kept the record,
`resumePlan` and Finish as they were; not drawing would have changed what `made` means. The window
opens with nothing picked; "Start from the suggested three" fills the run's frames and words (no
photos). (Superseded by #244, the last section: the run gives a story's pairs no frame, so it draws
nothing for them, and the button fills the words only.)

**Older records.** `failure.stage` may still name `tone-photos` (`RETIRED_STAGES`; Owen's first run
stopped there). Such a record keeps story, frames, scoring and words; the view adds "That step is
gone: you pick the photos yourself below, so Finish only draws the thumbnails." and Finish draws with
no model call and no lease. `tone`, `seed`, `photos`, `rankedFor` and `draw` stay readable and are no
longer written (null / empty).

**The window** (`thumbnails-window.{ts,html,scss}`, rules pure in `thumbnails-compose.ts`):

1. **Frames**: ONE flat grid (`frameList`): the run's two-per-scene frames (still deduplicated) ordered
   best score first, no scene labels; the other candidates behind "Show more (n)". Click order 1/2/3.
   (Since #244: every candidate in time order, no scores, no "Show more".)
2. **Text**: a vertical list, one line each: the words, then "kind · for “title”" small. Typed words
   and "No text". Click order 1/2/3.
3. **Photos**: one row of the library's photos plus "No photo". Click order 1/2/3; photo n goes on
   thumbnail n; a thumbnail beyond the photos picked has none. "No photo" can be picked more than once
   (its badges show every place it holds; clicking a badge takes that one out). No percentages. The
   Logo switch sits in this row's header.
4. **Generate thumbnails** at the bottom of the picks. Nothing is drawn on a click. Disabled, with the
   reason written beside it, until at least one frame and one text (or "No text") are picked (or one
   of his own images is set); beside it, what it will draw ("1: frame 1 + text 1 + photo “horrified” ·
   ..."). Pressing it draws every ready place fresh (`drawChange`, so a look changed since applies),
   checks each now shows its picks, then saves the places as the ordered picks (pick 1 the video's
   thumbnail, as before).
5. **Your thumbnails**: shown once generated. A card whose picks changed since is dimmed and says
   "Your picks for it changed: press Generate thumbnails."; its line says "No photo picked yet" when
   no photo pick stands for it.

**Text size.** The look gains `textScale` ("Text size (% of the largest that fits)", 50-100%, default
85%): the size layout.ts chooses is drawn at that fraction, so the largest letters are 17% of the
height instead of 20% and a width-limited phrase is 15% smaller; where the words go (off the faces or
not) is decided at the full size, still one or two lines, never refused. `maxCapFraction` stays 20%.

**The border.** One PNG kept in `<userData>/thumbnail-lab/border/` (photo-library.ts `libraryBorder` /
`setLibraryBorder`, checked by border.ts `readBorder`: a missing file, one that is not a picture, not
16:9, fully transparent or fully opaque is refused naming the file; a refused file leaves the kept
one). Thumbnail look: "Border", its picture, "Choose file…"/"Replace…", and "Draw the border" (the
look's `border`, saved with Save look). Drawn over the whole frame scaled to the output with a normal
alpha composite, before the patch and words, the photo and the logo (canvas-page.ts). It REPLACES the
procedural vignette: `vignette`/`vignetteStrength` are removed from the look. On by default; with no
border kept nothing is drawn and the record says "No border is kept in the app, so none is drawn."
(or that it is switched off).

**A look saved before 2026-09-29** has no `textScale` and no `border` and has the retired vignette:
`readStoredStyle` reads it with the new defaults (85%, border on, vignette dropped) and a line saying
so, in the record's lines and in Thumbnail look. Nothing is written back until Save look. So Owen's
saved look (if any) gets the smaller text and his border without him doing anything.

### The saved picks, for the A/B fill (the browser extension, later)

The extension's A/B fill (Studio's "Title and thumbnail" Test & Compare) was deferred to a session with
a live Studio window. What it will read, all written already:

- The record: the item's `thumbnails` key in `<outputDir>/.contentstudio/metadata/<jobId>.json`, read
  with `readItemThumbnails`. `picks` is ordered, at most 3.
- The files: `pickCopies(record)` (pipeline-record.ts) gives `{ n, pick, file }` per pick, where `file`
  is `<record.folder>/picks/Pick n.png` (`.jpg` when the picked file is not a PNG). The copies are
  rewritten on every save, exactly the picks in order; no picks, no `picks/` folder.
- The pairing: pick n goes with the report's chosen title n (the publish record's
  `chosenTitles[n - 1]`), read live, because Owen can reorder titles after picking. Each made pick also
  stores `wordsFor` (the title its words were written for), which is not the pairing.
- The transport the extension already uses for the single thumbnail (`GET /publish/thumbnail`,
  publish-bridge `getThumbnail`: fitted, base64 in JSON through the service worker) is the model for a
  per-pick route; the extension would set each file on the variant's file input with a DataTransfer,
  and never press Set test.

**Screenshots** (scratch userData, a fixture from the keeper's synthetic session, the fake Crucible
standalone, Owen's photos, logo and border COPIED into the scratch folder; no live Crucible; session
scratchpad `shots2/shots/`): the window open with nothing picked; frames and text picked; photos
picked 1, No photo 2, laugh 3 with Generate enabled and its plan; the three generated thumbnails; the
cards after a photo pick changed; Thumbnail look's border and text size; a record stopped at
tone-photos and Finish.

## The frame scoring removed: Owen picks the frames (2026-09-29, LEDGER #244)

Owen now picks frames 1, 2 and 3 himself from the flat grid, so the vision model's ranking was not
needed; and its one live run had just failed: the load went to `crucible@owens-pc-wsl` and was
refused (a context of 8192 over that host's 1700 ceiling for `qwen3.5-9b-vl`). No frame was ever
scored for real.

**Removed**: the `scoring` stage (`THUMBNAIL_STAGES` is story, frames, words, render), frame-scorer.ts,
frame-ranking.ts, thumbnails.yml `frames.*` and the frame-question code in prompts.ts, frame-scenes.ts
`allocateScoring` / `framesToScore` / `sceneRows` (the "best by scene" rows), `MAX_FRAMES_TO_SCORE`,
`defaultFrames` (each pair's ranked default frame), the setup's Crucible doors (pipeline-setup.ts),
the `thumbnail_frames` routing row and the four vision rungs offered only on it (`qwen35-9b-vl`,
`qwen35-2b`, `qwen35-08b`, `qwen38-27b-vl`; a stored selection of either is dropped loudly and written
back: `REMOVED_ROUTING_TASKS` / `REMOVED_ROUTING_OPTIONS`), `visionAvailability` and the options'
`vision` flag, the record's `scoring` and `bestScenes` and each frame's `score` / `reading` / `flag`,
the window's "Show more" and its `thumbnails:frames` channel. The Crucible transport's generic
`decideItems` and image support are untouched (nothing in the app calls them now).

**How the grid is chosen, on the CPU** (frame-scenes.ts `gridFrames`): sampling, the blur and repeat
filters and the scene grouping are unchanged; then each scene offers `gridQuota` frames: two
(`GRID_PER_SCENE`), one when it was on screen under `SHORT_SCENE_SECONDS` (10 s, the short-scene rule
the scoring allocation had), never more than it kept. They are chosen with `thinAcrossRange` over the
scene's first to last appearance: the sharpest (Laplacian variance, the blur filter's measure) of
each half of its time on screen, so a scene the story returns to shows both visits. Only those
frames stay on disk; the record's `frames` is the grid in time order (`scenes[].shown` says how many
of each scene's), and the window shows it in time order with no scores and no "Show more".

**Look-alikes dropped** (2026-09-29, Owen: "can we programmatically select similar frames so we dont
have 60 frames that are basically identical to each other?"; frame-scenes.ts `distinctFrames`): after
the per-scene quota, the grid keeps a frame only when its colour signature differs from every frame
already kept in more than `DISTINCT_MIN_FRACTION` (0.25) of the cells, sharpest first. A shot split
over several scenes, or a scene's two frames of one talking head, collapse to one. Measured on his
old grids that day: witzke 105 → 14, the Alex Jones trump story 120 → 47 (varied footage stays
varied), christian nationalist 24 → 5. The frames line in the record counts what was dropped.

**Pairs get no frame from the run.** `default.frameId` / `default.scene` are null for a story's pairs
(the pair's line says "No frame picked yet: pick one in the Thumbnails window."), the render stage
draws only pairs that have a frame (screenshot pairs, screenshot n on pair n), and the record's line
is "3 title and thumbnail pairs have their words; pick the frames and photos in the Thumbnails
window." The window's Generate thumbnails is already gated on a frame and a text being picked for a
place; drawing a pair with no frame (`renderPair`) and "Rewrite words for this title" on one are
refused by name, and a saved pick whose pair has no frame is refused on reading the picks (nothing
is substituted). "Start from the suggested three" became **Start from the suggested words** (in the
Text header): pair n's default words as text n; frames and photos are his.

**Older records.** A record that stopped at `scoring` (`RETIRED_STAGES`) is read. Its frames are the
up-to-120 it sent to the scoring (its scenes say `scored`, not `shown`), so Finish keeps only the
story and runs frames, words and render: the grid is chosen again, look-alikes dropped. A record
stopped at a removed stage (`tone-photos`, `scoring`) is headed "These thumbnails are not finished
yet." with no reason line (Owen: "if the step was removed, why would it say it was removed?"): the
removed step is not named and its old reason (a refused vision model, an empty library) is not shown. Resuming a story record (any stop) clears the frames the
old ranking gave its pairs, so only screenshot pairs are drawn. `bestScenes`, `scoring` and the
per-frame scores stay in old JSON, unread.

**Keeper**: thumbnail-pipeline-checks.js 24 (no model before the chapters and no decide at all, the
27B the job's only load; the grid's per-scene bound, time order and disk; no pair framed or drawn by
the run; a words-stage failure; old scored records read and resumed; a frameless pair refused;
Finish on a tone-photos record draws nothing; a screenshots record stopped at render draws only;
from scratch loads only the 27B; frameList in time order, suggested words, Show more gone; the
scorer, ranking, frame prompts, routing row and frames channel gone); thumbnail-lab-checks.js 31
(grid quota and choice replace the allocation, ranking and scoring checks); routing-publish-checks.js
(the frame row and vision rungs retired loudly; one thumbnails row); test-crucible-acts.js (the
option list).

## Open questions

- The name method: the tab's rule was "never linked by name" ("f2 - the rapture" is made from "f1 -
  the rapture"); the coordinator's brief was name first. Built as name first, checked against the
  transcript (a disagreement links nothing). Owen may want transcript-only.
- The words prompt was not changed; "adds something the title leaves unsaid" is the complement rule
  already. A line citing "a second chance at winning the click" would be a prompt change for Owen.
- Imported story transcripts (`transcript_file` items) carry their story's identity in `importMeta`
  but no week folder; they get "no story" today (screenshots now cover them).
- No live run: the stage timings above are not measured in the job, and the window was built and
  checked offline, never opened (no app launch on Owen's data).
- Words over a face: when no face-free space holds the words at 7%, they are drawn at 7% or smaller
  at the top or bottom of the box, whichever covers less of a face. Owen may prefer them even
  smaller but face-free; the floor is the look's "Smallest letters kept off faces".
- A screenshot of another shape is cut to 16:9 around its centre (said). Owen may prefer to choose
  the crop, or to be refused.
- Swapping the words does not re-rank the photos (the ranking says which words it was made for);
  "Rewrite words" does. A "rank the photos for these words" button would be the 27B again. Since
  the 2026-09-29 rebuild the window at least uses the ranking of the pair the words came from.
- Frames and texts picked beyond the drawn places (e.g. three frames and one text) are not stored;
  closing the window forgets them. The saved picks are read back on reopening.
- The per-run switch is still not on the queue (the Inputs page was off-limits).
- The tab's per-item frame caches (`<userData>/thumbnail-lab/<item id>/`) are left on disk; the
  photo library and logo live beside them and are kept. A one-time cleanup (retired-components.ts)
  could remove the caches.
- Manual story link / re-run for a `no-story` item (the phase-1 plan's `thumbnails:link` /
  `thumbnails:run`) was not built; Owen's ruling for no story is screenshots.

## Handoff

Phase 1: built on its agent branch from `crucible` (dcdd0c4), merged into `crucible` (0bab4dc).
Phase 2: built on its agent branch from `crucible` (0bab4dc), not merged. Commits: the main
process (look.ts, the text rules, report-thumbnails.ts, thumbnails-ipc.ts, delete, the tab's
backend removed); the reports page (the window, the look dialog, the block, the picks on the
Thumbnail row, the tab and THUMBNAIL TEXT OPTIONS UI removed); the keeper; this doc and the ledger.
Checks: build:all, check:thumbnail-lab (44 + 18 + 15 electron), check:thumbnail, check:pure,
check:crucible, check:p4, tools/routing-publish-checks.js.
