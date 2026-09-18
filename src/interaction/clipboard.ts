/**
 * Copy / cut / paste / duplicate.
 *
 * The payload is the same JSON the file format uses, restricted to the copied
 * subtrees. That means a copy can be pasted into another tab, kept in a text
 * file, or inspected by hand — and it costs nothing extra, since import already
 * has to be defensive about arbitrary input.
 *
 * The system clipboard is best-effort: it needs permission and a user gesture,
 * and it is unavailable over plain HTTP. An in-memory clipboard always backs it
 * up so copy/paste never silently does nothing.
 */

import type { Document, NodeId } from "../core/types.ts";
import { isContainer } from "../core/types.ts";
import type { Editor } from "../core/editor.ts";
import { cloneNodes, deleteNodes, insertNode, translateNodes } from "../core/commands.ts";
import { descendantsOf, newId, sortByPaintOrder, topmostIds, unionWorldBounds } from "../core/document.ts";
import { deserialize, serialize } from "../core/serialize.ts";
import { createNode } from "../core/factory.ts";

const MIME = "application/x-figma-lite+json";

interface ClipboardPayload {
  kind: typeof MIME;
  roots: NodeId[];
  document: ReturnType<typeof serialize>;
}

/** Survives across paste calls so repeated pastes cascade instead of stacking. */
let memory: string | null = null;
let pasteCount = 0;

export const PASTE_OFFSET = 16;

/** Builds a self-contained payload for the given subtrees. */
export function buildPayload(doc: Document, ids: Iterable<NodeId>): string | null {
  const roots = sortByPaintOrder(doc, topmostIds(doc, ids)).filter((id) => id !== doc.root);
  if (roots.length === 0) return null;

  // Collect the roots plus every descendant, so the payload is closed.
  const keep = new Set<NodeId>();
  for (const id of roots) {
    keep.add(id);
    for (const d of descendantsOf(doc, id)) keep.add(d.id);
  }

  const subset: Record<NodeId, (typeof doc.nodes)[string]> = {};
  for (const id of keep) {
    const node = doc.nodes[id];
    if (!node) continue;
    // Detach the copied roots so they import as top-level nodes.
    subset[id] = roots.includes(id) ? ({ ...node, parent: null } as typeof node) : node;
  }

  const payload: ClipboardPayload = {
    kind: MIME,
    roots,
    document: serialize({ nodes: subset, root: doc.root }),
  };
  return JSON.stringify(payload);
}

export async function copySelection(editor: Editor): Promise<boolean> {
  const text = buildPayload(editor.doc, editor.selection);
  if (!text) return false;
  memory = text;
  pasteCount = 0;
  await writeSystemClipboard(text);
  return true;
}

export async function cutSelection(editor: Editor): Promise<boolean> {
  const ok = await copySelection(editor);
  if (!ok) return false;
  const ids = [...editor.selection];
  editor.commit("Cut", (doc) => deleteNodes(doc, ids));
  editor.clearSelection();
  return true;
}

/**
 * Pastes into `parentId`. Prefers the system clipboard so cross-tab copy works,
 * and falls back to the in-memory copy when the browser denies access.
 */
export async function paste(editor: Editor, parentId: NodeId, at?: { x: number; y: number }): Promise<boolean> {
  const text = (await readSystemClipboard()) ?? memory;
  if (!text) return false;

  const payload = parsePayload(text);
  if (!payload) return false;

  let result;
  try {
    result = deserialize(payload.document);
  } catch {
    return false;
  }

  const source = result.doc;
  const sourceRoots = (source.nodes[source.root] as { children: readonly NodeId[] }).children;
  if (sourceRoots.length === 0) return false;

  // Re-id everything so pasting into the *same* document cannot collide.
  const idMap = new Map<NodeId, NodeId>();
  for (const id of Object.keys(source.nodes)) {
    if (id !== source.root) idMap.set(id, newId("p"));
  }

  pasteCount += 1;
  const bounds = unionWorldBounds(source, sourceRoots);
  const offset = at && bounds
    ? { x: at.x - bounds.x - bounds.w / 2, y: at.y - bounds.y - bounds.h / 2 }
    : { x: PASTE_OFFSET * pasteCount, y: PASTE_OFFSET * pasteCount };

  const newIds: NodeId[] = [];
  editor.commit("Paste", (doc) => {
    let next = doc;

    const insertSubtree = (sourceId: NodeId, targetParent: NodeId): void => {
      const node = source.nodes[sourceId];
      if (!node) return;
      const mapped = idMap.get(sourceId)!;
      const cloned = isContainer(node)
        ? { ...node, id: mapped, parent: targetParent, children: [] }
        : { ...node, id: mapped, parent: targetParent };
      next = insertNode(next, cloned, { parent: targetParent });
      if (isContainer(node)) {
        for (const childId of node.children) insertSubtree(childId, mapped);
      }
    };

    for (const rootId of sourceRoots) {
      insertSubtree(rootId, parentId);
      const mapped = idMap.get(rootId);
      if (mapped) newIds.push(mapped);
    }
    return translateNodes(next, newIds, offset.x, offset.y);
  });

  editor.setSelection(newIds);
  return newIds.length > 0;
}

/** Ctrl/Cmd+D — clone in place with a small offset, ready to be nudged. */
export function duplicateSelection(editor: Editor): boolean {
  if (editor.selection.length === 0) return false;
  const ids = [...editor.selection];
  let created: NodeId[] = [];

  editor.commit("Duplicate", (doc) => {
    const result = cloneNodes(doc, ids, { offsetX: PASTE_OFFSET, offsetY: PASTE_OFFSET });
    created = result.ids;
    return result.doc;
  });

  if (created.length) editor.setSelection(created);
  return created.length > 0;
}

/** Turns a pasted or dropped image file into an image node. */
export async function insertImageFile(
  editor: Editor,
  file: File,
  parentId: NodeId,
  at: { x: number; y: number },
): Promise<boolean> {
  if (!file.type.startsWith("image/")) return false;

  const dataUrl = await readAsDataURL(file);
  const size = await imageSize(dataUrl);
  // Cap the initial size so a 4000px photo does not fill the whole canvas.
  const scale = Math.min(1, 400 / Math.max(size.w, size.h));
  const w = Math.max(1, Math.round(size.w * scale));
  const h = Math.max(1, Math.round(size.h * scale));

  const node = createNode("image", {
    name: file.name.replace(/\.[^.]+$/, "") || "Image",
    box: { x: at.x - w / 2, y: at.y - h / 2, w, h },
  });

  editor.commit("Insert image", (doc) =>
    insertNode(doc, { ...node, src: dataUrl, fit: "cover" } as typeof node, { parent: parentId }),
  );
  editor.setSelection([node.id]);
  return true;
}

function parsePayload(text: string): ClipboardPayload | null {
  try {
    const parsed = JSON.parse(text) as ClipboardPayload;
    if (parsed && parsed.kind === MIME && parsed.document) return parsed;
  } catch {
    // Not our payload — plain text on the clipboard is not an error.
  }
  return null;
}

async function writeSystemClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // Permission denied or insecure context; the in-memory copy still works.
  }
}

async function readSystemClipboard(): Promise<string | null> {
  try {
    const text = await navigator.clipboard?.readText();
    return text && parsePayload(text) ? text : null;
  } catch {
    return null;
  }
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function imageSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 200, h: 200 });
    img.src = src;
  });
}

/** Lets the paste cascade restart when the user copies something new. */
export function resetPasteCascade(): void {
  pasteCount = 0;
}
