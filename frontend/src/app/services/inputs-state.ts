import { Injectable, signal, effect } from '@angular/core';

export interface InputItem {
  type: string; // 'subject', 'video', 'transcript_file', 'master-report', 'text-subject'
  path: string;
  displayName: string;
  icon: string;
  selected: boolean;
  promptSet: string; // ID of the prompt set to use (e.g., "sample-youtube")
  notes?: string; // Optional notes/instructions for the AI (e.g., "focus on tax fraud")
  generateChapters?: boolean; // For video files: generate YouTube chapter markers (default: true)
  textContent?: string; // For text-subject items: the actual text content
  // Master report specific fields
  masterReportPath?: string; // Path to the master report JSON file
  masterReportData?: {
    sectionCount: number;
    totalDuration: string;
    masterVideoName: string;
  };
}

export interface GenerationState {
  isGenerating: boolean;
  generationStartTime: number;
  elapsedTime: string;
  generationProgress: number;
  currentlyProcessing: string;
}

const STORAGE_KEY = 'contentstudio-inputs';

@Injectable({
  providedIn: 'root'
})
export class InputsStateService {
  // Persistent state across component instances
  inputItems = signal<InputItem[]>([]);

  // Master controls
  compilationMode = signal(false); // If true, all items use the same prompt set
  masterPromptSet = signal('sample-youtube'); // Default prompt set

  // Generation state
  generationState = signal<GenerationState>({
    isGenerating: false,
    generationStartTime: 0,
    elapsedTime: '0s',
    generationProgress: 0,
    currentlyProcessing: ''
  });

  // Track if initial settings have been loaded
  private settingsLoaded = false;

  constructor() {
    // Load persisted state from localStorage
    this.loadFromStorage();

    // Auto-save when state changes
    effect(() => {
      const state = {
        inputItems: this.inputItems(),
        compilationMode: this.compilationMode(),
        masterPromptSet: this.masterPromptSet()
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    });
  }

  private loadFromStorage() {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const state = JSON.parse(stored);
        if (state.inputItems) this.inputItems.set(state.inputItems);
        if (state.compilationMode !== undefined) this.compilationMode.set(state.compilationMode);
        if (state.masterPromptSet) this.masterPromptSet.set(state.masterPromptSet);
      }
    } catch (error) {
      console.error('Failed to load inputs state from storage:', error);
    }
  }

  addItem(item: InputItem) {
    this.inputItems.update(items => [...items, item]);
  }

  removeItem(index: number) {
    this.inputItems.update(items => items.filter((_, i) => i !== index));
  }

  clearItems() {
    this.inputItems.set([]);
  }

  reorderItems(previousIndex: number, currentIndex: number) {
    this.inputItems.update(items => {
      const result = [...items];
      const [removed] = result.splice(previousIndex, 1);
      result.splice(currentIndex, 0, removed);
      return result;
    });
  }

  updateGenerationState(state: Partial<GenerationState>) {
    this.generationState.update(current => ({ ...current, ...state }));
  }

  hasLoadedSettings(): boolean {
    return this.settingsLoaded;
  }

  markSettingsLoaded() {
    this.settingsLoaded = true;
  }
}
