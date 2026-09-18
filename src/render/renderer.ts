/**
 * The scene renderer.
 *
 * Draws the document onto a Canvas2D surface. Deliberately a *retained model,
 * immediate-mode painter*: there is no display list to keep in sync, each frame
 * walks the tree and paints. The optimisations that keep that cheap are:
 *
 *   - repaint only on a dirty flag, at most once per animation frame;
 *   - cull subtrees whose world bounds miss the viewport;
 *   - skip the whole subtree when a container is invisible or fully transparent;
 *   - cache text layout (see text.ts) and decoded images (see images.ts);
 *   - keep chrome on a second canvas so dragging a handle never repaints the scene.
 *
 * The device-pixel-ratio dance happens once per resize, not per frame.
 */

import type { Document, NodeId, SceneNode } from "../core/types.ts";
import { isContainer } from "../core/types.ts";
import { ancestorsOf, localTransform, worldTransform } from "../core/document.ts";
import { type Mat, type Rect, IDENTITY, mul, rectIntersects, transformedBounds } from "../core/math.ts";
import { type Viewport, viewMatrix, visibleWorldRect } from "../core/viewport.ts";
import { ImageCache } from "./images.ts";
import { fontString, layoutText } from "./text.ts";

export interface RenderStats {
  painted: number;
  culled: number;
  frameMs: number;
}

export class SceneRenderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  readonly images: ImageCache;
  stats: RenderStats = { painted: 0, culled: 0, frameMs: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    onImageLoad: () => void,
  ) {
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    this.ctx = ctx;
    this.images = new ImageCache(onImageLoad);
  }

  /**
   * Sizes the backing store. `pixelRatio` defaults to the device's, capped at 2
   * for on-screen use; export passes its own scale so the output resolution is
   * what was asked for rather than whatever display the browser happens to be on.
   */
  resize(width: number, height: number, pixelRatio?: number): void {
    this.dpr = pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(height * this.dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  /**
   * Paints the document. `roots` limits painting to specific subtrees — used by
   * selection-only export; each root still gets its real parent transform, so a
   * nested node exports exactly where it sits.
   */
  render(doc: Document, viewport: Viewport, roots?: readonly NodeId[]): RenderStats {
    const start = performance.now();
    const ctx = this.ctx;
    this.stats.painted = 0;
    this.stats.culled = 0;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);

    const visible = visibleWorldRect(viewport);
    const view = viewMatrix(viewport);

    if (roots) {
      for (const id of roots) {
        const node = doc.nodes[id];
        if (!node) continue;
        const parentWorld =
          node.parent && node.parent !== doc.root ? worldTransform(doc, node.parent) : IDENTITY;

        // Painting a subtree directly skips the ancestors, and with them any
        // clipping frame the node sits inside — so a half-hidden node would
        // export whole. Re-establish those clips before painting.
        const clips = this.applyAncestorClips(doc, id, view);
        this.paintNode(doc, id, parentWorld, view, visible, 1);
        for (let i = 0; i < clips; i++) this.ctx.restore();
      }
    } else {
      const root = doc.nodes[doc.root];
      if (root && isContainer(root)) {
        for (const childId of root.children) {
          this.paintNode(doc, childId, IDENTITY, view, visible, 1);
        }
      }
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.stats.frameMs = performance.now() - start;
    return this.stats;
  }

  /**
   * Paints one node and its subtree.
   *
   * `parentWorld` is the accumulated world transform of the parent, threaded
   * through the recursion rather than recomputed per node — recomputing it via
   * `worldTransform` would make painting O(depth²).
   */
  private paintNode(
    doc: Document,
    id: NodeId,
    parentWorld: Mat,
    view: Mat,
    visible: Rect,
    inheritedOpacity: number,
  ): void {
    const node = doc.nodes[id];
    if (!node || !node.visible || node.opacity <= 0.001) return;

    const world = mul(parentWorld, localTransform(node));
    const bounds = transformedBounds(world, { x: 0, y: 0, w: node.w, h: node.h });

    // A container's children can spill outside its own box, so only cull a
    // container when it clips; otherwise let the recursion cull each child.
    const clips = node.type === "frame" && node.clip;
    const cullable = !isContainer(node) || clips;
    if (cullable && !rectIntersects(visible, bounds)) {
      this.stats.culled += 1;
      return;
    }

    const ctx = this.ctx;
    const opacity = inheritedOpacity * node.opacity;
    const screen = mul(view, world);

    ctx.save();
    this.setWorldTransform(screen);
    ctx.globalAlpha = opacity;

    switch (node.type) {
      case "frame":
        this.paintFrame(node, ctx);
        break;
      case "rect":
        this.paintRect(node, ctx);
        break;
      case "ellipse":
        this.paintEllipse(node, ctx);
        break;
      case "text":
        this.paintText(node, ctx);
        break;
      case "image":
        this.paintImage(node, ctx);
        break;
      case "group":
        // Groups are pure structure: no paint of their own.
        break;
    }
    this.stats.painted += 1;

    if (isContainer(node)) {
      // The clip region is resolved to device space the moment it is set, so it
      // keeps applying to children even though each child installs its own
      // transform. `restore()` below tears it back down.
      let childVisible = visible;
      if (clips) {
        ctx.beginPath();
        roundedRectPath(ctx, 0, 0, node.w, node.h, (node as { radius: number }).radius);
        ctx.clip();
        childVisible = intersectRect(visible, bounds);
      }
      for (const childId of node.children) {
        this.paintNode(doc, childId, world, view, childVisible, opacity);
      }
    }

    ctx.restore();
  }

  /**
   * Installs each enclosing clipping frame's clip path, outermost first.
   * Returns how many `save()` calls the caller must unwind.
   */
  private applyAncestorClips(doc: Document, id: NodeId, view: Mat): number {
    const chain = ancestorsOf(doc, id)
      .filter((n) => n.id !== doc.root && n.type === "frame" && n.clip)
      .reverse();

    for (const frame of chain) {
      this.ctx.save();
      this.setWorldTransform(mul(view, worldTransform(doc, frame.id)));
      this.ctx.beginPath();
      roundedRectPath(this.ctx, 0, 0, frame.w, frame.h, (frame as { radius: number }).radius);
      this.ctx.clip();
    }
    return chain.length;
  }

  /** Installs a world→device transform, folding in the device pixel ratio. */
  private setWorldTransform(m: Mat): void {
    this.ctx.setTransform(
      this.dpr * m.a,
      this.dpr * m.b,
      this.dpr * m.c,
      this.dpr * m.d,
      this.dpr * m.e,
      this.dpr * m.f,
    );
  }

  private paintFrame(node: Extract<SceneNode, { type: "frame" }>, ctx: CanvasRenderingContext2D): void {
    if (node.fill) {
      ctx.fillStyle = node.fill.color;
      ctx.beginPath();
      roundedRectPath(ctx, 0, 0, node.w, node.h, node.radius);
      ctx.fill();
    }
    this.strokeShape(node, ctx, () => roundedRectPath(ctx, 0, 0, node.w, node.h, node.radius));
  }

  private paintRect(node: Extract<SceneNode, { type: "rect" }>, ctx: CanvasRenderingContext2D): void {
    ctx.beginPath();
    roundedRectPath(ctx, 0, 0, node.w, node.h, node.radius);
    if (node.fill) {
      ctx.fillStyle = node.fill.color;
      ctx.fill();
    }
    this.strokeShape(node, ctx, () => roundedRectPath(ctx, 0, 0, node.w, node.h, node.radius));
  }

  private paintEllipse(node: Extract<SceneNode, { type: "ellipse" }>, ctx: CanvasRenderingContext2D): void {
    const path = () => {
      ctx.beginPath();
      ctx.ellipse(node.w / 2, node.h / 2, node.w / 2, node.h / 2, 0, 0, Math.PI * 2);
    };
    path();
    if (node.fill) {
      ctx.fillStyle = node.fill.color;
      ctx.fill();
    }
    this.strokeShape(node, ctx, path);
  }

  private paintText(node: Extract<SceneNode, { type: "text" }>, ctx: CanvasRenderingContext2D): void {
    const layout = layoutText(ctx, node);
    ctx.fillStyle = node.color;
    ctx.font = fontString(node);
    ctx.textBaseline = "top";
    ctx.textAlign = node.align === "center" ? "center" : node.align === "right" ? "right" : "left";
    const originX = node.align === "center" ? node.w / 2 : node.align === "right" ? node.w : 0;

    for (let i = 0; i < layout.lines.length; i++) {
      const y = i * layout.lineHeight;
      if (y > node.h + layout.lineHeight) break; // Clip overflow cheaply.
      ctx.fillText(layout.lines[i]!, originX, y);
    }
  }

  private paintImage(node: Extract<SceneNode, { type: "image" }>, ctx: CanvasRenderingContext2D): void {
    const img = this.images.get(node.src);
    ctx.beginPath();
    roundedRectPath(ctx, 0, 0, node.w, node.h, node.radius);

    if (!img) {
      // Placeholder while the bitmap decodes, so the layout does not jump.
      ctx.fillStyle = "#e6e8f2";
      ctx.fill();
      return;
    }

    ctx.save();
    ctx.clip();
    const { sx, sy, sw, sh, dx, dy, dw, dh } = fitRect(node.fit, img.naturalWidth, img.naturalHeight, node.w, node.h);
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.restore();
    this.strokeShape(node, ctx, () => roundedRectPath(ctx, 0, 0, node.w, node.h, node.radius));
  }

  private strokeShape(
    node: { stroke?: { color: string }; strokeWidth: number },
    ctx: CanvasRenderingContext2D,
    path: () => void,
  ): void {
    if (!node.stroke || node.strokeWidth <= 0) return;
    ctx.beginPath();
    path();
    ctx.strokeStyle = node.stroke.color;
    ctx.lineWidth = node.strokeWidth;
    ctx.stroke();
  }
}

/** Rounded-rect path with the radius clamped to what the box can hold. */
export function roundedRectPath(
  ctx: CanvasRenderingContext2D | Path2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, Math.min(Math.abs(w), Math.abs(h)) / 2));
  if (r === 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function intersectRect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x),
    h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y),
  };
}

/** Maps CSS object-fit semantics onto drawImage's source/destination rects. */
function fitRect(
  fit: "fill" | "contain" | "cover",
  iw: number,
  ih: number,
  bw: number,
  bh: number,
): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } {
  if (fit === "fill" || iw === 0 || ih === 0) {
    return { sx: 0, sy: 0, sw: iw, sh: ih, dx: 0, dy: 0, dw: bw, dh: bh };
  }
  const scale = fit === "cover" ? Math.max(bw / iw, bh / ih) : Math.min(bw / iw, bh / ih);
  const dw = iw * scale;
  const dh = ih * scale;

  if (fit === "contain") {
    return { sx: 0, sy: 0, sw: iw, sh: ih, dx: (bw - dw) / 2, dy: (bh - dh) / 2, dw, dh };
  }
  // Cover crops in source space so the drawn rect exactly fills the box.
  const sw = bw / scale;
  const sh = bh / scale;
  return { sx: (iw - sw) / 2, sy: (ih - sh) / 2, sw, sh, dx: 0, dy: 0, dw: bw, dh: bh };
}
