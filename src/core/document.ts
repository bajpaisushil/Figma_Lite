/**
 * Pure queries and constructors over the document model.
 *
 * Nothing here mutates: every function either reads a `Document` or returns a
 * new one. All *edits* live in `commands.ts`; this module is the vocabulary
 * those commands are written in.
 */

import {
  type Document,
  type NodeId,
  type SceneNode,
  type ContainerNode,
  type NodeType,
  isContainer,
} from "./types.ts";
import {
  type Mat,
  type Rect,
  type Vec2,
  IDENTITY,
  apply,
  boundsOfPoints,
  mul,
  rectCorners,
  rotation,
  translation,
} from "./math.ts";

let idCounter = 0;

export function newId(prefix = "n"): NodeId {
  idCounter += 1;
  return `${prefix}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Keeps generated ids unique after importing a document that used this scheme. */
export function bumpIdCounter(by: number): void {
  idCounter += by;
}

export const ROOT_ID = "root";

export function emptyDocument(): Document {
  const root: ContainerNode = {
    id: ROOT_ID,
    type: "frame",
    name: "Page",
    parent: null,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    children: [],
    radius: 0,
    clip: false,
    strokeWidth: 0,
  };
  return { nodes: { [ROOT_ID]: root }, root: ROOT_ID };
}

// --- Lookup -----------------------------------------------------------------

export function getNode(doc: Document, id: NodeId): SceneNode | undefined {
  return doc.nodes[id];
}

/** Throws if absent — use where a missing node means a genuine bug. */
export function expectNode(doc: Document, id: NodeId): SceneNode {
  const node = doc.nodes[id];
  if (!node) throw new Error(`Node not found: ${id}`);
  return node;
}

export function getContainer(doc: Document, id: NodeId): ContainerNode | undefined {
  const node = doc.nodes[id];
  return node && isContainer(node) ? node : undefined;
}

export function childrenOf(doc: Document, id: NodeId): SceneNode[] {
  const node = doc.nodes[id];
  if (!node || !isContainer(node)) return [];
  return node.children.map((cid) => doc.nodes[cid]).filter(Boolean) as SceneNode[];
}

export function isRoot(doc: Document, id: NodeId): boolean {
  return id === doc.root;
}

/** Ancestors from the immediate parent up to (and including) the root. */
export function ancestorsOf(doc: Document, id: NodeId): SceneNode[] {
  const out: SceneNode[] = [];
  let current = doc.nodes[id]?.parent;
  while (current) {
    const node = doc.nodes[current];
    if (!node) break;
    out.push(node);
    current = node.parent;
  }
  return out;
}

export function isAncestorOf(doc: Document, ancestor: NodeId, descendant: NodeId): boolean {
  let current = doc.nodes[descendant]?.parent;
  while (current) {
    if (current === ancestor) return true;
    current = doc.nodes[current]?.parent;
  }
  return false;
}

/** Depth-first walk in paint order (first child painted first, i.e. behind). */
export function walk(doc: Document, from: NodeId, visit: (node: SceneNode, depth: number) => void, depth = 0): void {
  const node = doc.nodes[from];
  if (!node) return;
  visit(node, depth);
  if (isContainer(node)) {
    for (const cid of node.children) walk(doc, cid, visit, depth + 1);
  }
}

export function descendantsOf(doc: Document, id: NodeId, includeSelf = false): SceneNode[] {
  const out: SceneNode[] = [];
  walk(doc, id, (node) => {
    if (includeSelf || node.id !== id) out.push(node);
  });
  return out;
}

/**
 * Drops any id whose ancestor is also in the set. Selecting a group and one of
 * its children must move the child once, not twice.
 */
export function topmostIds(doc: Document, ids: Iterable<NodeId>): NodeId[] {
  const set = new Set(ids);
  return [...set].filter((id) => !ancestorsOf(doc, id).some((a) => set.has(a.id)));
}

/** Orders ids the way they are painted, so cut/paste and grouping stay stable. */
export function sortByPaintOrder(doc: Document, ids: Iterable<NodeId>): NodeId[] {
  const rank = new Map<NodeId, number>();
  let i = 0;
  walk(doc, doc.root, (node) => rank.set(node.id, i++));
  return [...new Set(ids)].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
}

export function indexInParent(doc: Document, id: NodeId): number {
  const node = doc.nodes[id];
  if (!node?.parent) return -1;
  const parent = getContainer(doc, node.parent);
  return parent ? parent.children.indexOf(id) : -1;
}

// --- Transforms -------------------------------------------------------------

/**
 * A node's own transform: place the box at (x, y), then rotate about its centre.
 * Maps the node's *local* space — where the box is always (0, 0, w, h) — into
 * its parent's space.
 */
export function localTransform(node: SceneNode): Mat {
  const cx = node.w / 2;
  const cy = node.h / 2;
  if (node.rotation === 0) return translation(node.x, node.y);
  return mul(
    translation(node.x + cx, node.y + cy),
    mul(rotation(node.rotation), translation(-cx, -cy)),
  );
}

/** Local space → world (page) space, by composing every ancestor transform. */
export function worldTransform(doc: Document, id: NodeId): Mat {
  const chain: SceneNode[] = [];
  let node: SceneNode | undefined = id === doc.root ? undefined : doc.nodes[id];
  while (node) {
    chain.push(node);
    const parentId: NodeId | null = node.parent;
    node = parentId && parentId !== doc.root ? doc.nodes[parentId] : undefined;
  }
  // Walk root-most first so parents pre-multiply their children.
  let m = IDENTITY;
  for (let i = chain.length - 1; i >= 0; i--) m = mul(m, localTransform(chain[i]!));
  return m;
}

/** Transform of the space *inside* a node, i.e. what its children are relative to. */
export function childSpaceTransform(doc: Document, id: NodeId): Mat {
  return id === doc.root ? IDENTITY : worldTransform(doc, id);
}

export function localRect(node: SceneNode): Rect {
  return { x: 0, y: 0, w: node.w, h: node.h };
}

/** The node's four corners in world space, in clockwise order from top-left. */
export function worldCorners(doc: Document, id: NodeId): Vec2[] {
  const node = doc.nodes[id];
  if (!node) return [];
  const m = worldTransform(doc, id);
  return rectCorners(localRect(node)).map((p) => apply(m, p));
}

/** Axis-aligned world bounds of a single node (ignoring its children). */
export function worldBounds(doc: Document, id: NodeId): Rect {
  return boundsOfPoints(worldCorners(doc, id));
}

/**
 * World bounds including descendants. Groups have no intrinsic size of their
 * own in most editors; here they do carry a box, but children may overflow it,
 * so the visual bounds are the union.
 */
export function deepWorldBounds(doc: Document, id: NodeId): Rect {
  const node = doc.nodes[id];
  if (!node) return { x: 0, y: 0, w: 0, h: 0 };
  const points: Vec2[] = [];
  const collect = (nid: NodeId) => {
    const n = doc.nodes[nid];
    if (!n) return;
    points.push(...worldCorners(doc, nid));
    if (isContainer(n) && n.type === "group") {
      for (const cid of n.children) collect(cid);
    }
  };
  collect(id);
  return boundsOfPoints(points);
}

/** Union of the world bounds of many nodes — the selection box. */
export function unionWorldBounds(doc: Document, ids: Iterable<NodeId>): Rect | null {
  const points: Vec2[] = [];
  for (const id of ids) {
    if (!doc.nodes[id]) continue;
    points.push(...worldCorners(doc, id));
  }
  return points.length ? boundsOfPoints(points) : null;
}

// --- Naming -----------------------------------------------------------------

const DEFAULT_NAMES: Record<NodeType, string> = {
  frame: "Frame",
  group: "Group",
  rect: "Rectangle",
  ellipse: "Ellipse",
  text: "Text",
  image: "Image",
};

/** Picks "Rectangle 3" style names, counting only existing nodes of that type. */
export function defaultName(doc: Document, type: NodeType): string {
  const base = DEFAULT_NAMES[type];
  let n = 0;
  for (const node of Object.values(doc.nodes)) {
    if (node.type !== type) continue;
    if (node.name === base) n = Math.max(n, 1);
    const m = /^(.+) (\d+)$/.exec(node.name);
    if (m && m[1] === base) n = Math.max(n, Number(m[2]));
  }
  return n === 0 ? base : `${base} ${n + 1}`;
}
