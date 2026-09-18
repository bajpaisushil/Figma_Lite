/**
 * The history manager.
 *
 * Commands are pure `Document → Document`, and every command clones only the
 * nodes it touches. That single invariant means undo does not need each command
 * to hand-write an inverse: comparing the before and after documents *by
 * reference* yields the exact set of nodes that changed, and storing both sides
 * of those nodes gives a patch that can be applied in either direction.
 *
 *   - One mechanism covers property edits, insertion, deletion, reparenting and
 *     grouping alike, so a new command gets undo for free and cannot get it wrong.
 *   - A patch is O(changed nodes), not O(document) — dragging one rectangle
 *     around a 5,000-node file stores one node per history entry.
 *
 * Selection is stored alongside each patch, because undo that restores geometry
 * but leaves a stale selection feels broken.
 */

import type { Document, NodeId, SceneNode } from "./types.ts";

/** `null` means "the node did not exist on this side of the edit". */
export type NodeSide = Record<NodeId, SceneNode | null>;

export interface Patch {
  label: string;
  before: NodeSide;
  after: NodeSide;
  selectionBefore: NodeId[];
  selectionAfter: NodeId[];
  /** Used to decide whether a follow-up edit may be merged into this one. */
  timestamp: number;
  /** Opaque tag; only patches sharing a non-null tag may coalesce. */
  mergeKey: string | null;
}

export interface HistoryState {
  doc: Document;
  selection: NodeId[];
}

/** Reference-compares two documents and returns the changed nodes, or null. */
export function diffDocuments(before: Document, after: Document): { before: NodeSide; after: NodeSide } | null {
  if (before === after) return null;
  const beforeSide: NodeSide = {};
  const afterSide: NodeSide = {};
  let changed = false;

  const ids = new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)]);
  for (const id of ids) {
    const a = before.nodes[id] ?? null;
    const b = after.nodes[id] ?? null;
    if (a === b) continue;
    beforeSide[id] = a;
    afterSide[id] = b;
    changed = true;
  }
  return changed ? { before: beforeSide, after: afterSide } : null;
}

/** Applies one side of a patch, adding, replacing and removing nodes as needed. */
export function applySide(doc: Document, side: NodeSide): Document {
  const nodes: Record<NodeId, SceneNode> = { ...doc.nodes };
  for (const [id, node] of Object.entries(side)) {
    if (node === null) delete nodes[id];
    else nodes[id] = node;
  }
  return { ...doc, nodes };
}

export interface HistoryOptions {
  /** Entries beyond this are dropped from the bottom of the undo stack. */
  limit?: number;
  /** Window in which two same-key edits merge into one entry. */
  coalesceWindowMs?: number;
}

export class History {
  private undoStack: Patch[] = [];
  private redoStack: Patch[] = [];
  private readonly limit: number;
  private readonly coalesceWindowMs: number;
  private listeners = new Set<() => void>();

  /** Depth of open `transact` calls; only the outermost one records a patch. */
  private transactionDepth = 0;

  constructor(options: HistoryOptions = {}) {
    this.limit = options.limit ?? 200;
    this.coalesceWindowMs = options.coalesceWindowMs ?? 450;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  get depth(): number {
    return this.undoStack.length;
  }

  /** True while a `transact` is open — used to suppress redundant bookkeeping. */
  get isTransacting(): boolean {
    return this.transactionDepth > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  /**
   * Records the transition from `before` to `after` as one undoable entry.
   * Returns false when nothing actually changed, so callers can skip repainting.
   */
  record(
    label: string,
    before: HistoryState,
    after: HistoryState,
    mergeKey: string | null = null,
  ): boolean {
    const delta = diffDocuments(before.doc, after.doc);
    const selectionChanged = !sameIds(before.selection, after.selection);
    if (!delta && !selectionChanged) return false;
    // A pure selection change is not worth a history entry on its own.
    if (!delta) return false;

    const now = Date.now();
    const top = this.undoStack.at(-1);

    // Merge rapid same-key edits (holding an arrow key, dragging a slider) so
    // undo steps back in meaningful units rather than one pixel at a time.
    if (
      top &&
      mergeKey !== null &&
      top.mergeKey === mergeKey &&
      now - top.timestamp <= this.coalesceWindowMs
    ) {
      for (const [id, node] of Object.entries(delta.before)) {
        if (!(id in top.before)) top.before[id] = node;
      }
      Object.assign(top.after, delta.after);
      top.selectionAfter = [...after.selection];
      top.timestamp = now;
      this.redoStack = [];
      this.emit();
      return true;
    }

    this.undoStack.push({
      label,
      before: delta.before,
      after: delta.after,
      selectionBefore: [...before.selection],
      selectionAfter: [...after.selection],
      timestamp: now,
      mergeKey,
    });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
    return true;
  }

  undo(state: HistoryState): HistoryState | null {
    const patch = this.undoStack.pop();
    if (!patch) return null;
    this.redoStack.push(patch);
    this.emit();
    const doc = applySide(state.doc, patch.before);
    return { doc, selection: patch.selectionBefore.filter((id) => id in doc.nodes) };
  }

  redo(state: HistoryState): HistoryState | null {
    const patch = this.redoStack.pop();
    if (!patch) return null;
    this.undoStack.push(patch);
    this.emit();
    const doc = applySide(state.doc, patch.after);
    return { doc, selection: patch.selectionAfter.filter((id) => id in doc.nodes) };
  }

  /** Opens a nesting level; `record` is expected once the outermost one closes. */
  beginTransaction(): void {
    this.transactionDepth += 1;
  }

  endTransaction(): boolean {
    this.transactionDepth = Math.max(0, this.transactionDepth - 1);
    return this.transactionDepth === 0;
  }
}

export function sameIds(a: readonly NodeId[], b: readonly NodeId[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
