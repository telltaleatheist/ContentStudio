import { Component, signal, OnInit } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTabsModule } from '@angular/material/tabs';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../services/electron';
import { NotificationService } from '../../services/notification';

interface PromptSet {
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

interface MasterPromptSet {
  id: string;
  name: string;
  description?: string;
  prompt?: string;
}

interface MasterPromptSetListItem {
  id: string;
  name: string;
  description?: string;
}

@Component({
  selector: 'app-prompts',
  standalone: true,
  imports: [
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatCheckboxModule,
    MatTabsModule,
    FormsModule
  ],
  templateUrl: './prompts.html',
  styleUrl: './prompts.scss',
})
export class Prompts implements OnInit {
  // Active tab (0 = Metadata, 1 = Master Analysis)
  activeTabIndex = signal(0);

  // Metadata prompt sets list
  promptSets = signal<PromptSetListItem[]>([]);
  selectedPromptSetId = signal<string | null>(null);
  currentPromptSet = signal<PromptSet | null>(null);

  // Master prompt sets list
  masterPromptSets = signal<MasterPromptSetListItem[]>([]);
  selectedMasterPromptSetId = signal<string | null>(null);
  currentMasterPromptSet = signal<MasterPromptSet | null>(null);

  // Edit mode signals (Metadata)
  editName = signal('');
  editEditorialPrompt = signal('');
  editInstructionsPrompt = signal('');
  editDescriptionLinks = signal('');

  // Edit mode signals (Master)
  editMasterName = signal('');
  editMasterDescription = signal('');
  editMasterPrompt = signal('');

  // Dialog states (Metadata)
  showCreateDialog = signal(false);
  showDeleteDialog = signal(false);
  promptSetToDelete = signal<string | null>(null);

  // Dialog states (Master)
  showMasterCreateDialog = signal(false);
  showMasterDeleteDialog = signal(false);
  masterPromptSetToDelete = signal<string | null>(null);

  // Create dialog fields (Metadata)
  newPromptSetName = signal('');

  // Create dialog fields (Master)
  newMasterPromptSetName = signal('');

  // Instructions Builder
  showBuilderDialog = signal(false);
  builderTitles = signal({ enabled: false, count: 10, minLength: 45, maxLength: 70 });
  builderDescription = signal({ enabled: false, minWords: 125, maxWords: 200 });
  builderTags = signal({ enabled: false, count: 15 });
  builderHashtags = signal({ enabled: false, count: 3 });
  builderThumbnailText = signal({ enabled: false, count: 5, maxWords: 3 });
  builderChapters = signal({ enabled: false, minCount: 3, maxCount: 10 });

  constructor(
    private electron: ElectronService,
    private notificationService: NotificationService
  ) {}

  async ngOnInit() {
    // Load both types of prompt sets
    await Promise.all([
      this.loadPromptSets(),
      this.loadMasterPromptSets()
    ]);

    // Select first metadata prompt set
    if (this.promptSets().length > 0) {
      this.selectPromptSet(this.promptSets()[0].id);
    }

    // Select first master prompt set
    if (this.masterPromptSets().length > 0) {
      this.selectMasterPromptSet(this.masterPromptSets()[0].id);
    }
  }

  async loadPromptSets() {
    try {
      const result = await this.electron.listPromptSets();
      if (result.success) {
        this.promptSets.set(result.promptSets);
      }
    } catch (error) {
      this.notificationService.error('Load Error', 'Failed to load prompt sets: ' + (error as Error).message, false);
    }
  }

  async selectPromptSet(id: string) {
    this.selectedPromptSetId.set(id);
    const result = await this.electron.getPromptSet(id);
    if (result.success) {
      this.currentPromptSet.set(result.promptSet);
      this.editName.set(result.promptSet.name);
      this.editEditorialPrompt.set(result.promptSet.editorial_prompt || '');
      this.editInstructionsPrompt.set(result.promptSet.instructions_prompt || '');
      this.editDescriptionLinks.set(result.promptSet.description_links || '');
    }
  }

  async saveCurrentPromptSet() {
    if (!this.selectedPromptSetId()) return;

    // Validate {subject} is present in editorial_prompt
    if (!this.editEditorialPrompt().includes('{subject}')) {
      this.notificationService.error('Validation Error', 'Editorial prompt must contain {subject} placeholder', false);
      return;
    }

    try {
      const result = await this.electron.updatePromptSet(
        this.selectedPromptSetId()!,
        {
          name: this.editName(),
          editorial_prompt: this.editEditorialPrompt(),
          instructions_prompt: this.editInstructionsPrompt(),
          description_links: this.editDescriptionLinks()
        }
      );

      if (result.success) {
        await this.loadPromptSets();
        this.notificationService.success('Saved', 'Prompt set saved successfully', false);
      } else {
        this.notificationService.error('Save Error', result.error || 'Unknown error', false);
      }
    } catch (error) {
      this.notificationService.error('Save Error', 'Failed to save prompt set: ' + (error as Error).message, false);
    }
  }

  openCreateDialog() {
    this.newPromptSetName.set('');
    this.showCreateDialog.set(true);
  }

  closeCreateDialog() {
    this.showCreateDialog.set(false);
  }

  async createNewPromptSet() {
    if (!this.newPromptSetName().trim()) {
      return;
    }

    try {
      const result = await this.electron.createPromptSet({
        name: this.newPromptSetName(),
        editorial_prompt: '',
        instructions_prompt: '',
        description_links: ''
      });

      if (result.success) {
        await this.loadPromptSets();
        this.selectPromptSet(result.id);
        this.closeCreateDialog();
      }
    } catch (error) {
      this.notificationService.error('Create Error', 'Failed to create prompt set: ' + (error as Error).message, false);
    }
  }

  confirmDelete(id: string) {
    this.promptSetToDelete.set(id);
    this.showDeleteDialog.set(true);
  }

  async deletePromptSet() {
    const id = this.promptSetToDelete();
    if (!id) return;

    try {
      const result = await this.electron.deletePromptSet(id);
      if (result.success) {
        await this.loadPromptSets();
        this.showDeleteDialog.set(false);
        this.promptSetToDelete.set(null);

        // Select first available prompt set
        if (this.promptSets().length > 0) {
          this.selectPromptSet(this.promptSets()[0].id);
        } else {
          this.selectedPromptSetId.set(null);
          this.currentPromptSet.set(null);
        }
      }
    } catch (error) {
      this.notificationService.error('Delete Error', 'Failed to delete prompt set: ' + (error as Error).message, false);
    }
  }

  // Instructions Builder methods
  openBuilderDialog() {
    this.showBuilderDialog.set(true);
  }

  closeBuilderDialog() {
    this.showBuilderDialog.set(false);
  }

  generateBuilderPreview(): string {
    const lines: string[] = [];

    if (this.builderTitles().enabled) {
      const t = this.builderTitles();
      lines.push(`TITLES: Generate ${t.count} options, ${t.minLength}-${t.maxLength} characters each`);
    }

    if (this.builderDescription().enabled) {
      const d = this.builderDescription();
      lines.push(`DESCRIPTION: ${d.minWords}-${d.maxWords} words`);
    }

    if (this.builderTags().enabled) {
      const t = this.builderTags();
      lines.push(`TAGS: ${t.count} comma-separated tags`);
    }

    if (this.builderHashtags().enabled) {
      const h = this.builderHashtags();
      lines.push(`HASHTAGS: ${h.count} hashtags`);
    }

    if (this.builderThumbnailText().enabled) {
      const t = this.builderThumbnailText();
      lines.push(`THUMBNAIL_TEXT: ${t.count} options, max ${t.maxWords} words each, ALL CAPS`);
    }

    if (this.builderChapters().enabled) {
      const c = this.builderChapters();
      lines.push(`CHAPTERS: ${c.minCount}-${c.maxCount} chapter markers with timestamps`);
    }

    return lines.join('\n');
  }

  insertBuilderInstructions() {
    const generated = this.generateBuilderPreview();
    if (generated) {
      // Append to existing instructions or replace if empty
      const current = this.editInstructionsPrompt();
      if (current.trim()) {
        this.editInstructionsPrompt.set(current + '\n\n' + generated);
      } else {
        this.editInstructionsPrompt.set(generated);
      }
    }
    this.closeBuilderDialog();
  }

  // ==================== MASTER PROMPT SETS ====================

  async loadMasterPromptSets() {
    try {
      const result = await this.electron.listMasterPromptSets();
      if (result.success) {
        this.masterPromptSets.set(result.promptSets);
      }
    } catch (error) {
      this.notificationService.error('Load Error', 'Failed to load master prompt sets: ' + (error as Error).message, false);
    }
  }

  async selectMasterPromptSet(id: string) {
    this.selectedMasterPromptSetId.set(id);
    const result = await this.electron.getMasterPromptSet(id);
    if (result.success) {
      this.currentMasterPromptSet.set(result.promptSet);
      this.editMasterName.set(result.promptSet.name);
      this.editMasterDescription.set(result.promptSet.description || '');
      this.editMasterPrompt.set(result.promptSet.prompt || '');
    }
  }

  async saveCurrentMasterPromptSet() {
    if (!this.selectedMasterPromptSetId()) return;

    // Validate {transcript} is present in prompt
    if (!this.editMasterPrompt().includes('{transcript}')) {
      this.notificationService.error('Validation Error', 'Prompt must contain {transcript} placeholder', false);
      return;
    }

    try {
      const result = await this.electron.updateMasterPromptSet(
        this.selectedMasterPromptSetId()!,
        {
          name: this.editMasterName(),
          description: this.editMasterDescription(),
          prompt: this.editMasterPrompt()
        }
      );

      if (result.success) {
        await this.loadMasterPromptSets();
        this.notificationService.success('Saved', 'Master prompt set saved successfully', false);
      } else {
        this.notificationService.error('Save Error', result.error || 'Unknown error', false);
      }
    } catch (error) {
      this.notificationService.error('Save Error', 'Failed to save master prompt set: ' + (error as Error).message, false);
    }
  }

  openMasterCreateDialog() {
    this.newMasterPromptSetName.set('');
    this.showMasterCreateDialog.set(true);
  }

  closeMasterCreateDialog() {
    this.showMasterCreateDialog.set(false);
  }

  async createNewMasterPromptSet() {
    if (!this.newMasterPromptSetName().trim()) {
      return;
    }

    try {
      const result = await this.electron.createMasterPromptSet({
        name: this.newMasterPromptSetName(),
        description: '',
        prompt: 'Analyze this transcript and identify sections.\n\n{transcript}'
      });

      if (result.success) {
        await this.loadMasterPromptSets();
        this.selectMasterPromptSet(result.id);
        this.closeMasterCreateDialog();
      }
    } catch (error) {
      this.notificationService.error('Create Error', 'Failed to create master prompt set: ' + (error as Error).message, false);
    }
  }

  confirmMasterDelete(id: string) {
    this.masterPromptSetToDelete.set(id);
    this.showMasterDeleteDialog.set(true);
  }

  async deleteMasterPromptSet() {
    const id = this.masterPromptSetToDelete();
    if (!id) return;

    try {
      const result = await this.electron.deleteMasterPromptSet(id);
      if (result.success) {
        await this.loadMasterPromptSets();
        this.showMasterDeleteDialog.set(false);
        this.masterPromptSetToDelete.set(null);

        // Select first available master prompt set
        if (this.masterPromptSets().length > 0) {
          this.selectMasterPromptSet(this.masterPromptSets()[0].id);
        } else {
          this.selectedMasterPromptSetId.set(null);
          this.currentMasterPromptSet.set(null);
        }
      }
    } catch (error) {
      this.notificationService.error('Delete Error', 'Failed to delete master prompt set: ' + (error as Error).message, false);
    }
  }
}
