import { Injectable, signal, effect } from '@angular/core';
import type { TranscriptChoice } from '../features/transcript-link/transcript-link.types';

export interface InputItem {
  type: string; // 'subject', 'video', 'transcript_file', 'master-report', 'text-subject'
  path: string;
  displayName: string;
  icon: string;
  selected: boolean;
  promptSet: string; // ID of the prompt set to use (e.g., "sample-youtube")
  notes?: string; // Optional notes/instructions for the AI (e.g., "focus on tax fraud")
  splitEpisode?: boolean; // For transcript imports: mark for split-into-segments before generating
  /**
   * For video items: run this input from the transcript a previous run saved, instead of
   * transcribing it again.
   *
   * Default false, and only ever offered for a video the store already holds a matching
   * record for — the checkbox does not exist otherwise. Set on the item (not in a
   * component signal) so it is captured into the queued job with the rest of the item and
   * survives the sessionStorage round-trip, exactly like `transcriptChoice`.
   */
  useSavedTranscript?: boolean;
  textContent?: string; // For text-subject items: the actual text content
  /**
   * The operator's Phase-2 decision: which editor story transcript this video came from,
   * or an explicit declaration that there is none (spec §3.2).
   *
   * OPTIONAL, and absent is the default: an item nobody linked generates from the final
   * export's own transcript and nothing blocks on it. Absent is still not the same as the
   * 'final-only' branch — that one is the operator saying so — and the run records which
   * of the two it was, so a report can never imply a decision nobody made.
   *
   * Set on the item (not held in a component signal) so it is captured into the queued job
   * with the rest of the item and survives the sessionStorage round-trip.
   */
  transcriptChoice?: TranscriptChoice;
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
  /**
   * The channel every item in this batch publishes to.
   *
   * EMPTY until something real sets it — the persisted setting, or the first channel the main
   * process actually lists. It used to be seeded with 'sample-youtube', a prompt set this repo
   * has not shipped in a very long time, so a fresh install would send a channel id that
   * resolves to nothing.
   */
  masterPromptSet = signal('');
  /**
   * What the chapter pipeline detects for every job queued from this page (LEDGER #170).
   * 'detailed' is the default — a standalone video's internal turns; 'broad' groups the
   * same subject into larger pieces; 'stories' is for compilations (podcast merges,
   * streams), where the chapters are the separate stories. Persisted like the prompt set:
   * the operator's last pick carries to the next batch.
   */
  chapterGrain = signal<'detailed' | 'broad' | 'stories'>('detailed');

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
        masterPromptSet: this.masterPromptSet(),
        chapterGrain: this.chapterGrain()
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
        if (state.chapterGrain === 'detailed' || state.chapterGrain === 'broad' || state.chapterGrain === 'stories') {
          this.chapterGrain.set(state.chapterGrain);
        }
      }
    } catch (error) {
      console.error('Failed to load inputs state from storage:', error);
    }
  }

  addItem(item: InputItem) {
    // Dedup by path.
    // For text subjects the path is the content, so adding the same text twice
    // is a no-op. Keeps @for track-by-path keys unique in the template.
    this.inputItems.update(items =>
      items.some(existing => existing.path === item.path) ? items : [...items, item]
    );
  }

  removeItem(index: number) {
    this.inputItems.update(items => items.filter((_, i) => i !== index));
  }

  /** Replace the item at `index` with `replacements` (splice in place). Used by
   *  the split-episode flow to fan one transcript into N segment items. */
  replaceItemAt(index: number, replacements: InputItem[]) {
    this.inputItems.update(items => {
      if (index < 0 || index >= items.length) return items;
      const result = [...items];
      result.splice(index, 1, ...replacements);
      return result;
    });
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
