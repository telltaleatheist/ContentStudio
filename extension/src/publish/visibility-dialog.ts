// A "Change visibility later" box inside Studio's own visibility dialog, under its "Save or
// publish" and "Schedule" boxes (Owen, 2026-11-05: "i expected it to work like tubebuddy").
// The same panel as the shelf's Visibility section, so it does what that does: any visibility
// to any visibility at a set time, on the scheduler on Triton.
//
// The dialog is one element at the end of <body>, reused for every video, and it does not say
// which video it is for. So the click that opens it is what names the video: its row on the
// Content list, or the URL on a video's Details page. Read live 2026-11-05, on both pages.

import { visible, waitFor } from './dom';
import { videoIdFromUrl } from './page';
import { VISIBILITY_CSS, VisibilityPanel, type VisibilityTransport } from './visibility-panel';

const DIALOG_SELECT = 'ytcp-video-visibility-edit-popup tp-yt-paper-dialog ytcp-video-visibility-select';
const LIST_CELL = 'ytcp-video-row .tablecell-visibility';
const DETAILS_FIELD = 'ytcp-video-metadata-visibility';

/** The shelf's shared classes the panel uses, and Studio's box and heading to sit among its own. */
const DIALOG_CSS = `
${VISIBILITY_CSS}
:host { display: block; margin-top: 16px; font-size: 12px; color: #f1f1f1; }
.box {
  max-height: 45vh; overflow-y: auto; padding: 4px 20px 16px;
  border: 1px solid #f1f1f1; border-radius: 16px;
}
.vis { margin: 0; padding: 0; border: 0; }
.vhead { margin: 12px 0 8px; }
.vtitle { font-size: 16px; font-weight: 500; letter-spacing: 0; text-transform: none; color: #f1f1f1; }
.muted { color: #8f8f8f; }
.sub { color: #8f8f8f; font-size: 11px; margin-top: 1px; }
.chip {
  font-size: 10px; padding: 1px 6px; border-radius: 10px;
  background: #303030; color: #bbb; border: 1px solid #454545;
}
.more {
  cursor: pointer; background: transparent; border: 0; color: #8f8f8f;
  font-size: 11px; padding: 5px 0 0; text-decoration: underline;
}
.note {
  font-size: 11px; line-height: 1.35; border-radius: 6px; padding: 5px 7px; margin: 6px 0 0;
  color: #8f8f8f; background: #282828; border: 1px solid #383838;
}
.note.differ { color: #ffcf6b; background: #2b2418; border-color: #5a4a20; }
.err {
  color: #ff8a80; background: #2c1d1d; border: 1px solid #5a2b2b;
  border-radius: 6px; padding: 6px 8px; margin-top: 8px; font-size: 11px;
}
`;

export class VisibilityDialog {
  private readonly panel: VisibilityPanel;
  private readonly host = document.createElement('div');
  private readonly problem = document.createElement('div');
  /** The latest click wins: a wait for an earlier one stops attaching. */
  private opening = 0;

  constructor(transport: VisibilityTransport) {
    this.panel = new VisibilityPanel(transport, {
      heading: 'Change visibility later',
      saveLabel: 'Schedule change',
      formNote: "Saved when you press Schedule change. Studio's buttons below do not affect it.",
    });

    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = DIALOG_CSS;
    const box = document.createElement('div');
    box.className = 'box';
    this.problem.className = 'err';
    this.problem.hidden = true;
    box.append(this.problem, this.panel.el);
    root.append(style, box);

    // The dialog sizes itself to what it held when it opened; a form opening in here needs it
    // to fit again. An event, because the method is out of reach of a content script.
    new ResizeObserver(() => {
      this.host.closest('tp-yt-paper-dialog')?.dispatchEvent(new CustomEvent('iron-resize'));
    }).observe(this.host);
  }

  start(): void {
    document.addEventListener('click', (event) => this.onClick(event), true);
  }

  private onClick(event: Event): void {
    if (!(event.target instanceof Element)) return;
    const cell = event.target.closest(LIST_CELL);
    if (!cell && !event.target.closest(DETAILS_FIELD)) return;

    const videoId = cell ? videoIdOfRow(cell) : videoIdFromUrl();
    const opening = (this.opening += 1);
    waitFor(() => visible<HTMLElement>(DIALOG_SELECT), "Studio's visibility dialog", 3000, 100)
      .then((select) => {
        if (opening === this.opening) this.attach(select, videoId);
      })
      .catch((error: unknown) => {
        console.error('[ContentStudio] no place for "Change visibility later":', error);
      });
  }

  private attach(select: HTMLElement, videoId: string | null): void {
    if (this.host.parentElement !== select) select.appendChild(this.host);
    this.problem.hidden = videoId !== null;
    this.problem.textContent = videoId === null ? 'Could not tell which video this dialog is for, so no change can be scheduled here.' : '';
    this.panel.setVideo(videoId);
    this.panel.reload();
  }
}

function videoIdOfRow(cell: Element): string | null {
  const link = cell.closest('ytcp-video-row')?.querySelector('a[href*="/video/"]');
  return /\/video\/([^/?#]+)/.exec(link?.getAttribute('href') ?? '')?.[1] ?? null;
}
