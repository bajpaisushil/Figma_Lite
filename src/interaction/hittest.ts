/**
 * Hit testing.
 *
 * Everything here works by mapping the *pointer* into a node's local space
 * through the inverse of that node's world transform, rather than mapping the
 * node into screen space. That keeps the shape maths trivial — a rotated,
 * nested ellipse is still just `x²/a² + y²/b² ≤ 1` once you are in its own
 * coordinates — and it is what makes rotation work at all.
 *
 * Traversal is reverse paint order (last child first) so the topmost node under
 * the cursor wins.
 */

import type { Document, NodeId, SceneNode } from "../core/types.ts";
import { isContainer } from "../core/types.ts";
import { ancestorsOf, localTransform, worldCorners } from "../core/document.ts";
import {
  type Mat,
  type Rect,
  type Vec2,
  IDENTITY,
  apply,
  boundsOfPoints,
  invert,
  mul,
  rectIntersects,
} from "../core/math.ts";

export interface HitOptions {
  /** Ignore locked nodes (true for pointer interaction, false for the layers list). */
  skipLocked?: boolean;
  /** Extra world-space tolerance, so thin shapes stay clickable when zoomed out. */
  tolerance?: number;
}

/** Deepest visible node containing `worldPoint`, or null. */
export function hitTest(doc: Document, worldPoint: Vec2, options: HitOptions = {}): NodeId | null {
  const root = doc.nodes[doc.root];
  if (!root || !isContainer(root)) return null;
  return hitTestChildren(doc, root.children, worldPoint, IDENTITY, options);
}

function hitTestChildren(
  doc: Document,
  children: readonly NodeId[],
  point: Vec2,
  parentWorld: Mat,
  options: HitOptions,
): NodeId | null {
  // Reverse order: the last child is painted last, so it is on top.
  for (let i = children.length - 1; i >= 0; i--) {
    const node = doc.nodes[children[i]!];
    if (!node || !node.visible) continue;
    if (options.skipLocked !== false && node.locked) continue;

    const world = mul(parentWorld, localTransform(node));

    if (isContainer(node)) {
      const clips = node.type === "frame" && node.clip;
      // A clipping frame hides anything outside itself, so do not even descend
      // when the pointer is beyond its bounds.
      if (!clips || pointInNode(node, world, point, options.tolerance ?? 0)) {
        const inner = hitTestChildren(doc, node.children, point, world, options);
        if (inner) return inner;
      }
      // Frames are clickable on their own background; groups never are.
      if (node.type === "frame" && pointInNode(node, world, point, options.tolerance ?? 0)) {
        return node.id;
      }
      continue;
    }

    if (pointInNode(node, world, point, options.tolerance ?? 0)) return node.id;
  }
  return null;
}

/** Tests a world-space point against a node's shape, in that node's local space. */
export function pointInNode(node: SceneNode, world: Mat, point: Vec2, tolerance = 0): boolean {
  const local = apply(invert(world), point);
  const t = tolerance;

  switch (node.type) {
    case "ellipse": {
      const rx = node.w / 2 + t;
      const ry = node.h / 2 + t;
      if (rx <= 0 || ry <= 0) return false;
      const dx = (local.x - node.w / 2) / rx;
      const dy = (local.y - node.h / 2) / ry;
      return dx * dx + dy * dy <= 1;
    }
    case "frame":
    case "rect":
    case "image":
      return pointInRoundedRect(local, node.w, node.h, (node as { radius: number }).radius, t);
    default:
      return local.x >= -t && local.y >= -t && local.x <= node.w + t && local.y <= node.h + t;
  }
}

function pointInRoundedRect(p: Vec2, w: number, h: number, radius: number, tolerance: number): boolean {
  const t = tolerance;
  if (p.x < -t || p.y < -t || p.x > w + t || p.y > h + t) return false;

  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  if (r <= 0) return true;

  // Only the four corner squares can fall outside the rounded outline.
  const cx = p.x < r ? r : p.x > w - r ? w - r : p.x;
  const cy = p.y < r ? r : p.y > h - r ? h - r : p.y;
  if (cx === p.x || cy === p.y) return true;
  return Math.hypot(p.x - cx, p.y - cy) <= r + t;
}

/**
 * Selection scoping, Figma-style: a plain click selects the outermost ancestor
 * still inside the container you have drilled into, so clicking a shape inside a
 * group selects the group until you double-click your way in.
 */
export function resolveSelectionTarget(doc: Document, hitId: NodeId, scopeId: NodeId): NodeId {
  const node = doc.nodes[hitId];
  if (!node) return hitId;
  if (node.parent === scopeId || hitId === scopeId) return hitId;

  const chain = ancestorsOf(doc, hitId);
  // Walk up until the node whose parent is the scope.
  for (const ancestor of chain) {
    if (ancestor.parent === scopeId) return ancestor.id;
    if (ancestor.id === scopeId) break;
  }
  // The hit is outside the current scope entirely: fall back to top level.
  let current = hitId;
  while (true) {
    const n = doc.nodes[current];
    if (!n?.parent || n.parent === doc.root) return current;
    current = n.parent;
  }
}

/** The container a double-click should drill into, or null if there is none. */
export function drillTarget(doc: Document, hitId: NodeId, scopeId: NodeId): NodeId | null {
  const chain = [doc.nodes[hitId], ...ancestorsOf(doc, hitId)].filter(Boolean) as SceneNode[];
  const index = chain.findIndex((n) => n.id === scopeId);
  const searchable = index >= 0 ? chain.slice(0, index) : chain;
  // The container closest to the scope is the next one to enter.
  for (let i = searchable.length - 1; i >= 0; i--) {
    const n = searchable[i]!;
    if (isContainer(n) && n.id !== scopeId) return n.id;
  }
  return null;
}

// --- Marquee ----------------------------------------------------------------

/**
 * Nodes touched by a world-space marquee. Uses the separating-axis test against
 * each node's rotated rectangle, so a rotated shape is not selected merely
 * because its axis-aligned bounding box overlaps.
 */
export function marqueeHits(
  doc: Document,
  worldRect: Rect,
  scopeId: NodeId,
  options: { requireContainment?: boolean } = {},
): NodeId[] {
  const scope = doc.nodes[scopeId];
  if (!scope || !isContainer(scope)) return [];

  const out: NodeId[] = [];
  for (const id of scope.children) {
    const node = doc.nodes[id];
    if (!node || !node.visible || node.locked) continue;
    const corners = worldCorners(doc, id);
    if (corners.length === 0) continue;

    const hit = options.requireContainment
      ? corners.every((p) => pointInRect(worldRect, p))
      : obbIntersectsRect(corners, worldRect);
    if (hit) out.push(id);
  }
  return out;
}

function pointInRect(r: Rect, p: Vec2): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Separating-axis test between a rotated quad and an axis-aligned rectangle. */
function obbIntersectsRect(corners: Vec2[], r: Rect): boolean {
  // Cheap reject on bounding boxes first.
  if (!rectIntersects(boundsOfPoints(corners), r)) return false;

  const rectCorners: Vec2[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];

  // The AABB axes are already covered by the bounds check above, so only the
  // quad's own two edge normals remain.
  for (let i = 0; i < 2; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    const axis = { x: -(b.y - a.y), y: b.x - a.x };
    const len = Math.hypot(axis.x, axis.y);
    if (len < 1e-9) continue;
    axis.x /= len;
    axis.y /= len;
    if (!overlapsOnAxis(corners, rectCorners, axis)) return false;
  }
  return true;
}

function overlapsOnAxis(a: Vec2[], b: Vec2[], axis: Vec2): boolean {
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;
  for (const p of a) {
    const d = p.x * axis.x + p.y * axis.y;
    if (d < minA) minA = d;
    if (d > maxA) maxA = d;
  }
  for (const p of b) {
    const d = p.x * axis.x + p.y * axis.y;
    if (d < minB) minB = d;
    if (d > maxB) maxB = d;
  }
  return !(maxA < minB || maxB < minA);
}
