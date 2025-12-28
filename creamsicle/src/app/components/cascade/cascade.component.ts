import { Component, Input, Output, EventEmitter, signal, computed, ChangeDetectionStrategy, ChangeDetectorRef, effect, HostListener, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ScrollingModule, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { trigger, transition, style, animate } from '@angular/animations';
import { CascadeGroup, CascadeItem, ContextMenuAction, ContextMenuPosition, ItemProgress } from '../../models/file.model';
import { ContextMenuComponent } from '../context-menu/context-menu.component';

interface ExpandableGroup extends CascadeGroup {
  expanded: boolean;
}

// Union type for virtual scroll items
export type VirtualListItem =
  | { type: 'header'; group: ExpandableGroup }
  | { type: 'item'; item: CascadeItem; groupLabel: string; itemId: string };

@Component({
  selector: 'app-cascade',
  standalone: true,
  imports: [CommonModule, ScrollingModule, ContextMenuComponent],
  templateUrl: './cascade.component.html',
  styleUrls: ['./cascade.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    trigger('expandCollapse', [
      transition(':enter', [
        style({ height: 0, opacity: 0, overflow: 'hidden' }),
        animate('200ms ease-out', style({ height: '*', opacity: 1 }))
      ]),
      transition(':leave', [
        style({ height: '*', opacity: 1, overflow: 'hidden' }),
        animate('150ms ease-in', style({ height: 0, opacity: 0 }))
      ])
    ])
  ]
})
export class CascadeComponent {
  private cdr: ChangeDetectorRef;

  constructor(cdr: ChangeDetectorRef) {
    this.cdr = cdr;

    // Emit selection changes (skip initial)
    effect(() => {
      const ids = this.selectedItems();
      if (this.initialized) {
        this.selectionChanged.emit({ count: ids.size, ids });
      } else {
        this.initialized = true;
      }
    }, { allowSignalWrites: true });
  }

  @Input() set groups(value: CascadeGroup[]) {
    console.log('Cascade received groups:', value);
    const expandableGroups = value.map(group => ({
      ...group,
      expanded: group.expanded !== false
    }));
    this.cascadeGroups.set(expandableGroups);
    console.log('Virtual items count:', this.virtualItems().length);
    this.cdr.markForCheck();
  }

  @Input() progressMapper?: (item: CascadeItem) => ItemProgress | null;
  @Input() showStatusIndicator = true;
  @Input() showIcon = true;
  @Input() emptyIcon = '📁';
  @Input() emptyTitle = 'No items';
  @Input() emptyMessage = 'Items will appear here';
  @Input() customContextMenuActions?: ContextMenuAction[];

  @Output() selectionChanged = new EventEmitter<{ count: number; ids: Set<string> }>();
  @Output() itemAction = new EventEmitter<{ action: string; items: CascadeItem[] }>();
  @Output() itemDoubleClick = new EventEmitter<CascadeItem>();

  @ViewChild(CdkVirtualScrollViewport) private viewport?: CdkVirtualScrollViewport;

  cascadeGroups = signal<ExpandableGroup[]>([]);
  selectedItems = signal<Set<string>>(new Set());
  highlightedItemId = signal<string | null>(null);
  selectionAnchorId = signal<string | null>(null);
  contextMenuVisible = signal(false);
  contextMenuPosition = signal<ContextMenuPosition>({ x: 0, y: 0 });
  contextMenuItem = signal<CascadeItem | null>(null);

  // Drag selection state (desktop)
  isDragSelecting = signal(false);
  dragStartPoint = signal<{ x: number; y: number } | null>(null);
  dragCurrentPoint = signal<{ x: number; y: number } | null>(null);
  private dragSelectionInitialSelected = new Set<string>();
  private dragMinDistance = 5;
  private dragHasMoved = false;
  private dragStartClientX = 0;
  private dragStartClientY = 0;
  private justFinishedDrag = false;
  private autoScrollInterval: ReturnType<typeof setInterval> | null = null;
  private autoScrollSpeed = 0;
  private readonly AUTO_SCROLL_ZONE = 50;
  private readonly AUTO_SCROLL_MAX_SPEED = 15;
  private dragMinY = 0;
  private dragMaxY = 0;

  // Touch selection state (mobile)
  private lastTapTime = 0;
  private lastTapItemId: string | null = null;
  private readonly DOUBLE_TAP_DELAY = 300;
  isTouchSelecting = signal(false);
  private touchStartY = 0;
  private touchSelectionAnchorId: string | null = null;
  private justHandledTouch = false;

  selectedCount = computed(() => this.selectedItems().size);
  private initialized = false;

  selectionRect = computed(() => {
    const start = this.dragStartPoint();
    const current = this.dragCurrentPoint();
    if (!start || !current) return null;

    const left = Math.min(start.x, current.x);
    const top = Math.min(start.y, current.y);
    const width = Math.abs(current.x - start.x);
    const height = Math.abs(current.y - start.y);

    return { left, top, width, height };
  });

  // Flattened list for virtual scrolling
  virtualItems = computed<VirtualListItem[]>(() => {
    const items: VirtualListItem[] = [];
    const groups = this.cascadeGroups();

    for (const group of groups) {
      items.push({ type: 'header', group });
      if (group.expanded) {
        for (const item of group.items) {
          const itemId = `${group.label}|${item.id}`;
          items.push({ type: 'item', item, groupLabel: group.label, itemId });
        }
      }
    }
    return items;
  });

  allItemsInOrder = computed<Array<{ itemId: string; item: CascadeItem; groupLabel: string }>>(() => {
    const items: Array<{ itemId: string; item: CascadeItem; groupLabel: string }> = [];
    const groups = this.cascadeGroups();

    for (const group of groups) {
      for (const item of group.items) {
        const itemId = `${group.label}|${item.id}`;
        items.push({ itemId, item, groupLabel: group.label });
      }
    }
    return items;
  });

  // Context menu actions
  contextMenuActions = computed<ContextMenuAction[]>(() => {
    if (this.customContextMenuActions) {
      return this.customContextMenuActions;
    }

    const count = this.selectedCount();
    const countSuffix = count > 1 ? ` (${count})` : '';

    return [
      { label: `Open${countSuffix}`, icon: '▶️', action: 'open' },
      { label: 'Details', icon: 'ℹ️', action: 'details' },
      { label: '', icon: '', action: '', divider: true },
      { label: `Delete${countSuffix}`, icon: '🗑️', action: 'delete' }
    ];
  });

  scrollToTop(): void {
    this.viewport?.scrollToIndex(0, 'smooth');
  }

  scrollToIndex(index: number, behavior: 'auto' | 'smooth' = 'smooth'): void {
    this.viewport?.scrollToIndex(index, behavior);
  }

  getProgress(item: CascadeItem): ItemProgress | null {
    if (!this.progressMapper) return null;
    return this.progressMapper(item);
  }

  isHighlighted(itemId: string): boolean {
    return this.highlightedItemId() === itemId;
  }

  isSelected(itemId: string): boolean {
    return this.selectedItems().has(itemId);
  }

  isSelectionEdgeTop(index: number): boolean {
    const items = this.virtualItems();
    const row = items[index];
    if (!row || row.type !== 'item') return false;

    const itemId = row.itemId;
    const isCurrentActive = this.selectedItems().has(itemId) || this.highlightedItemId() === itemId;
    if (!isCurrentActive) return false;

    for (let i = index - 1; i >= 0; i--) {
      const prevRow = items[i];
      if (prevRow.type === 'item') {
        const isPrevActive = this.selectedItems().has(prevRow.itemId) || this.highlightedItemId() === prevRow.itemId;
        return !isPrevActive;
      }
    }
    return true;
  }

  isSelectionEdgeBottom(index: number): boolean {
    const items = this.virtualItems();
    const row = items[index];
    if (!row || row.type !== 'item') return false;

    const itemId = row.itemId;
    const isCurrentActive = this.selectedItems().has(itemId) || this.highlightedItemId() === itemId;
    if (!isCurrentActive) return false;

    for (let i = index + 1; i < items.length; i++) {
      const nextRow = items[i];
      if (nextRow.type === 'item') {
        const isNextActive = this.selectedItems().has(nextRow.itemId) || this.highlightedItemId() === nextRow.itemId;
        return !isNextActive;
      }
    }
    return true;
  }

  toggleGroup(group: ExpandableGroup, event: Event) {
    event.stopPropagation();
    this.closeContextMenu();
    group.expanded = !group.expanded;
    this.cascadeGroups.set([...this.cascadeGroups()]);
  }

  selectItem(itemId: string, item: CascadeItem, event: MouseEvent) {
    event.stopPropagation();
    this.closeContextMenu();

    const hasModifier = event.ctrlKey || event.metaKey;
    const hasShift = event.shiftKey;

    if (hasModifier && hasShift) {
      this.rangeSelect(itemId, true);
      this.selectionAnchorId.set(itemId);
    } else if (hasModifier) {
      const selected = new Set(this.selectedItems());
      const isDeselecting = selected.has(itemId);

      if (isDeselecting) {
        selected.delete(itemId);
        // Clear highlight if we deselected the highlighted item
        if (this.highlightedItemId() === itemId) {
          // Move highlight to another selected item, or clear it
          const remaining = Array.from(selected);
          this.highlightedItemId.set(remaining.length > 0 ? remaining[remaining.length - 1] : null);
        }
      } else {
        selected.add(itemId);
        this.selectionAnchorId.set(itemId);
        this.highlightedItemId.set(itemId);
      }
      this.selectedItems.set(selected);
    } else if (hasShift && (this.selectionAnchorId() || this.selectedItems().size > 0)) {
      this.rangeSelect(itemId, false);
    } else {
      this.selectedItems.set(new Set([itemId]));
      this.highlightedItemId.set(itemId);
      this.selectionAnchorId.set(itemId);
    }
  }

  rangeSelect(endItemId: string, addToExisting: boolean = false) {
    const allItems = this.virtualItems().filter(item => item.type === 'item') as Array<{ type: 'item'; item: CascadeItem; groupLabel: string; itemId: string }>;

    const anchorId = this.selectionAnchorId();
    const startId = anchorId || Array.from(this.selectedItems())[0];

    if (!startId) return;

    const startIndex = allItems.findIndex(item => item.itemId === startId);
    const endIndex = allItems.findIndex(item => item.itemId === endItemId);

    if (startIndex === -1 || endIndex === -1) return;

    const rangeStart = Math.min(startIndex, endIndex);
    const rangeEnd = Math.max(startIndex, endIndex);

    const selected = addToExisting ? new Set(this.selectedItems()) : new Set<string>();

    for (let i = rangeStart; i <= rangeEnd; i++) {
      selected.add(allItems[i].itemId);
    }

    this.selectedItems.set(selected);
    this.highlightedItemId.set(endItemId);
  }

  handleItemClick(itemId: string, item: CascadeItem, event: MouseEvent): void {
    if (this.justFinishedDrag || this.justHandledTouch) {
      event.stopPropagation();
      this.justHandledTouch = false;
      return;
    }
    this.selectItem(itemId, item, event);
  }

  handleItemDoubleClick(item: CascadeItem, event: MouseEvent): void {
    event.stopPropagation();
    this.itemDoubleClick.emit(item);
  }

  // Touch handling for mobile multi-select
  onTouchStart(itemId: string, item: CascadeItem, event: TouchEvent): void {
    const now = Date.now();
    const touch = event.touches[0];
    this.touchStartY = touch.clientY;

    // Check for double-tap
    if (this.lastTapItemId === itemId && (now - this.lastTapTime) < this.DOUBLE_TAP_DELAY) {
      // Double-tap detected - enter touch selection mode
      event.preventDefault();
      this.isTouchSelecting.set(true);
      this.touchSelectionAnchorId = itemId;

      // Select this item
      const selected = new Set(this.selectedItems());
      selected.add(itemId);
      this.selectedItems.set(selected);
      this.highlightedItemId.set(itemId);

      this.lastTapTime = 0;
      this.lastTapItemId = null;
    } else {
      this.lastTapTime = now;
      this.lastTapItemId = itemId;
    }
  }

  onTouchMove(event: TouchEvent): void {
    if (!this.isTouchSelecting()) return;

    event.preventDefault();
    const touch = event.touches[0];
    const element = document.elementFromPoint(touch.clientX, touch.clientY);

    if (element) {
      const itemEl = element.closest('.cascade-item') as HTMLElement;
      if (itemEl) {
        const itemId = itemEl.getAttribute('data-item-id');
        if (itemId && this.touchSelectionAnchorId) {
          // Select range from anchor to current
          this.selectTouchRange(this.touchSelectionAnchorId, itemId);
        }
      }
    }
  }

  onTouchEnd(itemId: string, item: CascadeItem, event: TouchEvent): void {
    if (this.isTouchSelecting()) {
      // End touch selection mode
      this.isTouchSelecting.set(false);
      this.touchSelectionAnchorId = null;
      this.justHandledTouch = true;
      return;
    }

    // Single tap - if item is selected, deselect it
    if (this.isSelected(itemId)) {
      const selected = new Set(this.selectedItems());
      selected.delete(itemId);
      this.selectedItems.set(selected);
      this.justHandledTouch = true;

      if (this.highlightedItemId() === itemId) {
        const remaining = Array.from(selected);
        this.highlightedItemId.set(remaining.length > 0 ? remaining[remaining.length - 1] : null);
      }
    }
  }

  private selectTouchRange(startId: string, endId: string): void {
    const allItems = this.virtualItems().filter(item => item.type === 'item') as Array<{ type: 'item'; item: CascadeItem; groupLabel: string; itemId: string }>;

    const startIndex = allItems.findIndex(item => item.itemId === startId);
    const endIndex = allItems.findIndex(item => item.itemId === endId);

    if (startIndex === -1 || endIndex === -1) return;

    const rangeStart = Math.min(startIndex, endIndex);
    const rangeEnd = Math.max(startIndex, endIndex);

    const selected = new Set<string>();
    for (let i = rangeStart; i <= rangeEnd; i++) {
      selected.add(allItems[i].itemId);
    }

    this.selectedItems.set(selected);
    this.highlightedItemId.set(endId);
  }

  preventContextMenu(event: Event): void {
    event.preventDefault();
  }

  onContextMenu(itemId: string, item: CascadeItem, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    if (!this.isSelected(itemId)) {
      this.selectedItems.set(new Set([itemId]));
      this.highlightedItemId.set(itemId);
    } else {
      this.highlightedItemId.set(itemId);
    }

    this.contextMenuItem.set(item);
    this.contextMenuPosition.set({ x: event.clientX, y: event.clientY });
    this.contextMenuVisible.set(true);
  }

  onContextMenuAction(action: string) {
    const item = this.contextMenuItem();
    if (!item) return;

    const selectedItems = this.getSelectedItems();
    const items = selectedItems.length > 0 ? selectedItems : [item];

    this.itemAction.emit({ action, items });
    this.closeContextMenu();
  }

  private getSelectedItems(): CascadeItem[] {
    const selectedItemIds = this.selectedItems();
    const allItems = this.virtualItems().filter(item => item.type === 'item') as Array<{ type: 'item'; item: CascadeItem; groupLabel: string; itemId: string }>;

    const itemMap = new Map<string, CascadeItem>();
    for (const item of allItems) {
      if (selectedItemIds.has(item.itemId)) {
        itemMap.set(item.item.id, item.item);
      }
    }

    return Array.from(itemMap.values());
  }

  closeContextMenu() {
    this.contextMenuVisible.set(false);
    this.contextMenuItem.set(null);
  }

  clearSelection() {
    if (this.justFinishedDrag) return;
    this.selectedItems.set(new Set());
    this.highlightedItemId.set(null);
    this.selectionAnchorId.set(null);
    this.closeContextMenu();
  }

  getStatusClass(item: CascadeItem): string {
    switch (item.status) {
      case 'pending': return 'status-pending';
      case 'active': return 'status-active';
      case 'complete': return 'status-complete';
      case 'error': return 'status-error';
      default: return 'status-default';
    }
  }

  // Keyboard navigation
  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }

    const isDelete = event.key === 'Delete';
    const isCmdBackspace = event.key === 'Backspace' && (event.metaKey || event.ctrlKey);

    if (isDelete || isCmdBackspace) {
      const selectedItems = this.getSelectedItems();
      if (selectedItems.length > 0) {
        event.preventDefault();
        this.itemAction.emit({ action: 'delete', items: selectedItems });
      }
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.navigateWithArrowKey(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey);
      return;
    }

    if (event.key === ' ' && !event.ctrlKey && !event.metaKey) {
      const highlightedId = this.highlightedItemId();
      if (highlightedId) {
        event.preventDefault();
        const item = this.getItemByItemId(highlightedId);
        if (item) {
          this.itemAction.emit({ action: 'preview', items: [item] });
        }
      }
      return;
    }

    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      const highlightedId = this.highlightedItemId();
      if (highlightedId) {
        event.preventDefault();
        const item = this.getItemByItemId(highlightedId);
        if (item) {
          this.itemAction.emit({ action: 'open', items: [item] });
        }
      }
      return;
    }

    if (event.key === 'a' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.handleSelectAll();
      return;
    }
  }

  private navigateWithArrowKey(direction: 1 | -1, extendSelection: boolean): void {
    const items = this.allItemsInOrder();
    if (items.length === 0) return;

    const currentId = this.highlightedItemId();
    let currentIndex = currentId ? items.findIndex(item => item.itemId === currentId) : -1;

    if (currentIndex === -1) {
      currentIndex = direction === 1 ? -1 : items.length - 1;
    }

    const newIndex = Math.max(0, Math.min(items.length - 1, currentIndex + direction));

    if (newIndex === currentIndex) return;

    const newItem = items[newIndex];

    if (newItem) {
      this.highlightedItemId.set(newItem.itemId);

      if (extendSelection) {
        const selected = new Set(this.selectedItems());
        selected.add(newItem.itemId);
        this.selectedItems.set(selected);
      } else {
        this.selectedItems.set(new Set([newItem.itemId]));
      }

      this.scrollToItemId(newItem.itemId);
    }
  }

  private scrollToItemId(itemId: string): void {
    const allItems = this.virtualItems();
    const targetIndex = allItems.findIndex(item =>
      item.type === 'item' && item.itemId === itemId
    );
    if (targetIndex < 0 || !this.viewport) return;

    const itemSize = 60;
    const viewportHeight = this.viewport.getViewportSize();
    const currentScroll = this.viewport.measureScrollOffset('top');

    const itemTop = targetIndex * itemSize;
    const itemBottom = itemTop + itemSize;

    const visibleTop = currentScroll;
    const visibleBottom = currentScroll + viewportHeight;
    const margin = itemSize;

    const isFullyVisible = itemTop >= visibleTop + margin && itemBottom <= visibleBottom - margin;

    if (isFullyVisible) return;

    const targetOffset = itemTop - (viewportHeight / 2) + (itemSize / 2);
    const totalContentHeight = allItems.length * itemSize;
    const maxScroll = Math.max(0, totalContentHeight - viewportHeight);
    const scrollOffset = Math.max(0, Math.min(targetOffset, maxScroll));

    this.viewport.scrollToOffset(scrollOffset, 'auto');
  }

  private getItemByItemId(itemId: string): CascadeItem | null {
    const allItems = this.virtualItems().filter(item => item.type === 'item') as Array<{ type: 'item'; item: CascadeItem; groupLabel: string; itemId: string }>;
    const found = allItems.find(item => item.itemId === itemId);
    return found?.item || null;
  }

  private handleSelectAll(): void {
    const allItems = this.virtualItems();
    const itemItems = allItems.filter(item => item.type === 'item') as Array<{ type: 'item'; item: CascadeItem; groupLabel: string; itemId: string }>;

    if (itemItems.length === 0) return;

    const allItemIds = new Set(itemItems.map(item => item.itemId));
    this.selectedItems.set(allItemIds);
  }

  highlightAndScrollToItemId(itemId: string): void {
    const allItems = this.virtualItems().filter(item => item.type === 'item') as Array<{ type: 'item'; item: CascadeItem; groupLabel: string; itemId: string }>;
    const found = allItems.find(item => item.item.id === itemId);

    if (found) {
      this.highlightedItemId.set(found.itemId);
      this.selectedItems.set(new Set([found.itemId]));
      this.scrollToItemId(found.itemId);
    }
  }

  // Drag selection methods
  onDragSelectStart(event: MouseEvent): void {
    if (event.button !== 0) return;

    const target = event.target as HTMLElement;
    if (target.closest('button') || target.closest('.group-header')) {
      return;
    }

    this.dragStartClientX = event.clientX;
    this.dragStartClientY = event.clientY;
    this.dragHasMoved = false;

    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      this.dragSelectionInitialSelected = new Set(this.selectedItems());
    } else {
      this.dragSelectionInitialSelected = new Set();
    }

    const container = event.currentTarget as HTMLElement;
    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const contentWrapper = container.querySelector('.cdk-virtual-scroll-content-wrapper');
    if (contentWrapper && this.viewport) {
      const contentRect = contentWrapper.getBoundingClientRect();
      const renderedRange = this.viewport.getRenderedRange();
      const itemSize = 60;
      const scrollSpaceY = (event.clientY - contentRect.top) + (renderedRange.start * itemSize);
      this.dragMinY = scrollSpaceY;
      this.dragMaxY = scrollSpaceY;
    }

    this.dragStartPoint.set({ x, y });
    this.dragCurrentPoint.set({ x, y });

    document.addEventListener('mousemove', this.onDragSelectMove);
    document.addEventListener('mouseup', this.onDragSelectEnd);
  }

  private onDragSelectMove = (event: MouseEvent): void => {
    const start = this.dragStartPoint();
    if (!start) return;

    const dx = event.clientX - this.dragStartClientX;
    const dy = event.clientY - this.dragStartClientY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (!this.dragHasMoved && distance >= this.dragMinDistance) {
      this.dragHasMoved = true;
      this.isDragSelecting.set(true);

      if (this.dragSelectionInitialSelected.size === 0) {
        this.selectedItems.set(new Set());
      }

      this.startAutoScroll();
    }

    if (!this.dragHasMoved) return;

    const container = document.querySelector('.cascade') as HTMLElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    this.dragCurrentPoint.set({ x, y });

    const viewportEl = container.querySelector('cdk-virtual-scroll-viewport');
    const contentWrapper = container.querySelector('.cdk-virtual-scroll-content-wrapper');
    if (viewportEl && contentWrapper && this.viewport) {
      const viewportRect = viewportEl.getBoundingClientRect();
      const contentRect = contentWrapper.getBoundingClientRect();
      const renderedRange = this.viewport.getRenderedRange();
      const itemSize = 60;
      const mouseY = event.clientY;

      const scrollSpaceY = (mouseY - contentRect.top) + (renderedRange.start * itemSize);
      this.dragMinY = Math.min(this.dragMinY, scrollSpaceY);
      this.dragMaxY = Math.max(this.dragMaxY, scrollSpaceY);

      if (mouseY < viewportRect.top + this.AUTO_SCROLL_ZONE) {
        const distanceFromEdge = viewportRect.top + this.AUTO_SCROLL_ZONE - mouseY;
        this.autoScrollSpeed = -Math.min(distanceFromEdge / 2, this.AUTO_SCROLL_MAX_SPEED);
      } else if (mouseY > viewportRect.bottom - this.AUTO_SCROLL_ZONE) {
        const distanceFromEdge = mouseY - (viewportRect.bottom - this.AUTO_SCROLL_ZONE);
        this.autoScrollSpeed = Math.min(distanceFromEdge / 2, this.AUTO_SCROLL_MAX_SPEED);
      } else {
        this.autoScrollSpeed = 0;
      }
    }

    this.updateDragSelection();
  };

  private startAutoScroll(): void {
    if (this.autoScrollInterval) return;

    this.autoScrollInterval = setInterval(() => {
      if (this.autoScrollSpeed === 0 || !this.viewport) return;

      const currentScroll = this.viewport.measureScrollOffset('top');
      const newScroll = currentScroll + this.autoScrollSpeed;
      this.viewport.scrollTo({ top: Math.max(0, newScroll) });

      if (this.autoScrollSpeed > 0) {
        this.dragMaxY += this.autoScrollSpeed;
      } else {
        this.dragMinY += this.autoScrollSpeed;
      }

      const current = this.dragCurrentPoint();
      if (current) {
        this.dragCurrentPoint.set({ x: current.x, y: current.y + this.autoScrollSpeed });
        this.updateDragSelection();
      }
    }, 16);
  }

  private stopAutoScroll(): void {
    if (this.autoScrollInterval) {
      clearInterval(this.autoScrollInterval);
      this.autoScrollInterval = null;
    }
    this.autoScrollSpeed = 0;
  }

  private onDragSelectEnd = (): void => {
    const wasDragging = this.dragHasMoved;

    this.stopAutoScroll();

    this.isDragSelecting.set(false);
    this.dragStartPoint.set(null);
    this.dragCurrentPoint.set(null);
    this.dragSelectionInitialSelected = new Set();
    this.dragHasMoved = false;

    if (wasDragging) {
      this.justFinishedDrag = true;
      setTimeout(() => {
        this.justFinishedDrag = false;
      }, 0);
    }

    document.removeEventListener('mousemove', this.onDragSelectMove);
    document.removeEventListener('mouseup', this.onDragSelectEnd);
  };

  private updateDragSelection(): void {
    if (!this.isDragSelecting()) return;

    const itemSize = 60;
    const allItems = this.virtualItems();
    const newSelection = new Set(this.dragSelectionInitialSelected);

    let currentY = 0;
    for (const item of allItems) {
      if (item.type === 'item') {
        const itemTop = currentY;
        const itemBottom = currentY + itemSize;

        if (itemBottom > this.dragMinY && itemTop < this.dragMaxY) {
          if (this.dragSelectionInitialSelected.has(item.itemId)) {
            newSelection.delete(item.itemId);
          } else {
            newSelection.add(item.itemId);
          }
        }
      }
      currentY += itemSize;
    }

    this.selectedItems.set(newSelection);
  }

  trackItem(index: number, item: VirtualListItem): string {
    if (item.type === 'header') {
      return `header-${item.group.label}`;
    }
    return `item-${item.itemId}`;
  }
}
