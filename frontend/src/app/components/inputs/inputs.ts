import { Component, signal, OnInit, effect } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../services/electron';
import { TextSubjectDialog } from '../text-subject-dialog/text-subject-dialog';
import { InputsStateService, InputItem } from '../../services/inputs-state';

interface QueuedJob {
  id: string;
  inputs: InputItem[];
  platform: string;
  mode: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
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
    MatCheckboxModule,
    FormsModule
  ],
  templateUrl: './inputs.html',
  styleUrl: './inputs.scss',
})
export class Inputs implements OnInit {
  // Local computed values from generation state
  isGenerating = signal(false);
  generationStartTime = signal<number>(0);
  elapsedTime = signal<string>('0s');
  generationProgress = signal<number>(0);
  currentlyProcessing = signal<string>('');

  jobQueue = signal<QueuedJob[]>([]);

  private elapsedInterval: any;

  constructor(
    private dialog: MatDialog,
    private electron: ElectronService,
    public inputsState: InputsStateService
  ) {
    // Sync generation state from service
    effect(() => {
      const state = this.inputsState.generationState();
      this.isGenerating.set(state.isGenerating);
      this.generationStartTime.set(state.generationStartTime);
      this.elapsedTime.set(state.elapsedTime);
      this.generationProgress.set(state.generationProgress);
      this.currentlyProcessing.set(state.currentlyProcessing);
    });
  }

  async ngOnInit() {
    // Load persisted settings only on first initialization
    if (!this.inputsState.hasLoadedSettings()) {
      try {
        const settings = await this.electron.getSettings();
        if (settings.platform) {
          this.inputsState.setPlatform(settings.platform);
        }
        if (settings.mode) {
          this.inputsState.setMode(settings.mode);
        }
        this.inputsState.markSettingsLoaded();
      } catch (error) {
        console.error('Error loading settings:', error);
      }
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
          this.inputsState.addItem({
            type: 'subject',
            path: subject.trim(),
            displayName: subject.trim(),
            icon: 'text_fields',
            includeInJob: true,
            isCompilation: false,
            forSpreaker: false
          });
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
          this.inputsState.addItem({
            type: 'directory',
            path: filePath,
            displayName: fileName,
            icon: 'folder',
            includeInJob: true,
            isCompilation: false,
            forSpreaker: false
          });
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

          this.inputsState.addItem({
            type,
            path: filePath,
            displayName: fileName,
            icon,
            includeInJob: true,
            isCompilation: false,
            forSpreaker: false
          });
        }
      }
    }
  }

  removeInput(index: number) {
    this.inputsState.removeItem(index);
  }

  async onPlatformChange() {
    // Persist platform selection
    try {
      await this.electron.updateSettings({ platform: this.inputsState.selectedPlatform() });
    } catch (error) {
      console.error('Error saving platform:', error);
    }
  }

  async onModeChange() {
    // Persist mode selection
    try {
      await this.electron.updateSettings({ mode: this.inputsState.selectedMode() });
    } catch (error) {
      console.error('Error saving mode:', error);
    }
  }

  private startElapsedTimer() {
    const startTime = Date.now();
    this.inputsState.updateGenerationState({
      generationStartTime: startTime,
      elapsedTime: '0s'
    });

    this.elapsedInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      let elapsedStr: string;
      if (elapsed < 60) {
        elapsedStr = `${elapsed}s`;
      } else {
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        elapsedStr = `${minutes}m ${seconds}s`;
      }
      this.inputsState.updateGenerationState({ elapsedTime: elapsedStr });
    }, 1000);
  }

  private stopElapsedTimer() {
    if (this.elapsedInterval) {
      clearInterval(this.elapsedInterval);
      this.elapsedInterval = null;
    }
  }

  async generateMetadata() {
    if (this.inputsState.inputItems().length === 0) return;
    if (this.isGenerating()) return; // Prevent double-clicks

    const inputs = this.inputsState.inputItems().map(item => item.path);
    const totalItems = inputs.length;

    this.inputsState.updateGenerationState({
      isGenerating: true,
      generationProgress: 0,
      currentlyProcessing: 'Starting...'
    });
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

          // Update currently processing text
          const currentItemIndex = Math.floor((simulatedProgress / 100) * totalItems);
          if (currentItemIndex < totalItems) {
            const currentItem = this.inputsState.inputItems()[currentItemIndex];
            this.inputsState.updateGenerationState({
              generationProgress: simulatedProgress,
              currentlyProcessing: `Processing: ${currentItem.displayName}`
            });
          } else {
            this.inputsState.updateGenerationState({ generationProgress: simulatedProgress });
          }
        }
      }, 2000);

      const result = await this.electron.generateMetadata({
        inputs,
        platform: this.inputsState.selectedPlatform(),
        mode: this.inputsState.selectedMode()
      });

      // Complete progress
      clearInterval(progressInterval);
      this.inputsState.updateGenerationState({
        generationProgress: 100,
        currentlyProcessing: 'Complete!'
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
      if (progressInterval) clearInterval(progressInterval);
    } finally {
      this.stopElapsedTimer();
      this.inputsState.updateGenerationState({
        isGenerating: false,
        generationProgress: 0,
        currentlyProcessing: ''
      });
    }
  }
}
