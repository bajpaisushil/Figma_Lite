import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { drillTarget, hitTest, marqueeHits, resolveSelectionTarget } from "../src/interaction/hittest.ts";
import { build } from "./helpers.ts";

describe("point hit testing", () => {
  test("picks the topmost node when shapes overlap", () => {
    const doc = build([
      { id: "under", x: 0, y: 0, w: 100, h: 100 },
      { id: "over", x: 0, y: 0, w: 100, h: 100 },
    ]);
    assert.equal(hitTest(doc, { x: 50, y: 50 }), "over");
  });

  test("respects a node's rotation", () => {
    // A 100×20 bar rotated 90° about its centre occupies a tall, thin column.
    const doc = build([{ id: "bar", x: 0, y: 0, w: 100, h: 20, rotation: Math.PI / 2 }]);
    assert.equal(hitTest(doc, { x: 50, y: 5 }), "bar", "inside the rotated box");
    assert.equal(hitTest(doc, { x: 10, y: 10 }), null, "outside the rotated box");
  });

  test("ellipses are tested against the ellipse, not its bounding box", () => {
    const doc = build([{ id: "e", type: "ellipse", x: 0, y: 0, w: 100, h: 100 }]);
    assert.equal(hitTest(doc, { x: 50, y: 50 }), "e", "centre");
    assert.equal(hitTest(doc, { x: 3, y: 3 }), null, "corner of the bounding box is a miss");
  });

  test("rounded rectangle corners are a miss", () => {
    const doc = build([{ id: "r", x: 0, y: 0, w: 100, h: 100, props: { radius: 50 } }]);
    assert.equal(hitTest(doc, { x: 50, y: 50 }), "r");
    assert.equal(hitTest(doc, { x: 1, y: 1 }), null);
  });

  test("hidden and locked nodes are skipped", () => {
    const hidden = build([{ id: "a", props: { visible: false } }]);
    assert.equal(hitTest(hidden, { x: 50, y: 50 }), null);

    const locked = build([{ id: "a", props: { locked: true } }]);
    assert.equal(hitTest(locked, { x: 50, y: 50 }), null);
    assert.equal(hitTest(locked, { x: 50, y: 50 }, { skipLocked: false }), "a");
  });

  test("finds a child inside a nested, rotated frame", () => {
    const doc = build([
      {
        id: "f",
        type: "frame",
        x: 0,
        y: 0,
        w: 200,
        h: 200,
        rotation: Math.PI / 2,
        children: [{ id: "c", x: 0, y: 0, w: 50, h: 50 }],
      },
    ]);
    // The child's local (0,0)-(50,50) box lands at world x 150..200, y 0..50.
    assert.equal(hitTest(doc, { x: 175, y: 25 }), "c");
    assert.equal(hitTest(doc, { x: 25, y: 25 }), "f", "elsewhere is the frame itself");
  });

  test("a clipping frame hides children that overflow it", () => {
    const doc = build([
      {
        id: "f",
        type: "frame",
        x: 0,
        y: 0,
        w: 50,
        h: 50,
        props: { clip: true },
        children: [{ id: "c", x: 100, y: 100, w: 50, h: 50 }],
      },
    ]);
    assert.equal(hitTest(doc, { x: 120, y: 120 }), null, "the clipped child is unreachable");
    assert.equal(hitTest(doc, { x: 25, y: 25 }), "f");
  });

  test("groups are never hit directly, only their children", () => {
    const doc = build([
      { id: "g", type: "group", x: 0, y: 0, w: 200, h: 200, children: [{ id: "c", x: 0, y: 0, w: 50, h: 50 }] },
    ]);
    assert.equal(hitTest(doc, { x: 25, y: 25 }), "c");
    assert.equal(hitTest(doc, { x: 150, y: 150 }), null, "empty group area is not clickable");
  });
});

describe("selection scoping", () => {
  const doc = build([
    {
      id: "outer",
      type: "group",
      children: [{ id: "inner", type: "group", children: [{ id: "leaf" }] }],
    },
  ]);

  test("clicking a nested shape selects the outermost group by default", () => {
    assert.equal(resolveSelectionTarget(doc, "leaf", doc.root), "outer");
  });

  test("inside a scope, the click resolves to that scope's direct child", () => {
    assert.equal(resolveSelectionTarget(doc, "leaf", "outer"), "inner");
    assert.equal(resolveSelectionTarget(doc, "leaf", "inner"), "leaf");
  });

  test("drillTarget steps down one container at a time", () => {
    assert.equal(drillTarget(doc, "leaf", doc.root), "outer");
    assert.equal(drillTarget(doc, "leaf", "outer"), "inner");
    assert.equal(drillTarget(doc, "leaf", "inner"), null, "nothing left to enter");
  });
});

describe("marquee", () => {
  test("selects nodes that intersect the band", () => {
    const doc = build([
      { id: "a", x: 0, y: 0, w: 50, h: 50 },
      { id: "b", x: 200, y: 0, w: 50, h: 50 },
    ]);
    assert.deepEqual(marqueeHits(doc, { x: -10, y: -10, w: 80, h: 80 }, doc.root), ["a"]);
    assert.deepEqual(marqueeHits(doc, { x: -10, y: -10, w: 400, h: 80 }, doc.root).sort(), ["a", "b"]);
  });

  test("requireContainment needs the node fully inside", () => {
    const doc = build([{ id: "a", x: 0, y: 0, w: 100, h: 100 }]);
    const partly = { x: 50, y: 50, w: 100, h: 100 };
    assert.deepEqual(marqueeHits(doc, partly, doc.root), ["a"], "intersection mode selects it");
    assert.deepEqual(marqueeHits(doc, partly, doc.root, { requireContainment: true }), []);
  });

  test("a rotated node is not selected merely because its AABB overlaps", () => {
    // A square rotated 45° has a much larger AABB than the shape itself; a
    // marquee sitting in the AABB's corner must not catch it.
    const doc = build([{ id: "diamond", x: 0, y: 0, w: 100, h: 100, rotation: Math.PI / 4 }]);
    const corner = { x: -19, y: -19, w: 12, h: 12 };
    assert.deepEqual(marqueeHits(doc, corner, doc.root), [], "corner of the AABB is empty space");
    assert.deepEqual(marqueeHits(doc, { x: 40, y: 40, w: 20, h: 20 }, doc.root), ["diamond"]);
  });

  test("only searches inside the given scope", () => {
    const doc = build([
      { id: "g", type: "group", x: 0, y: 0, w: 200, h: 200, children: [{ id: "c", x: 0, y: 0, w: 50, h: 50 }] },
    ]);
    assert.deepEqual(marqueeHits(doc, { x: -5, y: -5, w: 300, h: 300 }, doc.root), ["g"]);
    assert.deepEqual(marqueeHits(doc, { x: -5, y: -5, w: 300, h: 300 }, "g"), ["c"]);
  });

  test("skips hidden and locked nodes", () => {
    const doc = build([
      { id: "a", x: 0, y: 0, w: 50, h: 50, props: { visible: false } },
      { id: "b", x: 0, y: 0, w: 50, h: 50, props: { locked: true } },
      { id: "c", x: 0, y: 0, w: 50, h: 50 },
    ]);
    assert.deepEqual(marqueeHits(doc, { x: -5, y: -5, w: 100, h: 100 }, doc.root), ["c"]);
  });
});
