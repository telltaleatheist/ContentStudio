import { Component, signal } from '@angular/core';
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
export class Inputs {
  inputItems = signal<InputItem[]>([]);
  selectedPlatform = signal('youtube');
  selectedMode = signal('individual');
  isGenerating = signal(false);
  generationStartTime = signal<number>(0);
  elapsedTime = signal<string>('0s');

  private elapsedInterval: any;

  constructor(
    private dialog: MatDialog,
    private electron: ElectronService
  ) {}

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

    this.isGenerating.set(true);
    this.startElapsedTimer();

    try {
      const result = await this.electron.generateMetadata({
        inputs,
        platform: this.selectedPlatform(),
        mode: this.selectedMode()
      });

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
    } finally {
      this.stopElapsedTimer();
      this.isGenerating.set(false);
    }
  }
}
