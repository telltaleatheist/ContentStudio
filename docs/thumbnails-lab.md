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
(default 12% and 20% of the picture's height), and the two reserved spaces as percentages: Owen's
reaction photo (default bottom right, 69/55/29/43%) and the logo (top right). Both spaces are kept
EMPTY: nothing is drawn in them until Owen's photos exist.

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

## Routing (the routing table is the only model authority)
Two rows under "Thumbnails tab (testing)" in the Routing dialog, in their own group: a metadata
run never reads them, its log line leaves them out, and the change-all menu does not touch them.
- **Thumbnail frames (vision)**: local vision models only (decide needs a distribution; no upstream
  gives one). Default **Qwen3.5 9B with vision** (`qwen3.5-9b-vl`); also 4B, 2B, 0.8B and the 27B
  with vision. A server that lists a model as text-only shows it as not here.
- **Thumbnail words**: the thumbnail_text rungs (27B default, 9B, Sonnet, Opus, Haiku, claude -p).

## Where it stands (2026-09-28)
- **No live run yet.** No Crucible call has been made; the scorer and the words were checked on the
  fake Crucible only.
- **The Mac cannot score frames today.** No Mac model serves image decide (mlx-lm is text-only;
  mlx-vlm had no logprobs). Crucible 1.0.54 is to add logprobs to mlx-vlm and a Mac entry for
  `qwen3.5-9b-vl` (Owen's choice). Until then a Mac run is refused by name
  (`refuse_images_not_served` or not installed), in the tab's words. The PC (vLLM) serves the
  0.8B/2B/4B with images; the 9B with vision does not usefully fit its 24 GB card (~1,700 tokens of
  KV, per its manifest), so on the PC pick the 4B.
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
