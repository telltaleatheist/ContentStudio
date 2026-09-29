/**
 * The thumbnail renderer in the app, for the metadata run and the Thumbnails window: the drawing (renderer.ts
 * on the hidden canvas page, faces from Apple Vision through Chromium's FaceDetector), the reaction
 * photo trimmed (reaction-photos.ts), the logo cut to its visible pixels (logo.ts) and the border
 * overlay read and checked (border.ts). Kept apart from pipeline.ts because all three need Electron (a BrowserWindow and
 * nativeImage); the checks hand the pipeline a stand-in renderer under plain Node.
 */
import { readBorder } from './border';
import { ThumbnailCanvas, canvasPagePath } from './canvas-page';
import { logoAt, readLogo } from './logo';
import type { ThumbnailRenderer } from './pipeline';
import { trimmedPhoto } from './reaction-photos';
import { renderThumbnail } from './renderer';

/** One hidden canvas page for one render stage; `close()` shuts it (a window left open keeps the app from quitting). */
export function electronThumbnailRenderer(appRoot: string): ThumbnailRenderer {
  let canvas: ThumbnailCanvas | null = null;
  return {
    async render(input) {
      canvas ??= new ThumbnailCanvas(canvasPagePath(appRoot));
      const photo = input.photo === null ? null : trimmedPhoto(input.photo);
      const logo = input.logoFile === null ? null : readLogo(input.logoFile);
      const border = input.borderFile === null ? null : readBorder(input.borderFile).png;
      return renderThumbnail({
        canvas,
        frame: input.frame,
        phrase: input.phrase,
        style: input.style,
        border,
        photo,
        logo: logo === null ? null : { width: logo.width, height: logo.height, at: (w, h) => logoAt(logo, w, h) },
        outStem: input.outStem,
      });
    },
    close() {
      canvas?.close();
      canvas = null;
    },
  };
}
