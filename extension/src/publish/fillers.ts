// The fill registry.
//
// Each action declares { id, label, surface, detect, fill } so adding the planned extras
// later (thumbnail upload, scheduling) is one new entry rather than surgery on the panel.
// Monetization (0.2.1) was exactly that: one entry, plus the `surface` field it needed
// because its control is on a different Studio panel from every other field.
//
// Nothing here is ever committed on the operator's behalf: fillers put text into the
// form and stop. The operator still presses "Set test" in the A/B dialog and "Save" on
// the page — that human click is the whole point of the design.
//
// Selector policy: prefer STABLE attributes over visible text.
//   * the radios carry locale-independent `name`s (VIDEO_HAS_ALTERED_CONTENT_NO, …)
//   * chip removal uses `#delete-icon`, not the localized aria-label "Remove"
//   * A/B variant slots are located BY POSITION inside the dialog, with the
//     `aria-label="Add title N"` only used as a confirmation, because that label is
//     localized English and would break on a non-English Studio.

import {
  findMonetizationRadios,
  monetizationAvailability,
  planMonetization,
  radioIsChecked,
} from './monetization';
import {
  FillError,
  buttonByText,
  isDisabled,
  pressEnter,
  setContentEditable,
  setNativeInput,
  sleep,
  visible,
  visibleAll,
  waitFor,
} from './dom';

export type FillId =
  | 'title'
  | 'ab-test'
  | 'description'
  | 'tags'
  | 'altered-content'
  | 'paid-promotion'
  | 'monetization';

/**
 * Which Studio SURFACE a filler's controls live on.
 *
 * Studio splits one video's settings across two places that are never on screen at the
 * same time: the metadata form ('details' — the standalone /video/<id>/edit page, or the
 * upload wizard's Details step) and the monetization panel ('monetization' — the
 * standalone /video/<id>/monetization page, or the wizard's Monetization step).
 *
 * Declared per filler rather than inferred, so the shelf can offer exactly the actions
 * the page in front of the operator can actually take, and "Fill everything" means
 * "everything fillable HERE" instead of a run that half-fails by design. Adding a filler
 * for a third surface is one more value.
 */
export type FillSurface = 'details' | 'monetization';

export interface FillContext {
  /** Ordered. titles[0] is the main title AND A/B variant 1. */
  titles: string[];
  description: string;
  /** Comma-separated. */
  tags: string;
  /**
   * The operator's monetization intent: true = turn it on, false = turn it off, null =
   * no decision recorded, which means the monetization control is not touched at all.
   * Three-valued for a reason — see ChosenMetadata.monetize in the app.
   */
  monetize: boolean | null;
}

export type FillOutcome =
  | { ok: true; detail: string }
  | { ok: false; reason: string };

export interface Filler {
  id: FillId;
  label: string;
  /** The Studio page/panel this filler's controls live on. */
  surface: FillSurface;
  /** Whether this action has anything to do on the current page with this data. */
  detect(ctx: FillContext): { available: true } | { available: false; reason: string };
  fill(ctx: FillContext): Promise<FillOutcome>;
}

// ---------------------------------------------------------------- selectors

const SEL = {
  mainTitle: 'div#textbox[aria-label^="Add a title"]',
  description: 'div#textbox[aria-label^="Tell viewers"]',
  // MUST stay scoped to #tags-container. In the upload wizard the modal overlays the
  // channel content list, whose navigation filter chips (Videos / Shorts / Live / Posts /
  // Playlists) are ALSO `ytcp-chip` and are also visible — and they sort FIRST in document
  // order. An unscoped `ytcp-chip` therefore grabs "Videos", which has no delete button,
  // and clearing dies before touching a single real tag. (Hit live on the first run.)
  tagsContainer: 'ytcp-form-input-container#tags-container',
  tagsInput: 'ytcp-form-input-container#tags-container input#text-input',
  tagChip: 'ytcp-form-input-container#tags-container ytcp-chip',
  chipDelete: '#delete-icon',
  radio: (name: string) => `tp-yt-paper-radio-button[name="${name}"]`,
  ALTERED_NO: 'VIDEO_HAS_ALTERED_CONTENT_NO',
  // Paid promotion has TWO shapes depending on entry point:
  //   standalone page -> a radio pair (…_NOTIFY / …_NO)
  //   upload wizard   -> a single checkbox #has-ppp; UNCHECKED means "no paid promotion"
  PAID_NO: 'VIDEO_PAID_PRODUCT_PLACEMENT_NO',
  paidCheckbox: 'ytcp-checkbox-lit#has-ppp',
  // Stable ids beat visible text: these work regardless of Studio's language.
  // Verified live in BOTH entry points (standalone /edit page and the upload wizard).
  abTestButton: 'ytcp-button#ab-test-button',
  showMoreToggle: 'ytcp-video-metadata-editor ytcp-button#toggle-button',
};

/**
 * Studio hides tags / altered-content / paid-promotion behind "Show more"; those fields
 * do not exist in the DOM until it's expanded. Idempotent — if the fields are already
 * present this does nothing.
 */
async function ensureAdvancedExpanded(): Promise<void> {
  if (visible(SEL.tagsInput)) return;

  // Prefer the stable id; fall back to the (localized) label only if Studio changes it.
  const showMore = visible<HTMLElement>(SEL.showMoreToggle) ?? buttonByText(/show more/i);
  if (!showMore) {
    throw new FillError('Could not find the "Show more" control to reveal the advanced fields');
  }
  showMore.click();
  await waitFor(() => visible(SEL.tagsInput), 'the advanced fields to expand');
}

// ---------------------------------------------------------------- A/B dialog

/**
 * Locate the A/B variant slots.
 *
 * The dialog's host element DIFFERS by entry point — `ytcp-dialog` on the standalone
 * /video/<id>/edit page, `tp-yt-paper-dialog#dialog` in the upload wizard — so this must
 * not be scoped to one container type. (Scoping to ytcp-dialog only was a real bug: in
 * the wizard it found nothing and timed out.)
 *
 * Fast path is the aria-label, which needs no container at all. The positional fallback
 * covers a non-English Studio, and deliberately skips any container holding the
 * DESCRIPTION field — that's the wizard modal itself, whose title+description textboxes
 * would otherwise look like two variant slots and get overwritten.
 */
function abSlots(): HTMLElement[] {
  const byLabel = visibleAll<HTMLElement>('div#textbox[aria-label^="Add title"]');
  if (byLabel.length >= 2) return byLabel;

  const description = visible<HTMLElement>(SEL.description);
  const containers = visibleAll<HTMLElement>('tp-yt-paper-dialog, ytcp-dialog');

  for (const container of containers) {
    if (description && container.contains(description)) continue; // the page/wizard form
    const boxes = [...container.querySelectorAll<HTMLElement>('div#textbox')].filter(
      (b) => b.getBoundingClientRect().height > 0,
    );
    if (boxes.length >= 2) return boxes;
  }
  return [];
}

async function openAbDialog(): Promise<HTMLElement[]> {
  if (abSlots().length >= 2) return abSlots();

  // The TITLE A/B trigger has a stable id. The page also carries a separate thumbnail
  // experiment control (ytcp-thumbnails-experiment-editor), which must not be clicked.
  const byId = visible<HTMLElement>(SEL.abTestButton);

  if (byId) {
    byId.click();
  } else {
    // Fallback: nearest "A/B Testing" control to the title field.
    const titleEl = visible<HTMLElement>(SEL.mainTitle);
    if (!titleEl) throw new FillError(`Title field not found (${SEL.mainTitle})`);
    const titleY = titleEl.getBoundingClientRect().top;

    const triggers = visibleAll<HTMLElement>('ytcp-button, button, tp-yt-paper-button').filter((b) =>
      /a\/b\s*testing/i.test((b.textContent || '').trim()),
    );
    triggers.sort(
      (a, b) =>
        Math.abs(a.getBoundingClientRect().top - titleY) -
        Math.abs(b.getBoundingClientRect().top - titleY),
    );
    const nearest = triggers[0];
    if (!nearest) {
      throw new FillError('No "A/B Testing" control on this page — the video may not be eligible');
    }
    nearest.click();
  }

  return waitFor(() => {
    const slots = abSlots();
    return slots.length >= 2 ? slots : null;
  }, 'the A/B testing dialog to open');
}

// ---------------------------------------------------------------- fillers

/**
 * The main title field on the page.
 *
 * SEPARATE from the A/B action on purpose. A test is not a one-shot setup: cancelling a
 * running test, changing the titles and setting a new one is normal, and that has to be
 * possible without also rewriting the page's title field. Both still run under "Fill
 * everything", in this order.
 */
const titleFiller: Filler = {
  id: 'title',
  label: 'Main title',
  surface: 'details',
  detect(ctx) {
    if (!ctx.titles.length) return { available: false, reason: 'No titles chosen for this item' };
    if (!visible(SEL.mainTitle)) return { available: false, reason: 'Title field not on this page' };
    return { available: true };
  },
  async fill(ctx) {
    try {
      const main = visible<HTMLElement>(SEL.mainTitle);
      if (!main) throw new FillError(`Title field not found (${SEL.mainTitle})`);

      const primary = ctx.titles[0];
      if (!primary) throw new FillError('No titles to fill');

      // Variant 1 is the main title.
      setContentEditable(main, primary);
      await sleep(250);
      return { ok: true, detail: 'Set the main title.' };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
};

/**
 * The A/B variant dialog, on its own so a test can be re-set at any time.
 *
 * Deliberately does NOT check whether a test is already running: Studio's own dialog is
 * the authority on that, and guessing from the page would either block a legitimate
 * re-fill or claim a test exists when it doesn't. If a test IS live, opening the dialog
 * shows it and the fill reports what it actually found.
 */
const abTestFiller: Filler = {
  id: 'ab-test',
  label: 'A/B variants',
  surface: 'details',
  detect(ctx) {
    if (ctx.titles.length < 2) {
      return {
        available: false,
        reason: `Pick at least 2 titles (${ctx.titles.length} chosen)`,
      };
    }
    // Drafts are ineligible for A/B testing, so the control simply isn't rendered — say
    // that rather than opening a dialog that will never appear.
    const hasControl =
      !!visible(SEL.abTestButton) ||
      visibleAll<HTMLElement>('ytcp-button, button, tp-yt-paper-button').some((b) =>
        /a\/b\s*testing/i.test((b.textContent || '').trim()),
      );
    if (!hasControl) {
      return { available: false, reason: 'No A/B control here — drafts cannot be tested' };
    }
    return { available: true };
  },
  async fill(ctx) {
    try {
      if (ctx.titles.length < 2) {
        return { ok: false, reason: 'A/B testing needs at least 2 titles' };
      }

      const slots = await openAbDialog();
      if (slots.length < ctx.titles.length) {
        return {
          ok: false,
          reason: `Chose ${ctx.titles.length} titles but the dialog only offers ${slots.length} slots`,
        };
      }

      for (let i = 0; i < ctx.titles.length; i++) {
        const slot = slots[i];
        const text = ctx.titles[i];
        if (!slot || text === undefined) {
          return { ok: false, reason: `A/B variant slot ${i + 1} went missing while filling` };
        }
        setContentEditable(slot, text);
        await sleep(200);
      }

      // Confirm Studio actually registered the variants: "Set test" stays disabled until
      // variant 2 is non-empty, so an enabled button is proof the writes landed.
      const setTest = buttonByText(/set test/i);
      if (setTest && isDisabled(setTest)) {
        return {
          ok: false,
          reason: 'Variants were written but "Set test" is still disabled — Studio did not register them',
        };
      }

      return {
        ok: true,
        detail: `Filled ${ctx.titles.length} variants. Press "Set test" to start it.`,
      };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
};

const descriptionFiller: Filler = {
  id: 'description',
  label: 'Description',
  surface: 'details',
  detect(ctx) {
    if (!ctx.description.trim()) return { available: false, reason: 'No description for this item' };
    if (!visible(SEL.description)) return { available: false, reason: 'Description field not on this page' };
    return { available: true };
  },
  async fill(ctx) {
    try {
      const el = visible<HTMLElement>(SEL.description);
      if (!el) throw new FillError(`Description field not found (${SEL.description})`);

      setContentEditable(el, ctx.description);
      await sleep(300);

      // Verify: contenteditable writes can be silently swallowed, so read it back.
      const written = (el.textContent || '').trim();
      const expectedHead = ctx.description.trim().slice(0, 40);
      if (!written.startsWith(expectedHead.slice(0, 20))) {
        return { ok: false, reason: 'Description did not take — the field still shows different text' };
      }
      return { ok: true, detail: `Replaced the description (${ctx.description.length} chars).` };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
};

const tagsFiller: Filler = {
  id: 'tags',
  label: 'Tags',
  surface: 'details',
  detect(ctx) {
    if (!ctx.tags.trim()) return { available: false, reason: 'No tags for this item' };
    return { available: true };
  },
  async fill(ctx) {
    try {
      await ensureAdvancedExpanded();

      const input = visible<HTMLInputElement>(SEL.tagsInput);
      if (!input) throw new FillError(`Tags input not found (${SEL.tagsInput})`);

      // Tags APPEND rather than replace, so the channel-default chips must go first.
      // Each removal re-renders the chip bar, hence the re-query each pass. The guard
      // bounds it so a broken delete button can't spin forever.
      let removed = 0;
      for (let guard = 0; guard < 200; guard++) {
        // Re-query each pass: removing a chip re-renders the whole bar.
        const chip = visibleAll<HTMLElement>(SEL.tagChip).find((c) =>
          c.querySelector<HTMLElement>(SEL.chipDelete),
        );
        if (!chip) break;
        chip.querySelector<HTMLElement>(SEL.chipDelete)!.click();
        removed++;
        await sleep(120);
      }

      const stuck = visibleAll<HTMLElement>(SEL.tagChip).length;
      if (stuck > 0) {
        return {
          ok: false,
          reason: `Could not clear ${stuck} existing tag(s) — they have no delete control`,
        };
      }

      // One comma-separated write; Studio splits it into chips on Enter.
      const wanted = ctx.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      setNativeInput(input, wanted.join(','));
      await sleep(200);
      pressEnter(input);
      await sleep(500);

      const finalCount = visibleAll(SEL.tagChip).length;
      if (finalCount === 0) {
        return { ok: false, reason: 'Tags were typed but no chips were created' };
      }
      return {
        ok: true,
        detail: `Removed ${removed} existing tag(s), added ${finalCount}.`,
      };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
};

/** Shared implementation for the two standing-default radio answers. */
function radioFiller(
  id: FillId,
  label: string,
  radioName: string,
  successDetail: string,
): Filler {
  return {
    id,
    label,
    // Both standing-default answers live in the details form's advanced section.
    surface: 'details',
    detect() {
      return { available: true };
    },
    async fill() {
      try {
        await ensureAdvancedExpanded();

        const radio = visible<HTMLElement>(SEL.radio(radioName));
        if (!radio) {
          throw new FillError(`Radio "${radioName}" not found — Studio may have changed this form`);
        }

        if (radio.getAttribute('aria-checked') === 'true') {
          return { ok: true, detail: `${successDetail} (already set)` };
        }

        radio.click();
        await sleep(300);

        if (radio.getAttribute('aria-checked') !== 'true') {
          return { ok: false, reason: `Clicked "${radioName}" but it did not become selected` };
        }
        return { ok: true, detail: successDetail };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

const alteredContentFiller = radioFiller(
  'altered-content',
  'No altered/AI content',
  SEL.ALTERED_NO,
  'Answered "No" to altered content.',
);

/** True if a ytcp-checkbox-lit is ticked. The component exposes this inconsistently, so
 *  check every representation rather than trusting one. */
function checkboxIsChecked(el: HTMLElement): boolean {
  if (el.getAttribute('aria-checked') === 'true') return true;
  if (el.hasAttribute('checked')) return true;
  const inner = el.querySelector<HTMLInputElement>('input[type="checkbox"]');
  return !!inner?.checked;
}

/**
 * "No paid promotion", across both form shapes.
 *
 * Wizard: a single checkbox (#has-ppp) where UNCHECKED already means no paid promotion,
 * so the correct action is usually to confirm and do nothing.
 * Standalone page: an explicit radio pair, where "No" must be actively selected.
 */
const paidPromotionFiller: Filler = {
  id: 'paid-promotion',
  label: 'No paid promotion',
  surface: 'details',
  detect() {
    return { available: true };
  },
  async fill() {
    try {
      await ensureAdvancedExpanded();

      const checkbox = visible<HTMLElement>(SEL.paidCheckbox);
      if (checkbox) {
        if (!checkboxIsChecked(checkbox)) {
          return { ok: true, detail: 'Paid promotion is unchecked (no sponsor).' };
        }
        checkbox.click();
        await sleep(300);
        if (checkboxIsChecked(checkbox)) {
          return { ok: false, reason: 'Clicked the paid-promotion checkbox but it stayed checked' };
        }
        return { ok: true, detail: 'Unchecked paid promotion.' };
      }

      const radio = visible<HTMLElement>(SEL.radio(SEL.PAID_NO));
      if (!radio) {
        throw new FillError(
          'No paid-promotion control found (neither the #has-ppp checkbox nor the radio pair)',
        );
      }
      if (radio.getAttribute('aria-checked') === 'true') {
        return { ok: true, detail: 'Answered "No" to paid promotion. (already set)' };
      }
      radio.click();
      await sleep(300);
      if (radio.getAttribute('aria-checked') !== 'true') {
        return { ok: false, reason: 'Clicked "No" for paid promotion but it did not select' };
      }
      return { ok: true, detail: 'Answered "No" to paid promotion.' };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
};

/**
 * Monetization — the one field the YouTube Data API cannot write at all.
 *
 * Lives on a DIFFERENT Studio surface from every other filler (the standalone
 * /video/VIDEOID/monetization page, or the upload wizard's Monetization step), which is
 * why `surface` exists. This filler does NOT navigate there: the shelf offers it only
 * when the control is already on screen, because clicking Studio's own navigation on the
 * operator's behalf is the automation this design refuses to do — and a "navigate then
 * fill" would also silently discard unsaved edits on the details form.
 *
 * All of the deciding is in monetization.ts and is pure. What is left here is: read the
 * radios, ask what to do, do exactly that, and confirm it landed.
 */
const monetizationFiller: Filler = {
  id: 'monetization',
  label: 'Monetization',
  surface: 'monetization',
  detect(ctx) {
    // Cheap check first: with no decision recorded there is nothing to do regardless of
    // what page this is, and scanning the DOM to say so would be wasted work.
    if (ctx.monetize === null) return monetizationAvailability(null, false);
    return monetizationAvailability(ctx.monetize, findMonetizationRadios().found);
  },
  async fill(ctx) {
    try {
      if (ctx.monetize === null) {
        // Reachable via "Fill everything" if the shelf's data changed under it. Refusing
        // is the point of the third state: no decision means touch nothing.
        return {
          ok: false,
          reason: 'No monetization decision on this report — nothing was changed.',
        };
      }

      const target = findMonetizationRadios();
      if (!target.found) throw new FillError(target.reason);

      const plan = planMonetization(target.facts, ctx.monetize);
      if (plan.kind === 'refuse') throw new FillError(plan.reason);
      if (plan.kind === 'already') return { ok: true, detail: plan.detail };

      const radio = target.radios[plan.index];
      if (!radio) {
        throw new FillError(
          `Monetization radio ${plan.index + 1} of ${target.radios.length} vanished before it was clicked`,
        );
      }

      radio.click();
      await sleep(300);

      if (!radioIsChecked(radio)) {
        return {
          ok: false,
          reason:
            `Clicked the "${ctx.monetize ? 'on' : 'off'}" monetization radio but it did not ` +
            `become selected — Studio may be refusing it (channel not in the Partner ` +
            `Program, or this video not eligible).`,
        };
      }
      return { ok: true, detail: `${plan.detail} Press Save in Studio to keep it.` };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
};

/**
 * Registry order IS the execution order for "Fill everything".
 *
 * The A/B action is LAST on purpose: it opens a modal that covers the rest of the form.
 * Filling the page fields first means the operator ends up looking at the A/B dialog with
 * everything else already done behind it. The main title comes immediately before it, so
 * the page field is set while the form is still reachable.
 */
export const FILLERS: Filler[] = [
  tagsFiller,
  descriptionFiller,
  alteredContentFiller,
  paidPromotionFiller,
  titleFiller,
  abTestFiller,
  // Last, and on its own surface: it is never on screen at the same time as the ones
  // above, so a run that includes it is a run on the monetization panel alone.
  monetizationFiller,
];

export function fillerById(id: FillId): Filler | undefined {
  return FILLERS.find((f) => f.id === id);
}

/**
 * The fillers whose controls live on one of the surfaces currently on screen.
 *
 * The shelf builds its buttons from this rather than from FILLERS, so an action is never
 * offered for a panel the operator is not looking at — a "Description" button on the
 * monetization tab could only ever fail.
 */
export function fillersForSurfaces(surfaces: FillSurface[]): Filler[] {
  return FILLERS.filter((f) => surfaces.includes(f.surface));
}
