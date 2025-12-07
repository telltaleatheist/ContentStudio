import { Component, signal, OnInit } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatCheckboxModule } from '@angular/material/checkbox';
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
    FormsModule
  ],
  templateUrl: './prompts.html',
  styleUrl: './prompts.scss',
})
export class Prompts implements OnInit {
  // Prompt sets list
  promptSets = signal<PromptSetListItem[]>([]);
  selectedPromptSetId = signal<string | null>(null);
  currentPromptSet = signal<PromptSet | null>(null);

  // Edit mode signals
  editName = signal('');
  editEditorialPrompt = signal('');
  editInstructionsPrompt = signal('');
  editDescriptionLinks = signal('');

  // Dialog states
  showCreateDialog = signal(false);
  showDeleteDialog = signal(false);
  promptSetToDelete = signal<string | null>(null);

  // Create dialog fields
  newPromptSetName = signal('');

  // Instructions Builder
  showBuilderDialog = signal(false);
  builderTitles = signal({ enabled: false, count: 10, minLength: 45, maxLength: 70 });
  builderDescription = signal({ enabled: false, minWords: 200, maxWords: 300 });
  builderTags = signal({ enabled: false, count: 15 });
  builderHashtags = signal({ enabled: false, count: 3 });
  builderThumbnailText = signal({ enabled: false, count: 5, maxWords: 3 });
  builderChapters = signal({ enabled: false, minCount: 3, maxCount: 10 });

  constructor(
    private electron: ElectronService,
    private notificationService: NotificationService
  ) {}

  async ngOnInit() {
    await this.loadPromptSets();
    if (this.promptSets().length > 0) {
      this.selectPromptSet(this.promptSets()[0].id);
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
}
