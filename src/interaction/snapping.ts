/**
 * The snapping engine.
 *
 * While dragging, the moving selection's bounding box offers six candidate
 * lines (left / centre / right, top / middle / bottom). Every other node in the
 * same scope offers the same six. Snapping picks the closest pair on each axis
 * within a tolerance and returns the correction plus the guides to draw.
 *
 * The tolerance is defined in *screen* pixels and divided by zoom, so snapping
 * feels equally sticky at 10% and at 800% — a detail that is very obvious when
 * it is missing.
 */

import type { Document, NodeId } from "../core/types.ts";
import { isContainer } from "../core/types.ts";
import { unionWorldBounds, worldBounds } from "../core/document.ts";
import type { Rect } from "../core/math.ts";

export interface SnapGuide {
  axis: "x" | "y";
  /** World coordinate of the guide line. */
  position: number;
  /** Extent of the line, so it spans both the source and the target. */
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

export interface SnapOptions {
  /** Screen-space stickiness, converted internally using `zoom`. */
  thresholdPx?: number;
  zoom: number;
  /** Snap to a world-space grid as well; 0 disables. */
  gridSize?: number;
  enabled?: boolean;
}

const NO_SNAP: SnapResult = { dx: 0, dy: 0, guides: [] };

interface Candidate {
  value: number;
  from: number;
  to: number;
}

function edgesX(r: Rect): Candidate[] {
  const span = { from: r.y, to: r.y + r.h };
  return [
    { value: r.x, ...span },
    { value: r.x + r.w / 2, ...span },
    { value: r.x + r.w, ...span },
  ];
}

function edgesY(r: Rect): Candidate[] {
  const span = { from: r.x, to: r.x + r.w };
  return [
    { value: r.y, ...span },
    { value: r.y + r.h / 2, ...span },
    { value: r.y + r.h, ...span },
  ];
}

/**
 * Computes the correction to apply to a moving box so it aligns with its peers.
 *
 * `movingIds` are excluded from the candidate set — a node must not snap to
 * itself, nor to anything being dragged with it.
 */
export function computeSnap(
  doc: Document,
  movingBounds: Rect,
  movingIds: Iterable<NodeId>,
  scopeId: NodeId,
  options: SnapOptions,
): SnapResult {
  if (options.enabled === false) return NO_SNAP;

  const threshold = (options.thresholdPx ?? 6) / Math.max(options.zoom, 0.0001);
  const exclude = new Set(movingIds);
  const scope = doc.nodes[scopeId];
  if (!scope || !isContainer(scope)) return NO_SNAP;

  const targets: Rect[] = [];
  for (const id of scope.children) {
    if (exclude.has(id)) continue;
    const node = doc.nodes[id];
    if (!node || !node.visible) continue;
    targets.push(worldBounds(doc, id));
  }
  // Frames act as containers you align against, so include the scope itself.
  if (scopeId !== doc.root) targets.push(worldBounds(doc, scopeId));

  const sourceX = edgesX(movingBounds);
  const sourceY = edgesY(movingBounds);

  // `guide` is null for a grid snap, which corrects position but draws no line.
  let bestX: { delta: number; guide: SnapGuide | null } | null = null;
  let bestY: { delta: number; guide: SnapGuide | null } | null = null;

  for (const target of targets) {
    for (const s of sourceX) {
      for (const t of edgesX(target)) {
        const delta = t.value - s.value;
        if (Math.abs(delta) > threshold) continue;
        if (!bestX || Math.abs(delta) < Math.abs(bestX.delta)) {
          bestX = {
            delta,
            guide: {
              axis: "x",
              position: t.value,
              from: Math.min(s.from, t.from),
              to: Math.max(s.to, t.to),
            },
          };
        }
      }
    }
    for (const s of sourceY) {
      for (const t of edgesY(target)) {
        const delta = t.value - s.value;
        if (Math.abs(delta) > threshold) continue;
        if (!bestY || Math.abs(delta) < Math.abs(bestY.delta)) {
          bestY = {
            delta,
            guide: {
              axis: "y",
              position: t.value,
              from: Math.min(s.from, t.from),
              to: Math.max(s.to, t.to),
            },
          };
        }
      }
    }
  }

  // The grid is a weaker attractor: only consult it where nothing else matched.
  const grid = options.gridSize ?? 0;
  if (grid > 0) {
    if (!bestX) {
      const snapped = Math.round(movingBounds.x / grid) * grid;
      const delta = snapped - movingBounds.x;
      if (Math.abs(delta) <= threshold) bestX = { delta, guide: null };
    }
    if (!bestY) {
      const snapped = Math.round(movingBounds.y / grid) * grid;
      const delta = snapped - movingBounds.y;
      if (Math.abs(delta) <= threshold) bestY = { delta, guide: null };
    }
  }

  const guides: SnapGuide[] = [];
  if (bestX?.guide) guides.push(bestX.guide);
  if (bestY?.guide) guides.push(bestY.guide);

  return { dx: bestX?.delta ?? 0, dy: bestY?.delta ?? 0, guides };
}

/** Convenience wrapper that derives the moving bounds from the selection. */
export function snapSelection(
  doc: Document,
  ids: NodeId[],
  scopeId: NodeId,
  options: SnapOptions,
): SnapResult {
  const bounds = unionWorldBounds(doc, ids);
  if (!bounds) return NO_SNAP;
  return computeSnap(doc, bounds, ids, scopeId, options);
}
