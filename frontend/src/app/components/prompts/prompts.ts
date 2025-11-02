import { Component, signal, OnInit } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../services/electron';
import { NotificationService } from '../../services/notification';

interface PromptSet {
  id: string;
  name: string;
  platform: string;
  editorial_guidelines?: string;
  generation_instructions?: string;
  description_links?: string;
}

interface PromptSetListItem {
  id: string;
  name: string;
  platform: string;
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
  editPlatform = signal('youtube');
  editEditorialGuidelines = signal('');
  editGenerationInstructions = signal('');
  editDescriptionLinks = signal('');

  // Dialog states
  showCreateDialog = signal(false);
  showDeleteDialog = signal(false);
  promptSetToDelete = signal<string | null>(null);

  // Create dialog fields
  newPromptSetName = signal('');
  newPromptSetPlatform = signal('youtube');

  // Save notification
  showSaveNotification = signal(false);
  saveNotificationTimeout: any;

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
      this.notificationService.error('Load Error', 'Failed to load prompt sets: ' + (error as Error).message);
    }
  }

  async selectPromptSet(id: string) {
    this.selectedPromptSetId.set(id);
    const result = await this.electron.getPromptSet(id);
    if (result.success) {
      this.currentPromptSet.set(result.promptSet);
      this.editName.set(result.promptSet.name);
      this.editPlatform.set(result.promptSet.platform);
      this.editEditorialGuidelines.set(result.promptSet.editorial_guidelines || '');
      this.editGenerationInstructions.set(result.promptSet.generation_instructions || '');
      this.editDescriptionLinks.set(result.promptSet.description_links || '');
    }
  }

  async saveCurrentPromptSet() {
    if (!this.selectedPromptSetId()) return;

    try {
      const result = await this.electron.updatePromptSet(
        this.selectedPromptSetId()!,
        {
          name: this.editName(),
          platform: this.editPlatform(),
          editorial_guidelines: this.editEditorialGuidelines(),
          generation_instructions: this.editGenerationInstructions(),
          description_links: this.editDescriptionLinks()
        }
      );

      if (result.success) {
        this.notificationService.success('Prompt Set Saved', 'Your prompt set has been saved successfully');
        this.showSaveSuccess();
        await this.loadPromptSets();
      }
    } catch (error) {
      this.notificationService.error('Save Error', 'Failed to save prompt set: ' + (error as Error).message);
    }
  }

  openCreateDialog() {
    this.newPromptSetName.set('');
    this.newPromptSetPlatform.set('youtube');
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
        platform: this.newPromptSetPlatform(),
        editorial_guidelines: '',
        generation_instructions: '',
        description_links: ''
      });

      if (result.success) {
        this.notificationService.success('Prompt Set Created', 'New prompt set has been created successfully');
        await this.loadPromptSets();
        this.selectPromptSet(result.id);
        this.closeCreateDialog();
      }
    } catch (error) {
      this.notificationService.error('Create Error', 'Failed to create prompt set: ' + (error as Error).message);
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
      this.notificationService.error('Delete Error', 'Failed to delete prompt set: ' + (error as Error).message);
    }
  }

  private showSaveSuccess() {
    if (this.saveNotificationTimeout) {
      clearTimeout(this.saveNotificationTimeout);
    }

    this.showSaveNotification.set(true);

    this.saveNotificationTimeout = setTimeout(() => {
      this.showSaveNotification.set(false);
    }, 3000);
  }

  dismissSaveNotification() {
    if (this.saveNotificationTimeout) {
      clearTimeout(this.saveNotificationTimeout);
    }
    this.showSaveNotification.set(false);
  }
}
