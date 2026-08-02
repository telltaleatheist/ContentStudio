// The on-page ContentStudio shelf.
//
// Always mounted on Studio, never auto-fills. It shows what ContentStudio has and waits
// for a click; that human review step is what keeps this "assisted data entry by the
// account owner" rather than automation, and it's also just safer — a bad filename match
// never silently writes the wrong titles onto the wrong video.
//
// Deliberate properties:
//   - PERSISTENT. It survives SPA navigation and closing a video, because it is also how
//     the operator browses reports and picks titles, not just a per-video prompt.
//   - MOVABLE + COLLAPSIBLE, persisted, since it overlays a UI the operator needs to see.
//   - TERSE. Only what can't be inferred: which report is loaded, what state it's in, the
//     titles, the actions, and any failure. Explanations live in the app, not on top of
//     someone's work.
//
// Rendered inside a shadow root so Studio's stylesheet can't reach in and ours can't leak
// out. Two tabs: the video currently open, and the report browser.

import { FILLERS, type FillContext, type FillId, type Filler } from './fillers';
import type { BrowsePage, BrowseRow, ItemDetail } from './publish-client';
import { DEFAULT_SHELF_PREFS, loadShelfPrefs, saveShelfPrefs, type ShelfPrefs } from './shelf-prefs';
import { STALE_CONTEXT_MESSAGE, extensionContextAlive } from './publish-messages';

const HOST_ID = 'contentstudio-publish-shelf';

/** Fixed row height for the virtual list. Must match .row height in CSS. */
const ROW_HEIGHT = 42;
/** Rows fetched per request. */
const PAGE_SIZE = 50;
/** Extra rows rendered above/below the viewport so scrolling doesn't flash blanks. */
const OVERSCAN = 6;

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.shell {
  position: fixed; bottom: 16px; z-index: 2147483000;
  font: 12px/1.4 Roboto, system-ui, -apple-system, sans-serif;
  color: #f1f1f1;
}
.shell.right { right: 16px; }
.shell.left { left: 16px; }
.card {
  width: 320px; max-height: 72vh; display: flex; flex-direction: column;
  background: #212121; border: 1px solid #383838; border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.55); overflow: hidden;
}
.head {
  display: flex; align-items: center; gap: 2px; flex: 0 0 auto;
  padding: 6px 6px 6px 10px; background: #282828; border-bottom: 1px solid #383838;
}
.head .name {
  flex: 1; font-size: 10px; font-weight: 700; letter-spacing: .08em;
  text-transform: uppercase; color: #ff6b35;
}
.icon {
  cursor: pointer; border: 0; background: transparent; color: #999;
  font-size: 13px; line-height: 1; padding: 4px 5px; border-radius: 5px;
}
.icon:hover { color: #fff; background: #383838; }
.icon.spin { animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.card.flash { animation: flash 1s ease-out 2; }
@keyframes flash {
  0%, 100% { border-color: #383838; box-shadow: 0 8px 28px rgba(0,0,0,.55); }
  35%      { border-color: #ff6b35; box-shadow: 0 0 0 3px rgba(255,107,53,.35), 0 8px 28px rgba(0,0,0,.55); }
}
.tabs { display: flex; flex: 0 0 auto; border-bottom: 1px solid #383838; background: #242424; }
.tab {
  flex: 1; cursor: pointer; border: 0; background: transparent; color: #999;
  padding: 6px 4px; font-size: 11px; font-weight: 600;
  border-bottom: 2px solid transparent;
}
.tab.on { color: #f1f1f1; border-bottom-color: #ff6b35; }
.tab:hover:not(.on) { color: #ddd; }
.body { flex: 1 1 auto; overflow: auto; padding: 10px; min-height: 60px; }
.pill {
  cursor: pointer; display: flex; align-items: center; gap: 6px;
  padding: 8px 10px; background: #212121; border: 1px solid #383838;
  border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.5);
  font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  color: #ff6b35; white-space: nowrap;
}
.pill:hover { border-color: #ff6b35; }
.pill .badge {
  background: #ff6b35; color: #fff; border-radius: 8px; padding: 1px 5px;
  font-size: 10px; letter-spacing: 0;
}
.label { font-weight: 600; word-break: break-word; }
.sub { color: #8f8f8f; font-size: 11px; margin-top: 1px; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 8px; }
.chip {
  font-size: 10px; padding: 1px 6px; border-radius: 10px;
  background: #303030; color: #bbb; border: 1px solid #454545;
}
.chip.warn { color: #ffcf6b; border-color: #5a4a20; }
.chip.good { color: #7ddc7d; border-color: #2c4a2c; }
.pick { margin: 0; padding: 0; list-style: none; }
.pick li {
  display: flex; align-items: flex-start; gap: 7px; padding: 5px 6px;
  border-radius: 6px; cursor: pointer; border: 1px solid transparent;
}
.pick li:hover { background: #2a2a2a; }
.pick li.on { background: #2e2419; border-color: #ff6b35; }
.pick li.full { opacity: .45; cursor: default; }
.pick li.full:hover { background: transparent; }
.n {
  flex: 0 0 17px; height: 17px; margin-top: 1px; border-radius: 50%;
  background: #3a3a3a; color: #888; font-size: 10px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.on .n { background: #ff6b35; color: #fff; }
.t { flex: 1; }
.len { color: #777; font-size: 10px; }
.len.over { color: #ff8a80; }
.more {
  cursor: pointer; background: transparent; border: 0; color: #8f8f8f;
  font-size: 11px; padding: 5px 0 0; text-decoration: underline;
}
.more:hover { color: #ddd; }
.actions { display: flex; flex-direction: column; gap: 5px; margin-top: 9px; }
button.act {
  cursor: pointer; text-align: left; padding: 6px 9px; font-size: 11px;
  color: #f1f1f1; background: #303030; border: 1px solid #454545; border-radius: 6px;
}
button.act:hover:not(:disabled) { border-color: #ff6b35; }
button.act:disabled { opacity: .4; cursor: default; }
button.primary {
  background: #ff6b35; border-color: #ff6b35; color: #fff;
  font-weight: 700; text-align: center; padding: 7px 9px; font-size: 12px;
}
.log { margin-top: 9px; border-top: 1px solid #383838; padding-top: 7px; }
.line { display: flex; gap: 5px; padding: 1px 0; font-size: 11px; }
.ok { color: #7ddc7d; }
.bad { color: #ff8a80; }
.muted { color: #8f8f8f; }
.err {
  color: #ff8a80; background: #2c1d1d; border: 1px solid #5a2b2b;
  border-radius: 6px; padding: 6px 8px; margin-top: 8px; font-size: 11px;
}
.search {
  width: 100%; padding: 6px 8px; margin-bottom: 8px; font-size: 11px;
  color: #f1f1f1; background: #303030; border: 1px solid #454545; border-radius: 6px;
}
.search:focus { outline: none; border-color: #ff6b35; }
.scroller { height: 46vh; overflow-y: auto; position: relative; }
.spacer { position: relative; width: 100%; }
.row {
  position: absolute; left: 0; right: 0; height: ${ROW_HEIGHT}px;
  display: flex; align-items: center; gap: 6px; padding: 0 6px;
  border-radius: 6px; cursor: pointer; overflow: hidden;
}
.row:hover { background: #2a2a2a; }
.row .rl { flex: 1; min-width: 0; }
.row .rt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row.skeleton { cursor: default; color: #666; }
.row.skeleton:hover { background: transparent; }
.count { font-size: 10px; padding: 1px 5px; border-radius: 8px; background: #303030; color: #999; }
.count.set { background: #ff6b35; color: #fff; }
`;

export interface ShelfCallbacks {
  /** Run the named fillers against the currently loaded item. */
  onFill(ids: FillId[]): Promise<void>;
  /** Re-pull everything from ContentStudio. */
  onRefresh(): Promise<void>;
  /** Operator chose a report from the browser. */
  onOpenReport(jobId: string, itemIndex: number): Promise<void>;
  /** Operator changed the chosen title set. Order is the variant order. */
  onSaveTitles(titles: string[]): Promise<void>;
  /** Fetch one page of the report index. */
  onFetchReports(offset: number, limit: number, query: string): Promise<BrowsePage>;
}

type Tab = 'current' | 'reports';

/** What the shelf knows about the Studio page underneath it. */
export interface PageContext {
  videoId: string | null;
  filename: string | null;
  isDraft: boolean;
  /** Whether the metadata form is actually present and fillable. */
  formReady: boolean;
}

export class PublishShelf {
  private host: HTMLElement;
  private root: ShadowRoot;
  private shell!: HTMLElement;
  private card!: HTMLElement;
  private body!: HTMLElement;
  private tabsEl!: HTMLElement;
  private refreshBtn!: HTMLButtonElement;

  private prefs: ShelfPrefs = { ...DEFAULT_SHELF_PREFS };
  private tab: Tab = 'current';
  private busy = false;

  // ---- current-item state
  private item: ItemDetail | null = null;
  private reason = '';
  private page: PageContext = { videoId: null, filename: null, isDraft: false, formReady: false };
  private statusText = 'Waiting for ContentStudio…';
  private errorText: string | null = null;
  private showAllTitles = false;
  private logLines: Array<{ ok: boolean; text: string }> = [];

  // ---- report browser state
  private pages = new Map<number, BrowseRow[]>();
  private inFlight = new Set<number>();
  private total = 0;
  private unreadable = 0;
  private query = '';
  private searchTimer: number | null = null;
  private scrollTop = 0;
  private browseError: string | null = null;

  constructor(private callbacks: ShelfCallbacks) {
    document.getElementById(HOST_ID)?.remove();

    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    this.root = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    this.root.append(style);
  }

  /** Attach to the page and paint. Prefs load first so it never flashes on the wrong side. */
  async mount(): Promise<void> {
    this.prefs = await loadShelfPrefs();
    document.body.appendChild(this.host);
    this.render();
  }

  destroy(): void {
    this.host.remove();
  }

  // ------------------------------------------------------------------ state in

  /** The Studio page changed underneath us. */
  setPageContext(page: PageContext): void {
    this.page = page;
    this.render();
  }

  /**
   * A report is loaded and ready to act on.
   *
   * `demand` means the operator has something to do here (a match with no titles picked).
   * A collapsed shelf expands for that, and only that — expanding on every navigation
   * would make the collapse button useless.
   */
  setItem(item: ItemDetail, reason: string, demand = false): void {
    this.item = item;
    this.reason = reason;
    this.errorText = null;
    this.showAllTitles = false;
    this.logLines = [];
    this.tab = 'current';
    if (demand && this.prefs.collapsed) {
      void this.setCollapsed(false);
      return; // setCollapsed re-renders
    }
    this.render();
  }

  /**
   * Bring the shelf to the operator's attention: expand it and flash the frame.
   *
   * Driven by the toolbar button, whose obvious meaning is "show me the thing".
   */
  async reveal(): Promise<void> {
    this.tab = 'current';
    if (this.prefs.collapsed) await this.setCollapsed(false);
    else this.render();

    const card = this.root.querySelector('.card') as HTMLElement | null;
    if (!card) return;
    card.classList.remove('flash');
    // Force a reflow so re-adding the class restarts the animation on a repeat click.
    void card.offsetWidth;
    card.classList.add('flash');
  }

  /** No report loaded; explain why in one line. */
  setStatus(text: string): void {
    this.item = null;
    this.reason = '';
    this.statusText = text;
    this.errorText = null;
    this.render();
  }

  /** A real fault. Stays on screen until something replaces it. */
  setError(text: string): void {
    this.errorText = text;
    this.render();
  }

  /** Append one fill result. Failures stay visible — never silently swallowed. */
  log(ok: boolean, filler: Filler | null, message: string): void {
    this.logLines.push({ ok, text: filler ? `${filler.label}: ${message}` : message });
    this.render();
  }

  /** Drop cached report pages so the next browse re-reads from ContentStudio. */
  invalidateReports(): void {
    this.pages.clear();
    this.inFlight.clear();
    this.total = 0;
    this.browseError = null;
  }

  // -------------------------------------------------------------------- render

  private render(): void {
    const existing = this.root.querySelector('.shell');
    existing?.remove();

    this.shell = document.createElement('div');
    this.shell.className = `shell ${this.prefs.side}`;

    if (this.prefs.collapsed) {
      this.shell.appendChild(this.buildPill());
      this.root.appendChild(this.shell);
      return;
    }

    this.card = document.createElement('div');
    this.card.className = 'card';
    this.card.appendChild(this.buildHead());
    this.card.appendChild(this.buildTabs());

    this.body = document.createElement('div');
    this.body.className = 'body';
    this.card.appendChild(this.body);

    this.shell.appendChild(this.card);
    this.root.appendChild(this.shell);

    if (this.tab === 'current') this.renderCurrent();
    else this.renderBrowser();
  }

  private buildPill(): HTMLElement {
    const pill = document.createElement('button');
    pill.className = 'pill';
    pill.title = 'Open ContentStudio shelf';
    pill.textContent = 'ContentStudio';
    if (this.item) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = `${this.item.chosenTitles.length}/${this.item.maxVariants}`;
      pill.appendChild(badge);
    }
    pill.addEventListener('click', () => {
      void this.setCollapsed(false);
    });
    return pill;
  }

  private buildHead(): HTMLElement {
    const head = document.createElement('div');
    head.className = 'head';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = 'ContentStudio';
    head.appendChild(name);

    this.refreshBtn = this.iconButton('⟳', 'Pull the latest from ContentStudio', () => {
      void this.doRefresh();
    });
    head.appendChild(this.refreshBtn);

    head.appendChild(
      this.iconButton(
        this.prefs.side === 'right' ? '⇤' : '⇥',
        this.prefs.side === 'right' ? 'Move to the left' : 'Move to the right',
        () => {
          void this.setSide(this.prefs.side === 'right' ? 'left' : 'right');
        },
      ),
    );

    head.appendChild(
      this.iconButton('–', 'Collapse', () => {
        void this.setCollapsed(true);
      }),
    );

    return head;
  }

  private buildTabs(): HTMLElement {
    this.tabsEl = document.createElement('div');
    this.tabsEl.className = 'tabs';

    const mk = (id: Tab, text: string) => {
      const b = document.createElement('button');
      b.className = `tab${this.tab === id ? ' on' : ''}`;
      b.textContent = text;
      b.addEventListener('click', () => {
        if (this.tab === id) return;
        this.tab = id;
        this.render();
      });
      return b;
    };

    this.tabsEl.append(mk('current', 'This video'), mk('reports', 'Reports'));
    return this.tabsEl;
  }

  private iconButton(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'icon';
    b.textContent = glyph;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  // ------------------------------------------------------------ current-item view

  private renderCurrent(): void {
    if (this.errorText) {
      this.body.appendChild(this.errorBox(this.errorText));
    }

    if (!this.item) {
      const s = document.createElement('div');
      s.className = 'muted';
      s.textContent = this.statusText;
      this.body.appendChild(s);

      const browse = document.createElement('button');
      browse.className = 'act';
      browse.style.marginTop = '8px';
      browse.style.width = '100%';
      browse.textContent = 'Browse reports…';
      browse.addEventListener('click', () => {
        this.tab = 'reports';
        this.render();
      });
      this.body.appendChild(browse);
      return;
    }

    const item = this.item;

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = item.label;
    this.body.appendChild(label);

    if (this.reason) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = this.reason;
      this.body.appendChild(sub);
    }

    this.body.appendChild(this.buildChips(item));
    this.body.appendChild(this.buildPicker(item));
    this.body.appendChild(this.buildActions(item));

    if (this.logLines.length) {
      const log = document.createElement('div');
      log.className = 'log';
      for (const line of this.logLines) {
        const div = document.createElement('div');
        div.className = 'line';
        const mark = document.createElement('span');
        mark.className = line.ok ? 'ok' : 'bad';
        mark.textContent = line.ok ? '✓' : '✕';
        const text = document.createElement('span');
        text.textContent = line.text;
        div.append(mark, text);
        log.appendChild(div);
      }
      this.body.appendChild(log);
    }
  }

  private buildChips(item: ItemDetail): HTMLElement {
    const chips = document.createElement('div');
    chips.className = 'chips';

    const add = (text: string, cls = '') => {
      const c = document.createElement('span');
      c.className = `chip ${cls}`.trim();
      c.textContent = text;
      chips.appendChild(c);
    };

    const picked = item.chosenTitles.length;
    add(`${picked}/${item.maxVariants} picked`, picked === item.maxVariants ? 'good' : 'warn');

    // Drafts cannot be A/B tested at all, so this is load-bearing rather than decoration.
    if (this.page.isDraft) add('draft — no A/B', 'warn');
    if (item.status === 'filled') add('filled');
    if (item.videoId && this.page.videoId && item.videoId !== this.page.videoId) {
      add('linked to another video', 'warn');
    }
    return chips;
  }

  private buildPicker(item: ItemDetail): HTMLElement {
    const wrap = document.createElement('div');

    const chosen = item.chosenTitles;
    const atCap = chosen.length >= item.maxVariants;

    // Chosen titles first in variant order, then the rest — the operator is deciding an
    // order, so the order has to be what they see.
    const rest = item.generatedTitles.filter((t) => !chosen.includes(t));
    const collapsedRest = this.showAllTitles ? rest : rest.slice(0, Math.max(0, 5 - chosen.length));
    const shown = [...chosen, ...collapsedRest];

    const ul = document.createElement('ul');
    ul.className = 'pick';

    for (const title of shown) {
      const variant = chosen.indexOf(title);
      const isOn = variant !== -1;
      const blocked = !isOn && atCap;

      const li = document.createElement('li');
      li.className = isOn ? 'on' : blocked ? 'full' : '';
      li.title = isOn
        ? 'Click to remove from the test'
        : blocked
          ? `Deselect one first — YouTube allows ${item.maxVariants} variants`
          : 'Click to add to the test';

      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = isOn ? String(variant + 1) : '+';

      const t = document.createElement('span');
      t.className = 't';
      t.textContent = title;

      if (title.length > item.maxTitleLength) {
        const len = document.createElement('span');
        len.className = 'len over';
        len.textContent = String(title.length);
        len.title = `Over YouTube's ${item.maxTitleLength}-character limit`;
        t.appendChild(document.createTextNode(' '));
        t.appendChild(len);
      }

      li.append(n, t);
      if (!blocked) {
        li.addEventListener('click', () => {
          void this.toggleTitle(title);
        });
      }
      ul.appendChild(li);
    }

    wrap.appendChild(ul);

    const hidden = rest.length - collapsedRest.length;
    if (hidden > 0 || this.showAllTitles) {
      const more = document.createElement('button');
      more.className = 'more';
      more.textContent = this.showAllTitles ? 'Show fewer' : `${hidden} more…`;
      more.addEventListener('click', () => {
        this.showAllTitles = !this.showAllTitles;
        this.render();
      });
      wrap.appendChild(more);
    }

    return wrap;
  }

  private buildActions(item: ItemDetail): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'actions';

    if (!this.page.formReady) {
      const note = document.createElement('div');
      note.className = 'muted';
      note.textContent = 'Open a video in Studio to fill it.';
      actions.appendChild(note);
      return actions;
    }

    const ctx: FillContext = {
      titles: item.chosenTitles.length ? item.chosenTitles : item.generatedTitles.slice(0, item.maxVariants),
      description: item.description,
      tags: item.tags,
    };

    const all = document.createElement('button');
    all.className = 'act primary';
    all.textContent = 'Fill everything';
    all.addEventListener('click', () => this.run(FILLERS.map((f) => f.id)));
    actions.appendChild(all);

    const button = (filler: Filler): HTMLButtonElement => {
      const detected = filler.detect(ctx);
      const btn = document.createElement('button');
      btn.className = 'act';
      if (!detected.available) {
        btn.disabled = true;
        btn.textContent = `${filler.label} — ${detected.reason}`;
        btn.title = detected.reason;
      } else {
        btn.textContent = filler.label;
        btn.addEventListener('click', () => this.run([filler.id]));
      }
      return btn;
    };

    // The A/B action stays visible rather than folded away: re-setting a test (cancel,
    // change the titles, set again) is a normal thing to do, not a rare repair.
    const abFiller = FILLERS.find((f) => f.id === 'ab-test');
    if (abFiller) actions.appendChild(button(abFiller));

    // The rest are the exception — keep them one click down.
    const rest = FILLERS.filter((f) => f.id !== 'ab-test');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'One field at a time';
    summary.style.cssText = 'cursor:pointer;color:#8f8f8f;font-size:11px;padding:2px 0';
    details.appendChild(summary);

    const inner = document.createElement('div');
    inner.className = 'actions';
    for (const filler of rest) inner.appendChild(button(filler));
    details.appendChild(inner);
    actions.appendChild(details);

    return actions;
  }

  private async toggleTitle(title: string): Promise<void> {
    if (!this.item || this.busy) return;
    const chosen = this.item.chosenTitles;
    const idx = chosen.indexOf(title);
    const next = idx === -1 ? [...chosen, title] : chosen.filter((_, i) => i !== idx);

    this.busy = true;
    try {
      await this.callbacks.onSaveTitles(next);
    } finally {
      this.busy = false;
    }
  }

  private async run(ids: FillId[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setActionsDisabled(true);
    try {
      await this.callbacks.onFill(ids);
    } finally {
      this.busy = false;
      this.setActionsDisabled(false);
    }
  }

  private setActionsDisabled(disabled: boolean): void {
    this.root.querySelectorAll<HTMLButtonElement>('button.act').forEach((b) => {
      // Leave permanently-unavailable actions disabled.
      if (!disabled && b.title) return;
      b.disabled = disabled;
    });
  }

  private async doRefresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.refreshBtn?.classList.add('spin');
    try {
      this.invalidateReports();
      await this.callbacks.onRefresh();
    } catch (error) {
      this.setError(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
      this.refreshBtn?.classList.remove('spin');
    }
  }

  // ----------------------------------------------------------- report browser

  private renderBrowser(): void {
    const search = document.createElement('input');
    search.className = 'search';
    search.type = 'search';
    search.placeholder = 'Search reports by name…';
    search.value = this.query;
    search.addEventListener('input', () => {
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.searchTimer = null;
        this.query = search.value;
        this.invalidateReports();
        this.scrollTop = 0;
        this.render();
      }, 200) as unknown as number;
    });
    this.body.appendChild(search);

    if (this.browseError) this.body.appendChild(this.errorBox(this.browseError));

    if (this.unreadable > 0) {
      const warn = document.createElement('div');
      warn.className = 'chip warn';
      warn.textContent = `${this.unreadable} report(s) unreadable`;
      warn.title = 'These could not be parsed and are missing from the list.';
      this.body.appendChild(warn);
    }

    const scroller = document.createElement('div');
    scroller.className = 'scroller';
    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    scroller.appendChild(spacer);
    this.body.appendChild(scroller);

    scroller.addEventListener('scroll', () => {
      this.scrollTop = scroller.scrollTop;
      this.paintRows(scroller, spacer);
    });

    scroller.scrollTop = this.scrollTop;
    this.paintRows(scroller, spacer);
  }

  /**
   * Virtual list: only the visible window exists in the DOM, and only the pages covering
   * that window are fetched. The operator can scroll back through every report ever
   * generated without the shelf holding them all.
   */
  private paintRows(scroller: HTMLElement, spacer: HTMLElement): void {
    // Before the first fetch, total is unknown — ask for the first page and show it.
    if (this.pages.size === 0 && this.inFlight.size === 0) {
      void this.ensurePage(0, scroller, spacer);
    }

    spacer.style.height = `${Math.max(this.total, 1) * ROW_HEIGHT}px`;
    spacer.textContent = '';

    const viewHeight = scroller.clientHeight || 1;
    const first = Math.max(0, Math.floor(this.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(
      Math.max(this.total - 1, 0),
      Math.ceil((this.scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN,
    );

    if (this.total === 0 && this.inFlight.size === 0 && this.pages.size > 0) {
      const empty = document.createElement('div');
      empty.className = 'row skeleton';
      empty.style.transform = 'translateY(0)';
      empty.textContent = this.query ? 'No reports match.' : 'No reports generated yet.';
      spacer.appendChild(empty);
      return;
    }

    for (let i = first; i <= last; i++) {
      const row = this.rowAt(i);
      const el = document.createElement('div');
      el.style.transform = `translateY(${i * ROW_HEIGHT}px)`;

      if (!row) {
        el.className = 'row skeleton';
        el.textContent = '…';
        void this.ensurePage(Math.floor(i / PAGE_SIZE) * PAGE_SIZE, scroller, spacer);
      } else {
        el.className = 'row';
        const left = document.createElement('div');
        left.className = 'rl';
        const title = document.createElement('div');
        title.className = 'rt';
        title.textContent = row.label;
        const sub = document.createElement('div');
        sub.className = 'sub rt';
        sub.textContent = [shortDate(row.createdAt), row.promptSet ?? '']
          .filter(Boolean)
          .join(' · ');
        left.append(title, sub);

        const count = document.createElement('span');
        count.className = `count${row.chosenCount > 0 ? ' set' : ''}`;
        count.textContent = `${row.chosenCount}/${row.titleCount}`;
        count.title = `${row.chosenCount} picked of ${row.titleCount} generated`;

        el.append(left, count);
        el.title = row.label;
        el.addEventListener('click', () => {
          void this.callbacks.onOpenReport(row.jobId, row.itemIndex);
        });
      }
      spacer.appendChild(el);
    }
  }

  private rowAt(index: number): BrowseRow | null {
    const start = Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
    const page = this.pages.get(start);
    return page ? (page[index - start] ?? null) : null;
  }

  private async ensurePage(start: number, scroller: HTMLElement, spacer: HTMLElement): Promise<void> {
    if (this.pages.has(start) || this.inFlight.has(start)) return;
    this.inFlight.add(start);
    try {
      const page = await this.callbacks.onFetchReports(start, PAGE_SIZE, this.query);
      this.pages.set(start, page.rows);
      this.total = page.total;
      this.unreadable = page.unreadable;
      this.browseError = null;
    } catch (error) {
      // A failed page is not an empty page. Say so instead of showing a short list.
      this.browseError = error instanceof Error ? error.message : String(error);
    } finally {
      this.inFlight.delete(start);
    }
    if (this.tab === 'reports') {
      if (this.browseError) this.render();
      else this.paintRows(scroller, spacer);
    }
  }

  // ------------------------------------------------------------------- prefs

  private async setSide(side: ShelfPrefs['side']): Promise<void> {
    this.prefs = { ...this.prefs, side };
    this.render();
    await this.persistPrefs();
  }

  private async setCollapsed(collapsed: boolean): Promise<void> {
    this.prefs = { ...this.prefs, collapsed };
    this.render();
    await this.persistPrefs();
  }

  /**
   * Write the prefs, and say so when the write fails.
   *
   * Every caller of setSide/setCollapsed is a click handler that can only fire-and-forget,
   * so an unhandled rejection here surfaced as a bare "Uncaught (in promise) Error:
   * Extension context invalidated." in the page console and nothing at all in the UI. The
   * usual cause is the extension having been reloaded out from under this tab, which also
   * means every other shelf action is already broken — worth saying out loud, since the
   * move (reload the tab) is not guessable from a silently unsticky preference.
   */
  private async persistPrefs(): Promise<void> {
    try {
      await saveShelfPrefs(this.prefs);
    } catch (error) {
      this.setError(
        extensionContextAlive()
          ? `Could not save the shelf position: ${error instanceof Error ? error.message : String(error)}`
          : STALE_CONTEXT_MESSAGE,
      );
    }
  }

  private errorBox(text: string): HTMLElement {
    const div = document.createElement('div');
    div.className = 'err';
    div.textContent = text;
    return div;
  }
}

/** `2026-07-26T…` -> `Jul 26`. Empty when the report has no usable date. */
function shortDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
