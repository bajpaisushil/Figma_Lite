/** Default-constructs scene nodes. Keeps style defaults in exactly one place. */

import { type NodeType, type SceneNode } from "./types.ts";
import { type Rect } from "./math.ts";
import { newId } from "./document.ts";

export const PALETTE = {
  fill: "#8b9dff",
  frameFill: "#ffffff",
  stroke: "#1b1f2a",
  text: "#1b1f2a",
} as const;

export interface CreateOptions {
  name: string;
  box: Rect;
  id?: string;
}

export function createNode(type: NodeType, options: CreateOptions): SceneNode {
  const base = {
    id: options.id ?? newId(type[0]),
    name: options.name,
    parent: null,
    x: options.box.x,
    y: options.box.y,
    w: Math.max(options.box.w, 1),
    h: Math.max(options.box.h, 1),
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
  } as const;

  switch (type) {
    case "frame":
      return {
        ...base,
        type: "frame",
        children: [],
        fill: { color: PALETTE.frameFill },
        strokeWidth: 0,
        radius: 0,
        clip: true,
      };
    case "group":
      return { ...base, type: "group", children: [] };
    case "rect":
      return { ...base, type: "rect", fill: { color: PALETTE.fill }, strokeWidth: 0, radius: 4 };
    case "ellipse":
      return { ...base, type: "ellipse", fill: { color: PALETTE.fill }, strokeWidth: 0 };
    case "text":
      return {
        ...base,
        type: "text",
        text: "Text",
        fontSize: 24,
        fontFamily: "Inter, system-ui, sans-serif",
        fontWeight: 400,
        lineHeight: 1.3,
        align: "left",
        color: PALETTE.text,
      };
    case "image":
      return {
        ...base,
        type: "image",
        src: "",
        strokeWidth: 0,
        radius: 0,
        fit: "cover",
      };
  }
}
