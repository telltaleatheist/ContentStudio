/**
 * THE ONE THUMBNAIL LOOK, for every channel (Owen, 2026-09-28): the font, colours and spaces
 * (`ThumbnailStyle`), Owen's reaction photos with their notes, and the logo. Moved here from the
 * retired Thumbnails test tab (lab-service.ts) in phase 2; the metadata run reads the same store
 * keys at job time (pipeline-setup.ts), and the "Thumbnail look" dialog (opened from the reports
 * page's Thumbnails window) edits them.
 *
 * The store keys keep their `thumbnailLab.` names ON PURPOSE: they hold Owen's saved look and notes
 * from the tab, and a new name would drop them. The photos and the logo stay where the tab copied
 * them (`<userData>/thumbnail-lab/reaction-photos/` and `.../logo/`, photo-library.ts) for the same
 * reason.
 *
 * Every refusal throws with the missing thing named (Law 1); the IPC layer hands the sentence to
 * the page unchanged.
 */
import * as log from 'electron-log';
import { draftNotes } from './judge';
import { DEFAULT_STYLE, validateStyle, type ThumbnailStyle } from './layout';
import { logoPreview, readLogo } from './logo';
import {
  PhotosAlreadyThere,
  addPhotos,
  libraryLogo,
  libraryPhotos,
  logoCopyOffer,
  photoCopyOffer,
  photosDir,
  removePhoto,
  setLibraryLogo,
} from './photo-library';
import { photoPreview, trimmedPhoto } from './reaction-photos';

/** The store key holding the look (font, colours, spaces). Absent: DEFAULT_STYLE, said where it is shown. */
export const STYLE_STORE_KEY = 'thumbnailLab.style';

/**
 * The OLD setting: the folder Owen's photos were read from in place, before they lived in the app
 * (photo-library.ts). Read only to offer "Copy these into the app" while the library is empty.
 */
export const PHOTO_FOLDER_STORE_KEY = 'thumbnailLab.reactionFolder';

/**
 * Owen's note per reaction photo (name -> note), kept in the app's settings, never in the repo. A
 * photo with no stored note shows the draft from thumbnails.yml `photo.drafts`, marked as a draft,
 * until he saves one; a photo with neither has no note, and the legend lists its name alone.
 */
export const PHOTO_NOTES_STORE_KEY = 'thumbnailLab.reactionNotes';

/** The OLD setting: the logo file's path, read in place. Read only to offer copying it into the app. */
export const LOGO_STORE_KEY = 'thumbnailLab.logo';

export interface LookPhoto {
  name: string;
  /** A small picture of the trimmed photo, as a data URL. */
  preview: string;
  /** What the trim did (specks dropped), or null. */
  trim: string | null;
  note: string | null;
  /** True when the note is the drafted one, not Owen's own. */
  draft: boolean;
}

export interface LookPhotos {
  folder: string;
  photos: LookPhoto[];
  /** While the library is empty: the old folder's photos, offered for copying. */
  offer: { from: string; count: number } | null;
}

export interface LookLogo {
  logo: { file: string; name: string; width: number; height: number; preview: string } | null;
  offer: { from: string } | null;
}

export interface LookDeps {
  store: { get(key: string): unknown; set(key: string, value: unknown): void };
  userDataPath: string;
}

export class ThumbnailLook {
  constructor(private readonly deps: LookDeps) {}

  private userData(): string {
    return this.deps.userDataPath;
  }

  // ── the look ────────────────────────────────────────────────────────────────

  getStyle(): { style: ThumbnailStyle; stored: boolean } {
    const stored = this.deps.store.get(STYLE_STORE_KEY);
    if (stored === undefined || stored === null) return { style: DEFAULT_STYLE, stored: false };
    return { style: validateStyle(stored), stored: true };
  }

  setStyle(value: unknown): ThumbnailStyle {
    const style = validateStyle(value);
    this.deps.store.set(STYLE_STORE_KEY, style);
    log.info('[Thumbnails] the thumbnail look was saved');
    return style;
  }

  // ── the reaction photos ────────────────────────────────────────────────────

  /** The old folder setting (before the library), or null. Read only for the copy offer. */
  private oldPhotoFolder(): string | null {
    const folder = this.deps.store.get(PHOTO_FOLDER_STORE_KEY);
    if (folder === undefined || folder === null || folder === '') return null;
    if (typeof folder !== 'string') throw new Error(`The saved reaction photos folder is not a path: ${JSON.stringify(folder)}`);
    return folder;
  }

  /** The library's photo names, sorted. */
  photoNames(): string[] {
    return libraryPhotos(this.userData()).map((p) => p.name);
  }

  /**
   * Copy chosen photo files and/or folders into the library. A name already there is not copied
   * and comes back in `already` (nothing of the batch copied) unless `replace` is set, which the
   * page sends after Owen confirms.
   */
  addPhotos(chosen: string[], replace: boolean): { added: string[]; replaced: string[]; already: string[] } {
    if (!Array.isArray(chosen) || chosen.some((c) => typeof c !== 'string')) throw new Error(`The photos to add must be a list of paths, got ${JSON.stringify(chosen)}.`);
    if (typeof replace !== 'boolean') throw new Error(`"Replace" must be yes or no, got ${JSON.stringify(replace)}.`);
    try {
      const out = addPhotos(this.userData(), chosen, replace);
      log.info(`[Thumbnails] reaction photos added: ${out.added.join(', ') || 'none'}; replaced: ${out.replaced.join(', ') || 'none'}`);
      return { ...out, already: [] };
    } catch (err) {
      if (err instanceof PhotosAlreadyThere) return { added: [], replaced: [], already: err.names };
      throw err;
    }
  }

  /** Remove one photo from the library (its note stays saved under its name). */
  removePhoto(name: string): void {
    removePhoto(this.userData(), name);
    log.info(`[Thumbnails] reaction photo removed from the app: ${name}`);
  }

  /** Owen's one click on "Copy these into the app": the old folder's photos copied (his originals only read). */
  copyOldPhotos(): { added: string[]; replaced: string[]; already: string[] } {
    const offer = photoCopyOffer(this.userData(), this.oldPhotoFolder());
    if (offer === null) throw new Error('There is nothing to copy: the app already holds photos, or the old folder is not set or not there.');
    return this.addPhotos([offer.from], false);
  }

  /** Owen's saved notes, checked. */
  storedNotes(): Record<string, string> {
    const stored = this.deps.store.get(PHOTO_NOTES_STORE_KEY);
    if (stored === undefined || stored === null) return {};
    if (typeof stored !== 'object' || Array.isArray(stored) || Object.values(stored).some((v) => typeof v !== 'string')) {
      throw new Error(`The saved reaction photo notes are not a list of name: note (${JSON.stringify(stored).slice(0, 120)}).`);
    }
    return stored as Record<string, string>;
  }

  /** Each photo's note: Owen's saved one, else the draft (marked), else none. */
  notesFor(names: readonly string[]): Array<{ name: string; note: string | null; draft: boolean }> {
    const stored = this.storedNotes();
    const drafts = draftNotes();
    return names.map((name) =>
      stored[name] !== undefined ? { name, note: stored[name], draft: false }
      : drafts[name] !== undefined ? { name, note: drafts[name], draft: true }
      : { name, note: null, draft: false });
  }

  /** Save one photo's note (an empty note is saved as empty: the legend then lists the name alone). */
  setPhotoNote(name: string, note: string): void {
    if (typeof note !== 'string') throw new Error(`A photo note is text, got ${JSON.stringify(note)}.`);
    if (!this.photoNames().includes(name)) throw new Error(`There is no reaction photo "${name}" in the app's library.`);
    this.deps.store.set(PHOTO_NOTES_STORE_KEY, { ...this.storedNotes(), [name]: note.trim() });
  }

  /**
   * The library's photos, trimmed, each with a small picture and its note; and, while the library
   * is empty, the old folder's photos offered for copying.
   */
  photos(): LookPhotos {
    const list = libraryPhotos(this.userData());
    const notes = this.notesFor(list.map((p) => p.name));
    return {
      folder: photosDir(this.userData()),
      offer: photoCopyOffer(this.userData(), this.oldPhotoFolder()),
      photos: list.map((p, i) => {
        const trimmed = trimmedPhoto(p);
        return { name: p.name, preview: photoPreview(trimmed), trim: trimmed.note, note: notes[i].note, draft: notes[i].draft };
      }),
    };
  }

  // ── the logo ───────────────────────────────────────────────────────────────

  /** The old logo setting (a path read in place, before the library), or null. Read only for the copy offer. */
  private oldLogoFile(): string | null {
    const file = this.deps.store.get(LOGO_STORE_KEY);
    if (file === undefined || file === null || file === '') return null;
    if (typeof file !== 'string') throw new Error(`The saved logo is not a file path: ${JSON.stringify(file)}`);
    return file;
  }

  /** The app's logo file, or null when it holds none. */
  logoFile(): string | null {
    return libraryLogo(this.userData());
  }

  /**
   * The logo as the page shows it (file name, size, a small picture), or null for none; and, while
   * the app holds none, the old setting's file offered for copying. An unreadable kept logo throws.
   */
  logo(): LookLogo {
    const file = this.logoFile();
    if (file === null) return { logo: null, offer: logoCopyOffer(this.userData(), this.oldLogoFile()) };
    const logo = readLogo(file);
    return { logo: { file, name: logo.name, width: logo.fileWidth, height: logo.fileHeight, preview: logoPreview(logo) }, offer: null };
  }

  /** Copy a logo file into the app (replacing the one kept), after reading it: an unreadable file is refused and nothing changes. */
  setLogo(file: string): LookLogo {
    const kept = setLibraryLogo(this.userData(), file, (f) => void readLogo(f));
    log.info(`[Thumbnails] logo copied into the app: ${file} -> ${kept}`);
    return this.logo();
  }

  /** Owen's one click on "Copy it into the app" for the old logo setting (his file only read). */
  copyOldLogo(): LookLogo {
    const offer = logoCopyOffer(this.userData(), this.oldLogoFile());
    if (offer === null) throw new Error('There is no logo to copy: the app already holds one, or the old setting is not set or its file is not there.');
    return this.setLogo(offer.from);
  }
}
