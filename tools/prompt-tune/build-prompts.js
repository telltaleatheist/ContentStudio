/**
 * Prompt-tuning harness, phase A: produce the CURRENT production prompts for the corpus.
 *
 * Inputs come from real runs' _prompt_trace (the transcript rendering, chapter coverage,
 * pools, recorded hook — things only the pipeline can compute); the TEMPLATES and RULES
 * come from the repo's prompt tree as it exists right now, assembled by the production
 * loader. Editing a prompt asset and re-running this script yields the exact prompt the
 * app would send after a restart — no API call, no model run.
 */
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out', 'prompts');
const yaml = require(path.join(REPO, 'node_modules', 'js-yaml'));

// electron-log fails outside electron; alias it (and electron) to a no-op shim before dist loads.
const Module = require('module');
const origResolve = Module._resolveFilename;
const SHIM = path.join(__dirname, '_noop-shim.js');
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron' || request === 'electron-log') return SHIM;
  return origResolve.call(this, request, ...rest);
};

const { initPromptAssets, promptAssets } = require(path.join(REPO, 'dist/main/services/metadata/prompt-assets.js'));
initPromptAssets(path.join(REPO, 'electron/assets/prompts'));
const { CHAPTER_PROMPTS } = require(path.join(REPO, 'dist/main/services/metadata/chapter-prompts.js'));
const { formatPrompt } = require(path.join(REPO, 'dist/main/services/metadata/system-prompts.js'));

const pipelineDesc = yaml.load(fs.readFileSync(path.join(REPO, 'electron/assets/prompts/shared/pipeline/description.yml'), 'utf8'));

// The corpus lives beside this script as data the operator edits: each entry names a real
// job JSON whose items carry _prompt_trace. Add a video by running it once through the app
// (any cloud routing) and pointing an entry at the produced job file.
const CORPUS = JSON.parse(fs.readFileSync(path.join(__dirname, 'corpus.json'), 'utf8'));

/** Slice `text` between `after` and `before` markers; both must exist or we throw naming them. */
function between(text, after, before, label) {
  const a = text.indexOf(after);
  if (a === -1) throw new Error(`marker not found (${label}): ${JSON.stringify(after.slice(0, 60))}`);
  const start = a + after.length;
  const b = text.indexOf(before, start);
  if (b === -1) throw new Error(`end marker not found (${label}): ${JSON.stringify(before.slice(0, 60))}`);
  return text.slice(start, b);
}

fs.mkdirSync(OUT, { recursive: true });
const manifest = [];

for (const video of CORPUS) {
  const job = JSON.parse(fs.readFileSync(video.job, 'utf8'));
  const item = job.items[0];
  const trace = item._prompt_trace;
  const channelId = job.prompt_set;
  const channel = promptAssets().channel(channelId);
  const byWhat = (frag) => trace.find((t) => t.what.includes(frag));

  // ---- chapters stage-1: extract duration + rendered transcript, refill current template.
  const st1 = byWhat("this video's chapters").prompt;
  const duration = between(st1, 'The video runs ', '.\n', 'duration');
  const transcript = between(st1, 'TRANSCRIPT:\n', '\n\nThe video moves through a series of distinct chapters', 'chapter transcript');
  const promoted = (channel.promotedItems || []).join('; ');
  const chaptersPrompt = formatPrompt(CHAPTER_PROMPTS.WHOLE_TRANSCRIPT_CHAPTERS, {
    duration, promoted_items: promoted, transcript,
  });

  // ---- description hook/body: extract the filled input blocks, refill current templates.
  const hookTrace = byWhat('primary hook').prompt;
  const bodyTrace = byWhat('primary body for').prompt; // 'for' excludes the revision entry
  const channelBlock = between(hookTrace, 'Output JSON only.\n\n', '\n\nVideo: ', 'channel block');
  const videoLine = between(hookTrace, '\n\nVideo: ', '\n', 'video line');
  // Coverage has two real modes (chapter list / operator subject) and a third real state:
  // a run whose chapters failed has none. Extract whichever the trace shows.
  // Coverage has two real modes (chapter list / operator subject). On a chapterless item
  // the transcript block is EMPTY by design — the coverage block IS the content — so the
  // coverage's end marker is the transcript header when present, else the pools header.
  const hasTranscriptBlock = hookTrace.includes('The transcript of the video, in full:\n');
  const coverageEnd = hasTranscriptBlock
    ? '\n\nThe transcript of the video, in full:'
    : '\n\nNames and phrases from the video';
  let coverage = '';
  if (hookTrace.includes('What the video covers, chapter by chapter:\n')) {
    const items = between(hookTrace, 'What the video covers, chapter by chapter:\n', coverageEnd, 'coverage items');
    coverage = pipelineDesc.coverage_chapters.replace('{items}', () => items);
  } else if (hookTrace.includes('What the video covers, as the operator described it:\n')) {
    const items = between(hookTrace, 'What the video covers, as the operator described it:\n', coverageEnd, 'coverage items').replace(/\n+$/, '');
    coverage = pipelineDesc.coverage_subject.replace('{items}', () => items);
  }
  const descTranscript = hasTranscriptBlock
    ? between(hookTrace, 'The transcript of the video, in full:\n', 'Names and phrases from the video', 'desc transcript').replace(/\n+$/, '')
    : '';
  const pools = between(hookTrace, 'Names and phrases from the video, to draw on where they fit:\n', "\n\nThe channel's rules", 'pools');
  const recordedHook = between(bodyTrace, 'The opening line is already written, and it will stand above what you write:\n"', '"\n', 'recorded hook');

  const rules = pipelineDesc.rules_block.replace('{items}', () => promptAssets().fieldSection(channel, 'description'));
  const transcriptBlock = descTranscript ? pipelineDesc.transcript_block.replace('{items}', () => descTranscript) : '';
  const fill = (template, extra = {}) => {
    const slots = {
      channel: channelBlock,
      video: videoLine,
      coverage,
      transcript: transcriptBlock,
      speaker_tags: '', // both corpus videos are untagged runs
      pools,
      rules,
      hookTargetChars: '140',
      bodyMinWords: '60',
      bodyMaxWords: '200',
      ...extra,
    };
    let text = template;
    for (const [k, v] of Object.entries(slots)) text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v));
    // Collapse the blank lines an empty speaker_tags slot leaves, the way the unit does.
    text = text.replace(/\n{3,}/g, '\n\n');
    const unfilled = text.match(/\{[a-zA-Z_]+\}/);
    if (unfilled) throw new Error(`unfilled slot ${unfilled[0]} for ${video.key}`);
    return text;
  };
  const hookPrompt = fill(pipelineDesc.hook);
  const bodyPrompt = fill(pipelineDesc.body, { hook: recordedHook });

  // ---- titles group call: traced as-is (assembled by metadata-tasks; refresh is follow-up work).
  const titlesTrace = trace.filter((t) => t.what.startsWith('metadata package'))[0];

  const outputs = {
    'chapters-stage1': chaptersPrompt,
    'description-hook': hookPrompt,
    'description-body': bodyPrompt,
    'titles-group-STALE': titlesTrace ? titlesTrace.prompt : null,
  };
  for (const [stage, prompt] of Object.entries(outputs)) {
    if (!prompt) continue;
    const file = path.join(OUT, `${video.key}--${stage}.txt`);
    fs.writeFileSync(file, prompt);
    manifest.push({ video: video.key, stage, file, chars: prompt.length });
  }
  // Reference outputs from the real Sonnet run, for the grid.
  fs.writeFileSync(path.join(OUT, `${video.key}--REFERENCE.json`), JSON.stringify({
    description: item.description, titles: item.titles, chapters: item.chapters,
    description_options: item.description_options,
  }, null, 2));
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(manifest.map((m) => `${m.video} ${m.stage} ${m.chars}`).join('\n'));
