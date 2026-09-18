/**
 * PNG and JPEG export.
 *
 * Renders the document into a detached canvas at a chosen scale using the very
 * same `SceneRenderer` the editor draws with — so what is exported is what was
 * on screen, with no second rendering path to drift out of step.
 *
 * JPEG has no alpha channel, so a background is composited in; PNG keeps
 * transparency unless one is asked for.
 */

import type { Document, NodeId } from "../core/types.ts";
import type { Rect } from "../core/math.ts";
import { SceneRenderer } from "../render/renderer.ts";

export type RasterFormat = "png" | "jpeg";

export interface RasterOptions {
  bounds: Rect;
  /** Subtree roots to paint. Omit to paint the whole page. */
  ids?: readonly NodeId[];
  /** Pixel density multiplier: 2 gives a retina-sharp export. */
  scale?: number;
  format?: RasterFormat;
  /** Required for JPEG; optional for PNG, which can stay transparent. */
  background?: string;
  quality?: number;
}

/** Guards against a huge selection at 4× asking for a canvas no browser will allocate. */
const MAX_DIMENSION = 8192;

export async function exportRaster(doc: Document, options: RasterOptions): Promise<Blob> {
  const format = options.format ?? "png";
  const requested = options.scale ?? 2;
  const { bounds } = options;

  if (bounds.w <= 0 || bounds.h <= 0) throw new Error("Nothing to export");

  // Clamp rather than fail: a slightly smaller image beats no image.
  const scale = Math.min(requested, MAX_DIMENSION / bounds.w, MAX_DIMENSION / bounds.h);
  const width = Math.max(1, Math.round(bounds.w * scale));
  const height = Math.max(1, Math.round(bounds.h * scale));

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable");

  canvas.width = width;
  canvas.height = height;

  const background = options.background ?? (format === "jpeg" ? "#ffffff" : undefined);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }

  // The renderer applies its own device-pixel-ratio scaling on resize, so drive
  // it through a viewport rather than transforming the context by hand.
  const renderer = new SceneRenderer(canvas, () => undefined);
  await waitForImages(doc, renderer);

  renderer.resize(width / scale, height / scale);
  // `resize` clears the canvas, so paint the background after it.
  if (background) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  renderer.render(
    doc,
    { panX: -bounds.x, panY: -bounds.y, zoom: 1, width: bounds.w, height: bounds.h },
    options.ids,
  );

  return toBlob(canvas, format, options.quality ?? 0.92);
}

/**
 * The renderer can only paint an image that has already decoded, so give every
 * source a chance to load before the single export frame.
 */
async function waitForImages(doc: Document, renderer: SceneRenderer): Promise<void> {
  const sources = new Set<string>();
  for (const node of Object.values(doc.nodes)) {
    if (node.type === "image" && node.src) sources.add(node.src);
  }
  if (sources.size === 0) return;

  await Promise.all(
    [...sources].map(
      (src) =>
        new Promise<void>((resolve) => {
          if (renderer.images.get(src)) return resolve();
          const image = new Image();
          image.onload = () => resolve();
          image.onerror = () => resolve();
          image.src = src;
        }),
    ),
  );
  // Prime the renderer's own cache now that the bitmaps are decoded.
  for (const src of sources) renderer.images.get(src);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function toBlob(canvas: HTMLCanvasElement, format: RasterFormat, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode image"))),
      `image/${format}`,
      quality,
    );
  });
}
