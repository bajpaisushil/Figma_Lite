/**
 * The overlay renderer: selection chrome, handles, snap guides, marquee.
 *
 * This lives on its own canvas stacked above the scene. Dragging a handle
 * repaints only this layer, so the cost of interaction is independent of how
 * many nodes the document holds.
 *
 * Everything here is drawn in *screen* space at a fixed pixel size, so handles
 * stay the same physical size at every zoom level.
 */

import type { Document, NodeId } from "../core/types.ts";
import { localRect, worldTransform } from "../core/document.ts";
import {
  type Rect,
  type Vec2,
  apply,
  boundsOfPoints,
  matRotation,
  rectCorners,
} from "../core/math.ts";
import { type Viewport, worldToScreen } from "../core/viewport.ts";
import type { SnapGuide } from "../interaction/snapping.ts";
import { roundedRectPath } from "./renderer.ts";

export const THEME = {
  accent: "#6f5cff",
  accentSoft: "rgba(111, 92, 255, 0.16)",
  hover: "#9c8cff",
  snap: "#ff5fa2",
  handleFill: "#ffffff",
  label: "#ffffff",
  labelBg: "#6f5cff",
} as const;

export const HANDLE_SIZE = 9;
/** How far outside a corner the rotation hot-zone extends, in screen px. */
export const ROTATE_ZONE = 16;

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface SelectionFrame {
  /** Screen-space corners, clockwise from top-left of the unrotated box. */
  corners: [Vec2, Vec2, Vec2, Vec2];
  /** Screen-space handle positions, keyed by handle id. */
  handles: Record<ResizeHandle, Vec2>;
  /** Frame rotation in radians (0 for multi-select). */
  rotation: number;
  /** The underlying world-space box (unrotated) and its centre. */
  worldRect: Rect;
  worldCenter: Vec2;
  /** True when the frame is the axis-aligned union of several nodes. */
  isMulti: boolean;
}

/**
 * The oriented box to draw handles on.
 *
 * A single selected node shows its own rotated box — you resize along its axes.
 * A multi-selection shows the axis-aligned union, because there is no single
 * meaningful orientation for a mixed group.
 */
export function selectionFrame(
  doc: Document,
  selection: readonly NodeId[],
  viewport: Viewport,
): SelectionFrame | null {
  if (selection.length === 0) return null;

  let worldCorners: Vec2[];
  let rotation = 0;
  let worldRect: Rect;

  if (selection.length === 1) {
    const node = doc.nodes[selection[0]!];
    if (!node) return null;
    const m = worldTransform(doc, node.id);
    worldCorners = rectCorners(localRect(node)).map((p) => apply(m, p));
    rotation = matRotation(m);
    worldRect = { x: node.x, y: node.y, w: node.w, h: node.h };
  } else {
    const points: Vec2[] = [];
    for (const id of selection) {
      const node = doc.nodes[id];
      if (!node) continue;
      const m = worldTransform(doc, id);
      points.push(...rectCorners(localRect(node)).map((p) => apply(m, p)));
    }
    if (points.length === 0) return null;
    const aabb = boundsOfPoints(points);
    worldRect = aabb;
    worldCorners = rectCorners(aabb);
  }

  const screen = worldCorners.map((p) => worldToScreen(viewport, p)) as [Vec2, Vec2, Vec2, Vec2];
  const [tl, tr, br, bl] = screen;
  const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const worldCenter = {
    x: (worldCorners[0]!.x + worldCorners[2]!.x) / 2,
    y: (worldCorners[0]!.y + worldCorners[2]!.y) / 2,
  };

  return {
    corners: screen,
    rotation,
    worldRect,
    worldCenter,
    isMulti: selection.length > 1,
    handles: {
      nw: tl,
      n: mid(tl, tr),
      ne: tr,
      e: mid(tr, br),
      se: br,
      s: mid(br, bl),
      sw: bl,
      w: mid(bl, tl),
    },
  };
}

/** Unit-square coordinates of each handle, used to derive its resize anchor. */
export const HANDLE_UNIT: Record<ResizeHandle, Vec2> = {
  nw: { x: 0, y: 0 },
  n: { x: 0.5, y: 0 },
  ne: { x: 1, y: 0 },
  e: { x: 1, y: 0.5 },
  se: { x: 1, y: 1 },
  s: { x: 0.5, y: 1 },
  sw: { x: 0, y: 1 },
  w: { x: 0, y: 0.5 },
};

export const OPPOSITE_HANDLE: Record<ResizeHandle, ResizeHandle> = {
  nw: "se",
  n: "s",
  ne: "sw",
  e: "w",
  se: "nw",
  s: "n",
  sw: "ne",
  w: "e",
};

export interface OverlayState {
  marquee: Rect | null;
  guides: SnapGuide[];
  hoverId: NodeId | null;
  /** Text shown in the floating badge, e.g. "120 × 80" or "45°". */
  badge: string | null;
  /** Suppresses handles during a gesture where they would be noise. */
  hideHandles: boolean;
  scopeId: NodeId;
}

export class OverlayRenderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(height * this.dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  render(
    doc: Document,
    selection: readonly NodeId[],
    viewport: Viewport,
    state: OverlayState,
  ): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);

    if (state.scopeId !== doc.root) this.drawScope(doc, state.scopeId, viewport);
    if (state.hoverId && !selection.includes(state.hoverId)) {
      this.drawOutline(doc, state.hoverId, viewport, THEME.hover, 1.5);
    }

    // Outline every selected node, then one frame with handles around them all.
    if (selection.length > 1) {
      for (const id of selection) this.drawOutline(doc, id, viewport, THEME.accent, 1);
    }

    const frame = selectionFrame(doc, selection, viewport);
    if (frame) this.drawFrame(frame, state.hideHandles);

    for (const guide of state.guides) this.drawGuide(guide, viewport);
    if (state.marquee) this.drawMarquee(state.marquee);
    if (state.badge && frame) this.drawBadge(frame, state.badge);
  }

  private drawScope(doc: Document, scopeId: NodeId, viewport: Viewport): void {
    const node = doc.nodes[scopeId];
    if (!node) return;
    const ctx = this.ctx;
    const m = worldTransform(doc, scopeId);
    const pts = rectCorners(localRect(node)).map((p) => worldToScreen(viewport, apply(m, p)));

    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = "rgba(111, 92, 255, 0.45)";
    ctx.lineWidth = 1.5;
    this.polygon(pts);
    ctx.stroke();
    ctx.restore();
  }

  private drawOutline(
    doc: Document,
    id: NodeId,
    viewport: Viewport,
    color: string,
    width: number,
  ): void {
    const node = doc.nodes[id];
    if (!node) return;
    const m = worldTransform(doc, id);
    const pts = rectCorners(localRect(node)).map((p) => worldToScreen(viewport, apply(m, p)));

    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    this.polygon(pts);
    ctx.stroke();
    ctx.restore();
  }

  private drawFrame(frame: SelectionFrame, hideHandles: boolean): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = THEME.accent;
    ctx.lineWidth = 1.5;
    this.polygon(frame.corners);
    ctx.stroke();

    if (!hideHandles) {
      const size = HANDLE_SIZE;
      // A soft drop shadow makes the handles read as physical chips sitting
      // above the artwork rather than as hairlines drawn on it.
      ctx.shadowColor = "rgba(40, 30, 90, 0.28)";
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 1.5;

      for (const point of Object.values(frame.handles)) {
        ctx.beginPath();
        roundedRectPath(ctx, point.x - size / 2, point.y - size / 2, size, size, 3);
        ctx.fillStyle = THEME.handleFill;
        ctx.fill();
        ctx.shadowColor = "transparent";
        ctx.strokeStyle = THEME.accent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.shadowColor = "rgba(40, 30, 90, 0.28)";
      }
    }
    ctx.restore();
  }

  private drawGuide(guide: SnapGuide, viewport: Viewport): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = THEME.snap;
    ctx.lineWidth = 1;

    if (guide.axis === "x") {
      const x = Math.round(worldToScreen(viewport, { x: guide.position, y: 0 }).x) + 0.5;
      const a = worldToScreen(viewport, { x: guide.position, y: guide.from }).y;
      const b = worldToScreen(viewport, { x: guide.position, y: guide.to }).y;
      ctx.beginPath();
      ctx.moveTo(x, a - 12);
      ctx.lineTo(x, b + 12);
      ctx.stroke();
      this.tick(x, a - 12, true);
      this.tick(x, b + 12, true);
    } else {
      const y = Math.round(worldToScreen(viewport, { x: 0, y: guide.position }).y) + 0.5;
      const a = worldToScreen(viewport, { x: guide.from, y: guide.position }).x;
      const b = worldToScreen(viewport, { x: guide.to, y: guide.position }).x;
      ctx.beginPath();
      ctx.moveTo(a - 12, y);
      ctx.lineTo(b + 12, y);
      ctx.stroke();
      this.tick(a - 12, y, false);
      this.tick(b + 12, y, false);
    }
    ctx.restore();
  }

  /** Small perpendicular cap so a guide reads as a measurement, not a crop mark. */
  private tick(x: number, y: number, vertical: boolean): void {
    const ctx = this.ctx;
    const r = 3;
    ctx.beginPath();
    if (vertical) {
      ctx.moveTo(x - r, y);
      ctx.lineTo(x + r, y);
    } else {
      ctx.moveTo(x, y - r);
      ctx.lineTo(x, y + r);
    }
    ctx.stroke();
  }

  private drawMarquee(rect: Rect): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 4);
    ctx.fillStyle = THEME.accentSoft;
    ctx.fill();
    ctx.strokeStyle = THEME.accent;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  private drawBadge(frame: SelectionFrame, text: string): void {
    const ctx = this.ctx;
    const bottom = frame.corners.reduce((a, b) => (a.y > b.y ? a : b));
    const centerX = (frame.corners[0]!.x + frame.corners[2]!.x) / 2;

    ctx.save();
    ctx.font = "600 11px Inter, system-ui, sans-serif";
    const width = ctx.measureText(text).width + 16;
    const height = 22;
    const x = centerX - width / 2;
    const y = bottom.y + 12;

    ctx.shadowColor = "rgba(50, 35, 110, 0.35)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    roundedRectPath(ctx, x, y, width, height, height / 2);
    ctx.fillStyle = THEME.labelBg;
    ctx.fill();

    ctx.shadowColor = "transparent";
    ctx.fillStyle = THEME.label;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, centerX, y + height / 2 + 0.5);
    ctx.restore();
  }

  private polygon(points: Vec2[]): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
    ctx.closePath();
  }
}

/** Which handle, if any, sits under a screen point. */
export function handleAtPoint(frame: SelectionFrame, point: Vec2): ResizeHandle | null {
  const r = HANDLE_SIZE / 2 + 3;
  for (const [id, pos] of Object.entries(frame.handles) as [ResizeHandle, Vec2][]) {
    if (Math.abs(point.x - pos.x) <= r && Math.abs(point.y - pos.y) <= r) return id;
  }
  return null;
}

/**
 * Corner rotation zones sit just outside the frame, matching the convention
 * every design tool uses: near a corner is resize, just beyond it is rotate.
 */
export function rotationHandleAtPoint(frame: SelectionFrame, point: Vec2): ResizeHandle | null {
  const inner = HANDLE_SIZE / 2 + 3;
  const outer = inner + ROTATE_ZONE;
  const corners: ResizeHandle[] = ["nw", "ne", "se", "sw"];

  for (const id of corners) {
    const pos = frame.handles[id];
    const d = Math.hypot(point.x - pos.x, point.y - pos.y);
    if (d > inner && d <= outer) return id;
  }
  return null;
}
