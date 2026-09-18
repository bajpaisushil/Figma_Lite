import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ancestorsOf,
  deepWorldBounds,
  descendantsOf,
  isAncestorOf,
  localTransform,
  sortByPaintOrder,
  topmostIds,
  unionWorldBounds,
  worldBounds,
  worldTransform,
} from "../src/core/document.ts";
import { apply } from "../src/core/math.ts";
import { build, pointCloseTo, rectCloseTo } from "./helpers.ts";

describe("transforms", () => {
  test("localTransform rotates about the box centre, not the origin", () => {
    const doc = build([{ id: "a", x: 100, y: 100, w: 100, h: 100, rotation: Math.PI / 2 }]);
    const m = localTransform(doc.nodes.a!);
    // The centre is a fixed point of a rotation about the centre.
    pointCloseTo(apply(m, { x: 50, y: 50 }), { x: 150, y: 150 }, 1e-9, "centre");
    // The local top-left swings to where the bottom-left used to be.
    pointCloseTo(apply(m, { x: 0, y: 0 }), { x: 200, y: 100 }, 1e-9, "top-left");
  });

  test("worldTransform composes nested parents", () => {
    const doc = build([
      { id: "outer", x: 100, y: 50, children: [{ id: "inner", x: 10, y: 20, children: [{ id: "leaf", x: 5, y: 5 }] }] },
    ]);
    pointCloseTo(apply(worldTransform(doc, "leaf"), { x: 0, y: 0 }), { x: 115, y: 75 }, 1e-9);
  });

  test("worldTransform composes a rotated parent with a rotated child", () => {
    // Parent rotated 90° about its own centre (50,50 within a 100×100 box at origin).
    const doc = build([
      { id: "parent", x: 0, y: 0, w: 100, h: 100, rotation: Math.PI / 2, children: [{ id: "child", x: 0, y: 0, w: 20, h: 20 }] },
    ]);
    // Child's local (0,0) sits at parent-local (0,0), which the rotation sends to (100, 0).
    pointCloseTo(apply(worldTransform(doc, "child"), { x: 0, y: 0 }), { x: 100, y: 0 }, 1e-9);
    // And the child's own box is rotated with the parent.
    pointCloseTo(apply(worldTransform(doc, "child"), { x: 20, y: 0 }), { x: 100, y: 20 }, 1e-9);
  });

  test("worldBounds of a 45-degree rotated square", () => {
    const doc = build([{ id: "a", x: 0, y: 0, w: 100, h: 100, rotation: Math.PI / 4 }]);
    const side = 100 * Math.SQRT2;
    rectCloseTo(worldBounds(doc, "a"), { x: 50 - side / 2, y: 50 - side / 2, w: side, h: side }, 1e-9);
  });

  test("unionWorldBounds spans every member", () => {
    const doc = build([
      { id: "a", x: 0, y: 0, w: 50, h: 50 },
      { id: "b", x: 200, y: 100, w: 50, h: 50 },
    ]);
    rectCloseTo(unionWorldBounds(doc, ["a", "b"])!, { x: 0, y: 0, w: 250, h: 150 }, 1e-9);
  });

  test("unionWorldBounds returns null for an empty or unknown selection", () => {
    const doc = build([{ id: "a" }]);
    assert.equal(unionWorldBounds(doc, []), null);
    assert.equal(unionWorldBounds(doc, ["nope"]), null);
  });

  test("deepWorldBounds includes group children that overflow the group box", () => {
    const doc = build([
      { id: "g", type: "group", x: 0, y: 0, w: 10, h: 10, children: [{ id: "big", x: 0, y: 0, w: 500, h: 500 }] },
    ]);
    rectCloseTo(deepWorldBounds(doc, "g"), { x: 0, y: 0, w: 500, h: 500 }, 1e-9);
  });
});

describe("tree queries", () => {
  const doc = build([
    { id: "f", type: "frame", children: [{ id: "g", type: "group", children: [{ id: "leaf" }] }] },
    { id: "other" },
  ]);

  test("ancestorsOf walks up to the root", () => {
    assert.deepEqual(ancestorsOf(doc, "leaf").map((n) => n.id), ["g", "f", "root"]);
  });

  test("isAncestorOf is strict and directional", () => {
    assert.ok(isAncestorOf(doc, "f", "leaf"));
    assert.ok(!isAncestorOf(doc, "leaf", "f"));
    assert.ok(!isAncestorOf(doc, "leaf", "leaf"));
  });

  test("descendantsOf excludes self unless asked", () => {
    assert.deepEqual(descendantsOf(doc, "f").map((n) => n.id), ["g", "leaf"]);
    assert.deepEqual(descendantsOf(doc, "f", true).map((n) => n.id), ["f", "g", "leaf"]);
  });

  test("topmostIds drops descendants of other selected nodes", () => {
    assert.deepEqual(topmostIds(doc, ["f", "leaf", "other"]).sort(), ["f", "other"]);
    // A selection with no nesting is returned intact.
    assert.deepEqual(topmostIds(doc, ["leaf", "other"]).sort(), ["leaf", "other"]);
  });

  test("sortByPaintOrder returns ids back-to-front", () => {
    assert.deepEqual(sortByPaintOrder(doc, ["other", "leaf", "f"]), ["f", "leaf", "other"]);
  });
});
