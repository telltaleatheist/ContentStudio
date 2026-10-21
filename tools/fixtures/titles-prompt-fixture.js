/**
 * The ten-title prompt, assembled offline for every channel that writes titles, in every
 * content form the titles call reads (stretch summary, chapter digest, raw transcript), with
 * and without the insights block. Used by tools/pattern-titles-checks.js to prove the titles
 * call's prompt is byte-for-byte what it was before the tested-pattern titles existed; the
 * golden copies beside this file (titles-prompt-golden/) were written from commit ea53529's
 * compiled dist, the commit before that change.
 *
 * Nothing here calls a model: an AIManagerService is constructed and only asked to assemble.
 * The caller installs the electron-log stub before requiring this file.
 */
const path = require('path');

const INSIGHTS_BLOCK = [
  'CHANNEL PERFORMANCE DATA',
  "(Distilled from this channel's real audience data, 36 videos analyzed; it outranks generic best practices.)",
  '',
  'Channel baselines (first-week medians): CTR 4.2% | avg % viewed 31% | 30s retention 68% | views 5,100',
  '',
  'TITLE A/B EVIDENCE: none decided yet.',
  '',
  "LEARNED FROM THIS CHANNEL'S PERFORMANCE:",
  '- a fixture lesson, the same text on both sides of the comparison',
].join('\n');

const CHAPTERS = [
  { timestamp: '0:00', title: 'The work-release contract, read aloud', detail: 'The sheriff reads the parish contract into the record.' },
  { timestamp: '4:12', title: 'A cable panel reframes the prisoner exception', detail: 'A panel calls the arrangement rehabilitation.' },
  { timestamp: '11:40', title: 'What the parish budget actually shows', detail: '' },
];

const TRANSCRIPT =
  'HOST: The sheriff told the committee that the work-release program pays the parish four dollars an hour. ' +
  'CLIP: That is not slavery, that is rehabilitation. HOST: Eighteen thousand hours, and not one dollar to the people who worked them.';

const SUMMARY = {
  stretchSeconds: 300,
  model: 'fixture',
  speakerTagged: true,
  paragraphs: [
    { start: 0, text: 'The host reads the parish work-release contract aloud.' },
    { start: 300, text: 'A panel calls the arrangement rehabilitation, and the host answers it.' },
  ],
};

function ctx(promptSetName, form) {
  return {
    content: TRANSCRIPT,
    contentMode: 'raw-transcript',
    sourceLabel: 'fixture-video.mov',
    chapterSubjects: form === 'raw' ? [] : CHAPTERS.map((c) => c.title),
    chapterDetails: form === 'raw' ? [] : CHAPTERS.map((c) => c.detail),
    digestChapters: form === 'raw' ? [] : CHAPTERS,
    stretchSummary: form === 'summary' ? SUMMARY : null,
    videoTitle: 'The parish that rents out its prisoners',
    promptSetName,
    entities: ['Louisiana'],
    phrases: ['work release'],
    contentText: TRANSCRIPT,
    contentSpeakerTagged: true,
    generated: {},
    warn: () => {},
  };
}

/** { "<channel>/<form>/<insights|plain>": prompt } for every channel whose fields include titles. */
function assembleTitlesPrompts(distMain, assetsDir) {
  const aiManagerModule = require(path.join(distMain, 'services/metadata/ai-manager.service.js'));
  const promptAssetsModule = require(path.join(distMain, 'services/metadata/prompt-assets.js'));
  promptAssetsModule.initPromptAssets(path.join(assetsDir, 'prompts'));
  const assets = promptAssetsModule.promptAssets();
  const out = {};
  for (const id of assets.channelIds()) {
    if (!assets.channel(id).fields.includes('titles')) continue;
    for (const withInsights of [false, true]) {
      const manager = new aiManagerModule.AIManagerService({ transcriptCeiling: 'cloud', promptSet: id, promptSetsDir: assetsDir });
      manager.loadPrompts();
      if (withInsights) manager.setInsightsBlock(INSIGHTS_BLOCK);
      const spec = { field: 'titles', model: 'anthropic/claude-sonnet-5', insights: withInsights, inputFields: [] };
      for (const form of ['summary', 'digest', 'raw']) {
        out[`${id}/${form}/${withInsights ? 'insights' : 'plain'}`] = manager.buildMetadataFieldPrompt(spec, ctx(id, form));
      }
    }
  }
  return out;
}

module.exports = { assembleTitlesPrompts, ctx, INSIGHTS_BLOCK };
