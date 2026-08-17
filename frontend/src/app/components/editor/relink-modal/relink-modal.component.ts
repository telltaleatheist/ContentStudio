// src/app/components/editor/relink-modal/relink-modal.component.ts
//
// Asset relinking, as a File ▸ Relink… modal.
//
// The sixteen overlay PNGs the compound generators composite with are referenced by ABSOLUTE
// path in the host's config, so moving the assets folder (or opening the project on a second
// Mac) silently breaks every compound the pipeline builds. This dialog is where that gets
// fixed: it shows each expected file, whether the stored path still resolves, and lets the
// user point at one folder to relink all of them at once.
//
// Ported from AutoCutStudio's standalone relinking PAGE. The list, the categories, the
// expected filenames and the save mapping are all verbatim — those keys are the config schema
// the Python side reads, and inventing new ones would break the generators. What changed:
//
//   - It is a modal, not a routed page (the editor window has no router chrome).
//   - It talks to EDITOR_HOST, not to the host's ElectronService. Same reason as every other
//     file under components/editor/.
//   - The eight alert()/confirm() calls are gone. Native dialogs block the whole renderer and
//     say nothing the UI could not say better, so every outcome is an inline line here, and
//     the one confirm() is an inline confirm row.

import { Component, EventEmitter, Inject, OnInit, Output } from '@angular/core';
import { AssetPaths, EDITOR_HOST, EditorHost } from '../editor-host';

/** One row of the list: an asset the pipeline expects, and where it currently points. */
interface AssetPath {
  key: string;
  displayName: string;
  currentPath: string;
  isValid: boolean;
  category: string;
  expectedFilename: string;  // The filename to search for when relinking
}

@Component({
  selector: 'app-editor-relink-modal',
  templateUrl: './relink-modal.component.html',
  styleUrls: ['./relink-modal.component.scss'],
  standalone: false
})
export class RelinkModalComponent implements OnInit {
  /** Dismissed — the host clears the field it renders this component behind. */
  @Output() closed = new EventEmitter<void>();

  assetsFolder: string = '';
  assets: AssetPath[] = [];
  isSearching: boolean = false;
  searchProgress: string = '';

  /**
   * The two inline lines that replaced alert(). `status` is a neutral/success readout,
   * `error` is a failure — kept separate so a search that half-succeeded can say both.
   */
  status: string | null = null;
  error: string | null = null;

  /** Replaces the one confirm(): the Reset row asks in place instead of blocking the renderer. */
  confirmingReset = false;

  constructor(@Inject(EDITOR_HOST) private host: EditorHost) {}

  async ngOnInit() {
    await this.loadAssetPaths();
  }

  async loadAssetPaths() {
    // Load current asset paths from the host. Declared before the try so a
    // persistent IPC failure can fall back to empty paths without recursing.
    let backgrounds: { [key: string]: string } = {};
    let borders: Partial<AssetPaths['borders']> = {};

    this.error = null;

    try {
      if (this.host.isElectron()) {
        const result = await this.host.getAssetConfig();

        if (result.success && result.assetPaths) {
          backgrounds = result.assetPaths.backgrounds || {};
          borders = result.assetPaths.borders || {};
        } else {
          // Said out loud, where the old page only console.warn'd it: an empty list that
          // looks like "nothing has ever been linked" is indistinguishable from a read that
          // failed, and the two need very different responses from the user.
          this.error = `Could not read the stored asset paths: ${result.error || 'the host gave no reason'}`;
        }
      }
    } catch (err: any) {
      this.error = `Could not read the stored asset paths: ${err?.message || String(err)}`;
      // Fall through with empty backgrounds/borders — no recursion, the dialog stays usable.
    }

    // Always populate the assets list (even if paths are empty)
    this.assets = [
        // Backgrounds
        {
          key: 'space_background',
          displayName: 'Space Background',
          currentPath: backgrounds?.['space_background'] || '',
          isValid: false,
          category: 'backgrounds',
          expectedFilename: 'earth background.png'
        },

          // CAM DC borders
          {
            key: 'cam_dc_top_left',
            displayName: 'Top Left (Cam 1)',
            currentPath: borders?.cam_dc?.['top_left'] || '',
            isValid: false,
            category: 'cam_dc_borders',
            expectedFilename: 'cam dc top left.png'
          },
          {
            key: 'cam_dc_bottom_right',
            displayName: 'Bottom Right (Cam 2)',
            currentPath: borders?.cam_dc?.['bottom_right'] || '',
            isValid: false,
            category: 'cam_dc_borders',
            expectedFilename: 'cam dc bottom right.png'
          },

          // GS borders
          {
            key: 'gs_bottom_left',
            displayName: 'Bottom Left (Cam 1)',
            currentPath: borders?.gs?.['bottom_left'] || '',
            isValid: false,
            category: 'gs_borders',
            expectedFilename: 'gs bottom left.png'
          },
          {
            key: 'gs_bottom_right',
            displayName: 'Bottom Right (Game)',
            currentPath: borders?.gs?.['bottom_right'] || '',
            isValid: false,
            category: 'gs_borders',
            expectedFilename: 'gs bottom right.png'
          },
          {
            key: 'gs_top_left',
            displayName: 'Top Left (Screen)',
            currentPath: borders?.gs?.['top_left'] || '',
            isValid: false,
            category: 'gs_borders',
            expectedFilename: 'gs top left.png'
          },

          // GS DC borders
          {
            key: 'gs_dc_bottom_left',
            displayName: 'Bottom Left (Cam 1)',
            currentPath: borders?.gs_dc?.['bottom_left'] || '',
            isValid: false,
            category: 'gs_dc_borders',
            expectedFilename: 'gs dc bottom left.png'
          },
          {
            key: 'gs_dc_bottom_right',
            displayName: 'Bottom Right (Game)',
            currentPath: borders?.gs_dc?.['bottom_right'] || '',
            isValid: false,
            category: 'gs_dc_borders',
            expectedFilename: 'gs dc bottom right.png'
          },
          {
            key: 'gs_dc_top_left',
            displayName: 'Top Left (Screen)',
            currentPath: borders?.gs_dc?.['top_left'] || '',
            isValid: false,
            category: 'gs_dc_borders',
            expectedFilename: 'gs dc top left.png'
          },
          {
            key: 'gs_dc_top_right',
            displayName: 'Top Right (Cam 2)',
            currentPath: borders?.gs_dc?.['top_right'] || '',
            isValid: false,
            category: 'gs_dc_borders',
            expectedFilename: 'gs dc top right.png'
          },

          // SSB borders
          {
            key: 'ssb_top_left',
            displayName: 'Top Left (Cam)',
            currentPath: borders?.ssb?.['top_left'] || '',
            isValid: false,
            category: 'ssb_borders',
            expectedFilename: 'ssb top left.png'
          },
          {
            key: 'ssb_bottom_right',
            displayName: 'Bottom Right (Screen)',
            currentPath: borders?.ssb?.['bottom_right'] || '',
            isValid: false,
            category: 'ssb_borders',
            expectedFilename: 'ssb bottom right.png'
          },

          // SSB DC borders
          {
            key: 'ssb_dc_top_left',
            displayName: 'Top Left (Cam 1)',
            currentPath: borders?.ssb_dc?.['top_left'] || '',
            isValid: false,
            category: 'ssb_dc_borders',
            expectedFilename: 'ssb dc top left.png'
          },
          {
            key: 'ssb_dc_bottom_left',
            displayName: 'Bottom Left (Cam 2)',
            currentPath: borders?.ssb_dc?.['bottom_left'] || '',
            isValid: false,
            category: 'ssb_dc_borders',
            expectedFilename: 'ssb dc bottom left.png'
          },
          {
            key: 'ssb_dc_bottom_right',
            displayName: 'Bottom Right (Screen)',
            currentPath: borders?.ssb_dc?.['bottom_right'] || '',
            isValid: false,
            category: 'ssb_dc_borders',
            expectedFilename: 'ssb dc bottom right.png'
          },

          // Shorts border
          {
            key: 'shorts_border',
            displayName: 'Shorts Border',
            currentPath: borders?.shorts?.['border'] || '',
            isValid: false,
            category: 'shorts_borders',
            expectedFilename: 'shorts border.png'
          }
        ];

    // Check validity of each path (best-effort — a validation failure must not
    // bubble out and must not trigger a reload).
    try {
      await this.validateAllPaths();
    } catch (err: any) {
      this.error = `Could not check whether the linked files still exist: ${err?.message || String(err)}`;
    }
  }

  async validateAllPaths() {
    for (const asset of this.assets) {
      if (asset.currentPath) {
        const result = await this.host.checkFileExists(asset.currentPath);
        asset.isValid = result.exists;
      }
    }
  }

  async selectAssetsFolder() {
    const result = await this.host.selectDirectory({
      title: 'Select Assets Folder'
    });

    if (!result.canceled && result.filePaths.length > 0) {
      this.assetsFolder = result.filePaths[0];
      await this.autoRelinkAssets();
    }
  }

  async autoRelinkAssets() {
    // Try to find matching files in the selected folder (recursively)
    if (!this.assetsFolder) return;

    this.isSearching = true;
    this.searchProgress = 'Searching recursively for asset files...';
    this.status = null;
    this.error = null;

    try {
      // Collect all expected filenames we're searching for
      const filenames = this.assets
        .map(asset => asset.expectedFilename)
        .filter(filename => filename !== '');

      // Use recursive search
      const result = await this.host.searchFilesRecursive({
        rootPath: this.assetsFolder,
        filenames: filenames,
        maxDepth: 5 // Search up to 5 levels deep
      });

      if (result.success && result.foundFiles) {
        const found = result.foundFiles;
        let foundCount = 0;

        // Update asset paths with found files
        for (const asset of this.assets) {
          const filename = asset.expectedFilename;
          if (filename && found[filename]) {
            asset.currentPath = found[filename];
            asset.isValid = true;
            foundCount++;
          }
        }

        this.searchProgress = `Found ${foundCount} of ${filenames.length} files`;

        // Re-validate all paths
        await this.validateAllPaths();

        // Show result message
        if (foundCount === filenames.length) {
          this.status = `Found all ${foundCount} asset files.`;
        } else {
          this.status =
            `Found ${foundCount} of ${filenames.length} files. Some assets may still need manual linking.`;
        }
      } else {
        this.error = `Search failed: ${result.error || 'Unknown error'}`;
      }
    } catch (err: any) {
      this.error = `An error occurred during search: ${err?.message || String(err)}`;
    } finally {
      this.isSearching = false;
      this.searchProgress = '';
    }
  }

  async selectAssetFile(asset: AssetPath) {
    const result = await this.host.selectFile({
      title: `Select ${asset.displayName}`,
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (!result.canceled && result.filePaths.length > 0) {
      asset.currentPath = result.filePaths[0];
      asset.isValid = true;
      // Re-validate to ensure the file exists
      await this.validateAllPaths();
    }
  }

  getFilename(path: string): string {
    return path.split('/').pop() || '';
  }

  async saveAssetPaths() {
    this.status = null;
    this.error = null;

    try {
      // Convert assets array to the config structure
      const assetPaths: AssetPaths = {
        backgrounds: {},
        borders: {
          cam_dc: {},
          gs: {},
          gs_dc: {},
          ssb: {},
          ssb_dc: {},
          shorts: {}
        }
      };

      // Map assets to config structure
      this.assets.forEach(asset => {
        if (asset.category === 'backgrounds') {
          assetPaths.backgrounds[asset.key] = asset.currentPath;
        } else if (asset.category === 'cam_dc_borders') {
          const borderKey = asset.key.replace('cam_dc_', '');
          assetPaths.borders.cam_dc[borderKey] = asset.currentPath;
        } else if (asset.category === 'gs_borders') {
          const borderKey = asset.key.replace('gs_', '');
          assetPaths.borders.gs[borderKey] = asset.currentPath;
        } else if (asset.category === 'gs_dc_borders') {
          const borderKey = asset.key.replace('gs_dc_', '');
          assetPaths.borders.gs_dc[borderKey] = asset.currentPath;
        } else if (asset.category === 'ssb_borders') {
          const borderKey = asset.key.replace('ssb_', '');
          assetPaths.borders.ssb[borderKey] = asset.currentPath;
        } else if (asset.category === 'ssb_dc_borders') {
          const borderKey = asset.key.replace('ssb_dc_', '');
          assetPaths.borders.ssb_dc[borderKey] = asset.currentPath;
        } else if (asset.category === 'shorts_borders') {
          const borderKey = asset.key.replace('shorts_', '');
          assetPaths.borders.shorts[borderKey] = asset.currentPath;
        }
      });

      // Save to the host
      const result = await this.host.saveAssetConfig(assetPaths);

      if (result.success) {
        this.status = 'Asset paths saved.';
      } else {
        this.error = `Failed to save asset paths: ${result.error || 'the host gave no reason'}`;
      }
    } catch (err: any) {
      this.error = `Failed to save asset paths: ${err?.message || String(err)}`;
    }
  }

  /**
   * Reset ▸ re-read what is stored, discarding everything picked in this dialog since it
   * opened. Destructive to unsaved work, so it asks first — inline, not in a native confirm().
   */
  async resetToDefaults() {
    this.confirmingReset = false;
    this.status = null;
    await this.loadAssetPaths();
  }

  onClose(): void {
    this.closed.emit();
  }

  /** A click on the dim area outside the card dismisses, matching the editor's other modals. */
  onBackdropClick(): void {
    this.onClose();
  }

  get allPathsValid(): boolean {
    return this.assets.every(a => a.isValid);
  }

  get invalidCount(): number {
    return this.assets.filter(a => !a.isValid).length;
  }
}
