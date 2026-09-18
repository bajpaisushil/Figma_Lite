import assert from "node:assert/strict";
import type { Document, NodeId, SceneNode } from "../src/core/types.ts";
import { isContainer } from "../src/core/types.ts";
import { emptyDocument, worldBounds } from "../src/core/document.ts";
import { insertNode } from "../src/core/commands.ts";
import { createNode } from "../src/core/factory.ts";
import type { Rect, Vec2 } from "../src/core/math.ts";

export const EPS = 1e-6;

export function closeTo(actual: number, expected: number, epsilon = 1e-6, message?: string): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    message ?? `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

export function pointCloseTo(actual: Vec2, expected: Vec2, epsilon = 1e-6, label = "point"): void {
  closeTo(actual.x, expected.x, epsilon, `${label}.x: ${actual.x} != ${expected.x}`);
  closeTo(actual.y, expected.y, epsilon, `${label}.y: ${actual.y} != ${expected.y}`);
}

export function rectCloseTo(actual: Rect, expected: Rect, epsilon = 1e-6, label = "rect"): void {
  closeTo(actual.x, expected.x, epsilon, `${label}.x: ${actual.x} != ${expected.x}`);
  closeTo(actual.y, expected.y, epsilon, `${label}.y: ${actual.y} != ${expected.y}`);
  closeTo(actual.w, expected.w, epsilon, `${label}.w: ${actual.w} != ${expected.w}`);
  closeTo(actual.h, expected.h, epsilon, `${label}.h: ${actual.h} != ${expected.h}`);
}

export interface BuildSpec {
  id: NodeId;
  type?: SceneNode["type"];
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rotation?: number;
  props?: Record<string, unknown>;
  children?: BuildSpec[];
}

/** Builds a document from a nested literal, using each spec's `id` verbatim. */
export function build(specs: BuildSpec[]): Document {
  let doc = emptyDocument();

  const add = (spec: BuildSpec, parent: NodeId): void => {
    // A spec with children is a container unless it says otherwise.
    const type = spec.type ?? (spec.children?.length ? "frame" : "rect");
    const node = createNode(type, {
      id: spec.id,
      name: spec.id,
      box: { x: spec.x ?? 0, y: spec.y ?? 0, w: spec.w ?? 100, h: spec.h ?? 100 },
    });
    const withProps = { ...node, rotation: spec.rotation ?? 0, ...(spec.props ?? {}) } as SceneNode;
    doc = insertNode(doc, withProps, { parent });
    for (const child of spec.children ?? []) add(child, spec.id);
  };

  for (const spec of specs) add(spec, doc.root);
  return doc;
}

/** Snapshot of every node's world bounds, for "nothing moved visually" checks. */
export function worldSnapshot(doc: Document, ids: NodeId[]): Record<NodeId, Rect> {
  return Object.fromEntries(ids.map((id) => [id, worldBounds(doc, id)]));
}

export function assertWorldUnchanged(
  before: Record<NodeId, Rect>,
  doc: Document,
  ids: NodeId[],
  epsilon = 1e-6,
): void {
  for (const id of ids) {
    rectCloseTo(worldBounds(doc, id), before[id]!, epsilon, `world bounds of ${id}`);
  }
}

/** Child ids of a container, asserting that the node really is one. */
export function childIds(doc: Document, id: NodeId): NodeId[] {
  const node = doc.nodes[id];
  assert.ok(node, `no node "${id}"`);
  assert.ok(isContainer(node), `node "${id}" is not a container`);
  return [...node.children];
}

/** Reads a node as a loose record, for asserting on type-specific fields. */
export function fields(doc: Document, id: NodeId): Record<string, unknown> {
  const node = doc.nodes[id];
  assert.ok(node, `no node "${id}"`);
  return node as unknown as Record<string, unknown>;
}
