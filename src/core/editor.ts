/**
 * The editor store: the single source of truth the UI, renderer and interaction
 * engine all read from.
 *
 * It owns four pieces of state — document, selection, viewport, active tool —
 * and mediates every write to them so that history and repaint scheduling
 * happen in exactly one place.
 *
 * Two ways to change the document:
 *
 *   `commit(label, fn)`        one-shot edit, one history entry.
 *   `begin() / live() / end()` a drag: many intermediate documents, but only
 *                              the net change from begin to end is recorded.
 *
 * The drag path is what keeps a 300-frame move gesture from producing 300
 * undo steps, without the interaction code having to think about history.
 */

import type { Document, NodeId, SceneNode } from "./types.ts";
import { History, type HistoryState } from "./history.ts";
import { emptyDocument, unionWorldBounds, deepWorldBounds } from "./document.ts";
import {
  type Viewport,
  createViewport,
  fitToRect,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from "./viewport.ts";
import type { Vec2, Rect } from "./math.ts";

export type ToolId = "select" | "hand" | "frame" | "rect" | "ellipse" | "text" | "image";

/** What changed, so listeners can skip work they do not need. */
export interface ChangeFlags {
  document: boolean;
  selection: boolean;
  viewport: boolean;
  tool: boolean;
  history: boolean;
  /** Transient UI state: hover, snap guides, in-flight gesture. */
  overlay: boolean;
}

const NO_CHANGE: ChangeFlags = {
  document: false,
  selection: false,
  viewport: false,
  tool: false,
  history: false,
  overlay: false,
};

export type ChangeListener = (flags: ChangeFlags, editor: Editor) => void;

export class Editor {
  doc: Document = emptyDocument();
  selection: NodeId[] = [];
  viewport: Viewport = createViewport();
  tool: ToolId = "select";
  hoverId: NodeId | null = null;
  readonly history = new History();

  /** Snapshot taken at `begin()`, used to record or roll back a whole gesture. */
  private gestureStart: HistoryState | null = null;
  private gestureLabel = "";

  private listeners = new Set<ChangeListener>();
  private pending: ChangeFlags = { ...NO_CHANGE };
  private flushScheduled = false;

  constructor() {
    this.history.onChange(() => this.markChanged({ history: true }));
  }

  // --- Subscription ---------------------------------------------------------

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Coalesces notifications to one per animation frame. A drag that touches
   * document and overlay 60 times a second still wakes the UI layer once a frame.
   */
  markChanged(flags: Partial<ChangeFlags>): void {
    Object.assign(this.pending, flags);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      const outgoing = this.pending;
      this.pending = { ...NO_CHANGE };
      for (const listener of this.listeners) listener(outgoing, this);
    });
  }

  private snapshot(): HistoryState {
    return { doc: this.doc, selection: [...this.selection] };
  }

  // --- Document edits -------------------------------------------------------

  /**
   * Applies a pure document transform and records one undo entry.
   * `mergeKey` lets rapid repeats (arrow-key nudges) collapse into one step.
   */
  commit(label: string, fn: (doc: Document) => Document, mergeKey: string | null = null): boolean {
    const before = this.snapshot();
    const next = fn(this.doc);
    if (next === this.doc) return false;
    this.doc = next;
    this.pruneSelection();
    const recorded = this.history.record(label, before, this.snapshot(), mergeKey);
    this.markChanged({ document: true, selection: true, history: recorded });
    return recorded;
  }

  /** Begins a gesture. Everything until `end()` collapses into one history entry. */
  begin(label: string): void {
    if (this.gestureStart) return;
    this.gestureStart = this.snapshot();
    this.gestureLabel = label;
    this.history.beginTransaction();
  }

  get isGestureActive(): boolean {
    return this.gestureStart !== null;
  }

  /** Applies an intermediate state during a gesture without touching history. */
  live(fn: (doc: Document) => Document): void {
    const next = fn(this.doc);
    if (next === this.doc) return;
    this.doc = next;
    this.markChanged({ document: true });
  }

  /** Closes a gesture, recording the net change since `begin()`. */
  end(labelOverride?: string): boolean {
    const start = this.gestureStart;
    if (!start) return false;
    this.gestureStart = null;
    this.history.endTransaction();
    this.pruneSelection();
    const recorded = this.history.record(labelOverride ?? this.gestureLabel, start, this.snapshot());
    this.markChanged({ document: true, selection: true, history: recorded });
    return recorded;
  }

  /** Abandons a gesture, restoring the document captured at `begin()`. */
  cancel(): void {
    const start = this.gestureStart;
    if (!start) return;
    this.gestureStart = null;
    this.history.endTransaction();
    this.doc = start.doc;
    this.selection = [...start.selection];
    this.markChanged({ document: true, selection: true });
  }

  /** Replaces the document outright (import, new file). Clears history. */
  load(doc: Document, selection: NodeId[] = []): void {
    this.gestureStart = null;
    this.doc = doc;
    this.selection = selection.filter((id) => id in doc.nodes);
    this.history.clear();
    this.markChanged({ document: true, selection: true, history: true });
  }

  undo(): boolean {
    const next = this.history.undo(this.snapshot());
    if (!next) return false;
    this.doc = next.doc;
    this.selection = next.selection;
    this.markChanged({ document: true, selection: true, history: true });
    return true;
  }

  redo(): boolean {
    const next = this.history.redo(this.snapshot());
    if (!next) return false;
    this.doc = next.doc;
    this.selection = next.selection;
    this.markChanged({ document: true, selection: true, history: true });
    return true;
  }

  // --- Selection ------------------------------------------------------------

  private pruneSelection(): void {
    const kept = this.selection.filter((id) => id in this.doc.nodes);
    if (kept.length !== this.selection.length) this.selection = kept;
  }

  setSelection(ids: Iterable<NodeId>): void {
    const next = [...new Set(ids)].filter((id) => id in this.doc.nodes && id !== this.doc.root);
    if (next.length === this.selection.length && next.every((id, i) => this.selection[i] === id)) return;
    this.selection = next;
    this.markChanged({ selection: true });
  }

  addToSelection(ids: Iterable<NodeId>): void {
    this.setSelection([...this.selection, ...ids]);
  }

  toggleSelection(id: NodeId): void {
    this.selection.includes(id)
      ? this.setSelection(this.selection.filter((s) => s !== id))
      : this.setSelection([...this.selection, id]);
  }

  clearSelection(): void {
    this.setSelection([]);
  }

  isSelected(id: NodeId): boolean {
    return this.selection.includes(id);
  }

  get selectedNodes(): SceneNode[] {
    return this.selection.map((id) => this.doc.nodes[id]).filter(Boolean) as SceneNode[];
  }

  /** World-space bounds of the current selection, or null when empty. */
  get selectionBounds(): Rect | null {
    return unionWorldBounds(this.doc, this.selection);
  }

  setHover(id: NodeId | null): void {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.markChanged({ overlay: true });
  }

  // --- Tool -----------------------------------------------------------------

  setTool(tool: ToolId): void {
    if (this.tool === tool) return;
    this.tool = tool;
    this.markChanged({ tool: true, overlay: true });
  }

  // --- Viewport -------------------------------------------------------------

  setViewport(v: Partial<Viewport>): void {
    this.viewport = { ...this.viewport, ...v };
    this.markChanged({ viewport: true });
  }

  panBy(dx: number, dy: number): void {
    this.setViewport({ panX: this.viewport.panX + dx, panY: this.viewport.panY + dy });
  }

  zoomAtPoint(screenPoint: Vec2, zoom: number): void {
    this.viewport = zoomAt(this.viewport, screenPoint, zoom);
    this.markChanged({ viewport: true });
  }

  zoomBy(factor: number, screenPoint?: Vec2): void {
    const at = screenPoint ?? { x: this.viewport.width / 2, y: this.viewport.height / 2 };
    this.zoomAtPoint(at, this.viewport.zoom * factor);
  }

  zoomToFit(ids?: Iterable<NodeId>): void {
    const targets = ids ? [...ids] : (this.doc.nodes[this.doc.root] as { children: readonly NodeId[] }).children;
    if (targets.length === 0) {
      this.setViewport({ panX: this.viewport.width / 2, panY: this.viewport.height / 2, zoom: 1 });
      return;
    }
    let bounds: Rect | null = null;
    for (const id of targets) {
      const b = deepWorldBounds(this.doc, id);
      bounds = bounds
        ? {
            x: Math.min(bounds.x, b.x),
            y: Math.min(bounds.y, b.y),
            w: Math.max(bounds.x + bounds.w, b.x + b.w) - Math.min(bounds.x, b.x),
            h: Math.max(bounds.y + bounds.h, b.y + b.h) - Math.min(bounds.y, b.y),
          }
        : b;
    }
    if (!bounds) return;
    this.viewport = fitToRect(this.viewport, bounds);
    this.markChanged({ viewport: true });
  }

  toWorld(p: Vec2): Vec2 {
    return screenToWorld(this.viewport, p);
  }

  toScreen(p: Vec2): Vec2 {
    return worldToScreen(this.viewport, p);
  }
}
