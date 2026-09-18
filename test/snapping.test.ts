import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeSnap, snapSelection } from "../src/interaction/snapping.ts";
import { build, closeTo } from "./helpers.ts";

/** A static neighbour at x 100..200, y 0..100 to snap against. */
const doc = build([
  { id: "target", x: 100, y: 0, w: 100, h: 100 },
  { id: "moving", x: 0, y: 0, w: 40, h: 40 },
]);

const opts = { zoom: 1, thresholdPx: 6 };

describe("edge snapping", () => {
  test("snaps a left edge onto a neighbour's left edge", () => {
    // Moving box sits 3px off the target's left edge — inside the threshold.
    const result = computeSnap(doc, { x: 97, y: 300, w: 40, h: 40 }, ["moving"], doc.root, opts);
    closeTo(result.dx, 3, 1e-9, "pulled onto x = 100");
    assert.equal(result.guides.length, 1);
    assert.equal(result.guides[0]!.axis, "x");
    closeTo(result.guides[0]!.position, 100, 1e-9);
  });

  test("snaps a right edge onto a neighbour's right edge", () => {
    const result = computeSnap(doc, { x: 158, y: 300, w: 40, h: 40 }, ["moving"], doc.root, opts);
    closeTo(result.dx, 2, 1e-9, "right edge 198 → 200");
  });

  test("snaps centres together", () => {
    // Centre at 148 should be pulled to the target's centre at 150.
    const result = computeSnap(doc, { x: 128, y: 300, w: 40, h: 40 }, ["moving"], doc.root, opts);
    closeTo(result.dx, 2, 1e-9);
  });

  test("snaps on both axes at once", () => {
    const result = computeSnap(doc, { x: 97, y: 3, w: 40, h: 40 }, ["moving"], doc.root, opts);
    closeTo(result.dx, 3, 1e-9);
    closeTo(result.dy, -3, 1e-9);
    assert.equal(result.guides.length, 2);
  });

  test("does nothing beyond the threshold", () => {
    // Edges at 70 / 90 / 110 — every one at least 10 units from a target edge
    // (100 / 150 / 200), so nothing is in range.
    const result = computeSnap(doc, { x: 70, y: 300, w: 40, h: 40 }, ["moving"], doc.root, opts);
    assert.equal(result.dx, 0);
    assert.equal(result.guides.length, 0);
  });

  test("prefers the nearest candidate when several are in range", () => {
    const crowded = build([
      { id: "a", x: 100, y: 0, w: 10, h: 10 },
      { id: "b", x: 104, y: 0, w: 10, h: 10 },
      { id: "m", x: 0, y: 0, w: 10, h: 10 },
    ]);
    // Left edge at 103: 1 away from b's left (104), 3 away from a's left (100).
    const result = computeSnap(crowded, { x: 103, y: 300, w: 10, h: 10 }, ["m"], crowded.root, opts);
    closeTo(result.dx, 1, 1e-9, "snapped to the closer edge");
  });
});

describe("threshold and zoom", () => {
  test("stickiness is defined in screen pixels, so it shrinks as you zoom in", () => {
    const box = { x: 96, y: 300, w: 40, h: 40 };
    // 4 world units away. At zoom 1 the 6px threshold covers it.
    closeTo(computeSnap(doc, box, ["moving"], doc.root, { zoom: 1, thresholdPx: 6 }).dx, 4, 1e-9);
    // At zoom 4, 6 screen px is only 1.5 world units — out of range.
    assert.equal(computeSnap(doc, box, ["moving"], doc.root, { zoom: 4, thresholdPx: 6 }).dx, 0);
    // At zoom 0.25, 6 screen px is 24 world units — comfortably in range.
    closeTo(computeSnap(doc, box, ["moving"], doc.root, { zoom: 0.25, thresholdPx: 6 }).dx, 4, 1e-9);
  });

  test("can be turned off entirely", () => {
    const result = computeSnap(doc, { x: 97, y: 0, w: 40, h: 40 }, ["moving"], doc.root, {
      zoom: 1,
      enabled: false,
    });
    assert.equal(result.dx, 0);
    assert.equal(result.guides.length, 0);
  });
});

describe("candidate selection", () => {
  test("a node never snaps to itself", () => {
    const result = computeSnap(doc, { x: 0, y: 0, w: 40, h: 40 }, ["moving"], doc.root, opts);
    // Its own edges are at 0/20/40 — if self-snapping were allowed dx would be 0
    // for the wrong reason, so check the guide set is empty instead.
    assert.equal(result.guides.some((g) => g.axis === "x" && g.position === 0), false);
  });

  test("nodes being dragged together are all excluded", () => {
    const three = build([
      { id: "a", x: 0, y: 0, w: 40, h: 40 },
      { id: "b", x: 43, y: 0, w: 40, h: 40 },
      { id: "far", x: 500, y: 0, w: 40, h: 40 },
    ]);
    const result = computeSnap(three, { x: 0, y: 0, w: 83, h: 40 }, ["a", "b"], three.root, opts);
    assert.equal(result.dx, 0, "the selection does not snap to its own members");
  });

  test("hidden nodes are not snap targets", () => {
    const withHidden = build([
      { id: "ghost", x: 100, y: 0, w: 100, h: 100, props: { visible: false } },
      { id: "m", x: 0, y: 0, w: 40, h: 40 },
    ]);
    const result = computeSnap(withHidden, { x: 97, y: 300, w: 40, h: 40 }, ["m"], withHidden.root, opts);
    assert.equal(result.dx, 0);
  });

  test("inside a frame, the frame itself is a snap target", () => {
    const nested = build([
      {
        id: "f",
        type: "frame",
        x: 0,
        y: 0,
        w: 300,
        h: 300,
        children: [{ id: "c", x: 0, y: 0, w: 50, h: 50 }],
      },
    ]);
    // Child's left edge 4 world units inside the frame's left edge.
    const result = computeSnap(nested, { x: 4, y: 150, w: 50, h: 50 }, ["c"], "f", opts);
    closeTo(result.dx, -4, 1e-9, "pulled flush to the frame edge");
  });
});

describe("grid snapping", () => {
  test("the grid only applies where nothing else matched", () => {
    const lonely = build([{ id: "m", x: 0, y: 0, w: 40, h: 40 }]);
    const result = computeSnap(lonely, { x: 22, y: 300, w: 40, h: 40 }, ["m"], lonely.root, {
      zoom: 1,
      thresholdPx: 6,
      gridSize: 20,
    });
    closeTo(result.dx, -2, 1e-9, "snapped back to the 20-unit grid");
    assert.equal(result.guides.length, 0, "a grid snap draws no guide line");
  });
});

describe("snapSelection", () => {
  test("derives the moving bounds from the selection", () => {
    const d = build([
      { id: "target", x: 100, y: 0, w: 100, h: 100 },
      { id: "m", x: 97, y: 300, w: 40, h: 40 },
    ]);
    closeTo(snapSelection(d, ["m"], d.root, opts).dx, 3, 1e-9);
  });

  test("an empty selection is a no-op", () => {
    const result = snapSelection(doc, [], doc.root, opts);
    assert.equal(result.dx, 0);
    assert.equal(result.dy, 0);
  });
});
