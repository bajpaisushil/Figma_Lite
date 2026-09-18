/**
 * Editor actions.
 *
 * Every user-facing verb lives here exactly once, so the toolbar, the layers
 * panel context menu and the keyboard all trigger identical behaviour. Keeping
 * them out of the key handler is what stops "it works from the menu but not the
 * shortcut" bugs.
 */

import type { NodeId } from "../core/types.ts";
import { isContainer } from "../core/types.ts";
import type { Editor } from "../core/editor.ts";
import type { InteractionEngine } from "./tools.ts";
import {
  type AlignAxis,
  type ZMove,
  alignNodes,
  deleteNodes,
  distributeNodes,
  groupNodes,
  reorderNode,
  translateNodes,
  ungroupNodes,
  updateNodes,
} from "../core/commands.ts";
import { topmostIds } from "../core/document.ts";
import { copySelection, cutSelection, duplicateSelection, paste, resetPasteCascade } from "./clipboard.ts";

export interface ActionContext {
  editor: Editor;
  engine: InteractionEngine;
  /** Where a paste with no explicit position should land. */
  viewportCenterWorld: () => { x: number; y: number };
  exportJSON: () => void;
  importJSON: () => void;
  toast: (message: string) => void;
}

export const NUDGE_SMALL = 1;
export const NUDGE_LARGE = 10;

export function deleteSelection(ctx: ActionContext): void {
  const { editor } = ctx;
  if (editor.selection.length === 0) return;
  const ids = [...editor.selection];
  editor.commit("Delete", (doc) => deleteNodes(doc, ids));
  editor.clearSelection();
}

export function nudge(ctx: ActionContext, dx: number, dy: number): void {
  const { editor } = ctx;
  if (editor.selection.length === 0) return;
  const ids = [...editor.selection];
  // A shared merge key collapses a burst of arrow presses into one undo step.
  editor.commit("Nudge", (doc) => translateNodes(doc, ids, dx, dy), "nudge");
}

export function group(ctx: ActionContext): void {
  const { editor } = ctx;
  if (editor.selection.length < 2) return;
  const ids = [...editor.selection];
  let created: NodeId | null = null;
  editor.commit("Group", (doc) => {
    const result = groupNodes(doc, ids);
    created = result.groupId;
    return result.doc;
  });
  if (created) editor.setSelection([created]);
}

export function ungroup(ctx: ActionContext): void {
  const { editor } = ctx;
  const groups = editor.selection.filter((id) => editor.doc.nodes[id]?.type === "group");
  if (groups.length === 0) return;

  let released: NodeId[] = [];
  editor.commit("Ungroup", (doc) => {
    const result = ungroupNodes(doc, groups);
    released = result.released;
    return result.doc;
  });
  if (released.length) editor.setSelection(released);
}

export function reorder(ctx: ActionContext, move: ZMove): void {
  const { editor } = ctx;
  if (editor.selection.length === 0) return;
  const ids = topmostIds(editor.doc, editor.selection);
  editor.commit(`Bring ${move}`, (doc) => {
    let next = doc;
    // Moving forward/front must process the topmost node first, or earlier
    // moves would displace the ones that follow.
    const order = move === "front" || move === "forward" ? [...ids].reverse() : ids;
    for (const id of order) next = reorderNode(next, id, move);
    return next;
  });
}

export function align(ctx: ActionContext, axis: AlignAxis): void {
  const { editor } = ctx;
  if (editor.selection.length === 0) return;
  const ids = [...editor.selection];
  editor.commit("Align", (doc) => alignNodes(doc, ids, axis));
}

export function distribute(ctx: ActionContext, axis: "h" | "v"): void {
  const { editor } = ctx;
  if (editor.selection.length < 3) return;
  const ids = [...editor.selection];
  editor.commit("Distribute", (doc) => distributeNodes(doc, ids, axis));
}

export function selectAll(ctx: ActionContext): void {
  const { editor, engine } = ctx;
  const scope = editor.doc.nodes[engine.scopeId];
  if (!scope || !isContainer(scope)) return;
  editor.setSelection(scope.children.filter((id) => !editor.doc.nodes[id]?.locked));
}

export function deselectOrExitScope(ctx: ActionContext): void {
  const { editor, engine } = ctx;
  if (editor.selection.length > 0) {
    editor.clearSelection();
    return;
  }
  engine.exitScope();
}

export function toggleVisibility(ctx: ActionContext): void {
  const { editor } = ctx;
  if (editor.selection.length === 0) return;
  const nodes = editor.selectedNodes;
  const makeVisible = nodes.some((n) => !n.visible);
  const patches = Object.fromEntries(nodes.map((n) => [n.id, { visible: makeVisible }]));
  editor.commit(makeVisible ? "Show" : "Hide", (doc) => updateNodes(doc, patches));
}

export function toggleLock(ctx: ActionContext): void {
  const { editor } = ctx;
  if (editor.selection.length === 0) return;
  const nodes = editor.selectedNodes;
  const lock = nodes.some((n) => !n.locked);
  const patches = Object.fromEntries(nodes.map((n) => [n.id, { locked: lock }]));
  editor.commit(lock ? "Lock" : "Unlock", (doc) => updateNodes(doc, patches));
  if (lock) editor.clearSelection();
}

export async function copy(ctx: ActionContext): Promise<void> {
  if (await copySelection(ctx.editor)) ctx.toast("Copied");
}

export async function cut(ctx: ActionContext): Promise<void> {
  if (await cutSelection(ctx.editor)) ctx.toast("Cut");
}

export async function pasteHere(ctx: ActionContext): Promise<void> {
  const ok = await paste(ctx.editor, ctx.engine.scopeId);
  if (!ok) ctx.toast("Nothing to paste");
}

export function duplicate(ctx: ActionContext): void {
  resetPasteCascade();
  duplicateSelection(ctx.editor);
}

export function zoomIn(ctx: ActionContext): void {
  ctx.editor.zoomBy(1.2);
}

export function zoomOut(ctx: ActionContext): void {
  ctx.editor.zoomBy(1 / 1.2);
}

export function zoomReset(ctx: ActionContext): void {
  const { editor } = ctx;
  editor.zoomAtPoint({ x: editor.viewport.width / 2, y: editor.viewport.height / 2 }, 1);
}

export function zoomFit(ctx: ActionContext): void {
  ctx.editor.zoomToFit();
}

export function zoomToSelection(ctx: ActionContext): void {
  const { editor } = ctx;
  if (editor.selection.length === 0) return zoomFit(ctx);
  editor.zoomToFit(editor.selection);
}

export function toggleSnapping(ctx: ActionContext): void {
  ctx.engine.snapEnabled = !ctx.engine.snapEnabled;
  ctx.toast(ctx.engine.snapEnabled ? "Snapping on" : "Snapping off");
}
