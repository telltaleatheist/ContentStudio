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
  youtubeSystemPrompt = signal('');
  youtubeConsolidatedPrompt = signal('');
  youtubeKeywordsPrompt = signal('');

  // Podcast prompts
  podcastSystemPrompt = signal('');
  podcastConsolidatedPrompt = signal('');
  podcastKeywordsPrompt = signal('');

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
        this.youtubeSystemPrompt.set(prompts.youtube.system || '');
        this.youtubeConsolidatedPrompt.set(prompts.youtube.consolidated || '');
        this.youtubeKeywordsPrompt.set(prompts.youtube.keywords || '');
      }

      if (prompts.podcast) {
        this.podcastSystemPrompt.set(prompts.podcast.system || '');
        this.podcastConsolidatedPrompt.set(prompts.podcast.consolidated || '');
        this.podcastKeywordsPrompt.set(prompts.podcast.keywords || '');
      }
    } catch (error) {
      console.error('Error loading prompts:', error);
    }
  }

  async saveYoutubePrompts() {
    const prompts = {
      platform: 'youtube',
      system: this.youtubeSystemPrompt(),
      consolidated: this.youtubeConsolidatedPrompt(),
      keywords: this.youtubeKeywordsPrompt()
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
      system: this.podcastSystemPrompt(),
      consolidated: this.podcastConsolidatedPrompt(),
      keywords: this.podcastKeywordsPrompt()
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
