/**
 * Text layout.
 *
 * Wrapping needs `measureText`, which needs a canvas context, so layout is
 * cached by (text, font, width). Without the cache every repaint would re-measure
 * every word of every text node — the single most expensive thing a canvas
 * editor can do by accident.
 */

import type { TextNode } from "../core/types.ts";

export interface TextLayout {
  lines: string[];
  lineHeight: number;
  width: number;
}

const cache = new Map<string, TextLayout>();
const MAX_CACHE = 500;

export function fontString(node: Pick<TextNode, "fontWeight" | "fontSize" | "fontFamily">): string {
  return `${node.fontWeight} ${node.fontSize}px ${node.fontFamily}`;
}

export function layoutText(ctx: CanvasRenderingContext2D, node: TextNode): TextLayout {
  const font = fontString(node);
  const key = `${font}|${node.lineHeight}|${Math.round(node.w)}|${node.text}`;
  const hit = cache.get(key);
  if (hit) return hit;

  ctx.save();
  ctx.font = font;
  const lines: string[] = [];
  const maxWidth = Math.max(node.w, 1);

  for (const paragraph of node.text.split("\n")) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/(\s+)/);
    let current = "";
    for (const word of words) {
      const candidate = current + word;
      if (current !== "" && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current.trimEnd());
        current = word.trimStart();
      } else {
        current = candidate;
      }
    }
    lines.push(current.trimEnd());
  }
  ctx.restore();

  const layout: TextLayout = {
    lines,
    lineHeight: node.fontSize * node.lineHeight,
    width: maxWidth,
  };

  // Cheap eviction: the cache is a repaint accelerator, not a correctness
  // requirement, so dropping everything when it grows is fine.
  if (cache.size > MAX_CACHE) cache.clear();
  cache.set(key, layout);
  return layout;
}

/** Natural height of the laid-out text, used by "resize to fit". */
export function measuredHeight(layout: TextLayout): number {
  return layout.lines.length * layout.lineHeight;
}
