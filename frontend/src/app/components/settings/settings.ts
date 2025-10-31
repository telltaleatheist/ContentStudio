import { Component, signal, OnInit } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../services/electron';

@Component({
  selector: 'app-settings',
  imports: [
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    FormsModule
  ],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings implements OnInit {
  // AI Provider settings
  aiProvider = signal('ollama');
  ollamaModel = signal('qwen2.5:7b');
  ollamaHost = signal('http://localhost:11434');
  openaiApiKey = signal('');
  claudeApiKey = signal('');

  // Output settings
  outputDirectory = signal('~/Documents/LaunchPad Output');

  constructor(private electron: ElectronService) {}

  async ngOnInit() {
    // Load current settings from Electron
    try {
      const settings = await this.electron.getSettings();
      if (settings.aiProvider) this.aiProvider.set(settings.aiProvider);
      if (settings.ollamaModel) this.ollamaModel.set(settings.ollamaModel);
      if (settings.ollamaHost) this.ollamaHost.set(settings.ollamaHost);
      if (settings.openaiApiKey) this.openaiApiKey.set(settings.openaiApiKey);
      if (settings.claudeApiKey) this.claudeApiKey.set(settings.claudeApiKey);
      if (settings.outputDirectory) this.outputDirectory.set(settings.outputDirectory);
    } catch (error) {
      console.error('Error loading settings:', error);
    }
  }

  async selectOutputDirectory() {
    const result = await this.electron.selectOutputDirectory();
    if (result.success && result.directory) {
      this.outputDirectory.set(result.directory);
    }
  }

  async saveSettings() {
    const settings = {
      aiProvider: this.aiProvider(),
      ollamaModel: this.ollamaModel(),
      ollamaHost: this.ollamaHost(),
      openaiApiKey: this.openaiApiKey(),
      claudeApiKey: this.claudeApiKey(),
      outputDirectory: this.outputDirectory()
    };

    try {
      const result = await this.electron.updateSettings(settings);
      if (result.success) {
        alert('Settings saved successfully!');
      } else {
        alert('Failed to save settings');
      }
    } catch (error) {
      console.error('Error saving settings:', error);
      alert('Error saving settings');
    }
  }
}