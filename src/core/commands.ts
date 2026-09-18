/**
 * The command system.
 *
 * Every edit the editor can make is expressed here as a pure function
 * `(Document, args) => Document`. Commands never touch selection, viewport,
 * history or the DOM — that separation is what makes undo, scripting and the
 * JSON round-trip fall out for free.
 *
 * Commands clone only the nodes they change, so the history layer can compute
 * an undo patch by reference-comparing two documents (see `history.ts`).
 */

import {
  type ContainerNode,
  type Document,
  type NodeId,
  type SceneNode,
  isContainer,
} from "./types.ts";
import {
  ROOT_ID,
  ancestorsOf,
  defaultName,
  descendantsOf,
  getContainer,
  isAncestorOf,
  localTransform,
  newId,
  sortByPaintOrder,
  topmostIds,
  unionWorldBounds,
  worldTransform,
} from "./document.ts";
import { type Mat, IDENTITY, apply, applyVector, invert, matRotation, mul, normalizeAngle, rotation } from "./math.ts";

/** Nodes may never collapse to zero area — that would make their matrix singular. */
export const MIN_SIZE = 0.01;

/** Replaces nodes wholesale, preserving structural sharing for everything else. */
function withNodes(doc: Document, changed: Record<NodeId, SceneNode | null>): Document {
  const nodes: Record<NodeId, SceneNode> = { ...doc.nodes };
  for (const [id, node] of Object.entries(changed)) {
    if (node === null) delete nodes[id];
    else nodes[id] = node;
  }
  return { ...doc, nodes };
}

function patchNode<T extends SceneNode>(node: T, patch: Partial<T>): T {
  return { ...node, ...patch };
}

// --- Property edits ---------------------------------------------------------

/**
 * Applies a partial patch to each listed node. This is the workhorse: moving,
 * resizing, renaming, restyling and toggling visibility all funnel through it.
 */
export function updateNodes(
  doc: Document,
  patches: Record<NodeId, Partial<SceneNode>>,
): Document {
  const changed: Record<NodeId, SceneNode> = {};
  for (const [id, patch] of Object.entries(patches)) {
    const node = doc.nodes[id];
    if (!node) continue;
    // `id`, `type` and `parent` are structural; they may only change through
    // the structural commands below, never through a property patch.
    const { id: _i, type: _t, parent: _p, ...safe } = patch as Record<string, unknown> & Partial<SceneNode>;
    changed[id] = patchNode(node, safe as Partial<SceneNode>);
  }
  return withNodes(doc, changed);
}

export function updateNode(doc: Document, id: NodeId, patch: Partial<SceneNode>): Document {
  return updateNodes(doc, { [id]: patch });
}

/** Translates nodes by a world-space delta, converting into each parent's space. */
export function translateNodes(doc: Document, ids: Iterable<NodeId>, dx: number, dy: number): Document {
  const patches: Record<NodeId, Partial<SceneNode>> = {};
  for (const id of topmostIds(doc, ids)) {
    const node = doc.nodes[id];
    if (!node || node.locked) continue;
    // A delta in world space becomes a different delta inside a rotated or
    // nested parent, so map it through the inverse of the parent transform.
    const parentM = node.parent && node.parent !== ROOT_ID ? worldTransform(doc, node.parent) : IDENTITY;
    const inv = invert(parentM);
    const origin = apply(inv, { x: 0, y: 0 });
    const moved = apply(inv, { x: dx, y: dy });
    patches[id] = { x: node.x + (moved.x - origin.x), y: node.y + (moved.y - origin.y) };
  }
  return updateNodes(doc, patches);
}

// --- Insertion and removal --------------------------------------------------

export interface InsertOptions {
  parent?: NodeId;
  /** Defaults to appending on top. */
  index?: number;
}

export function insertNode(doc: Document, node: SceneNode, options: InsertOptions = {}): Document {
  const parentId = options.parent ?? doc.root;
  const parent = getContainer(doc, parentId);
  if (!parent) throw new Error(`Cannot insert into non-container: ${parentId}`);

  const children = [...parent.children];
  const index = options.index ?? children.length;
  children.splice(Math.max(0, Math.min(index, children.length)), 0, node.id);

  return withNodes(doc, {
    [node.id]: { ...node, parent: parentId } as SceneNode,
    [parentId]: patchNode(parent, { children } as Partial<ContainerNode>),
  });
}

/** Removes nodes and their entire subtrees. The root is never removable. */
export function deleteNodes(doc: Document, ids: Iterable<NodeId>): Document {
  const changed: Record<NodeId, SceneNode | null> = {};
  const removeFromParent = new Map<NodeId, Set<NodeId>>();

  for (const id of topmostIds(doc, ids)) {
    const node = doc.nodes[id];
    if (!node || id === doc.root || node.locked) continue;
    changed[id] = null;
    for (const d of descendantsOf(doc, id)) changed[d.id] = null;
    if (node.parent) {
      if (!removeFromParent.has(node.parent)) removeFromParent.set(node.parent, new Set());
      removeFromParent.get(node.parent)!.add(id);
    }
  }

  for (const [parentId, removed] of removeFromParent) {
    const parent = getContainer(doc, parentId);
    if (!parent) continue;
    changed[parentId] = patchNode(parent, {
      children: parent.children.filter((c) => !removed.has(c)),
    } as Partial<ContainerNode>);
  }

  return withNodes(doc, changed);
}

// --- Reparenting and z-order ------------------------------------------------

/**
 * Moves nodes under a new parent at a given index while keeping them visually
 * still: the local transform is rebuilt from the world transform.
 */
export function reparentNodes(
  doc: Document,
  ids: Iterable<NodeId>,
  newParentId: NodeId,
  index?: number,
): Document {
  const parent = getContainer(doc, newParentId);
  if (!parent) return doc;

  const moving = sortByPaintOrder(doc, topmostIds(doc, ids)).filter(
    (id) => id !== doc.root && id !== newParentId && !isAncestorOf(doc, id, newParentId),
  );
  if (moving.length === 0) return doc;

  // Capture world transforms before the tree changes underneath us.
  const worldBefore = new Map<NodeId, Mat>(moving.map((id) => [id, worldTransform(doc, id)]));

  let next = doc;
  for (const id of moving) {
    const node = next.nodes[id];
    if (!node) continue;
    const oldParent = getContainer(next, node.parent ?? ROOT_ID);
    if (oldParent) {
      next = withNodes(next, {
        [oldParent.id]: patchNode(oldParent, {
          children: oldParent.children.filter((c) => c !== id),
        } as Partial<ContainerNode>),
      });
    }
  }

  const target = getContainer(next, newParentId)!;
  const children = [...target.children];
  const at = index === undefined ? children.length : Math.max(0, Math.min(index, children.length));
  children.splice(at, 0, ...moving);
  next = withNodes(next, {
    [newParentId]: patchNode(target, { children } as Partial<ContainerNode>),
  });

  // Rewrite each node's local box so it lands exactly where it was on screen.
  // Node transforms are translation + rotation only (never scale), so the new
  // local transform decomposes cleanly into a centre and an angle.
  const parentWorld = newParentId === next.root ? IDENTITY : worldTransform(next, newParentId);
  const toLocal = invert(parentWorld);
  const relocated: Record<NodeId, SceneNode> = {};

  for (const id of moving) {
    const node = next.nodes[id];
    const before = worldBefore.get(id);
    if (!node || !before) continue;
    const local = mul(toLocal, before);
    const centre = apply(local, { x: node.w / 2, y: node.h / 2 });
    relocated[id] = {
      ...node,
      parent: newParentId,
      x: centre.x - node.w / 2,
      y: centre.y - node.h / 2,
      rotation: normalizeAngle(matRotation(local)),
    } as SceneNode;
  }
  return withNodes(next, relocated);
}

export type ZMove = "front" | "back" | "forward" | "backward";

export function reorderNode(doc: Document, id: NodeId, move: ZMove): Document {
  const node = doc.nodes[id];
  if (!node?.parent) return doc;
  const parent = getContainer(doc, node.parent);
  if (!parent) return doc;

  const children = [...parent.children];
  const from = children.indexOf(id);
  if (from < 0) return doc;

  let to = from;
  if (move === "front") to = children.length - 1;
  else if (move === "back") to = 0;
  else if (move === "forward") to = Math.min(children.length - 1, from + 1);
  else to = Math.max(0, from - 1);
  if (to === from) return doc;

  children.splice(from, 1);
  children.splice(to, 0, id);
  return withNodes(doc, {
    [parent.id]: patchNode(parent, { children } as Partial<ContainerNode>),
  });
}

/** Moves a node to an explicit slot — used by layer-panel drag and drop. */
export function moveNodeTo(doc: Document, id: NodeId, parentId: NodeId, index: number): Document {
  const node = doc.nodes[id];
  if (!node) return doc;
  if (node.parent === parentId) {
    const parent = getContainer(doc, parentId);
    if (!parent) return doc;
    const children = [...parent.children];
    const from = children.indexOf(id);
    if (from < 0) return doc;
    children.splice(from, 1);
    const at = Math.max(0, Math.min(index > from ? index - 1 : index, children.length));
    children.splice(at, 0, id);
    return withNodes(doc, {
      [parentId]: patchNode(parent, { children } as Partial<ContainerNode>),
    });
  }
  return reparentNodes(doc, [id], parentId, index);
}

// --- Grouping ---------------------------------------------------------------

export interface GroupResult {
  doc: Document;
  groupId: NodeId | null;
}

/**
 * Wraps the selection in a new group placed at the topmost member's slot. The
 * group's box is the selection's world bounds, and members are reparented into
 * it without moving.
 */
export function groupNodes(doc: Document, ids: Iterable<NodeId>): GroupResult {
  const members = sortByPaintOrder(doc, topmostIds(doc, ids)).filter((id) => id !== doc.root);
  if (members.length < 2) return { doc, groupId: null };

  // All members must share a parent for grouping to be unambiguous; otherwise
  // adopt the common ancestor and let reparenting preserve world positions.
  const parents = new Set(members.map((id) => doc.nodes[id]?.parent ?? doc.root));
  const parentId = parents.size === 1 ? [...parents][0]! : commonAncestor(doc, members);

  const bounds = unionWorldBounds(doc, members);
  if (!bounds) return { doc, groupId: null };

  // Express the group's box in its parent's space.
  const parentInv = invert(parentId === doc.root ? IDENTITY : worldTransform(doc, parentId));
  const topLeft = apply(parentInv, { x: bounds.x, y: bounds.y });
  const bottomRight = apply(parentInv, { x: bounds.x + bounds.w, y: bounds.y + bounds.h });

  const group: SceneNode = {
    id: newId("g"),
    type: "group",
    name: defaultName(doc, "group"),
    parent: parentId,
    x: Math.min(topLeft.x, bottomRight.x),
    y: Math.min(topLeft.y, bottomRight.y),
    w: Math.abs(bottomRight.x - topLeft.x),
    h: Math.abs(bottomRight.y - topLeft.y),
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    children: [],
  };

  const topIndex = Math.max(
    ...members.map((id) => getContainer(doc, doc.nodes[id]?.parent ?? doc.root)?.children.indexOf(id) ?? 0),
  );
  let next = insertNode(doc, group, { parent: parentId, index: topIndex + 1 });
  next = reparentNodes(next, members, group.id);
  return { doc: next, groupId: group.id };
}

/** Dissolves groups, lifting children into the group's parent at its z-slot. */
export function ungroupNodes(doc: Document, ids: Iterable<NodeId>): { doc: Document; released: NodeId[] } {
  let next = doc;
  const released: NodeId[] = [];
  for (const id of [...new Set(ids)]) {
    const group = getContainer(next, id);
    if (!group || group.type !== "group" || !group.parent) continue;
    const parentId = group.parent;
    const index = getContainer(next, parentId)?.children.indexOf(id) ?? 0;
    const children = [...group.children];
    next = reparentNodes(next, children, parentId, index);
    next = deleteNodes(next, [id]);
    released.push(...children);
  }
  return { doc: next, released };
}

function commonAncestor(doc: Document, ids: NodeId[]): NodeId {
  if (ids.length === 0) return doc.root;
  const chains = ids.map((id) => [...ancestorsOf(doc, id).map((n) => n.id)].reverse());
  let best = doc.root;
  const first = chains[0]!;
  for (let i = 0; i < first.length; i++) {
    const candidate = first[i]!;
    if (chains.every((c) => c[i] === candidate)) best = candidate;
    else break;
  }
  return best;
}

// --- Duplication ------------------------------------------------------------

export interface CloneResult {
  doc: Document;
  ids: NodeId[];
  /** Old id → new id, for every node in every cloned subtree. */
  mapping: Map<NodeId, NodeId>;
}

/** Deep-clones subtrees, assigning fresh ids throughout. */
export function cloneNodes(
  doc: Document,
  ids: Iterable<NodeId>,
  options: { offsetX?: number; offsetY?: number; parent?: NodeId } = {},
): CloneResult {
  const roots = sortByPaintOrder(doc, topmostIds(doc, ids)).filter((id) => id !== doc.root);
  const mapping = new Map<NodeId, NodeId>();
  let next = doc;
  const newRootIds: NodeId[] = [];

  const cloneSubtree = (sourceId: NodeId, parentId: NodeId, index?: number): NodeId | null => {
    const source = next.nodes[sourceId];
    if (!source) return null;
    // Containers are cloned empty; the recursion below re-inserts each child,
    // which is what keeps the new subtree's parent pointers consistent.
    const clone: SceneNode = isContainer(source)
      ? { ...source, id: newId(source.type[0]), parent: parentId, children: [] }
      : { ...source, id: newId(source.type[0]), parent: parentId };
    mapping.set(sourceId, clone.id);
    next = insertNode(next, clone, { parent: parentId, index });
    if (isContainer(source)) {
      for (const childId of source.children) cloneSubtree(childId, clone.id);
    }
    return clone.id;
  };

  for (const id of roots) {
    const source = doc.nodes[id];
    if (!source) continue;
    const parentId = options.parent ?? source.parent ?? doc.root;
    const cloned = cloneSubtree(id, parentId);
    if (cloned) newRootIds.push(cloned);
  }

  if (options.offsetX || options.offsetY) {
    next = translateNodes(next, newRootIds, options.offsetX ?? 0, options.offsetY ?? 0);
  }
  return { doc: next, ids: newRootIds, mapping };
}

// --- Alignment and distribution --------------------------------------------

export type AlignAxis = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/**
 * Aligns nodes to the selection bounds, or to the parent frame when a single
 * node is selected — which is what people expect from one-item alignment.
 */
export function alignNodes(doc: Document, ids: Iterable<NodeId>, axis: AlignAxis): Document {
  const targets = topmostIds(doc, ids).filter((id) => id !== doc.root && !doc.nodes[id]?.locked);
  if (targets.length === 0) return doc;

  let frame = unionWorldBounds(doc, targets);
  if (targets.length === 1) {
    const parentId = doc.nodes[targets[0]!]?.parent;
    const parentBounds =
      parentId && parentId !== doc.root ? unionWorldBounds(doc, [parentId]) : null;
    if (parentBounds) frame = parentBounds;
    else return doc;
  }
  if (!frame) return doc;

  let next = doc;
  for (const id of targets) {
    const b = unionWorldBounds(next, [id]);
    if (!b) continue;
    let dx = 0;
    let dy = 0;
    switch (axis) {
      case "left": dx = frame.x - b.x; break;
      case "right": dx = frame.x + frame.w - (b.x + b.w); break;
      case "hcenter": dx = frame.x + frame.w / 2 - (b.x + b.w / 2); break;
      case "top": dy = frame.y - b.y; break;
      case "bottom": dy = frame.y + frame.h - (b.y + b.h); break;
      case "vcenter": dy = frame.y + frame.h / 2 - (b.y + b.h / 2); break;
    }
    if (dx || dy) next = translateNodes(next, [id], dx, dy);
  }
  return next;
}

/** Evenly spaces nodes between the two extremes, leaving those extremes fixed. */
export function distributeNodes(doc: Document, ids: Iterable<NodeId>, axis: "h" | "v"): Document {
  const targets = topmostIds(doc, ids).filter((id) => id !== doc.root && !doc.nodes[id]?.locked);
  if (targets.length < 3) return doc;

  const boxes = targets
    .map((id) => ({ id, b: unionWorldBounds(doc, [id])! }))
    .filter((t) => t.b)
    .sort((p, q) => (axis === "h" ? p.b.x - q.b.x : p.b.y - q.b.y));

  const first = boxes[0]!.b;
  const last = boxes[boxes.length - 1]!.b;
  const span = axis === "h" ? last.x + last.w - first.x : last.y + last.h - first.y;
  const used = boxes.reduce((sum, t) => sum + (axis === "h" ? t.b.w : t.b.h), 0);
  const gap = (span - used) / (boxes.length - 1);

  let next = doc;
  let cursor = axis === "h" ? first.x : first.y;
  for (const { id, b } of boxes) {
    const current = axis === "h" ? b.x : b.y;
    const delta = cursor - current;
    if (delta) next = translateNodes(next, [id], axis === "h" ? delta : 0, axis === "h" ? 0 : delta);
    cursor += (axis === "h" ? b.w : b.h) + gap;
  }
  return next;
}

// --- Resize -----------------------------------------------------------------

/**
 * Rewrites a node's box so a chosen anchor corner stays pinned in parent space
 * while the opposite corner follows the pointer — the core of rotated resizing.
 *
 * `anchor` is in unit box coordinates: (0,0) top-left … (1,1) bottom-right.
 */
export function resizedBox(
  node: SceneNode,
  anchor: { x: number; y: number },
  newW: number,
  newH: number,
): { x: number; y: number; w: number; h: number } {
  const w = Math.max(newW, MIN_SIZE);
  const h = Math.max(newH, MIN_SIZE);

  // Where the anchor sits in parent space today. This point must not move.
  const pinned = apply(localTransform(node), { x: anchor.x * node.w, y: anchor.y * node.h });

  // At the new size the anchor sits this far from the box centre, once the
  // node's rotation is taken into account.
  const offset = applyVector(rotation(node.rotation), {
    x: (anchor.x - 0.5) * w,
    y: (anchor.y - 0.5) * h,
  });

  return { x: pinned.x - offset.x - w / 2, y: pinned.y - offset.y - h / 2, w, h };
}

/**
 * Scales a set of nodes as if they were one rigid selection box. Positions and
 * sizes scale about `origin` (world space); rotations are preserved.
 */
export function scaleNodesAbout(
  doc: Document,
  ids: Iterable<NodeId>,
  origin: { x: number; y: number },
  sx: number,
  sy: number,
): Document {
  const targets = topmostIds(doc, ids).filter((id) => id !== doc.root && !doc.nodes[id]?.locked);
  const patches: Record<NodeId, Partial<SceneNode>> = {};

  for (const id of targets) {
    const node = doc.nodes[id];
    if (!node) continue;
    const parentId = node.parent && node.parent !== doc.root ? node.parent : null;
    const parentM = parentId ? worldTransform(doc, parentId) : IDENTITY;
    const toParent = invert(parentM);

    // Scale the node's centre about the origin in world space, then bring the
    // result back into parent space.
    const centreWorld = apply(mul(parentM, localTransform(node)), { x: node.w / 2, y: node.h / 2 });
    const scaledWorld = {
      x: origin.x + (centreWorld.x - origin.x) * sx,
      y: origin.y + (centreWorld.y - origin.y) * sy,
    };
    const centreLocal = apply(toParent, scaledWorld);

    const w = Math.max(Math.abs(node.w * sx), MIN_SIZE);
    const h = Math.max(Math.abs(node.h * sy), MIN_SIZE);
    patches[id] = { x: centreLocal.x - w / 2, y: centreLocal.y - h / 2, w, h };
  }
  return updateNodes(doc, patches);
}

/** Rotates nodes about a shared world-space pivot, e.g. the selection centre. */
export function rotateNodesAbout(
  doc: Document,
  ids: Iterable<NodeId>,
  pivot: { x: number; y: number },
  delta: number,
): Document {
  const targets = topmostIds(doc, ids).filter((id) => id !== doc.root && !doc.nodes[id]?.locked);
  const cos = Math.cos(delta);
  const sin = Math.sin(delta);
  const patches: Record<NodeId, Partial<SceneNode>> = {};

  for (const id of targets) {
    const node = doc.nodes[id];
    if (!node) continue;
    const parentId = node.parent && node.parent !== doc.root ? node.parent : null;
    const parentM = parentId ? worldTransform(doc, parentId) : IDENTITY;
    const centreWorld = apply(mul(parentM, localTransform(node)), { x: node.w / 2, y: node.h / 2 });
    const dx = centreWorld.x - pivot.x;
    const dy = centreWorld.y - pivot.y;
    const rotatedWorld = { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
    const centreLocal = apply(invert(parentM), rotatedWorld);
    patches[id] = {
      x: centreLocal.x - node.w / 2,
      y: centreLocal.y - node.h / 2,
      rotation: normalizeAngle(node.rotation + delta),
    };
  }
  return updateNodes(doc, patches);
}

export { withNodes as _withNodes };
