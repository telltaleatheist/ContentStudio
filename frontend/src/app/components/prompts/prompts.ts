import { Component, signal, OnInit } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTabsModule } from '@angular/material/tabs';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../services/electron';

@Component({
  selector: 'app-prompts',
  standalone: true,
  imports: [
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatTabsModule,
    FormsModule
  ],
  templateUrl: './prompts.html',
  styleUrl: './prompts.scss',
})
export class Prompts implements OnInit {
  // YouTube prompts
  youtubeEditorialGuidelines = signal('');
  youtubeGenerationInstructions = signal('');
  youtubeDescriptionLinks = signal('');

  // Podcast prompts
  podcastEditorialGuidelines = signal('');
  podcastGenerationInstructions = signal('');
  podcastDescriptionLinks = signal('');

  // Save notification
  showSaveNotification = signal(false);
  saveNotificationTimeout: any;

  constructor(private electron: ElectronService) {}

  async ngOnInit() {
    await this.loadPrompts();
  }

  async loadPrompts() {
    try {
      const prompts = await this.electron.getPrompts();

      if (prompts.youtube) {
        this.youtubeEditorialGuidelines.set(prompts.youtube.editorial_guidelines || '');
        this.youtubeGenerationInstructions.set(prompts.youtube.generation_instructions || '');
        this.youtubeDescriptionLinks.set(prompts.youtube.description_links || '');
      }

      if (prompts.podcast) {
        this.podcastEditorialGuidelines.set(prompts.podcast.editorial_guidelines || '');
        this.podcastGenerationInstructions.set(prompts.podcast.generation_instructions || '');
        this.podcastDescriptionLinks.set(prompts.podcast.description_links || '');
      }
    } catch (error) {
      console.error('Error loading prompts:', error);
    }
  }

  async saveYoutubePrompts() {
    const prompts = {
      platform: 'youtube',
      editorial_guidelines: this.youtubeEditorialGuidelines(),
      generation_instructions: this.youtubeGenerationInstructions(),
      description_links: this.youtubeDescriptionLinks()
    };

    try {
      const result = await this.electron.savePrompts(prompts);
      if (result.success) {
        console.log('YouTube prompts saved successfully');
        this.showSaveSuccess();
      } else {
        console.error('Failed to save YouTube prompts');
      }
    } catch (error) {
      console.error('Error saving YouTube prompts:', error);
    }
  }

  async savePodcastPrompts() {
    const prompts = {
      platform: 'podcast',
      editorial_guidelines: this.podcastEditorialGuidelines(),
      generation_instructions: this.podcastGenerationInstructions(),
      description_links: this.podcastDescriptionLinks()
    };

    try {
      const result = await this.electron.savePrompts(prompts);
      if (result.success) {
        console.log('Podcast prompts saved successfully');
        this.showSaveSuccess();
      } else {
        console.error('Failed to save Podcast prompts');
      }
    } catch (error) {
      console.error('Error saving Podcast prompts:', error);
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
