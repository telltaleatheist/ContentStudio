# The Thumbnails tab (testing)

Built 2026-09-28 (LEDGER #236). A testing tab for Owen to try an automated YouTube-thumbnail
workflow on one processed video: find usable frames, pick three, add words, and render three
thumbnails for a title/thumbnail A/B test. Nothing in the metadata run or the publish pipeline
reads it; the metadata report's THUMBNAIL TEXT OPTIONS field is untouched.

Open it from the sidebar: **Thumbnails** (between Stream marks and Analytics).

## How it works

### 1. Report and story (changed 2026-09-28, same day)
Pick a report. Its frames come from the clean **screen recording** of the editor session, and only
over the stretches the report's **editor story** is made of. The report's own video (the finished
export, Owen's camera and the screen together) is never sampled; the old "Another video file" and
From/To inputs are gone, because the story now defines the range. The words are still written from
the report's own saved transcript; frames and words are not tied to each other by time.

- **The link.** The report's story link is the existing one: the publish selection record's
  `transcriptRef` (userData `publish/`), or, while the report has no record yet, the story its
  metadata was generated from (`content_provenance.transcript_ref`, which seeds that record).
  A record whose link is null (final export only, or cleared) counts as unlinked.
- **Unlinked: the picker.** The tab lists every story of every editor session in the report's week
  (`<week>/files/<session>/<session>_edits.json`), or of a project folder chosen with "Other project
  folder…". A story whose transcript was never exported cannot be linked (a link is identified by
  that file), and says why. "Link this story" saves it through the selection record, exactly as the
  Inputs page's link is saved (recorded as `manual`). A report is NEVER linked by name: "f2 - the
  rapture" is made from the story "f1 - the rapture".
- **The mapping** (story-source.ts), each step the editor's own rule:
  1. the story's regions (as drawn, not the export's 30 s padded shoulders) minus the session's cuts
     (half-open frame ranges × the manifest's frame length);
  2. timeline → master file through the editor manifest's segment table, piece by piece
     (`timelineRangeToMaster` in `electron/shared/master-timeline-map.ts`, the map the editor and the
     stream-marks import use): the processing step removed the dead air, so one story is dozens of
     pieces and the air between them is left out;
  3. master → screen recording by `<session>_alignment.json`'s video/screen entry:
     screen = (master − offset) × rate (`masterToSource`);
  4. cut to the recording's length; seconds outside it are said.
  The screen recording is found beside the master by the editor's own naming rule
  (`editor/session-sources.ts`). Refused by name: no alignment record, an untrusted or absent screen
  alignment, no screen recording, a recording in parts, a manifest playing a different master, a
  story renumbered or renamed since it was linked (link it again).
- **Drift (declared).** When the alignment records no drift factor (`driftFactor: null`, the usual
  case), the recording is read at the master's rate and the run says so. The processing step does
  retime the screen by its device factor (the 2026-09-24 compound: r = 0.99997639), so late in a long
  night the frames can be up to about a third of a second off; over the rapture story, under 0.03 s.
- **Sampling** takes the stretches: stretches within 30 s share one ffmpeg pass, and a frame that
  lands between two stretches is decoded and dropped, never kept.

A report without a recorded video, without titles, or without a saved transcript is listed but
disabled, with the reason.

### 2. Frames
- **Sampling** (frame-sampler.ts): about one frame a second across the story's stretches of the
  screen recording (at most 1,800 per run, evenly spaced when they hold more). Each frame is written as a 640x360 JPEG (for the
  model and the close-up) and a 320x180 JPEG (for the grid), and measured as a small grey frame
  on the fly. Only 16:9 video is taken; anything else is refused naming its size (fitting another
  shape would be a crop, which is Owen's choice).
- **Cheap filters** (frame-metrics.ts, no model): repeats by a 256-bit difference hash (held
  shots collapse to their sharpest frame; the threshold is tight so changes of expression
  survive), blur by Laplacian variance under 35% of the run's median. Face presence is NOT a CPU
  filter: the vision model answers it.
- **Scenes** (frame-scenes.ts, added 2026-09-28, same day; Owen: "grab a few scenes from each
  unique shot"). The screen recording sits on a handful of clips for most of a story, and the repeat
  filter only drops near-identical frames, so a talking head that moves a little survived dozens of
  times. The kept frames are now grouped by how they LOOK, over the whole story (not by time: clips
  alternate A B A B and every return joins its scene):
  - *Signature*: each frame shrunk to 16x9 colour cells (area average of the 320x180 grid picture),
    measured on the fly by the sampler on a second ffmpeg pipe (fd 3); nothing extra on disk.
  - *Distance*: the fraction of cells whose colour moved by more than 40 (RGB distance). A fraction,
    so a speaker moving or waving (a few cells) stays the same scene and a different clip (most
    cells) does not.
  - *Groups*: average-linkage clustering, cut where the average distance between two groups passes
    0.6 (nearest-neighbour chain, O(n^2) for the ≤ 1,800 frames of a run). Average linkage keeps a
    transition frame from chaining two clips together. No shot-boundary pass: appearance alone.
  - *Screen time*: every SAMPLED frame (the repeats and blurry ones too) counts toward the scene it
    looks most like, so "Scene 3 · 2:41 on screen" is the story's real time on that scene.
  - *Fragments folded* (2026-09-28, second pass; Owen: "there are really only like 10 unique
    frames"): a moving camera (the rapture story's trees and sky) split into seven small scenes, and
    colour alone cannot tell those pieces from two different short clips (the sky pieces sit
    0.68-0.78 apart; the pink-hair two-shot and the woman against the sky, 0.79). Time can: the
    pieces interleave inside one stretch. Two scenes fold when each is small (at most 10 kept
    frames), their stretches overlap or touch (within 2 sampling intervals) and their frames differ
    on average in at most 0.8 of the cells; closest pair first. Big scenes never fold.
  - Scenes are numbered by first appearance.
- **Scoring** (frame-scorer.ts): at most 120 kept frames, shared across the scenes
  (`allocateScoring`): every scene first gets 3 (all it has when fewer, so a one-frame scene still
  gets one), the rest go one at a time to the scene with the most screen time per extra frame
  (D'Hondt); within a scene the share is spread across that scene's own appearances, sharpest per
  stretch. If there are more scenes than 3 each allows, every scene gets one in turn, longest on
  screen first, and the run says so. One frame per Crucible `POST /v1/decide` call,
  five fixed-answer questions (thumbnails.yml `frames.*`): computer screen or video, a clear face,
  expression 1-5, eyes open, strong thumbnail. Since the SDK repin to Crucible 1.0.55 (2026-09-28)
  the five go as ITEMS of that one call (`transport.decideItems`, SDK `decideItems`): the frame is
  read once and each item answered as if asked alone (the maintainer's figure on the Mac: 1.9 s a
  frame against 4.3 s). Items are choices, so the yes/no questions go as the server's own yesno
  wording (`frames.statement`, Yes/No) and the expression as a choice over its five levels;
  prompts.ts `frameAnswersOfItems` reads back P(yes) and the expected level. Never one prompt with
  numbered slots. `missing: 'report'`; a frame whose answer lacks an option letter is set aside and
  named. It runs as ONE lane job (like a metadata run: one job per
  card, waiting behind a running job), with one lease on the model, and as many calls at once as
  the engine states it admits (`activity().chat.maxInFlight`, capped at 8; none stated = one at a
  time). If the server is busy the tab says who holds it and does not queue.
- **Ranking** (frame-ranking.ts): the screen answer is the one filter (P(screen) > 0.5 is
  rejected); everything else ranks: `score = P(face) × (0.45 × expression + 0.20 × eyes + 0.35 ×
  strong)`. **Best by scene** (since 2026-09-28, replacing the Best 20 picked across eight time
  sections) shows one row per scene, labelled "Scene 3 · 2:41 on screen", the scenes ordered by
  their best frame's score. Since the second pass the same day (Owen: "we dont need 25 of the same
  pictures") a row shows TWO frames: the best, and the best-ranked one that looks clearly different
  from it (16x9 signature distance ≥ 0.15, the upper quarter of a talking-head scene's own spread,
  or an expression reading a level or more apart); a scene with no clearly different frame shows its
  best alone. "More from this scene (N)" opens the rest of its ranked frames (never two within 4 s).
  Computer-screen frames stay out; a scene whose every scored frame was a screen has no row and the
  scoring line names it. **All kept frames** shows every survivor (scored or not, screens dimmed),
  grouped by scene, one row each collapsed to 6 frames spread across the scene, "Show all N" to
  open it; the tab works for browsing and marking even before (or without) scoring.

Click a frame to mark it: the first three marked become A, B and C. The zoom icon shows it at 640 px.

### 3. Words
Pick the title the words pair with (the report's titles). **Write words** makes one plain-text call
(thumbnails.yml `text`) on the routed model and shows five options in each of three kinds:
**Claim** (the subject's own claim, lightly paraphrased), **Stakes** (the stakes or the absurdity),
**Reaction** (the host's reaction). A starts on the first claim, B on the first stakes, C on the
first reaction; each can be switched to any option or to **No text (picture only)**, which is a
recommended A/B arm. Off-brief options (outside 2-5 words) are kept and warned about. A thumbnail is
only ever picture-only when Owen chose "No text" (see Auto-combine).

### 4. Look (saved under the store key `thumbnailLab.style`)
Font (default Impact; a font that is not installed is refused by name), letter and outline colour
(default #FF8000 on black), outline thickness, the soft blurred and darkened patch behind the words
(on/off, darkness), the dark edges (on/off, strength), the smallest and largest letter height
(default 7% and 20% of the picture's height; the smallest was 12% until 2026-09-28), the reaction photo's white outline (px at 1080p,
default 10, 0 for none) and how much of it may run off the bottom (default 10% of its height), and
the two spaces as percentages: Owen's reaction photo (default bottom right, 69/55/29/43%) and the
logo (default top right, 92.2/4.6/5.2/9.25%: the badge on his hand-made "f2 - the rapture.png",
1920x1080 x 1770-1870, y 50-150, so 66x66 px at 1280; a saved look keeps its own values).

### The logo (added 2026-09-28, same day)
- **File, kept in the app** (since 2026-09-28, second pass; Owen: "they should be stored in app data
  or something so i never have to upload them again"). "Add logo…" / "Replace…" reads the chosen
  PNG or JPEG (an unreadable one is refused naming it and nothing changes), then COPIES it into
  `<userData>/thumbnail-lab/logo/` (one file; a replace removes the old copy) and the tab reads it
  from there from then on. The old setting `thumbnailLab.logo` (a path read in place) is read only
  for an offer: while the app holds no logo and that file is there, the row says "The tab used to
  read <name> in place" with a one-click "Copy it into the app"; nothing is copied on its own and the
  original is only read. Owen's: `/Volumes/Callisto/youtube data/Misc/final logos/deprecated/
  logo-xl-blue-fixed-2mb.png` (2000x2000 PNG with alpha, a round badge).
- **Drawing** (logo.ts, layout.ts `placeLogo`). The picture is cut to its visible pixels (any alpha),
  fitted inside the logo space with its aspect kept, against the space's top and right edges, on
  whole pixels; it is downscaled once in the main process (nativeImage, 'best') to exactly that size
  and drawn 1:1 last, over everything, so a 2000 px badge lands crisp. The words avoid the logo's
  drawn bounds; with no logo drawn they keep the whole logo space clear.
- **Switch.** A "Logo" box beside "Make the thumbnails", on whenever a logo is set; off draws none.
  No logo set: nothing is drawn and no placeholder.

### Reaction photos (added 2026-09-28, same day)
- **Kept in the app** (since 2026-09-28, second pass, photo-library.ts). "Add photos…" takes PNG
  files and/or folders (a folder adds its PNGs) and COPIES them into
  `<userData>/thumbnail-lab/reaction-photos/<name>.png`; the tab reads them from there from then on.
  A photo's name is its file name without `selfie ` and `.png` ("oh please"). A name already in the
  app is not copied: the tab asks "Replace it?" and copies it over only on yes (nothing of that
  batch is copied before). Two chosen files under one name, or a `.png` that is not a PNG, are refused
  naming them. The × on a photo removes the app's copy only; its note stays saved under its name.
- **Moving over.** The old setting `thumbnailLab.reactionFolder` (Owen's: /Users/telltale/Downloads/
  selfies) is read only for an offer: while the app holds no photos and that folder has PNGs, the
  tab says "The tab used to read N photos from <folder>" with a one-click "Copy these into the app".
  Nothing is copied on its own, and his originals are only read (copied from, never moved or
  written).
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
  avoids all faces and both reserved spaces, bottom-left preferred on a tie. At most THREE lines
  (two until 2026-09-28), left-aligned, fitted by shrinking from the largest size; at an equal size
  fewer lines win. If the letters would fall under the smallest height (7% by default since
  2026-09-28, after Owen hit "TAKE YOUR CLOTHES OFF" refused at 68 px against an 87 px floor: "i
  think it would be fine to make the text smaller to fit it all"), the phrase is **too long**: the
  tab says so for that variant and draws nothing. It never shrinks further, never truncates and
  never covers a face.
- Saved in `<report folder>/thumbnail tests/` as `<title> - A (claim - DON'T STAND UNDER A
  ROOF).png` and so on; shown large and at 360, 246 and 168 px wide for the phone glance test.
  "Show the empty photo and logo spaces" starts OFF; ticked, it outlines only a space that was left
  empty on that render (never one with a photo or logo drawn). Each result says which photo and
  whether the logo was drawn. This folder is deliberately NOT the week's
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
  percentage. No photo is hidden or blocked. Tone and the photo questions run under one lease.
- **Drawn from the top 3** (since 2026-09-28, second pass, photo-draw.ts; Owen got "are you kidding
  me" (32%) on A, B and C: "i think it would be safe to have temperature, where it picks randomly from
  the top 3 or 4 … having the ability to pick directly is valuable"). A variant whose photo is not
  picked directly gets one DRAWN from its ranking's top 3 by the model's probabilities, renormalised
  over those three; a photo already on another thumbnail of the same render (picked directly or
  drawn before it) is left out while another of the three remains (when all three are taken the
  result says the repeat was forced). A photo held across "Test one thing" is one draw. Direct picks
  are untouched. The draw is seeded (mulberry32) and REPRODUCIBLE: the seed is shown in the run's
  lines ("Photos drawn with seed N …") and under Thumbnails ("last draw: seed N"); typing a seed in
  "Draw seed" repeats a draw, blank makes a new one (crypto.randomInt in the main process). The result
  line and the photo menu say what was drawn and its %: "oh please (21%), drawn from the top 3: are
  you kidding me 32%, oh please 21%, horrified 15%".
- **Auto-combine** (combine.ts): the favourites become A, B and C, each piece swappable in its row
  before saving; "Combine again" resets the swaps. NOTHING IS LEFT OFF WITHOUT A CHOICE (2026-09-28,
  after a render came out with no words and no photo because none were starred):
  - *Words*: starred lines are used as starred. With none starred, A, B and C take the top claim,
    stakes and reaction the model wrote (a held line in "Test one thing" is the top claim). With none
    starred and none written, combine refuses: "Write words first, or star “No text”." A kind with no
    line written is refused naming it. "No text" only when starred or picked in the row.
  - *Photos*: a variant with no photo starred shows "Drawn from the top 3 for A's words" (the three
    with their %, once ranked; the drawn photo and its % after a render). "Make the thumbnails" resolves it:
    when the suggestion has not run for the variants' exact words (or the words, folder or photo list
    changed since), it runs first, shown in the progress line with the clock ("No photo is starred,
    so first reading the tone and ranking the photos for these words"), then each variant's photo is
    drawn from its top 3 (above). A held photo in "Test one thing" is one draw on every variant. No
    photos in the app: "Add your reaction photos, or set each thumbnail to “No photo”." "No photo" is
    only Owen's pick in the row. A ranking made for other words is never used, by combine or render.
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
- **Thumbnail words**: the thumbnail_text rungs (the 8-bit 27B default, the 4-bit 27B for the PC,
  9B, Sonnet, Opus, Haiku, claude -p).
- **Thumbnail tone and photo**: the tone and photo decides. Its own row rather than the words row,
  because the words row offers cloud and claude -p, and a decide needs logprobs, which only a local
  Crucible model gives. Default the 8-bit 27B (Owen, 2026-09-28: "if we're using the 27b anyway we
  might as well keep it loaded to do the other stuff"); also the 9B, 4B and the 4-bit 27B.
- **One load for both** (lab-service.ts `textJob`, the editor's story-titling pattern): the words and
  the tone/photo steps run under ONE held job on their model, so the model is not unloaded and
  reloaded between them (each step used to take and give back its own lease, and a model nothing
  holds is unloaded). The hold is given back when a step needs a different model (the frame scorer's
  vision 9B releases it before it loads; a text row changed), when the tab is left, on quit, after a
  failed step, or after 5 minutes with no text step (declared, logged). Both steps run as standalone
  GPU steps (the words as queueAITask always did), because a lane job's end gives back what was held
  inside it.

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
- Measured on "f1 - the rapture" from the screen recording (2026-09-28, CPU only, read only): 126
  stretches, 749.7 s (screen capture 614.66-1488.33 s); 757 sampled, 420 repeats and 37 blurry
  removed, 300 kept, in 74 s. Every frame is a clean screen picture; some show Owen's desktop (a
  document, the player's frame), which the scorer's desktop question removes.
- Scenes on the same story (2026-09-28, CPU only, the tab's own findFrames run headless on a scratch
  userData, read only on Owen's files): the 300 kept frames make **18 scenes** in 78 s: the two-shot
  (52 kept, 2:54 on screen), the host alone (84, 3:02), the clip playing in a player window on the
  desktop (48, 2:00), the vertical rapture-tip clip (17), the pink-hair two-shot (8), the woman
  against the sky (9), the green-shirt vertical clip (35, 0:53), the pink-top vertical clip (14,
  1:08), a man alone (1), two document scenes (1 + 7), and the tree-and-sky footage in seven small
  groups (5, 8, 1, 2, 4, 3, 1: a moving camera changes most cells). 120 scored: 22, 23 and 16 from
  the three long scenes, every small scene all it has up to 3. A looser cut (0.63+) merged the
  documents into the player-window scene without joining the sky pieces, so 0.6 stays.
- The frame weights, the repeat threshold (8 of 256 bits), the blur rule (35% of median) and the
  scene cut (40 per cell, 0.6 of the cells) are declared starting points, tuned on one story.
- Second pass (2026-09-28, CPU only, the same headless findFrames on a scratch userData, read only):
  fragment folding takes the rapture story from **18 scenes to 12**: six of the seven sky/tree/porch
  pieces fold into one scene (21 kept, 0:48 on screen), the two document scenes fold into one; one
  3-frame sky piece (20:56-20:59) stays its own, and every main shot stays apart (the pink-hair
  two-shot and the woman against the sky included). With 2 per scene the best view shows 20 frames by
  default instead of up to 72 (sheet: sharpness as a CPU stand-in for the score). A stray sky frame
  (21:04) and a desktop frame sit inside the player-window scene; that is the 0.6 grouping, unchanged.

## Checks
`npm run check:thumbnail-lab` = `tools/thumbnail-lab-checks.js` (47 checks: filters, scenes
(alternating clips, a moving speaker, a two-frame scene, the chain against the naive merge, the
scoring budget, the per-scene rows), real ffmpeg
sampling of a synthetic video inside given stretches only, the story source (regions minus cuts, the
segment table, offset and drift, clipping, refusals), the unlinked report's picker and saved link on a
synthetic session, the real 2026-09-24 rapture story as a read-only fixture when Callisto is mounted, ranking, the words prompt and parser, face-safe layout
and the too-long refusal, scoring over the real transport and lanes against the fake Crucible
including each image refusal; combine never picture-only or photo-less without a choice, its
refusals; the photo suggestion run first, reused and re-run on changed words over the fake
Crucible, and the no-folder refusal; the logo placement and the words avoiding it; the empty-space
outlines off by default; since the second pass, 54 in all: "TAKE YOUR CLOTHES OFF" refused at 12%
and fitted on three lines at 7% clear of both faces; the library's add / duplicate refused then
replaced / remove / one-click copy offer from the old folder and logo settings, originals untouched,
on a CONTENTSTUDIO_USER_DATA scratch folder; the seeded top-3 draw (reproducible, the probabilities
followed over 3,000 seeds, repeats avoided, direct picks untouched, a held photo one draw); 2 per
scene with the rest behind "More"; fragment folding; the words and the tone/photo on ONE lease
with no reload, released before the frame scorer) and `tools/thumbnail-lab-render-smoke.js` under
the electron binary (14: Impact measured, a missing font refused, renders inside YouTube's bounds,
the logo cut to its visible pixels and drawn only in its place with its aspect kept, a missing or
unreadable logo refused, the library copy and read-back of a cut-out and a logo, the reference
frame's face found and avoided, "TAKE YOUR CLOTHES OFF" on the reference frame, and the evidence
renders with text, photo and logo).

## Retiring the old THUMBNAIL TEXT OPTIONS field (Owen decides after testing)
If this tab's words win: drop `thumbnail_text` from each channel's `fields:` list (the field stops
being generated and shown), remove its routing row with an entry in `REMOVED_ROUTING_TASKS`, and move
the tab's words step onto the reports page as the thumbnail field. Its re-roll gate rules and the
self-check lines about thumbnails go with it. Until then both exist and do not touch each other.

## Open
- When the alignment records no drift factor, read the screen's real retime from the session's
  compound (its timeMap) instead of the master's rate. Coordinator's rule (2026-09-28): only by
  reusing an editor reader. None exists today (the generators write timeMaps and editor_export.py
  passes them through; nothing reads one back), so rate 1 stays, declared in the run's lines.
- A live run (below) to measure the scorer's usefulness and tune the weights.
- Scenes: footage with a moving camera (the rapture story's trees and sky) splits into several
  small scenes, each taking a floor of the scoring budget; desktop scenes (documents, the player
  window) take their floor too, until the scorer rejects them.
- Whether image-only (no text) should be the default for one arm.
- The logo space's default is read off one hand-made thumbnail ("f2 - the rapture.png").
