import { Component, signal, computed, OnInit, OnDestroy, inject, ViewChild, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TextSubjectModalComponent } from '../../components/text-subject-modal/text-subject-modal.component';
import { CascadeComponent } from '../../components/cascade/cascade.component';
import { ButtonComponent } from '../../components/button/button.component';
import { ElectronService } from '../../services/electron.service';
import { InputsStateService, InputItem } from '../../services/inputs-state.service';
import { JobQueueService, QueuedJob } from '../../services/job-queue.service';
import { NotificationService } from '../../services/notification.service';
import { CascadeGroup, CascadeItem, ContextMenuAction } from '../../models/file.model';

interface PromptSetOption {
  id: string;
  name: string;
  platform: string;
}

interface AIModelOption {
  value: string;
  label: string;
  provider: 'cloud' | 'local';
  icon: string;
}

@Component({
  selector: 'app-inputs',
  standalone: true,
  imports: [CommonModule, FormsModule, TextSubjectModalComponent, CascadeComponent, ButtonComponent],
  templateUrl: './inputs.component.html',
  styleUrls: ['./inputs.component.scss']
})
export class InputsComponent implements OnInit, OnDestroy {
  private electron = inject(ElectronService);
  public inputsState = inject(InputsStateService);
  public jobQueue = inject(JobQueueService);
  private notificationService = inject(NotificationService);

  @ViewChild('textSubjectModal') textSubjectModal!: TextSubjectModalComponent;

  private processingInterval: any;

  isDraggingOver = signal(false);
  queueStarted = signal(false);
  expandedJobIds = signal<Set<string>>(new Set());
  availablePromptSets = signal<PromptSetOption[]>([]);
  availableAIModels = signal<AIModelOption[]>([]);
  masterAIModel = signal<string>('');
  selectedInputIds = signal<Set<string>>(new Set());

  constructor() {
    // Debug effect to track when inputItems changes
    effect(() => {
      const items = this.inputsState.inputItems();
      console.log('[Inputs Effect] inputItems changed, count:', items.length, items);
    });
  }

  // Context menu actions for cascade
  inputContextMenuActions = computed<ContextMenuAction[]>(() => {
    const promptChildren: ContextMenuAction[] = this.availablePromptSets().map(ps => ({
      label: ps.name,
      icon: '📝',
      action: `prompt:${ps.id}`
    }));

    const aiModelChildren: ContextMenuAction[] = [
      { label: 'Use Default', icon: '⚙️', action: 'ai:default' },
      ...this.availableAIModels().map(model => ({
        label: model.label,
        icon: model.icon,
        action: `ai:${model.value}`
      }))
    ];

    return [
      { label: 'Set Prompt', icon: '📋', action: 'set-prompt', children: promptChildren },
      { label: 'Set AI Model', icon: '🤖', action: 'set-ai', children: aiModelChildren },
      { label: 'Toggle Chapters', icon: '📑', action: 'toggle-chapters' },
      { label: '', icon: '', action: '', divider: true },
      { label: 'Remove', icon: '🗑️', action: 'remove' }
    ];
  });

  // Convert input items to cascade groups
  inputCascadeGroups = computed<CascadeGroup[]>(() => {
    const items = this.inputsState.inputItems();
    console.log('[Inputs] inputCascadeGroups computed, items count:', items.length, items);
    if (items.length === 0) return [];

    const groups: { [key: string]: InputItem[] } = {
      'Videos': [],
      'Transcripts': [],
      'Subjects': [],
      'Directories': [],
      'Other': []
    };

    const typeToGroup: { [key: string]: string } = {
      'video': 'Videos',
      'transcript': 'Transcripts',
      'subject': 'Subjects',
      'directory': 'Directories'
    };

    for (const item of items) {
      const groupName = typeToGroup[item.type] || 'Other';
      groups[groupName].push(item);
    }

    const cascadeGroups: CascadeGroup[] = [];
    for (const [label, groupItems] of Object.entries(groups)) {
      if (groupItems.length > 0) {
        cascadeGroups.push({
          label,
          items: groupItems.map(item => ({
            id: item.path,
            name: item.displayName,
            subtitle: this.inputsState.compilationMode() ? undefined : this.getItemSubtitle(item),
            icon: item.icon || this.getIconForType(item.type)
          })),
          expanded: true
        });
      }
    }

    console.log('[Inputs] Returning cascade groups:', cascadeGroups);
    return cascadeGroups;
  });

  private getItemSubtitle(item: InputItem): string {
    const promptName = this.getPromptSetName(item.promptSet);
    const aiLabel = item.aiModel ? this.getAIModelLabel(item.aiModel) : 'Default';
    const parts = [promptName, aiLabel];

    // Show chapters indicator for videos
    if (item.type === 'video') {
      parts.push(item.generateChapters ? '📑 Chapters' : 'No Chapters');
    }

    return parts.join(' · ');
  }

  async ngOnInit() {
    await this.loadPromptSets();
    await this.loadAIModels();

    if (!this.inputsState.hasLoadedSettings()) {
      try {
        const settings = await this.electron.getSettings();
        if (settings.promptSet) {
          this.inputsState.masterPromptSet.set(settings.promptSet);
        }
        this.inputsState.markSettingsLoaded();
      } catch (error) {
        this.notificationService.error('Settings Error', 'Failed to load settings');
      }
    }
  }

  ngOnDestroy() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }
  }

  async loadPromptSets() {
    try {
      const result = await this.electron.listPromptSets();
      if (result.success) {
        this.availablePromptSets.set(result.promptSets);
      }
    } catch (error) {
      this.notificationService.error('Prompt Sets Error', 'Failed to load prompt sets');
    }
  }

  async loadAIModels() {
    try {
      const models: AIModelOption[] = [];

      const ollamaResult = await this.electron.getAvailableModels('ollama');
      if (ollamaResult.success && ollamaResult.models.length > 0) {
        ollamaResult.models.forEach((model) => {
          models.push({
            value: `ollama:${model.id}`,
            label: model.name,
            provider: 'local',
            icon: '💻'
          });
        });
      }

      const apiKeys = await this.electron.getApiKeys();

      if (apiKeys.openaiApiKey) {
        const openaiResult = await this.electron.getAvailableModels('openai');
        if (openaiResult.success && openaiResult.models.length > 0) {
          openaiResult.models.forEach((model) => {
            models.push({
              value: `openai:${model.id}`,
              label: model.name,
              provider: 'cloud',
              icon: '☁️'
            });
          });
        }
      }

      if (apiKeys.claudeApiKey) {
        const claudeResult = await this.electron.getAvailableModels('claude');
        if (claudeResult.success && claudeResult.models.length > 0) {
          claudeResult.models.forEach((model) => {
            models.push({
              value: `claude:${model.id}`,
              label: model.name,
              provider: 'cloud',
              icon: '☁️'
            });
          });
        }
      }

      this.availableAIModels.set(models);
    } catch (error) {
      console.log('Error loading AI models:', error);
    }
  }

  // Selection helpers - using cascade selection
  get selectedItems(): InputItem[] {
    const selectedIds = this.selectedInputIds();
    return this.inputsState.inputItems().filter(item => {
      for (const id of selectedIds) {
        const pathPart = id.includes('|') ? id.split('|').slice(1).join('|') : id;
        if (pathPart === item.path) return true;
      }
      return false;
    });
  }

  get hasSelectedItems(): boolean {
    return this.selectedInputIds().size > 0;
  }

  get allItemsSelected(): boolean {
    const items = this.inputsState.inputItems();
    return items.length > 0 && this.selectedInputIds().size === items.length;
  }

  toggleSelectAll() {
    if (this.allItemsSelected) {
      this.selectedInputIds.set(new Set());
    } else {
      const allIds = new Set<string>();
      for (const group of this.inputCascadeGroups()) {
        for (const item of group.items) {
          allIds.add(`${group.label}|${item.id}`);
        }
      }
      this.selectedInputIds.set(allIds);
    }
  }

  // Cascade event handlers
  onInputSelectionChanged(event: { count: number; ids: Set<string> }) {
    this.selectedInputIds.set(event.ids);
  }

  onInputAction(event: { action: string; items: CascadeItem[] }) {
    const targetItems = event.items;
    if (targetItems.length === 0) return;

    if (event.action === 'remove') {
      for (const cascadeItem of targetItems) {
        const index = this.inputsState.inputItems().findIndex(i => i.path === cascadeItem.id);
        if (index !== -1) {
          this.inputsState.removeItem(index);
        }
      }
      this.selectedInputIds.set(new Set());
    } else if (event.action.startsWith('prompt:')) {
      const promptSetId = event.action.replace('prompt:', '');
      this.setPromptForItems(targetItems, promptSetId);
    } else if (event.action.startsWith('ai:')) {
      const aiModel = event.action.replace('ai:', '');
      this.setAIModelForItems(targetItems, aiModel === 'default' ? undefined : aiModel);
    } else if (event.action === 'toggle-chapters') {
      this.toggleChaptersForItems(targetItems);
    }
  }

  private toggleChaptersForItems(targetItems: CascadeItem[]) {
    const targetPaths = new Set(targetItems.map(t => t.id));

    const items = this.inputsState.inputItems();
    const updatedItems = items.map(item => {
      if (targetPaths.has(item.path)) {
        // Only toggle for video types - ignore subjects and transcripts
        if (item.type === 'video') {
          return { ...item, generateChapters: !item.generateChapters };
        }
      }
      return item;
    });

    this.inputsState.inputItems.set(updatedItems);

    // Count how many were actually toggled
    const toggledCount = targetItems.filter(t => {
      const item = items.find(i => i.path === t.id);
      return item?.type === 'video';
    }).length;

    if (toggledCount > 0) {
      this.notificationService.success('Chapters Toggled', `Updated ${toggledCount} video(s)`);
    } else {
      this.notificationService.warning('No Videos', 'Chapters only apply to video files');
    }
  }

  private setPromptForItems(targetItems: CascadeItem[], promptSetId: string) {
    const targetPaths = new Set(targetItems.map(t => t.id));

    const items = this.inputsState.inputItems();
    const updatedItems = items.map(item => {
      if (targetPaths.has(item.path)) {
        return { ...item, promptSet: promptSetId };
      }
      return item;
    });

    this.inputsState.inputItems.set(updatedItems);
    this.notificationService.success('Prompt Updated', `Set prompt for ${targetItems.length} item(s)`);
  }

  private setAIModelForItems(targetItems: CascadeItem[], aiModel: string | undefined) {
    const targetPaths = new Set(targetItems.map(t => t.id));

    const items = this.inputsState.inputItems();
    const updatedItems = items.map(item => {
      if (targetPaths.has(item.path)) {
        return { ...item, aiModel };
      }
      return item;
    });

    this.inputsState.inputItems.set(updatedItems);
    const modelLabel = aiModel ? this.getAIModelLabel(aiModel) : 'Default';
    this.notificationService.success('AI Model Updated', `Set to ${modelLabel} for ${targetItems.length} item(s)`);
  }

  // Master controls
  onMasterPromptSetChange(promptSetId: string) {
    this.inputsState.masterPromptSet.set(promptSetId);
    if (this.hasSelectedItems) {
      const items = this.inputsState.inputItems();
      const updatedItems = items.map(item =>
        item.selected ? { ...item, promptSet: promptSetId } : item
      );
      this.inputsState.inputItems.set(updatedItems);
    }
  }

  onMasterAIModelChange(modelValue: string) {
    this.masterAIModel.set(modelValue);
    if (this.hasSelectedItems) {
      const items = this.inputsState.inputItems();
      const updatedItems = items.map(item =>
        item.selected ? { ...item, aiModel: modelValue || undefined } : item
      );
      this.inputsState.inputItems.set(updatedItems);
    }
  }

  onCompilationModeChange(event: Event) {
    const isCompilation = (event.target as HTMLInputElement).checked;
    this.inputsState.compilationMode.set(isCompilation);
    if (isCompilation) {
      const items = this.inputsState.inputItems();
      const updatedItems = items.map(item => ({
        ...item,
        promptSet: this.inputsState.masterPromptSet()
      }));
      this.inputsState.inputItems.set(updatedItems);
    }
  }

  updateItemPromptSet(index: number, promptSetId: string) {
    const items = this.inputsState.inputItems();
    const updatedItems = [...items];
    updatedItems[index] = { ...updatedItems[index], promptSet: promptSetId };
    this.inputsState.inputItems.set(updatedItems);
  }

  // Notes dialog
  openNotesDialog(index: number) {
    const item = this.inputsState.inputItems()[index];
    const notes = prompt('Enter custom AI instructions for this item:', item.notes || '');
    if (notes !== null) {
      const items = this.inputsState.inputItems();
      const updatedItems = [...items];
      updatedItems[index] = { ...updatedItems[index], notes: notes || undefined };
      this.inputsState.inputItems.set(updatedItems);
    }
  }

  // Chapters
  canGenerateChapters(item: InputItem): boolean {
    return item.type === 'video' && !this.inputsState.compilationMode();
  }

  toggleChapterGeneration(index: number, event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    const items = this.inputsState.inputItems();
    const updatedItems = [...items];
    updatedItems[index] = { ...updatedItems[index], generateChapters: checked };
    this.inputsState.inputItems.set(updatedItems);
  }

  // Text subject modal
  openTextSubjectModal() {
    this.textSubjectModal.open();
  }

  onTextSubjectsSubmitted(text: string) {
    console.log('[Inputs] onTextSubjectsSubmitted called with:', text);
    const lines = text.split('\n').filter(line => line.trim());
    console.log('[Inputs] Parsed lines:', lines);
    lines.forEach(subject => {
      const item = {
        type: 'subject',
        path: subject.trim(),
        displayName: subject.trim(),
        icon: '💬',
        selected: false,
        promptSet: this.inputsState.masterPromptSet()
      };
      console.log('[Inputs] Adding subject item:', item);
      this.inputsState.addItem(item);
    });
    console.log('[Inputs] Items after adding subjects:', this.inputsState.inputItems());
  }

  // File operations
  async browseFiles() {
    console.log('[Inputs] browseFiles called');
    const result = await this.electron.selectFiles();
    console.log('[Inputs] selectFiles result:', result);
    if (result.success && result.files.length > 0) {
      for (const filePath of result.files) {
        console.log('[Inputs] Adding file:', filePath);
        await this.addFileToInputs(filePath);
      }
      console.log('[Inputs] Total items after adding:', this.inputsState.inputItems().length);
    }
  }

  private async addFileToInputs(filePath: string) {
    console.log('[Inputs] addFileToInputs called with:', filePath);
    try {
      const isDir = await this.electron.isDirectory(filePath);
      console.log('[Inputs] isDirectory result:', isDir);
      const fileName = filePath.split(/[/\\]/).pop() || filePath;

      if (isDir) {
        const item = {
          type: 'directory',
          path: filePath,
          displayName: fileName,
          icon: '📁',
          selected: false,
          promptSet: this.inputsState.masterPromptSet()
        };
        console.log('[Inputs] Adding directory item:', item);
        this.inputsState.addItem(item);
      } else {
        const ext = fileName.split('.').pop()?.toLowerCase() || '';
        let icon = '📄';
        let type = 'file';

        if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(ext)) {
          icon = '🎬';
          type = 'video';
        } else if (ext === 'txt') {
          icon = '📝';
          type = 'transcript';
        }

        const item = {
          type,
          path: filePath,
          displayName: fileName,
          icon,
          selected: false,
          promptSet: this.inputsState.masterPromptSet(),
          generateChapters: type === 'video' ? true : undefined
        };
        console.log('[Inputs] Adding file item:', item);
        this.inputsState.addItem(item);
      }
      console.log('[Inputs] Items after add:', this.inputsState.inputItems());
    } catch (error) {
      console.error('[Inputs] Error in addFileToInputs:', error);
    }
  }

  // Drag and drop (file drop zone)
  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingOver.set(true);
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingOver.set(false);
  }

  async onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingOver.set(false);

    if (!event.dataTransfer?.files) return;

    const files = Array.from(event.dataTransfer.files);
    for (const file of files) {
      // @ts-ignore - file.path is available in Electron
      const filePath = file.path;
      if (filePath) {
        await this.addFileToInputs(filePath);
      }
    }
  }

  removeInput(index: number) {
    this.inputsState.removeItem(index);
  }

  clearAllInputs() {
    this.inputsState.inputItems.set([]);
    this.selectedInputIds.set(new Set());
  }

  // Queue operations
  addToQueue() {
    if (this.selectedItems.length === 0) return;

    if (this.inputsState.compilationMode()) {
      const items = this.selectedItems;
      const promptSet = this.inputsState.masterPromptSet();
      const jobName = items.length === 1
        ? `${items[0].displayName} (compilation)`
        : `${items[0].displayName.substring(0, 30)}... + ${items.length - 1} more`;
      this.jobQueue.addJob(jobName, items, promptSet, 'compilation');
    } else {
      this.selectedItems.forEach(item => {
        this.jobQueue.addJob(item.displayName, [item], item.promptSet, 'individual');
      });
    }

    // Clear cascade selection after adding to queue
    this.selectedInputIds.set(new Set());
  }

  async startQueue() {
    if (this.queueStarted()) return;

    try {
      const settings = await this.electron.getSettings();
      const outputDir = settings.outputDirectory;

      if (!outputDir) {
        this.notificationService.error('Configuration Error', 'No output directory configured.');
        return;
      }

      const dirCheck = await this.electron.checkDirectory(outputDir);
      if (!dirCheck.exists || !dirCheck.writable) {
        this.notificationService.error('Directory Error', `Output directory issue: ${outputDir}`);
        return;
      }
    } catch (error) {
      this.notificationService.error('Directory Error', 'Failed to validate output directory.');
      return;
    }

    this.queueStarted.set(true);
    this.jobQueue.isProcessing.set(true);
    this.startQueueProcessor();
  }

  private startQueueProcessor() {
    this.processingInterval = setInterval(() => {
      this.processNextJob();
    }, 1000);
  }

  private async processNextJob() {
    if (this.jobQueue.hasProcessingJob()) return;

    const nextJob = this.jobQueue.getNextPendingJob();
    if (!nextJob) {
      if (this.queueStarted()) {
        this.queueStarted.set(false);
        this.jobQueue.isProcessing.set(false);
        if (this.processingInterval) {
          clearInterval(this.processingInterval);
          this.processingInterval = null;
        }
      }
      return;
    }

    this.jobQueue.updateJob(nextJob.id, {
      status: 'processing',
      progress: 0,
      currentlyProcessing: 'Starting...'
    });

    const startTime = Date.now();

    try {
      const unsubscribe = this.electron.onProgress((progress: any) => {
        if (progress.phase === 'transcription' && progress.percent !== undefined) {
          this.jobQueue.updateJob(nextJob.id, {
            progress: Math.floor(progress.percent / 2),
            currentlyProcessing: progress.message || 'Transcribing...'
          });
        }
        if (progress.phase === 'generating' && progress.percent !== undefined) {
          this.jobQueue.updateJob(nextJob.id, {
            progress: 50 + Math.floor(progress.percent / 2),
            currentlyProcessing: progress.message || 'Generating metadata...'
          });
        }
      });

      const inputs = nextJob.inputs.map(item => ({
        path: item.path,
        notes: item.notes
      }));

      const result = await this.electron.generateMetadata({
        inputs,
        promptSet: nextJob.promptSet,
        mode: nextJob.mode,
        jobId: nextJob.id,
        jobName: nextJob.name
      });

      unsubscribe();

      const processingTime = (Date.now() - startTime) / 1000;

      if (result.success) {
        this.jobQueue.updateJob(nextJob.id, {
          status: 'completed',
          progress: 100,
          currentlyProcessing: 'Complete!',
          completedAt: new Date(),
          outputFiles: result.output_files,
          processingTime
        });
        this.notificationService.success('Job Completed', `"${nextJob.name}" completed in ${processingTime.toFixed(1)}s`);
      } else {
        this.jobQueue.updateJob(nextJob.id, {
          status: 'failed',
          currentlyProcessing: 'Failed',
          completedAt: new Date(),
          error: result.error,
          processingTime
        });
        this.notificationService.error('Job Failed', result.error || 'Unknown error');
      }
    } catch (error) {
      this.jobQueue.updateJob(nextJob.id, {
        status: 'failed',
        currentlyProcessing: 'Error',
        completedAt: new Date(),
        error: String(error)
      });
    }
  }

  // Job expansion
  toggleJobExpansion(jobId: string) {
    const expanded = this.expandedJobIds();
    const newExpanded = new Set(expanded);
    if (newExpanded.has(jobId)) {
      newExpanded.delete(jobId);
    } else {
      newExpanded.add(jobId);
    }
    this.expandedJobIds.set(newExpanded);
  }

  isJobExpanded(jobId: string): boolean {
    return this.expandedJobIds().has(jobId);
  }

  // Job management
  clearCompletedJobs() {
    this.jobQueue.clearCompletedJobs();
  }

  removeJob(jobId: string) {
    this.jobQueue.removeJob(jobId);
  }

  cancelJob(jobId: string) {
    this.electron.cancelJob(jobId);
    this.jobQueue.updateJob(jobId, {
      status: 'failed',
      error: 'Cancelled by user'
    });
  }

  removeItemFromJob(jobId: string, itemIndex: number) {
    const job = this.jobQueue.jobs().find(j => j.id === jobId);
    if (job && job.status === 'pending') {
      const newInputs = [...job.inputs];
      newInputs.splice(itemIndex, 1);
      if (newInputs.length === 0) {
        this.jobQueue.removeJob(jobId);
      } else {
        this.jobQueue.updateJob(jobId, { inputs: newInputs });
      }
    }
  }

  // Helper methods
  getPromptSetName(promptSetId: string): string {
    const ps = this.availablePromptSets().find(p => p.id === promptSetId);
    return ps ? ps.name : promptSetId;
  }

  getAIModelLabel(modelValue: string): string {
    const model = this.availableAIModels().find(m => m.value === modelValue);
    return model?.label || modelValue;
  }

  getJobStatusIcon(status: string): string {
    switch (status) {
      case 'pending': return '⏳';
      case 'processing': return '⚙️';
      case 'completed': return '✅';
      case 'failed': return '❌';
      default: return '❓';
    }
  }

  getJobProgress(job: QueuedJob): number {
    return job.progress || 0;
  }

  getGlobalQueueProgress(): number {
    const jobs = this.jobQueue.jobs();
    if (jobs.length === 0) return 0;

    const totalProgress = jobs.reduce((sum, job) => {
      if (job.status === 'completed' || job.status === 'failed') return sum + 100;
      return sum + (job.progress || 0);
    }, 0);

    return totalProgress / jobs.length;
  }

  getCompletedJobsCount(): number {
    return this.jobQueue.jobs().filter(job =>
      job.status === 'completed' || job.status === 'failed'
    ).length;
  }

  getItemStatusClass(job: QueuedJob, index: number): string {
    if (job.status === 'completed') return 'completed';
    if (job.status === 'failed') return 'failed';
    if (job.status === 'processing') {
      // Simple heuristic: current item is being processed
      const progress = job.progress || 0;
      const itemProgress = (progress / 100) * job.inputs.length;
      if (index < Math.floor(itemProgress)) return 'completed';
      if (index === Math.floor(itemProgress)) return 'processing';
    }
    return 'pending';
  }

  getItemStatusText(job: QueuedJob, index: number): string {
    const statusClass = this.getItemStatusClass(job, index);
    switch (statusClass) {
      case 'completed': return 'Done';
      case 'processing': return 'Processing...';
      case 'failed': return 'Failed';
      default: return 'Pending';
    }
  }

  isItemCompleted(job: QueuedJob, index: number): boolean {
    return this.getItemStatusClass(job, index) === 'completed';
  }

  getIconForType(type: string): string {
    switch (type) {
      case 'video': return '🎬';
      case 'directory': return '📁';
      case 'transcript': return '📝';
      case 'subject': return '💬';
      default: return '📄';
    }
  }
}
