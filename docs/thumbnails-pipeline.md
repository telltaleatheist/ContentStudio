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
- **Render.** 1280x720 on the saved look (`thumbnailLab.style`, look.ts; the default look when none
  is saved, said), the logo kept in the app (none kept: none drawn, said), the renderer's own rules
  (phase 2: the text box left of the photo, one or two lines, shrunk to fit, never refused; see
  "The text always fits" below).

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
  "picks": []                  // phase 2: ordered, at most 3 (see "The ordered picks" below)
}
```

**States.** `made`: every stage ran (before phase 2 a pair whose words did not fit carried
`render.ok: false` and its reason; the words are always drawn now). `no-story`: `story.state` is `none`, its reason in
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
(`thumbnails:pair-title`: the words row for that title, the tone/photo row for the new words, a new
draw and a new render, on ONE held lease of the 27B; the pair and its pick follow).

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
