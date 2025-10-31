import { Component, signal, OnInit } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../services/electron';
import { TextSubjectDialog } from '../text-subject-dialog/text-subject-dialog';

interface InputItem {
  type: string;
  path: string;
  displayName: string;
  icon: string;
}

@Component({
  selector: 'app-inputs',
  imports: [
    MatIconModule,
    MatButtonModule,
    MatListModule,
    MatChipsModule,
    MatFormFieldModule,
    MatSelectModule,
    MatDialogModule,
    MatProgressBarModule,
    FormsModule
  ],
  templateUrl: './inputs.html',
  styleUrl: './inputs.scss',
})
export class Inputs implements OnInit {
  inputItems = signal<InputItem[]>([]);
  selectedPlatform = signal('youtube');
  selectedMode = signal('individual');
  isGenerating = signal(false);
  generationStartTime = signal<number>(0);
  elapsedTime = signal<string>('0s');
  generationProgress = signal<number>(0);
  currentlyProcessing = signal<string>('');

  private elapsedInterval: any;

  constructor(
    private dialog: MatDialog,
    private electron: ElectronService
  ) {}

  async ngOnInit() {
    // Load persisted settings
    try {
      const settings = await this.electron.getSettings();
      if (settings.platform) {
        this.selectedPlatform.set(settings.platform);
      }
      if (settings.mode) {
        this.selectedMode.set(settings.mode);
      }
    } catch (error) {
      console.error('Error loading settings:', error);
    }
  }

  openTextSubjectDialog() {
    const dialogRef = this.dialog.open(TextSubjectDialog, {
      width: '600px',
      disableClose: false
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        const lines = result.split('\n').filter((line: string) => line.trim());
        lines.forEach((subject: string) => {
          this.inputItems.update(items => [...items, {
            type: 'subject',
            path: subject.trim(),
            displayName: subject.trim(),
            icon: 'text_fields'
          }]);
        });
      }
    });
  }

  async browseFiles() {
    const result = await this.electron.selectFiles();
    if (result.success && result.files.length > 0) {
      for (const filePath of result.files) {
        const isDir = await this.electron.isDirectory(filePath);
        const fileName = filePath.split('/').pop() || filePath;

        if (isDir) {
          this.inputItems.update(items => [...items, {
            type: 'directory',
            path: filePath,
            displayName: fileName,
            icon: 'folder'
          }]);
        } else {
          const ext = fileName.split('.').pop()?.toLowerCase() || '';
          let icon = 'description';
          let type = 'file';

          if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(ext)) {
            icon = 'movie';
            type = 'video';
          } else if (ext === 'txt') {
            icon = 'text_fields';
            type = 'transcript';
          }

          this.inputItems.update(items => [...items, {
            type,
            path: filePath,
            displayName: fileName,
            icon
          }]);
        }
      }
    }
  }

  removeInput(index: number) {
    this.inputItems.update(items => items.filter((_, i) => i !== index));
  }

  async onPlatformChange() {
    // Persist platform selection
    try {
      await this.electron.updateSettings({ platform: this.selectedPlatform() });
    } catch (error) {
      console.error('Error saving platform:', error);
    }
  }

  async onModeChange() {
    // Persist mode selection
    try {
      await this.electron.updateSettings({ mode: this.selectedMode() });
    } catch (error) {
      console.error('Error saving mode:', error);
    }
  }

  private startElapsedTimer() {
    this.generationStartTime.set(Date.now());
    this.elapsedTime.set('0s');

    this.elapsedInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.generationStartTime()) / 1000);
      if (elapsed < 60) {
        this.elapsedTime.set(`${elapsed}s`);
      } else {
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        this.elapsedTime.set(`${minutes}m ${seconds}s`);
      }
    }, 1000);
  }

  private stopElapsedTimer() {
    if (this.elapsedInterval) {
      clearInterval(this.elapsedInterval);
      this.elapsedInterval = null;
    }
  }

  async generateMetadata() {
    if (this.inputItems().length === 0) return;
    if (this.isGenerating()) return; // Prevent double-clicks

    const inputs = this.inputItems().map(item => item.path);
    const totalItems = inputs.length;

    this.isGenerating.set(true);
    this.generationProgress.set(0);
    this.currentlyProcessing.set('Starting...');
    this.startElapsedTimer();

    // Simulate progress tracking
    // Since backend doesn't stream progress yet, we'll estimate based on typical processing time
    const estimatedTimePerItem = 30; // seconds
    const totalEstimatedTime = totalItems * estimatedTimePerItem;
    let progressInterval: any;

    try {
      // Start progress simulation
      let simulatedProgress = 0;
      progressInterval = setInterval(() => {
        if (simulatedProgress < 90) {
          // Gradually increase progress but cap at 90% until actual completion
          simulatedProgress += (100 / totalEstimatedTime) * 2; // Update every 2 seconds
          if (simulatedProgress > 90) simulatedProgress = 90;
          this.generationProgress.set(simulatedProgress);

          // Update currently processing text
          const currentItemIndex = Math.floor((simulatedProgress / 100) * totalItems);
          if (currentItemIndex < totalItems) {
            const currentItem = this.inputItems()[currentItemIndex];
            this.currentlyProcessing.set(`Processing: ${currentItem.displayName}`);
          }
        }
      }, 2000);

      const result = await this.electron.generateMetadata({
        inputs,
        platform: this.selectedPlatform(),
        mode: this.selectedMode()
      });

      // Complete progress
      clearInterval(progressInterval);
      this.generationProgress.set(100);
      this.currentlyProcessing.set('Complete!');

      if (result.success) {
        console.log('Metadata generated successfully:', result);
        const processingTime = result.processing_time ?
          `\n\nProcessing time: ${result.processing_time.toFixed(1)}s` : '';
        alert('Metadata generated successfully!' + processingTime + '\n\nOutput files:\n' + result.output_files?.join('\n'));
      } else {
        console.error('Generation failed:', result.error);
        alert('Generation failed: ' + result.error);
      }
    } catch (error) {
      console.error('Error generating metadata:', error);
      alert('Error generating metadata: ' + error);
      if (progressInterval) clearInterval(progressInterval);
    } finally {
      this.stopElapsedTimer();
      this.isGenerating.set(false);
      this.generationProgress.set(0);
      this.currentlyProcessing.set('');
    }
  }
}
