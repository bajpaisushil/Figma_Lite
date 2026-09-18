/** A small starter scene, so the editor opens on something rather than a void. */

import type { Document, NodeId, SceneNode } from "./core/types.ts";
import { emptyDocument } from "./core/document.ts";
import { insertNode } from "./core/commands.ts";
import { createNode } from "./core/factory.ts";

type Spec = {
  type: Parameters<typeof createNode>[0];
  name: string;
  box: { x: number; y: number; w: number; h: number };
  props?: Partial<SceneNode> & Record<string, unknown>;
  children?: Spec[];
};

const SCENE: Spec[] = [
  {
    type: "frame",
    name: "Card",
    box: { x: 0, y: 0, w: 360, h: 260 },
    props: { fill: { color: "#ffffff" }, radius: 28 },
    children: [
      {
        type: "rect",
        name: "Cover",
        box: { x: 16, y: 16, w: 328, h: 120 },
        props: { fill: { color: "#ffd5e8" }, radius: 20 },
      },
      {
        type: "ellipse",
        name: "Badge",
        box: { x: 36, y: 100, w: 64, h: 64 },
        props: { fill: { color: "#7b6cff" }, stroke: { color: "#ffffff" }, strokeWidth: 5 },
      },
      {
        type: "text",
        name: "Title",
        box: { x: 36, y: 178, w: 220, h: 30 },
        props: { text: "Soft UI kit", fontSize: 22, fontWeight: 700, color: "#241f43" },
      },
      {
        type: "text",
        name: "Caption",
        box: { x: 36, y: 208, w: 260, h: 22 },
        props: { text: "Drag me around · press R to draw", fontSize: 13, color: "#7b7597" },
      },
    ],
  },
  {
    type: "frame",
    name: "Palette",
    box: { x: 420, y: 0, w: 260, h: 260 },
    props: { fill: { color: "#f6f4ff" }, radius: 28 },
    children: [
      {
        type: "text",
        name: "Palette label",
        box: { x: 28, y: 26, w: 200, h: 24 },
        props: { text: "Swatches", fontSize: 16, fontWeight: 600, color: "#241f43" },
      },
      {
        type: "rect",
        name: "Swatch 1",
        box: { x: 28, y: 64, w: 92, h: 92 },
        props: { fill: { color: "#7b6cff" }, radius: 24 },
      },
      {
        type: "rect",
        name: "Swatch 2",
        box: { x: 136, y: 64, w: 92, h: 92 },
        props: { fill: { color: "#5fd6c4" }, radius: 24 },
      },
      {
        type: "rect",
        name: "Swatch 3",
        box: { x: 28, y: 168, w: 92, h: 60 },
        props: { fill: { color: "#ffc46b" }, radius: 20 },
      },
      {
        type: "rect",
        name: "Swatch 4",
        box: { x: 136, y: 168, w: 92, h: 60 },
        props: { fill: { color: "#ff8fb1" }, radius: 20 },
      },
    ],
  },
  {
    type: "ellipse",
    name: "Accent",
    box: { x: 250, y: 300, w: 120, h: 120 },
    props: { fill: { color: "#c8f0ea" }, rotation: 0 },
  },
  {
    type: "text",
    name: "Headline",
    box: { x: 0, y: 306, w: 230, h: 60 },
    props: { text: "Rotate me\nwith a corner", fontSize: 26, fontWeight: 700, color: "#241f43", lineHeight: 1.2 },
  },
  {
    type: "rect",
    name: "Tilted",
    box: { x: 430, y: 310, w: 160, h: 100 },
    props: { fill: { color: "#a99bff" }, radius: 22, rotation: -0.18 },
  },
];

export function sampleDocument(): Document {
  let doc = emptyDocument();

  const build = (spec: Spec, parent: NodeId): void => {
    const node = createNode(spec.type, { name: spec.name, box: spec.box });
    const withProps = { ...node, ...(spec.props ?? {}) } as SceneNode;
    doc = insertNode(doc, withProps, { parent });
    for (const child of spec.children ?? []) build(child, withProps.id);
  };

  for (const spec of SCENE) build(spec, doc.root);
  return doc;
}
