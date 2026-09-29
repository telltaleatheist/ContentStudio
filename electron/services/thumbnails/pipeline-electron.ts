/**
 * The metadata run's thumbnail renderer in the app: the Thumbnails tab's own drawing (renderer.ts
 * on the hidden canvas page, faces from Apple Vision through Chromium's FaceDetector), the reaction
 * photo trimmed as the tab trims it (reaction-photos.ts) and the logo cut to its visible pixels
 * (logo.ts). Kept apart from pipeline.ts because all three need Electron (a BrowserWindow and
 * nativeImage); the checks hand the pipeline a stand-in renderer under plain Node.
 */
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
      const photo = trimmedPhoto(input.photo);
      const logo = input.logoFile === null ? null : readLogo(input.logoFile);
      return renderThumbnail({
        canvas,
        frame: input.frame,
        phrase: input.phrase,
        style: input.style,
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
