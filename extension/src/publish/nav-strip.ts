// The video navigation strip.
//
// A slim rail down the right edge of a Studio edit page showing the videos immediately
// above and below the open one in the channel's content list, so moving between videos is
// one click instead of back-to-the-list-then-find-it-again.
//
// The list is ContentStudio's, not Studio's: the analytics collector already stores every
// video per channel, and the app answers "which channel is this video in, and what is its
// whole list" in one call. Nothing here scrapes Studio's content list — it isn't on screen
// on an edit page anyway.
//
// ORDER: newest first, the same order Studio's content list uses, so "up" means the same
// thing here as it does there. Up = newer, down = older.
//
// Like the shelf it lives in its own shadow root, and for the same reason: Studio's
// stylesheet must not reach in and ours must not leak out.

import type { NavVideo } from './publish-client';
import {
  DEFAULT_NAV_STRIP_PREFS,
  loadNavStripPrefs,
  saveNavStripPrefs,
  type NavStripPrefs,
} from './nav-strip-prefs';
import { STALE_CONTEXT_MESSAGE, extensionContextAlive } from './publish-messages';

const HOST_ID = 'contentstudio-video-nav';

/** How many neighbours to show on each side of the open video. */
const NEIGHBOURS = 3;

/**
 * The horizontal lane the strip occupies, expanded and collapsed.
 *
 * Reported to whoever mounts the strip (publish-content) so the shelf can be pushed left
 * by exactly this much when it is on the right — see PublishShelf.setRightLaneWidth.
 * These MUST match the widths in the CSS below.
 */
export const NAV_STRIP_WIDTH = 72;
export const NAV_STRIP_COLLAPSED_WIDTH = 26;

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.shell {
  position: fixed; right: 0; top: 50%; transform: translateY(-50%);
  z-index: 2147482900;
  font: 12px/1.4 Roboto, system-ui, -apple-system, sans-serif;
  color: #f1f1f1;
}
.card {
  width: ${NAV_STRIP_WIDTH}px; max-height: 92vh;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 4px 4px 6px;
  background: #212121; border: 1px solid #383838; border-right: 0;
  border-radius: 10px 0 0 10px;
  box-shadow: -6px 0 20px rgba(0,0,0,.5);
}
.bar { width: 100%; display: flex; justify-content: flex-end; }
.icon {
  cursor: pointer; border: 0; background: transparent; color: #999;
  font-size: 12px; line-height: 1; padding: 2px 4px; border-radius: 5px;
}
.icon:hover { color: #fff; background: #383838; }
.arrow {
  cursor: pointer; width: 64px; height: 20px; padding: 0;
  color: #999; background: #303030; border: 1px solid #454545; border-radius: 5px;
  font-size: 11px; line-height: 1;
}
.arrow:hover:not(:disabled) { color: #fff; border-color: #ff6b35; }
.arrow:disabled { opacity: .3; cursor: default; }
/* Scrolls rather than growing past the viewport on a short window; the arrows stay put
   above and below it because they are siblings, not part of the scroller. */
.tiles { display: flex; flex-direction: column; gap: 4px; flex: 0 1 auto; min-height: 0; overflow-y: auto; }
.tile {
  display: block; width: 64px; height: 36px; padding: 0; overflow: hidden;
  cursor: pointer; background: #181818;
  border: 1px solid #383838; border-radius: 4px;
}
.tile:hover:not(.on) { border-color: #ff6b35; }
.tile img { display: block; width: 100%; height: 100%; object-fit: cover; }
.tile.on { border-color: #ff6b35; box-shadow: 0 0 0 1px #ff6b35; cursor: default; }
.tile.noimg { display: flex; align-items: center; justify-content: center; }
.tile .txt {
  font-size: 9px; line-height: 1.15; color: #8f8f8f; padding: 2px;
  text-align: center; overflow: hidden;
}
.note {
  width: 64px; padding: 6px 2px; font-size: 10px; line-height: 1.25;
  color: #8f8f8f; text-align: center; word-break: break-word;
}
.note.bad { color: #ff8a80; }
.pill {
  cursor: pointer; writing-mode: vertical-rl; padding: 10px 4px;
  background: #212121; border: 1px solid #383838; border-right: 0;
  border-radius: 8px 0 0 8px; box-shadow: -6px 0 20px rgba(0,0,0,.5);
  color: #ff6b35; font-size: 9px; font-weight: 700;
  letter-spacing: .08em; text-transform: uppercase;
}
.pill:hover { border-color: #ff6b35; }
`;

export interface NavStripCallbacks {
  /**
   * The width the strip now occupies on the right edge (collapse and expand change it).
   *
   * The strip does not know the shelf exists; the content script owns both and moves the
   * shelf out of this lane. Keeping the knowledge there means neither overlay has to
   * import the other.
   */
  onLaneWidth(px: number): void;
}

/**
 * What the strip is showing.
 *
 * 'notice' is for the two ORDINARY not-showing-a-list states — the app is closed, or the
 * collector has not reached this video yet. Both have a plain next step and neither is a
 * fault, so they get muted text rather than the red 'error' treatment. Nothing renders an
 * empty rail: a strip with no tiles and no words would read as "this video has no
 * neighbours", which is a different and wrong claim.
 */
type StripState =
  | { kind: 'loading' }
  | { kind: 'ready'; current: string; videos: NavVideo[] }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string };

export class NavStrip {
  private host: HTMLElement;
  private root: ShadowRoot;

  private prefs: NavStripPrefs = { ...DEFAULT_NAV_STRIP_PREFS };
  private state: StripState = { kind: 'loading' };

  constructor(private callbacks: NavStripCallbacks) {
    document.getElementById(HOST_ID)?.remove();

    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    this.root = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    this.root.append(style);
  }

  /** Attach and paint. Prefs load first so a collapsed strip never flashes open. */
  async mount(): Promise<void> {
    this.prefs = await loadNavStripPrefs();
    document.body.appendChild(this.host);
    this.render();
  }

  destroy(): void {
    this.host.remove();
    this.callbacks.onLaneWidth(0);
  }

  /** The lane the strip currently occupies, for whoever has to stay out of it. */
  laneWidth(): number {
    return this.prefs.collapsed ? NAV_STRIP_COLLAPSED_WIDTH : NAV_STRIP_WIDTH;
  }

  // ------------------------------------------------------------------ state in

  setLoading(): void {
    this.state = { kind: 'loading' };
    this.render();
  }

  /** The channel's list, newest first, and which of them is open. */
  setList(current: string, videos: NavVideo[]): void {
    this.state = { kind: 'ready', current, videos };
    this.render();
  }

  /** An ordinary state with an ordinary next step. Muted, never red. */
  setNotice(text: string): void {
    this.state = { kind: 'notice', text };
    this.render();
  }

  /** A real fault. Stays until something replaces it. */
  setError(text: string): void {
    this.state = { kind: 'error', text };
    this.render();
  }

  // -------------------------------------------------------------------- render

  private render(): void {
    this.root.querySelector('.shell')?.remove();

    const shell = document.createElement('div');
    shell.className = 'shell';
    shell.appendChild(this.prefs.collapsed ? this.buildPill() : this.buildCard());
    this.root.appendChild(shell);

    this.callbacks.onLaneWidth(this.laneWidth());
  }

  private buildPill(): HTMLElement {
    const pill = document.createElement('button');
    pill.className = 'pill';
    pill.title = 'Show the video navigator';
    pill.textContent = 'Videos';
    pill.addEventListener('click', () => {
      void this.setCollapsed(false);
    });
    return pill;
  }

  private buildCard(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card';

    const bar = document.createElement('div');
    bar.className = 'bar';
    const collapse = document.createElement('button');
    collapse.className = 'icon';
    collapse.textContent = '›';
    collapse.title = 'Hide the video navigator';
    collapse.addEventListener('click', () => {
      void this.setCollapsed(true);
    });
    bar.appendChild(collapse);
    card.appendChild(bar);

    if (this.state.kind !== 'ready') {
      card.appendChild(this.buildNote());
      return card;
    }

    const { current, videos } = this.state;
    const index = videos.findIndex((v) => v.videoId === current);
    if (index === -1) {
      // The caller handed us a list that does not contain the open video. Say so rather
      // than picking a window around an arbitrary position — every arrow would then point
      // somewhere the operator did not ask for.
      card.appendChild(
        this.note('This video is not in the list ContentStudio returned.', true),
      );
      return card;
    }

    // Newest first, so a LOWER index is newer: up walks toward the top of the list.
    card.appendChild(this.buildArrow('▲', 'Newer video', videos[index - 1]));

    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    const from = Math.max(0, index - NEIGHBOURS);
    // Not the global `window`: the slice of the list this strip shows.
    const shown = videos.slice(from, index + NEIGHBOURS + 1);
    shown.forEach((video, offset) => {
      tiles.appendChild(this.buildTile(video, from + offset === index));
    });
    card.appendChild(tiles);

    card.appendChild(this.buildArrow('▼', 'Older video', videos[index + 1]));
    return card;
  }

  private buildArrow(glyph: string, title: string, target: NavVideo | undefined): HTMLElement {
    const button = document.createElement('button');
    button.className = 'arrow';
    button.textContent = glyph;
    if (!target) {
      // End of the list. Disabled both ways — greyed out AND without a handler — so a
      // click cannot navigate to whatever `undefined` would stringify into.
      button.disabled = true;
      button.title = 'End of the list';
      return button;
    }
    button.title = `${title}: ${labelOf(target)}`;
    button.addEventListener('click', () => go(target.videoId));
    return button;
  }

  private buildTile(video: NavVideo, isCurrent: boolean): HTMLElement {
    const tile = document.createElement('button');
    tile.className = `tile${isCurrent ? ' on' : ''}`;
    tile.title = isCurrent ? `Open now: ${labelOf(video)}` : labelOf(video);

    const img = document.createElement('img');
    // Derived, not stored: ContentStudio keeps no thumbnails, and this URL shape is
    // stable for every public YouTube video.
    img.src = `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`;
    img.alt = video.title ?? video.videoId;
    img.addEventListener('error', () => {
      // A thumbnail YouTube will not serve must not leave a blank clickable box. Swap in
      // the title so the tile still says which video it is.
      img.remove();
      tile.classList.add('noimg');
      const txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = video.title ?? video.videoId;
      tile.appendChild(txt);
    });
    tile.appendChild(img);

    if (isCurrent) {
      tile.disabled = true;
    } else {
      tile.addEventListener('click', () => go(video.videoId));
    }
    return tile;
  }

  private buildNote(): HTMLElement {
    if (this.state.kind === 'loading') return this.note('Loading…', false);
    if (this.state.kind === 'error') return this.note(this.state.text, true);
    if (this.state.kind === 'notice') return this.note(this.state.text, false);
    throw new Error(`buildNote called in state ${this.state.kind}`);
  }

  private note(text: string, bad: boolean): HTMLElement {
    const note = document.createElement('div');
    note.className = `note${bad ? ' bad' : ''}`;
    note.textContent = text;
    note.title = text;
    return note;
  }

  // --------------------------------------------------------------------- prefs

  private async setCollapsed(collapsed: boolean): Promise<void> {
    this.prefs = { ...this.prefs, collapsed };
    this.render();
    try {
      await saveNavStripPrefs(this.prefs);
    } catch (error) {
      // Same trap as the shelf's: the usual cause is the extension having been reloaded
      // under this tab, which breaks everything else here too. Say it instead of leaving
      // an unhandled rejection in the page console and a silently unsticky preference.
      this.setError(
        extensionContextAlive()
          ? `Could not save the strip state: ${error instanceof Error ? error.message : String(error)}`
          : STALE_CONTEXT_MESSAGE,
      );
    }
  }
}

/** Title plus publish date, for tooltips. */
function labelOf(video: NavVideo): string {
  const date = video.publishedAt.slice(0, 10);
  return `${video.title ?? '(no title recorded)'} — ${date}`;
}

/**
 * Go to a video's edit page.
 *
 * A HARD navigation. Studio is an SPA and pushState would be faster, but its router is
 * not ours to drive: a pushed URL that Studio does not act on leaves the address bar
 * pointing at one video and the form showing another, which is the one outcome worth
 * ruling out when the next thing the operator does is type into that form.
 */
function go(videoId: string): void {
  location.href = `https://studio.youtube.com/video/${videoId}/edit`;
}
