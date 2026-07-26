// Low-level DOM helpers for writing into YouTube Studio's form fields.
//
// Studio is a Polymer app in SHADY DOM mode (look for `<!--css-build:shady-->`), so its
// fields live in the LIGHT dom and plain querySelector reaches them — no shadow-root
// piercing required. Verified live 2026-07-26.
//
// There are TWO distinct write mechanics and using the wrong one silently does nothing:
//
//   * title / description are contenteditable <div id="textbox"> elements.
//     Assigning .textContent does not notify Polymer; execCommand('insertText') produces
//     a genuine beforeinput/input sequence and does.
//   * tags is a real <input>. execCommand doesn't apply; it needs the NATIVE value setter
//     plus an 'input' event, then Enter to commit (commas split into separate chips).
//
// Everything here FAILS LOUD. A selector that misses returns a specific reason rather
// than quietly no-opping — a silent no-op reads as "filled" and would only be discovered
// after publishing.

export class FillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FillError';
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` returns a truthy value, or throw after `timeoutMs`. */
export async function waitFor<T>(
  predicate: () => T | null | undefined | false,
  what: string,
  timeoutMs = 8000,
  intervalMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new FillError(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await sleep(intervalMs);
  }
}

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** First VISIBLE match, or null. Studio keeps detached/hidden copies of fields around. */
export function visible<E extends Element>(selector: string): E | null {
  for (const el of document.querySelectorAll<E>(selector)) {
    if (isVisible(el)) return el;
  }
  return null;
}

export function visibleAll<E extends Element>(selector: string): E[] {
  return [...document.querySelectorAll<E>(selector)].filter(isVisible);
}

/**
 * Write into a contenteditable field (title, description, A/B variants).
 *
 * Selects the existing contents first so this REPLACES rather than appends — Studio
 * drafts arrive pre-populated with channel-default text.
 */
export function setContentEditable(el: HTMLElement, text: string): void {
  el.focus();

  const selection = window.getSelection();
  if (!selection) throw new FillError('No window selection available');
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);

  if (text === '') {
    document.execCommand('delete');
    return;
  }
  if (!document.execCommand('insertText', false, text)) {
    throw new FillError('execCommand("insertText") was rejected by the browser');
  }
}

/**
 * Write into a real <input>. Assigning .value directly is not observed by Polymer, so
 * this goes through the native prototype setter and then dispatches 'input'.
 */
export function setNativeInput(el: HTMLInputElement, text: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const setter = descriptor?.set;
  if (!setter) throw new FillError('Could not access the native HTMLInputElement value setter');

  el.focus();
  setter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Full keydown/keypress/keyup triple — Studio's tag input commits on keydown but
 *  other Polymer inputs listen on keypress, so send all three. */
export function pressEnter(el: HTMLElement): void {
  for (const type of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(
      new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
      } as KeyboardEventInit),
    );
  }
}

/** Find a Studio button by its visible label. Text-based, so only for controls that
 *  have no stable id/name — prefer attribute selectors where they exist. */
export function buttonByText(pattern: RegExp): HTMLElement | null {
  const candidates = visibleAll<HTMLElement>('ytcp-button, button, tp-yt-paper-button');
  return candidates.find((b) => pattern.test((b.textContent || '').trim())) ?? null;
}

export function isDisabled(el: Element): boolean {
  return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
}
