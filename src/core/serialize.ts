/**
 * JSON export and import.
 *
 * Export is trivial because the document model is already a plain object tree.
 * Import is not: the file is untrusted input, and a malformed one must not be
 * allowed to put the editor into a state the renderer or hit tester cannot
 * survive. So import *rebuilds* the document node by node, coercing every field
 * and dropping anything it cannot make sense of, rather than casting the parsed
 * JSON and hoping.
 *
 * Specifically it guarantees: every node has a known type; every parent link
 * points at a real container; there are no cycles; and every `children` entry
 * exists exactly once in the tree.
 */

import {
  type Document,
  type FrameNode,
  type NodeId,
  type NodeType,
  type SceneNode,
  isContainer,
} from "./types.ts";
import { ROOT_ID, bumpIdCounter, emptyDocument } from "./document.ts";
import { createNode } from "./factory.ts";
import { round } from "./math.ts";

export const FILE_VERSION = 1;

export interface SerializedDocument {
  version: number;
  generator: string;
  root: NodeId;
  nodes: Record<NodeId, unknown>;
}

const NODE_TYPES: readonly NodeType[] = ["frame", "group", "rect", "ellipse", "text", "image"];

/** Rounds geometry on the way out so diffs of exported files stay readable. */
export function serialize(doc: Document): SerializedDocument {
  const nodes: Record<NodeId, unknown> = {};

  for (const [id, node] of Object.entries(doc.nodes)) {
    const out: Record<string, unknown> = { ...node };
    for (const key of ["x", "y", "w", "h"] as const) out[key] = round(node[key], 2);
    out.rotation = round(node.rotation, 5);
    out.opacity = round(node.opacity, 3);
    nodes[id] = out;
  }

  return { version: FILE_VERSION, generator: "figma-lite", root: doc.root, nodes };
}

export function toJSON(doc: Document, pretty = true): string {
  return JSON.stringify(serialize(doc), null, pretty ? 2 : 0);
}

export interface ImportResult {
  doc: Document;
  /** Non-fatal problems, surfaced to the user rather than thrown. */
  warnings: string[];
}

export class ImportError extends Error {}

export function fromJSON(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ImportError(`Not valid JSON: ${(error as Error).message}`);
  }
  return deserialize(parsed);
}

export function deserialize(input: unknown): ImportResult {
  const warnings: string[] = [];
  if (!isRecord(input)) throw new ImportError("Expected a JSON object at the top level.");

  const rawNodes = input.nodes;
  if (!isRecord(rawNodes)) throw new ImportError("Missing a `nodes` object.");

  if (typeof input.version === "number" && input.version > FILE_VERSION) {
    warnings.push(`File version ${input.version} is newer than this editor (v${FILE_VERSION}); unknown fields were ignored.`);
  }

  // Pass 1: coerce every entry into a well-formed node, discarding the rest.
  const clean = new Map<NodeId, SceneNode>();
  for (const [id, raw] of Object.entries(rawNodes)) {
    if (id === ROOT_ID) continue; // The root is synthesised below.
    const node = coerceNode(id, raw, warnings);
    if (node) clean.set(id, node);
  }

  // Pass 2: rebuild parent/child links, keeping only mutually consistent ones.
  const childrenOf = new Map<NodeId, NodeId[]>();
  const claimed = new Set<NodeId>();

  for (const [id, node] of clean) {
    if (!isContainer(node)) continue;
    const kept: NodeId[] = [];
    for (const childId of node.children) {
      if (!clean.has(childId)) {
        warnings.push(`Dropped missing child "${childId}" of "${id}".`);
        continue;
      }
      if (claimed.has(childId)) {
        warnings.push(`Node "${childId}" was listed under two parents; kept the first.`);
        continue;
      }
      if (childId === id) continue;
      claimed.add(childId);
      kept.push(childId);
    }
    childrenOf.set(id, kept);
  }

  // Pass 3: anything unclaimed becomes a top-level node.
  const rootChildren: NodeId[] = [];
  for (const [id] of clean) {
    if (!claimed.has(id)) rootChildren.push(id);
  }

  // Pass 4: break cycles. A node reachable from itself would hang every
  // traversal in the app, so detach the offender to the root instead.
  const safeParents = new Map<NodeId, NodeId>();
  for (const [parentId, children] of childrenOf) {
    for (const childId of children) safeParents.set(childId, parentId);
  }
  for (const id of clean.keys()) {
    const seen = new Set<NodeId>([id]);
    let cursor = safeParents.get(id);
    while (cursor) {
      if (seen.has(cursor)) {
        warnings.push(`Cycle detected at "${id}"; moved it to the top level.`);
        const parent = safeParents.get(id);
        if (parent) {
          childrenOf.set(parent, (childrenOf.get(parent) ?? []).filter((c) => c !== id));
        }
        safeParents.delete(id);
        rootChildren.push(id);
        break;
      }
      seen.add(cursor);
      cursor = safeParents.get(cursor);
    }
  }

  // Assemble.
  const base = emptyDocument();
  // The root is always a frame, and it is synthesised rather than imported so a
  // malformed file cannot replace it with something untraversable.
  const root = base.nodes[ROOT_ID] as FrameNode;
  const nodes: Record<NodeId, SceneNode> = { [ROOT_ID]: root };

  for (const [id, node] of clean) {
    const parent = safeParents.get(id) ?? ROOT_ID;
    if (isContainer(node)) {
      nodes[id] = { ...node, parent, children: childrenOf.get(id) ?? [] };
    } else {
      nodes[id] = { ...node, parent };
    }
  }

  const orderedRootChildren = [...new Set(rootChildren)].filter((id) => nodes[id]);
  nodes[ROOT_ID] = { ...root, children: orderedRootChildren };

  bumpIdCounter(clean.size + 1);
  return { doc: { nodes, root: ROOT_ID }, warnings };
}

/** Builds a valid node from arbitrary input, or returns null if hopeless. */
function coerceNode(id: NodeId, raw: unknown, warnings: string[]): SceneNode | null {
  if (!isRecord(raw)) {
    warnings.push(`Ignored node "${id}": not an object.`);
    return null;
  }
  const type = raw.type;
  if (typeof type !== "string" || !NODE_TYPES.includes(type as NodeType)) {
    warnings.push(`Ignored node "${id}": unknown type ${JSON.stringify(type)}.`);
    return null;
  }

  // Start from the factory defaults so any field the file omits is still valid.
  const defaults = createNode(type as NodeType, {
    id,
    name: str(raw.name, `${type}`),
    box: {
      x: num(raw.x, 0),
      y: num(raw.y, 0),
      w: Math.max(num(raw.w, 100), 0.01),
      h: Math.max(num(raw.h, 100), 0.01),
    },
  });

  const node: Record<string, unknown> = {
    ...defaults,
    rotation: num(raw.rotation, 0),
    opacity: clamp01(num(raw.opacity, 1)),
    visible: bool(raw.visible, true),
    locked: bool(raw.locked, false),
  };

  if (isContainer(defaults)) {
    node.children = Array.isArray(raw.children) ? raw.children.filter((c): c is string => typeof c === "string") : [];
  }
  if (type === "frame") node.clip = bool(raw.clip, true);
  if (type === "frame" || type === "rect" || type === "image") node.radius = Math.max(num(raw.radius, 0), 0);

  if (type === "frame" || type === "rect" || type === "ellipse" || type === "image") {
    node.fill = paint(raw.fill, (defaults as { fill?: { color: string } }).fill);
    node.stroke = paint(raw.stroke, undefined);
    node.strokeWidth = Math.max(num(raw.strokeWidth, 0), 0);
  }

  if (type === "text") {
    node.text = str(raw.text, "");
    node.fontSize = Math.max(num(raw.fontSize, 16), 1);
    node.fontFamily = str(raw.fontFamily, "Inter, system-ui, sans-serif");
    node.fontWeight = Math.max(num(raw.fontWeight, 400), 1);
    node.lineHeight = Math.max(num(raw.lineHeight, 1.3), 0.5);
    node.align = ["left", "center", "right"].includes(raw.align as string) ? raw.align : "left";
    node.color = str(raw.color, "#1b1f2a");
  }

  if (type === "image") {
    // Only data: URLs survive import — a remote URL in a shared file is a
    // silent request to a third party the moment someone opens it.
    const src = str(raw.src, "");
    if (src && !src.startsWith("data:")) {
      warnings.push(`Node "${id}": dropped a non-data image source.`);
      node.src = "";
    } else {
      node.src = src;
    }
    node.fit = ["fill", "contain", "cover"].includes(raw.fit as string) ? raw.fit : "cover";
  }

  return node as unknown as SceneNode;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function paint(v: unknown, fallback: { color: string } | undefined): { color: string } | undefined {
  if (v === null) return undefined;
  if (isRecord(v) && typeof v.color === "string") return { color: v.color };
  return fallback;
}
