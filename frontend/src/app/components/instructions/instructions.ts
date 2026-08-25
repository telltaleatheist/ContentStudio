import { Component, computed, signal, OnInit } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FormsModule } from '@angular/forms';
import { ElectronService, InstructionFile } from '../../services/electron';
import { NotificationService } from '../../services/notification';

/** One heading and the files under it, in the order the main process listed them. */
interface InstructionGroup {
  name: string;
  files: InstructionFile[];
}

/** What `get-prompt-set` assembles for one channel. Read-only, and shown as such. */
interface AssembledPromptSet {
  id: string;
  name: string;
  editorial_prompt?: string;
  instructions_prompt?: string;
  description_links?: string;
}

interface PromptSetListItem {
  id: string;
  name: string;
}

/**
 * The Instructions page: the prompt tree's files, editable, plus what they assemble to.
 *
 * TWO VIEWS, AND THE DIFFERENCE BETWEEN THEM IS THE WHOLE POINT. The files tab edits ONE file
 * at a time as raw YAML, because that is the only form in which an edit can be saved back —
 * the instructions are shared across channels with per-format variants inside each file, and a
 * channel file is data naming which variant it takes. The preview tab shows the JOIN of those
 * files for one channel, which is what generation actually sends and which nothing can edit,
 * because there is no way back from a join to the files it came from.
 */
@Component({
  selector: 'app-instructions',
  standalone: true,
  imports: [
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTabsModule,
    MatTooltipModule,
    FormsModule
  ],
  templateUrl: './instructions.html',
  styleUrl: './instructions.scss',
})
export class Instructions implements OnInit {
  // --- The files -----------------------------------------------------------
  files = signal<InstructionFile[]>([]);
  groupOrder = signal<string[]>([]);
  /** The directory on disk, shown in the header so the operator can find it outside the app. */
  promptsRoot = signal('');
  listError = signal('');

  selectedRelPath = signal<string | null>(null);
  /** The bytes as last read from (or written to) disk — what "Discard changes" resets to. */
  loadedContent = signal('');
  draft = signal('');
  saving = signal(false);
  /** Set while the revert confirmation is showing, holding the file it is about. */
  revertPending = signal<string | null>(null);

  dirty = computed(() => this.draft() !== this.loadedContent());

  selectedFile = computed<InstructionFile | null>(() => {
    const rel = this.selectedRelPath();
    if (!rel) return null;
    return this.files().find((f) => f.relPath === rel) ?? null;
  });

  /**
   * The sidebar, grouped. The ORDER comes from the main process, which owns the four groups —
   * a second ordering here would be a second answer to what the architecture's parts are.
   */
  groups = computed<InstructionGroup[]>(() =>
    this.groupOrder()
      .map((name) => ({ name, files: this.files().filter((f) => f.group === name) }))
      .filter((group) => group.files.length > 0)
  );

  // --- The assembled preview ----------------------------------------------
  promptSets = signal<PromptSetListItem[]>([]);
  selectedPromptSetId = signal<string | null>(null);
  currentPromptSet = signal<AssembledPromptSet | null>(null);

  constructor(
    private electron: ElectronService,
    private notificationService: NotificationService
  ) {}

  async ngOnInit() {
    await this.loadFiles();
    await this.loadPromptSets();
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  async loadFiles(keepSelection = false) {
    const result = await this.electron.listInstructionFiles();
    if (!result.success) {
      // The page has nothing to show and says why, in the main process's own words: every
      // reason it can fail (no installed tree, an unplaceable file, an unreadable manifest)
      // names a path the operator has to go and look at.
      this.listError.set(result.error || 'The instruction files could not be listed, and the app was not told why.');
      this.files.set([]);
      this.notificationService.error('Instructions', this.listError(), false);
      return;
    }

    this.listError.set('');
    this.files.set(result.files || []);
    this.groupOrder.set(result.groupOrder || []);
    this.promptsRoot.set(result.root || '');

    const current = this.selectedRelPath();
    if (keepSelection && current && (result.files || []).some((f) => f.relPath === current)) return;
    const first = (result.files || [])[0];
    if (first) {
      await this.selectFile(first.relPath);
    } else {
      this.selectedRelPath.set(null);
    }
  }

  async selectFile(relPath: string) {
    this.revertPending.set(null);
    const result = await this.electron.readInstructionFile(relPath);
    if (!result.success) {
      this.notificationService.error('Instructions', result.error || `${relPath} could not be read.`, false);
      return;
    }
    this.selectedRelPath.set(relPath);
    this.loadedContent.set(result.content ?? '');
    this.draft.set(result.content ?? '');
  }

  discardChanges() {
    this.draft.set(this.loadedContent());
  }

  async save() {
    const relPath = this.selectedRelPath();
    if (!relPath || !this.dirty()) return;

    this.saving.set(true);
    try {
      const content = this.draft();
      const result = await this.electron.writeInstructionFile(relPath, content);
      if (!result.success) {
        // VERBATIM. The message is the parser's line and column, or the prompt loader's own
        // complaint about a key that is now missing — rephrasing it would throw away the only
        // thing that says where to look.
        this.notificationService.error('Not saved', result.error || `${relPath} was not saved, and the app was not told why.`, false);
        return;
      }
      this.loadedContent.set(content);
      await this.loadFiles(true);
      this.notificationService.success('Saved', `${relPath} saved. The app is generating from it now.`, false);
    } finally {
      this.saving.set(false);
    }
  }

  askRevert(relPath: string) {
    this.revertPending.set(relPath);
  }

  cancelRevert() {
    this.revertPending.set(null);
  }

  async revert() {
    const relPath = this.revertPending();
    if (!relPath) return;

    const result = await this.electron.revertInstructionFile(relPath);
    this.revertPending.set(null);
    if (!result.success) {
      this.notificationService.error('Not reverted', result.error || `${relPath} was not reverted, and the app was not told why.`, false);
      return;
    }
    this.loadedContent.set(result.content ?? '');
    this.draft.set(result.content ?? '');
    await this.loadFiles(true);
    this.notificationService.success('Reverted', `${relPath} is back to the version this build ships.`, false);
  }

  // -------------------------------------------------------------------------
  // Assembled preview
  // -------------------------------------------------------------------------

  async loadPromptSets() {
    try {
      const result = await this.electron.listPromptSets();
      if (!result.success) {
        this.notificationService.error('Channels', result.error || 'The channels could not be listed.', false);
        return;
      }
      this.promptSets.set(result.promptSets);
      if (result.promptSets.length > 0) {
        await this.selectPromptSet(result.promptSets[0].id);
      }
    } catch (error) {
      this.notificationService.error('Channels', 'Failed to load channels: ' + (error as Error).message, false);
    }
  }

  async selectPromptSet(id: string) {
    this.selectedPromptSetId.set(id);
    const result = await this.electron.getPromptSet(id);
    if (!result.success) {
      this.notificationService.error('Channels', result.error || `The assembled prompt for "${id}" could not be read.`, false);
      return;
    }
    this.currentPromptSet.set(result.promptSet);
  }
}
