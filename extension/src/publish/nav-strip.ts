// The video navigation strip.
//
// A rail down the right edge of a Studio edit page showing the channel's content list as
// thumbnails, centred on the open video, so moving between videos is one click instead of
// back-to-the-list-then-find-it-again. The column scrolls — the whole fetched list is in
// it — while the arrows stay anchored to the video actually being edited, so browsing and
// navigating never get confused with one another.
//
// The list is STUDIO'S OWN and ContentStudio is not involved: the worker reads it from
// the same `creator/list_creator_videos` endpoint that backs Studio's content list, in the
// same order, so the strip navigates exactly what the operator sees on that page — and it
// keeps working with the desktop app closed. Drafts, private and unlisted videos are in it
// for that same reason: they are in Studio's list, and walking straight into one to edit
// its metadata is the whole point.
//
// ORDER: newest display time first, Studio's own order, so "up" means the same thing here
// as it does there. Up = newer, down = older.
//
// Like the shelf it lives in its own shadow root, and for the same reason: Studio's
// stylesheet must not reach in and ours must not leak out.

import {
  DEFAULT_NAV_STRIP_PREFS,
  loadNavStripPrefs,
  saveNavStripPrefs,
  type NavStripPrefs,
} from './nav-strip-prefs';
import { STALE_CONTEXT_MESSAGE, extensionContextAlive } from './publish-messages';

/**
 * One entry of Studio's content list, as the strip renders it.
 *
 * Mapped down from the worker's CatalogueVideo (catalogue.ts): the strip needs four of
 * its fields, and carrying the rest would invite rendering decisions that belong to the
 * data source. BOTH of the first two strings can be empty, and that is a real state rather than missing
 * data — a draft has no publish date, and Studio holds no title for an upload nobody has
 * named yet. Nothing here invents a stand-in for either.
 */
export interface NavVideo {
  videoId: string;
  /** '' when Studio holds no title for it. */
  title: string;
  /** ISO, or '' for anything never published — drafts and scheduled uploads. */
  publishedAt: string;
  /**
   * Studio's own thumbnail URL, or null when its content-list response carried none.
   *
   * null is not "no thumbnail exists" — it is "Studio did not tell us one". See buildTile
   * for what gets drawn instead, and why that substitution is written down.
   */
  thumbnailUrl: string | null;
}

/**
 * A channel's content list, newest display time first, and the channel it came from.
 *
 * `complete` is load-bearing. The list is fetched with an early stop so the strip appears
 * in a second or two rather than after the whole channel has been paged (see
 * nav-source.ts), so `complete: false` means "there are more videos below the last one
 * here" — NOT the end of the channel. Nothing in the strip may present a truncated list as
 * the end of the list.
 */
export interface NavList {
  channelId: string;
  videos: NavVideo[];
  complete: boolean;
}

const HOST_ID = 'contentstudio-video-nav';

/**
 * How many neighbours the strip guarantees around the open video.
 *
 * The tile column shows the WHOLE fetched list and scrolls; this is the margin the list
 * must still have below the open video to be worth keeping — the content script uses it to
 * decide when a truncated list has been outgrown (see syncNavStrip) and it sizes the
 * loading skeleton.
 */
export const NEIGHBOURS = 3;

/**
 * Tile geometry, in CSS pixels. Shared by the stylesheet and the scroll maths, which have
 * to agree: centring the open tile and spotting the end of the column are both arithmetic
 * on these numbers.
 */
const TILE_W = 128;
const TILE_H = 72;
const TILE_GAP = 6;

/**
 * How many tiles are VISIBLE at once — the rest stay reachable by scrolling the column.
 * Five keeps the rail to roughly the height of the video player area instead of the
 * whole window. The cap counts the gaps between tiles but not the arrows/bar around
 * the column, which add their own height outside it.
 */
const VISIBLE_TILES = 5;
const COLUMN_MAX_PX = VISIBLE_TILES * TILE_H + (VISIBLE_TILES - 1) * TILE_GAP;

/**
 * How close to the bottom of a TRUNCATED column counts as "about to run out", in tiles.
 *
 * Crossing it asks for a deeper fetch. Far enough from the end that the answer usually
 * arrives before the operator gets there.
 */
const NEAR_END_TILES = 5;
const NEAR_END_PX = NEAR_END_TILES * (TILE_H + TILE_GAP);

/**
 * The horizontal lane the strip occupies, expanded and collapsed.
 *
 * Reported to whoever mounts the strip (publish-content) so the shelf can be pushed left
 * by exactly this much when it is on the right — see PublishShelf.setRightLaneWidth.
 * These MUST match the widths in the CSS below: the card is a tile plus its padding and
 * borders, and the collapsed pill is its vertical text plus the same.
 */
export const NAV_STRIP_WIDTH = TILE_W + 16;
export const NAV_STRIP_COLLAPSED_WIDTH = 30;

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
  display: flex; flex-direction: column; align-items: center; gap: 5px;
  padding: 5px 5px 7px;
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
  cursor: pointer; width: ${TILE_W}px; height: 26px; padding: 0; flex: 0 0 auto;
  color: #999; background: #303030; border: 1px solid #454545; border-radius: 5px;
  font-size: 14px; line-height: 1;
}
.arrow:hover:not(:disabled) { color: #fff; border-color: #ff6b35; }
.arrow:disabled { opacity: .3; cursor: default; }
/* The WHOLE fetched list lives in here and scrolls; the arrows stay put above and below it
   because they are siblings, not part of the scroller. overscroll-behavior keeps a wheel
   that runs off the end of this column from scrolling Studio's page underneath. */
.tiles {
  display: flex; flex-direction: column; align-items: center; gap: ${TILE_GAP}px;
  flex: 0 1 auto; min-height: 0; width: 100%; max-height: ${COLUMN_MAX_PX}px;
  overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: #555 transparent;
}
.tile {
  display: block; width: ${TILE_W}px; height: ${TILE_H}px; padding: 0; overflow: hidden;
  flex: 0 0 auto; cursor: pointer; background: #181818;
  border: 1px solid #383838; border-radius: 4px;
}
.tile:hover:not(.on) { border-color: #ff6b35; }
.tile img { display: block; width: 100%; height: 100%; object-fit: cover; }
.tile.on { border-color: #ff6b35; box-shadow: 0 0 0 1px #ff6b35; cursor: default; }
.tile.noimg { display: flex; align-items: center; justify-content: center; }
.tile .txt {
  font-size: 11px; line-height: 1.2; color: #8f8f8f; padding: 4px;
  text-align: center; overflow: hidden;
}
/* Placeholders for a list that has not arrived. Inert: no pointer, no click, nothing to
   click on — they say "a list is coming", not "here are some videos". */
.tile.skeleton { cursor: default; background: #2a2a2a; border-color: #333; }
.tile.skeleton:hover { border-color: #333; }
/* The bottom of a truncated column while more of it is being fetched. */
.more {
  font-size: 10px; line-height: 1.2; color: #8f8f8f; padding: 4px 2px;
  text-align: center; flex: 0 0 auto;
}
.more.bad { color: #ff8a80; }
.note {
  width: ${TILE_W}px; padding: 8px 4px; font-size: 11px; line-height: 1.3;
  color: #8f8f8f; text-align: center; word-break: break-word;
}
.note.bad { color: #ff8a80; }
.pill {
  /* Width stated rather than left to the vertical text, so the lane this strip reports
     when collapsed (NAV_STRIP_COLLAPSED_WIDTH) is the width it actually takes. */
  cursor: pointer; writing-mode: vertical-rl; width: ${NAV_STRIP_COLLAPSED_WIDTH}px;
  padding: 12px 6px;
  background: #212121; border: 1px solid #383838; border-right: 0;
  border-radius: 8px 0 0 8px; box-shadow: -6px 0 20px rgba(0,0,0,.5);
  color: #ff6b35; font-size: 10px; font-weight: 700;
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

  /**
   * The operator has scrolled near the bottom of a TRUNCATED list and more of it is
   * wanted.
   *
   * The strip cannot fetch — it has no worker channel — and it does not know how the list
   * was fetched the first time. It reports the situation; the content script decides
   * whether to ask for more, how much more, and answers with setLoadingMore/setList.
   *
   * May fire repeatedly while scrolling. The handler is expected to be idempotent.
   */
  onNeedMore(): void;
}

/**
 * What the strip is showing.
 *
 * 'notice' is for the ORDINARY not-showing-a-list state: this tab has no usable Studio
 * session yet. It has a plain next step (reload the page), it is nobody's fault, and it
 * resolves itself, so it gets muted text rather than the red 'error' treatment. Nothing
 * renders an empty rail: a strip with no tiles and no words would read as "this video has
 * no neighbours", which is a different and wrong claim.
 *
 * `detail` is the underlying message, kept for the tooltip. The rail is a thumbnail wide so
 * the visible line has to be short — but shortening it must not be how the real reason gets
 * lost, so the reason hangs on the note's title instead of being dropped.
 *
 * On 'ready', `complete` says whether `videos` reaches the end of the channel and `more`
 * what is being done about it when it does not. They are separate because they answer
 * different questions: one is about the list, the other about the attempt to extend it.
 */
type MoreState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  /** The deeper fetch failed. The list on screen is still good; extending it is not. */
  | { kind: 'failed'; detail: string };

type StripState =
  | { kind: 'loading' }
  | { kind: 'ready'; current: string; videos: NavVideo[]; complete: boolean; more: MoreState }
  | { kind: 'notice'; text: string; detail: string | null }
  | { kind: 'error'; text: string; detail: string | null };

export class NavStrip {
  private host: HTMLElement;
  private root: ShadowRoot;

  private prefs: NavStripPrefs = { ...DEFAULT_NAV_STRIP_PREFS };
  private state: StripState = { kind: 'loading' };

  /**
   * The video the tile column's current scroll position belongs to, or null when nothing
   * scrollable is on screen.
   *
   * Every render rebuilds the shadow tree, which throws the scroll position away. Repaints
   * that leave the open video where it was — a list that grew at the bottom, the
   * loading-more row appearing — must LAND WHERE THE OPERATOR LEFT THEM, or scrolling down
   * to find more videos would be undone by the arrival of those videos. A repaint for a
   * different video is a different question and re-centres.
   */
  private scrolledFor: string | null = null;

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

  /**
   * The channel's list, newest first, which of them is open, and whether it is the end.
   *
   * `complete: false` means the fetch stopped early and more videos exist below the last
   * entry — the strip must not draw an end-of-list anywhere.
   */
  setList(current: string, videos: NavVideo[], complete: boolean): void {
    this.state = { kind: 'ready', current, videos, complete, more: { kind: 'idle' } };
    this.render();
  }

  /**
   * A deeper fetch is running. Draws a row at the foot of the column and changes nothing
   * else — the list on screen stays exactly as it is, scroll position included.
   *
   * Ignored unless a list is showing: there is no "more" of a list that never arrived.
   */
  setLoadingMore(): void {
    if (this.state.kind !== 'ready' || this.state.more.kind === 'loading') return;
    this.state = { ...this.state, more: { kind: 'loading' } };
    this.render();
  }

  /**
   * The deeper fetch failed.
   *
   * Said at the foot of the column rather than replacing the strip: the tiles that are
   * already there still navigate correctly, so throwing them away would cost the operator
   * a working navigator over a request that only concerned the videos below it. Silence is
   * not on the table either — the column stops growing, and something has to say why.
   */
  setMoreFailed(detail: string): void {
    if (this.state.kind !== 'ready') return;
    this.state = { ...this.state, more: { kind: 'failed', detail } };
    this.render();
  }

  /** An ordinary state with an ordinary next step. Muted, never red. */
  setNotice(text: string, detail: string | null = null): void {
    this.state = { kind: 'notice', text, detail };
    this.render();
  }

  /** A real fault. Stays until something replaces it. */
  setError(text: string, detail: string | null = null): void {
    this.state = { kind: 'error', text, detail };
    this.render();
  }

  // -------------------------------------------------------------------- render

  private render(): void {
    // Read the outgoing scroll position BEFORE the tree it belongs to is destroyed.
    const previous = this.root.querySelector<HTMLElement>('.tiles');
    const previousTop = previous ? previous.scrollTop : null;
    const previousFor = this.scrolledFor;
    this.root.querySelector('.shell')?.remove();

    const shell = document.createElement('div');
    shell.className = 'shell';
    shell.appendChild(this.prefs.collapsed ? this.buildPill() : this.buildCard());
    this.root.appendChild(shell);

    // Positioning happens after the tree is in the document: offsetTop and clientHeight
    // are zero until it has been laid out.
    const tiles = this.root.querySelector<HTMLElement>('.tiles');
    const current = this.state.kind === 'ready' ? this.state.current : null;
    if (tiles && current) {
      if (previousTop !== null && previousFor === current) {
        tiles.scrollTop = previousTop;
      } else {
        this.centreCurrentTile(tiles);
      }
    }
    this.scrolledFor = tiles ? current : null;

    this.callbacks.onLaneWidth(this.laneWidth());
  }

  /**
   * Put the open video's tile in the middle of the visible column.
   *
   * scrollTop arithmetic rather than scrollIntoView: scrollIntoView walks up through every
   * scrollable ancestor, and the ancestors here are Studio's page, which must not move
   * because our rail rearranged itself. Both offsetTops are measured from the same
   * offsetParent (the fixed .shell), so their difference is the tile's position inside the
   * column.
   */
  private centreCurrentTile(tiles: HTMLElement): void {
    const tile = tiles.querySelector<HTMLElement>('.tile.on');
    if (!tile) return;
    tiles.scrollTop = tile.offsetTop - tiles.offsetTop - (tiles.clientHeight - tile.offsetHeight) / 2;
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

    if (this.state.kind === 'loading') {
      // Skeleton tiles rather than the word "Loading": the rail keeps the shape it is
      // about to have, so the card does not jump when the list lands. They are inert divs
      // — nothing here is clickable, because there is nothing to click yet.
      const skeletons = document.createElement('div');
      skeletons.className = 'tiles';
      for (let i = 0; i < NEIGHBOURS * 2 + 1; i++) {
        const box = document.createElement('div');
        box.className = 'tile skeleton';
        skeletons.appendChild(box);
      }
      card.appendChild(skeletons);
      card.appendChild(this.note('Reading Studio’s list…', false));
      return card;
    }

    if (this.state.kind !== 'ready') {
      card.appendChild(this.buildNote());
      return card;
    }

    const { current, videos, complete, more } = this.state;
    const index = videos.findIndex((v) => v.videoId === current);
    if (index === -1) {
      // The caller handed us a list that does not contain the open video. Say so rather
      // than picking a window around an arbitrary position — every arrow would then point
      // somewhere the operator did not ask for.
      card.appendChild(
        this.note('This video is not in Studio’s content list.', true),
      );
      return card;
    }

    // THE ARROWS ARE ANCHORED TO THE OPEN VIDEO, NOT TO THE VIEW. Scrolling the column
    // browses the channel; it does not move the arrows, because "the next video" means the
    // one after the one being edited, and an arrow that followed the scroll would send the
    // operator somewhere they were only looking at.
    //
    // Newest first, so a LOWER index is newer: up walks toward the top of the list.
    card.appendChild(this.buildArrow('▲', 'Newer video', videos[index - 1], true));

    // THE WHOLE FETCHED LIST, scrolling. The window used to be six tiles wide; browsing
    // further meant leaving the page. The column is capped by the card's max-height, and
    // the open video is centred in it on every fresh paint (see render).
    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    videos.forEach((video, offset) => {
      tiles.appendChild(this.buildTile(video, offset === index));
    });
    if (more.kind === 'loading') {
      const row = document.createElement('div');
      row.className = 'more';
      row.textContent = 'Loading more…';
      tiles.appendChild(row);
    } else if (more.kind === 'failed') {
      const row = document.createElement('div');
      row.className = 'more bad';
      row.textContent = 'Could not load more of the list.';
      row.title = more.detail;
      tiles.appendChild(row);
    }
    if (!complete && more.kind !== 'failed') {
      // A truncated list ends where the fetch stopped, not where the channel does. Reaching
      // the foot of it asks for more; the content script decides whether to go and get it.
      tiles.addEventListener('scroll', () => {
        const remaining = tiles.scrollHeight - tiles.scrollTop - tiles.clientHeight;
        if (remaining <= NEAR_END_PX) this.callbacks.onNeedMore();
      });
    }
    card.appendChild(tiles);

    card.appendChild(this.buildArrow('▼', 'Older video', videos[index + 1], complete));
    return card;
  }

  /**
   * One navigation arrow.
   *
   * `atEnd` says whether the absence of a target really is the end of the list. It is
   * always true upwards — index 0 is the newest video Studio has — and downwards only when
   * the list is COMPLETE. On a truncated list the arrow is still disabled (there is no
   * videoId to navigate to yet) but it does not claim the channel ends here, because it
   * does not: the fetch stopped early and more is on its way.
   */
  private buildArrow(
    glyph: string,
    title: string,
    target: NavVideo | undefined,
    atEnd: boolean,
  ): HTMLElement {
    const button = document.createElement('button');
    button.className = 'arrow';
    button.textContent = glyph;
    if (!target) {
      // Disabled both ways — greyed out AND without a handler — so a click cannot navigate
      // to whatever `undefined` would stringify into.
      button.disabled = true;
      button.title = atEnd
        ? 'End of the list'
        : 'Still reading more of Studio’s list — scroll the thumbnails to fetch it.';
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
    // THE THUMBNAIL, AND ITS TWO DOCUMENTED FALLBACKS.
    //
    // First choice is the URL STUDIO GAVE US for this video (thumbnailDetails on the
    // content-list response — see catalogue.ts). It is the picture Studio itself draws, it
    // is signed for drafts and private videos, and it loads promptly.
    //
    // When that is null — Studio's response carried no thumbnail for this entry, or carried
    // one in a shape this build does not recognise — the URL is DERIVED instead. This is a
    // deliberate degradation and here is what it costs: the i.ytimg.com shape is stable for
    // PUBLIC videos only, so a draft or a private falls through it to the second fallback
    // below. That is better than a blank tile, and it is why the derived URL is kept rather
    // than deleted now that Studio's own is available.
    //
    // The last resort is the img error handler: no picture at all, so the tile shows the
    // video's title instead of an empty clickable box.
    img.src = video.thumbnailUrl ?? `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`;
    img.alt = video.title || video.videoId;
    img.addEventListener('error', () => {
      // A thumbnail YouTube will not serve must not leave a blank clickable box. Swap in
      // the title so the tile still says which video it is.
      img.remove();
      tile.classList.add('noimg');
      const txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = video.title || video.videoId;
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
    // 'loading' never arrives here — buildCard draws skeleton tiles for it — and 'ready'
    // is a list rather than a note. Either one reaching this point is a bug, so it throws.
    if (this.state.kind === 'error') return this.note(this.state.text, true, this.state.detail);
    if (this.state.kind === 'notice') return this.note(this.state.text, false, this.state.detail);
    throw new Error(`buildNote called in state ${this.state.kind}`);
  }

  private note(text: string, bad: boolean, detail: string | null = null): HTMLElement {
    const note = document.createElement('div');
    note.className = `note${bad ? ' bad' : ''}`;
    note.textContent = text;
    // The tooltip carries the cause when there is one, so the short line on screen is a
    // summary rather than the only thing that survived.
    note.title = detail ? `${text}\n\n${detail}` : text;
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

/**
 * Title plus publish date, for tooltips.
 *
 * Studio's content list is full of drafts, and a draft has no publish date. The date is
 * left OFF rather than filled with a placeholder or with today: a tooltip stating a
 * publication that never happened is worse than one that says nothing about it.
 */
function labelOf(video: NavVideo): string {
  const title = video.title || '(no title recorded)';
  const date = video.publishedAt.slice(0, 10);
  return date ? `${title} — ${date}` : title;
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
