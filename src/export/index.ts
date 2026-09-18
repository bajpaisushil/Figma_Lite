/**
 * Export orchestration: picks a target region, runs the right encoder, and
 * hands the browser a file.
 */

import type { Document, NodeId } from "../core/types.ts";
import { isContainer } from "../core/types.ts";
import { deepWorldBounds, unionWorldBounds } from "../core/document.ts";
import type { Rect } from "../core/math.ts";
import { toJSON } from "../core/serialize.ts";
import { exportRaster } from "./raster.ts";
import { exportPdf } from "./pdf.ts";

export type ExportFormat = "json" | "png" | "jpeg" | "pdf";

export interface ExportRequest {
  format: ExportFormat;
  /** Export only the selection, rather than the whole page. */
  selectionOnly: boolean;
  scale: number;
  /** Omit for a transparent PNG; JPEG and PDF fall back to white. */
  background?: string;
  documentName: string;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
}

/** Padding around the artwork, so nothing sits flush against the edge. */
const PAGE_PADDING = 24;

/** The world rectangle an export should cover, and the roots inside it. */
export function resolveTarget(
  doc: Document,
  selection: readonly NodeId[],
  selectionOnly: boolean,
): { bounds: Rect; ids: NodeId[] } | null {
  const root = doc.nodes[doc.root];
  const topLevel = root && isContainer(root) ? [...root.children] : [];

  const ids = selectionOnly && selection.length > 0 ? [...selection] : topLevel;
  if (ids.length === 0) return null;

  // Use deep bounds so a group's overflowing children are not cropped.
  let bounds: Rect | null = null;
  for (const id of ids) {
    const b = deepWorldBounds(doc, id);
    if (b.w <= 0 && b.h <= 0) continue;
    bounds = bounds ? union(bounds, b) : b;
  }
  bounds ??= unionWorldBounds(doc, ids);
  if (!bounds || bounds.w <= 0 || bounds.h <= 0) return null;

  const padded = {
    x: bounds.x - PAGE_PADDING,
    y: bounds.y - PAGE_PADDING,
    w: bounds.w + PAGE_PADDING * 2,
    h: bounds.h + PAGE_PADDING * 2,
  };
  return { bounds: padded, ids };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export async function runExport(
  doc: Document,
  selection: readonly NodeId[],
  request: ExportRequest,
): Promise<ExportResult> {
  const safeName = request.documentName.replace(/[^\w\- ]+/g, "").trim() || "figma-lite";

  if (request.format === "json") {
    return {
      blob: new Blob([toJSON(doc)], { type: "application/json" }),
      filename: `${safeName}.json`,
    };
  }

  const target = resolveTarget(doc, selection, request.selectionOnly);
  if (!target) throw new Error("There is nothing to export");

  if (request.format === "pdf") {
    const blob = await exportPdf(doc, {
      bounds: target.bounds,
      ids: target.ids,
      background: request.background,
      title: request.documentName,
    });
    return { blob, filename: `${safeName}.pdf` };
  }

  const blob = await exportRaster(doc, {
    bounds: target.bounds,
    ids: target.ids,
    scale: request.scale,
    format: request.format,
    background: request.background,
  });
  return { blob, filename: `${safeName}@${request.scale}x.${request.format === "jpeg" ? "jpg" : "png"}` };
}

/** Hands a blob to the browser as a download. */
export function download(result: ExportResult): void {
  const url = URL.createObjectURL(result.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
