/**
 * The viewport: the camera looking at the infinite canvas.
 *
 * Three coordinate spaces exist in this editor and confusing them is the single
 * biggest source of bugs in a canvas app, so the conversions live here alone:
 *
 *   screen  — CSS pixels inside the canvas element, y down, origin top-left
 *   world   — the page's own units; what the document stores for top-level nodes
 *   local   — a node's own space, where its box is always (0, 0, w, h)
 *
 * screen = world * zoom + pan   (see `viewMatrix`)
 * local  → world is handled by `worldTransform` in document.ts.
 */

import { type Mat, type Rect, type Vec2, clamp, mul, scaling, translation } from "./math.ts";

export interface Viewport {
  /** Pan in screen pixels: where world-space (0, 0) lands on screen. */
  panX: number;
  panY: number;
  zoom: number;
  /** Size of the canvas in CSS pixels. */
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

export function createViewport(): Viewport {
  return { panX: 0, panY: 0, zoom: 1, width: 1, height: 1 };
}

/** world → screen. Feed straight to `ctx.setTransform`. */
export function viewMatrix(v: Viewport): Mat {
  return mul(translation(v.panX, v.panY), scaling(v.zoom));
}

export function screenToWorld(v: Viewport, p: Vec2): Vec2 {
  return { x: (p.x - v.panX) / v.zoom, y: (p.y - v.panY) / v.zoom };
}

export function worldToScreen(v: Viewport, p: Vec2): Vec2 {
  return { x: p.x * v.zoom + v.panX, y: p.y * v.zoom + v.panY };
}

/** The world-space rectangle currently visible — the culling window. */
export function visibleWorldRect(v: Viewport): Rect {
  const topLeft = screenToWorld(v, { x: 0, y: 0 });
  const bottomRight = screenToWorld(v, { x: v.width, y: v.height });
  return { x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y };
}

/** Zooms about a fixed screen point, so the world under the cursor stays put. */
export function zoomAt(v: Viewport, screenPoint: Vec2, nextZoom: number): Viewport {
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const before = screenToWorld(v, screenPoint);
  const panX = screenPoint.x - before.x * zoom;
  const panY = screenPoint.y - before.y * zoom;
  return { ...v, zoom, panX, panY };
}

/** Frames a world rectangle with padding, clamping to sane zoom levels. */
export function fitToRect(v: Viewport, rect: Rect, padding = 64): Viewport {
  if (rect.w <= 0 || rect.h <= 0) {
    return centerOn(v, { x: rect.x, y: rect.y }, 1);
  }
  const zoom = clamp(
    Math.min((v.width - padding * 2) / rect.w, (v.height - padding * 2) / rect.h),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  return centerOn({ ...v, zoom }, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, zoom);
}

export function centerOn(v: Viewport, worldPoint: Vec2, zoom = v.zoom): Viewport {
  return {
    ...v,
    zoom,
    panX: v.width / 2 - worldPoint.x * zoom,
    panY: v.height / 2 - worldPoint.y * zoom,
  };
}
