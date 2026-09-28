# The Thumbnails tab (testing)

Built 2026-09-28 (LEDGER #236). A testing tab for Owen to try an automated YouTube-thumbnail
workflow on one processed video: find usable frames, pick three, add words, and render three
thumbnails for a title/thumbnail A/B test. Nothing in the metadata run or the publish pipeline
reads it; the metadata report's THUMBNAIL TEXT OPTIONS field is untouched.

Open it from the sidebar: **Thumbnails** (between Stream marks and Analytics).

## How it works

### 1. Video
Pick a report. Its video is the report's recorded `source_path` (the final export). "Another
video file" takes any 16:9 file instead, for example the stream master, with an optional
**From/To** range (`07:31`, `1:07:31`). The words are always written from the report's own saved
transcript, which covers the whole video; frames and words are not tied to each other by time, so
no time mapping between the master and the export is ever done (the segment-table trap does not
arise).

A report without a recorded video, without titles, or without a saved transcript is listed but
disabled, with the reason.

### 2. Frames
- **Sampling** (frame-sampler.ts): one ffmpeg pass, about one frame a second (at most 1,800 per
  run, evenly spaced when the range is longer). Each frame is written as a 640x360 JPEG (for the
  model and the close-up) and a 320x180 JPEG (for the grid), and measured as a small grey frame
  on the fly. Only 16:9 video is taken; anything else is refused naming its size (fitting another
  shape would be a crop, which is Owen's choice).
- **Cheap filters** (frame-metrics.ts, no model): repeats by a 256-bit difference hash (held
  shots collapse to their sharpest frame; the threshold is tight so changes of expression
  survive), blur by Laplacian variance under 35% of the run's median. Face presence is NOT a CPU
  filter: the vision model answers it.
- **Scoring** (frame-scorer.ts): at most 120 kept frames, spread across the range in rounds so
  empty stretches do not leave the cap short. One frame per Crucible `POST /v1/decide` call,
  five fixed-answer questions (thumbnails.yml `frames.*`): computer screen or video, a clear face,
  expression 1-5, eyes open, strong thumbnail. `missing: 'report'`; a frame whose answer lacks an
  option letter is set aside and named. It runs as ONE lane job (like a metadata run: one job per
  card, waiting behind a running job), with one lease on the model, and as many calls at once as
  the engine states it admits (`activity().chat.maxInFlight`, capped at 8; none stated = one at a
  time). If the server is busy the tab says who holds it and does not queue.
- **Ranking** (frame-ranking.ts): the screen answer is the one filter (P(screen) > 0.5 is
  rejected); everything else ranks: `score = P(face) × (0.45 × expression + 0.20 × eyes + 0.35 ×
  strong)`. The **Best 20** are picked round-robin across eight sections of the range, never two
  within 4 s. **All kept frames** shows every survivor (scored or not, screens dimmed) so Owen can
  mark from anywhere; the tab works for browsing and marking even before (or without) scoring.

Click a frame to mark it: the first three marked become A, B and C. The zoom icon shows it at 640 px.

### 3. Words
Pick the title the words pair with (the report's titles). **Write words** makes one plain-text call
(thumbnails.yml `text`) on the routed model and shows five options in each of three kinds:
**Claim** (the subject's own claim, lightly paraphrased), **Stakes** (the stakes or the absurdity),
**Reaction** (the host's reaction). A starts on the first claim, B on the first stakes, C on the
first reaction; each can be switched to any option or to **No text (picture only)**, which is a
recommended A/B arm. Off-brief options (outside 2-5 words) are kept and warned about.

### 4. Look (saved under the store key `thumbnailLab.style`)
Font (default Impact; a font that is not installed is refused by name), letter and outline colour
(default #FF8000 on black), outline thickness, the soft blurred and darkened patch behind the words
(on/off, darkness), the dark edges (on/off, strength), the smallest and largest letter height
(default 12% and 20% of the picture's height), the reaction photo's white outline (px at 1080p,
default 10, 0 for none) and how much of it may run off the bottom (default 10% of its height), and
the two reserved spaces as percentages: Owen's reaction photo (default bottom right, 69/55/29/43%)
and the logo (top right, always drawn empty).

### Reaction photos (added 2026-09-28, same day)
- **Folder.** "Reaction photos: Choose folder…" under Words saves the folder under the store key
  `thumbnailLab.reactionFolder` (no default; the photos are read in place, never copied into the app
  or the repo). A folder that is missing or holds no PNG is refused naming it, and is not saved.
  Photos are listed by file name without `selfie ` and `.png` ("oh please"); two files that would list
  under one name are refused.
- **Per variant.** Each marked frame (A/B/C) gets a row of small pictures of the trimmed photos, plus
  "No photo".
- **Trim** (photo-trim.ts, reaction-photos.ts). A pixel with alpha ≥ 128 is solid; solid pixels are
  grouped by 8-neighbour connection and the largest group is the person (anything touching it, a
  mic arm or a hand, is part of it). The kept area is that group grown by 3 px so the soft
  partly-transparent edge survives; every other pixel is cleared and the photo is cut to the kept
  area. Separate groups are specks and are dropped; the render notes how many. Read and written with
  Electron's nativeImage. An unreadable photo is refused naming the file.
  On Owen's set: the dark bars seen along the bottom of `selfie horrified.png` (x 505-640, 1570-1690)
  are fully transparent in its alpha plane (confirmed with ffmpeg), so they never draw and there is
  nothing separate to drop; the rule is still pinned on synthetic specks by the checks.
- **Placement** (layout.ts `placeReaction`): as large as fits the reaction space's width and the
  height from the space's top to the picture's bottom, right side on the space's right edge, bottom
  running `reactionBleed` of its height off the picture's bottom edge, like Owen's hand-made
  thumbnails. The white outline is the silhouette stamped around a circle of the outline's radius,
  under the photo. With a photo chosen, the text avoids the photo's real drawn bounds (outline
  included) instead of the whole space; with none, the whole space stays clear.
- The soft patch behind the words follows each line, so a short line leaves the picture beside it
  clear.

### 5. Thumbnails (renderer.ts, layout.ts, canvas-page.ts)
Deterministic, no model:
- Output 1280x720 (the source frame is re-extracted at full size and scaled), PNG, or JPEG 92/85
  when the PNG is over 2 MiB (said in the notes), then checked by the app's own
  `validateThumbnailFile` (LEDGER #219).
- **Face boxes** come from Apple Vision through Chromium's FaceDetector in a hidden offscreen page
  (the experimental flag is on for that one window only). No helper binary, no Python, no ONNX
  model shipped: Electron already carries it. The boxes are grown (forehead, ears, chin) before the
  text must avoid them.
- **The text box** is the placement giving the largest letters among every clear rectangle that
  avoids all faces and both reserved spaces, bottom-left preferred on a tie. At most two lines,
  left-aligned, fitted by shrinking from the largest size. If the letters would fall under the
  smallest height, the phrase is **too long**: the tab says so for that variant and draws nothing.
  It never shrinks further and never truncates.
- Saved in `<report folder>/thumbnail tests/` as `<title> - A (claim - DON'T STAND UNDER A
  ROOF).png` and so on; shown large (with the empty spaces outlined, switchable) and at 360, 246
  and 168 px wide for the phone glance test. This folder is deliberately NOT the week's
  `thumbnails/` folder, so the publish pipeline never auto-attaches a test render.

### Favourites, tone, photo suggestion and auto-combine (added 2026-09-28, same day)
- **Favourites.** Owen stars a few of each piece: frames in the grid, word lines (and "No text"),
  reaction photos. Starring replaces the old "mark three frames".
- **Photo notes.** "Edit notes" under Reaction photos: one line per photo saying what it shows and
  when it fits, saved under the store key `thumbnailLab.reactionNotes` (with the folder setting,
  never in the repo). Until Owen saves one, a photo shows its draft from thumbnails.yml
  `photo.drafts`, marked "(draft)" (laugh / chuckle / uh oh laughing: light topics only, never for
  deaths or real victims; horrified / thats not good / this is wrong: serious; oh please / are you
  kidding me / exaspirated: dismissive; eww: disgust; head slap: facepalm; oh wow / ooh:
  surprised). A photo with neither is listed by its name alone.
- **Tone** (judge.ts, decide, text only): the report's description hook and description (without
  the links below it) and the first 60 caption lines; one choice question, "What is the tone of this
  video?", over the list in thumbnails.yml `tone.options` (mocking, absurd, outraged, alarming,
  disgusted, incredulous, hypocrisy exposed, sombre, pitiful, lighthearted; Owen edits it, at most
  26). The tab shows the top tone and its probability in one line.
- **Photo suggestion** (decide, text only, once per variant): the hook and description, the tone,
  that variant's words (or "none, the thumbnail is a picture only") and a legend of every photo with
  its note; "Which reaction photo fits this thumbnail?" with the photo names as the answers. The
  probabilities ARE the ranking: the variant's photo menu lists every photo in that order with its
  percentage, and the top one (the top starred one, when any are starred) is pre-selected. No photo is
  hidden or blocked. Tone and the three photo questions run as one lane job holding one lease.
- **Auto-combine** (combine.ts): the favourites become A, B and C, each piece swappable in its row
  before saving; "Combine again" resets the swaps.
  - *Best package*: each thumbnail takes a different favourite frame, words and photo (a short list
    repeats from its start).
  - *Test one thing*: two pieces stay the same on every thumbnail and the chosen one (frame, words
    or photo) changes, so the A/B test measures that piece alone; it needs at least two favourites
    of that piece and makes as many thumbnails as there are (up to three).

## Routing (the routing table is the only model authority)
Two rows under "Thumbnails tab (testing)" in the Routing dialog, in their own group: a metadata
run never reads them, its log line leaves them out, and the change-all menu does not touch them.
- **Thumbnail frames (vision)**: local vision models only (decide needs a distribution; no upstream
  gives one). Default **Qwen3.5 9B with vision** (`qwen3.5-9b-vl`); also 4B, 2B, 0.8B and the 27B
  with vision. A server that lists a model as text-only shows it as not here.
- **Thumbnail words**: the thumbnail_text rungs (27B default, 9B, Sonnet, Opus, Haiku, claude -p).
- **Thumbnail tone and photo**: the tone and photo decides. Its own row rather than the words row,
  because the words row offers cloud and claude -p, and a decide needs logprobs, which only a local
  Crucible model gives. Default Qwen3.5 9B; also 4B and 27B.

## Where it stands (2026-09-28)
- **No live run yet.** No Crucible call has been made; the scorer and the words were checked on the
  fake Crucible only.
- **The Mac serves image decide from Crucible 1.0.54** (the coordinator's read-only check,
  2026-09-28): `qwen3.5-9b-vl` installed and loadable, text + image. Before 1.0.54 no Mac model did
  (mlx-lm is text-only; mlx-vlm had no logprobs), and an older Mac server refuses by name
  (`refuse_images_not_served`). With a text-only model the refusal names the models that can read
  pictures there (`details.image_models`). The PC (vLLM) serves the 0.8B/2B/4B with images; the 9B
  with vision does not usefully fit its 24 GB card (~1,700 tokens of KV, per its manifest), so on
  the PC pick the 4B.
- **Expected speed on the Mac** (the maintainer's figures): a 640x360 frame is about 322 prompt
  tokens; about 0.65-0.77 s per question, the first call after the load about 4 s; later
  questions on the same image are cheaper. About 100 frames x 5 questions is about 7 minutes. The
  tab shows "Scoring frame N of M" and has a Stop button. Decide never loads a model: the scorer
  takes a lease (which loads it at 8,192) and holds it across every frame, releasing it at the end.
- Measured on the rapture master (07:31-30:00, CPU only): 1,349 sampled, 738 repeats and 45 blurry
  removed, 566 kept, in 115 s.
- The frame weights, the repeat threshold (8 of 256 bits) and the blur rule (35% of median) are
  declared starting points, not measurements.

## Checks
`npm run check:thumbnail-lab` = `tools/thumbnail-lab-checks.js` (19 checks: filters, real ffmpeg
sampling of a synthetic video, ranking and diversity, the words prompt and parser, face-safe layout
and the too-long refusal, scoring over the real transport and lanes against the fake Crucible
including each image refusal) and `tools/thumbnail-lab-render-smoke.js` under the electron binary
(Impact measured, a missing font refused, renders inside YouTube's bounds, the reference frame's
face found and avoided).

## Retiring the old THUMBNAIL TEXT OPTIONS field (Owen decides after testing)
If this tab's words win: drop `thumbnail_text` from each channel's `fields:` list (the field stops
being generated and shown), remove its routing row with an entry in `REMOVED_ROUTING_TASKS`, and move
the tab's words step onto the reports page as the thumbnail field. Its re-roll gate rules and the
self-check lines about thumbnails go with it. Until then both exist and do not touch each other.

## Open
- Owen's reaction photos: the slot is reserved; drawing a cut-out there is the next step.
- A live run (below) to measure the scorer's usefulness and tune the weights.
- Whether image-only (no text) should be the default for one arm.
- The logo slot's default position is read off one hand-made thumbnail.
