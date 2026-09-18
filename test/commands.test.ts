import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  alignNodes,
  cloneNodes,
  deleteNodes,
  distributeNodes,
  groupNodes,
  insertNode,
  moveNodeTo,
  reorderNode,
  reparentNodes,
  resizedBox,
  rotateNodesAbout,
  scaleNodesAbout,
  translateNodes,
  ungroupNodes,
  updateNodes,
} from "../src/core/commands.ts";
import { localTransform, worldBounds } from "../src/core/document.ts";
import { createNode } from "../src/core/factory.ts";
import { apply, normalizeAngle } from "../src/core/math.ts";
import { build, childIds, closeTo, pointCloseTo, rectCloseTo, worldSnapshot, assertWorldUnchanged } from "./helpers.ts";

describe("immutability and structural sharing", () => {
  test("an edit clones only the nodes it touches", () => {
    const doc = build([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const next = updateNodes(doc, { b: { x: 999 } });

    assert.notEqual(next, doc, "document identity changes");
    assert.notEqual(next.nodes.b, doc.nodes.b, "the edited node is replaced");
    // History diffing depends on untouched nodes keeping their identity.
    assert.equal(next.nodes.a, doc.nodes.a, "untouched sibling is shared");
    assert.equal(next.nodes.c, doc.nodes.c, "untouched sibling is shared");
    assert.equal(doc.nodes.b!.x, 0, "the original document is not mutated");
  });

  test("updateNodes refuses to rewrite structural fields", () => {
    const doc = build([{ id: "a" }, { id: "b", type: "frame" }]);
    const next = updateNodes(doc, { a: { id: "hacked", type: "ellipse", parent: "b" } as never });
    assert.equal(next.nodes.a!.id, "a");
    assert.equal(next.nodes.a!.type, "rect");
    assert.equal(next.nodes.a!.parent, "root");
  });

  test("a no-op edit still returns a new document but identical nodes", () => {
    const doc = build([{ id: "a" }]);
    const next = updateNodes(doc, { missing: { x: 1 } });
    assert.equal(next.nodes.a, doc.nodes.a);
  });
});

describe("translateNodes", () => {
  test("moves by a world delta at the top level", () => {
    const doc = build([{ id: "a", x: 10, y: 20 }]);
    const next = translateNodes(doc, ["a"], 5, -5);
    assert.equal(next.nodes.a!.x, 15);
    assert.equal(next.nodes.a!.y, 15);
  });

  test("converts the world delta into a rotated parent's space", () => {
    // Parent rotated +90° maps local (x, y) to world (-y, x), so a world +x
    // drag has to become a local -y move to land in the right place.
    const doc = build([
      { id: "p", type: "frame", x: 0, y: 0, w: 100, h: 100, rotation: Math.PI / 2, children: [{ id: "c", x: 0, y: 0, w: 10, h: 10 }] },
    ]);
    const before = worldBounds(doc, "c");
    const next = translateNodes(doc, ["c"], 30, 0);

    closeTo(next.nodes.c!.x, 0, 1e-9, "local x unchanged");
    closeTo(next.nodes.c!.y, -30, 1e-9, "local y absorbed the world x delta");
    const after = worldBounds(next, "c");
    closeTo(after.x - before.x, 30, 1e-9, "world x moved by exactly the drag");
    closeTo(after.y - before.y, 0, 1e-9, "world y did not move");
  });

  test("moves a selected ancestor once, not once per selected descendant", () => {
    const doc = build([{ id: "g", type: "group", children: [{ id: "c", x: 0, y: 0 }] }]);
    const next = translateNodes(doc, ["g", "c"], 10, 0);
    assert.equal(next.nodes.g!.x, 10);
    assert.equal(next.nodes.c!.x, 0, "the child must not be moved a second time");
  });

  test("skips locked nodes", () => {
    const doc = build([{ id: "a", props: { locked: true } }]);
    assert.equal(translateNodes(doc, ["a"], 10, 10).nodes.a!.x, 0);
  });
});

describe("insert and delete", () => {
  test("insertNode appends and links both ways", () => {
    const doc = build([{ id: "f", type: "frame", children: [{ id: "a" }] }]);
    const node = createNode("rect", { id: "new", name: "new", box: { x: 0, y: 0, w: 10, h: 10 } });
    const next = insertNode(doc, node, { parent: "f" });

    assert.deepEqual(childIds(next, "f"), ["a", "new"]);
    assert.equal(next.nodes.new!.parent, "f");
  });

  test("insertNode honours an explicit index and clamps out-of-range ones", () => {
    const doc = build([{ id: "f", type: "frame", children: [{ id: "a" }, { id: "b" }] }]);
    const make = (id: string) => createNode("rect", { id, name: id, box: { x: 0, y: 0, w: 1, h: 1 } });

    assert.deepEqual(childIds(insertNode(doc, make("x"), { parent: "f", index: 1 }), "f"), ["a", "x", "b"]);
    assert.deepEqual(childIds(insertNode(doc, make("y"), { parent: "f", index: 99 }), "f"), ["a", "b", "y"]);
  });

  test("deleteNodes removes the whole subtree and unlinks the parent", () => {
    const doc = build([{ id: "f", type: "frame", children: [{ id: "g", type: "group", children: [{ id: "leaf" }] }, { id: "keep" }] }]);
    const next = deleteNodes(doc, ["g"]);

    assert.equal(next.nodes.g, undefined);
    assert.equal(next.nodes.leaf, undefined, "descendants are removed too");
    assert.ok(next.nodes.keep, "siblings survive");
    assert.deepEqual(childIds(next, "f"), ["keep"]);
  });

  test("deleteNodes never removes the root and skips locked nodes", () => {
    const doc = build([{ id: "a", props: { locked: true } }]);
    const next = deleteNodes(doc, [doc.root, "a"]);
    assert.ok(next.nodes[doc.root]);
    assert.ok(next.nodes.a, "locked nodes are protected");
  });
});

describe("reparenting", () => {
  test("keeps nodes visually still when moved into a translated frame", () => {
    const doc = build([
      { id: "f", type: "frame", x: 100, y: 50, w: 200, h: 200 },
      { id: "a", x: 10, y: 10, w: 20, h: 20 },
    ]);
    const before = worldSnapshot(doc, ["a"]);
    const next = reparentNodes(doc, ["a"], "f");

    assert.equal(next.nodes.a!.parent, "f");
    assertWorldUnchanged(before, next, ["a"], 1e-9);
    closeTo(next.nodes.a!.x, -90, 1e-9, "local x is now relative to the frame");
  });

  test("keeps nodes visually still when moved into a rotated frame", () => {
    const doc = build([
      { id: "f", type: "frame", x: 0, y: 0, w: 100, h: 100, rotation: Math.PI / 3 },
      { id: "a", x: 40, y: 70, w: 30, h: 20, rotation: 0.2 },
    ]);
    const before = worldSnapshot(doc, ["a"]);
    const next = reparentNodes(doc, ["a"], "f");

    assertWorldUnchanged(before, next, ["a"], 1e-8);
    // The child absorbs the frame's rotation into its own.
    closeTo(normalizeAngle(next.nodes.a!.rotation), normalizeAngle(0.2 - Math.PI / 3), 1e-8);
  });

  test("refuses to reparent a node into its own descendant", () => {
    const doc = build([{ id: "g", type: "group", children: [{ id: "inner", type: "frame" }] }]);
    const next = reparentNodes(doc, ["g"], "inner");
    assert.equal(next.nodes.g!.parent, "root", "the tree is left intact");
  });

  test("moveNodeTo reorders within the same parent without a round trip", () => {
    const doc = build([{ id: "f", type: "frame", children: [{ id: "a" }, { id: "b" }, { id: "c" }] }]);
    const next = moveNodeTo(doc, "a", "f", 3);
    assert.deepEqual(childIds(next, "f"), ["b", "c", "a"]);
  });
});

describe("z-order", () => {
  const doc = build([{ id: "f", type: "frame", children: [{ id: "a" }, { id: "b" }, { id: "c" }] }]);
  const order = (d: typeof doc) => childIds(d, "f");

  test("front, back, forward and backward", () => {
    assert.deepEqual(order(reorderNode(doc, "a", "front")), ["b", "c", "a"]);
    assert.deepEqual(order(reorderNode(doc, "c", "back")), ["c", "a", "b"]);
    assert.deepEqual(order(reorderNode(doc, "a", "forward")), ["b", "a", "c"]);
    assert.deepEqual(order(reorderNode(doc, "c", "backward")), ["a", "c", "b"]);
  });

  test("moves at the extremes are no-ops that preserve identity", () => {
    assert.equal(reorderNode(doc, "c", "front"), doc);
    assert.equal(reorderNode(doc, "a", "back"), doc);
  });
});

describe("grouping", () => {
  test("groupNodes wraps the selection without moving anything", () => {
    const doc = build([
      { id: "a", x: 0, y: 0, w: 50, h: 50 },
      { id: "b", x: 100, y: 100, w: 50, h: 50 },
    ]);
    const before = worldSnapshot(doc, ["a", "b"]);
    const { doc: next, groupId } = groupNodes(doc, ["a", "b"]);

    assert.ok(groupId);
    assertWorldUnchanged(before, next, ["a", "b"], 1e-9);
    rectCloseTo(worldBounds(next, groupId!), { x: 0, y: 0, w: 150, h: 150 }, 1e-9, "group box");
    assert.equal(next.nodes.a!.parent, groupId);
  });

  test("groupNodes needs at least two nodes", () => {
    const doc = build([{ id: "a" }]);
    assert.equal(groupNodes(doc, ["a"]).groupId, null);
  });

  test("ungroupNodes restores the children in place", () => {
    const doc = build([
      { id: "a", x: 0, y: 0, w: 50, h: 50 },
      { id: "b", x: 100, y: 100, w: 50, h: 50 },
    ]);
    const before = worldSnapshot(doc, ["a", "b"]);
    const grouped = groupNodes(doc, ["a", "b"]);
    const { doc: next, released } = ungroupNodes(grouped.doc, [grouped.groupId!]);

    assert.deepEqual(released.sort(), ["a", "b"]);
    assert.equal(next.nodes[grouped.groupId!], undefined, "the group itself is gone");
    assert.equal(next.nodes.a!.parent, "root");
    assertWorldUnchanged(before, next, ["a", "b"], 1e-9);
  });

  test("group then ungroup is a round trip through a rotated frame", () => {
    const doc = build([
      {
        id: "f",
        type: "frame",
        x: 20,
        y: 30,
        w: 300,
        h: 300,
        rotation: 0.5,
        children: [
          { id: "a", x: 0, y: 0, w: 40, h: 40 },
          { id: "b", x: 80, y: 60, w: 40, h: 40, rotation: -0.3 },
        ],
      },
    ]);
    const before = worldSnapshot(doc, ["a", "b"]);
    const grouped = groupNodes(doc, ["a", "b"]);
    assertWorldUnchanged(before, grouped.doc, ["a", "b"], 1e-8);

    const { doc: next } = ungroupNodes(grouped.doc, [grouped.groupId!]);
    assertWorldUnchanged(before, next, ["a", "b"], 1e-8);
    assert.equal(next.nodes.a!.parent, "f", "children return to the original frame");
  });
});

describe("cloneNodes", () => {
  test("deep-clones a subtree with fresh ids", () => {
    const doc = build([{ id: "g", type: "group", children: [{ id: "c1" }, { id: "c2" }] }]);
    const { doc: next, ids, mapping } = cloneNodes(doc, ["g"]);

    assert.equal(ids.length, 1);
    assert.notEqual(ids[0], "g");
    const cloneChildren = childIds(next, ids[0]!);
    assert.equal(cloneChildren.length, 2);
    for (const childId of cloneChildren) {
      assert.ok(!["c1", "c2"].includes(childId), "children get new ids too");
      assert.equal(next.nodes[childId]!.parent, ids[0]);
    }
    assert.equal(mapping.get("c1"), cloneChildren[0]);
    assert.ok(next.nodes.g, "the original survives");
  });

  test("applies an offset to the clones only", () => {
    const doc = build([{ id: "a", x: 10, y: 10 }]);
    const { doc: next, ids } = cloneNodes(doc, ["a"], { offsetX: 16, offsetY: 16 });
    assert.equal(next.nodes.a!.x, 10);
    assert.equal(next.nodes[ids[0]!]!.x, 26);
  });
});

describe("alignment and distribution", () => {
  test("aligns to the selection bounds", () => {
    const doc = build([
      { id: "a", x: 0, y: 0, w: 50, h: 50 },
      { id: "b", x: 100, y: 200, w: 30, h: 30 },
    ]);
    const next = alignNodes(doc, ["a", "b"], "left");
    closeTo(worldBounds(next, "a").x, 0, 1e-9);
    closeTo(worldBounds(next, "b").x, 0, 1e-9);
  });

  test("centres a rotated node by its visual bounds", () => {
    const doc = build([
      { id: "a", x: 0, y: 0, w: 100, h: 100 },
      { id: "b", x: 300, y: 0, w: 100, h: 100, rotation: Math.PI / 4 },
    ]);
    const next = alignNodes(doc, ["a", "b"], "hcenter");
    const ba = worldBounds(next, "a");
    const bb = worldBounds(next, "b");
    closeTo(ba.x + ba.w / 2, bb.x + bb.w / 2, 1e-8, "centres coincide");
  });

  test("a single selection aligns to its parent frame", () => {
    const doc = build([
      { id: "f", type: "frame", x: 0, y: 0, w: 400, h: 400, children: [{ id: "a", x: 10, y: 10, w: 50, h: 50 }] },
    ]);
    const next = alignNodes(doc, ["a"], "right");
    closeTo(worldBounds(next, "a").x + 50, 400, 1e-9);
  });

  test("distribute equalises the gaps and leaves the extremes fixed", () => {
    const doc = build([
      { id: "a", x: 0, y: 0, w: 20, h: 20 },
      { id: "b", x: 30, y: 0, w: 20, h: 20 },
      { id: "c", x: 200, y: 0, w: 20, h: 20 },
    ]);
    const next = distributeNodes(doc, ["a", "b", "c"], "h");
    const [a, b, c] = ["a", "b", "c"].map((id) => worldBounds(next, id));

    closeTo(a!.x, 0, 1e-9, "first stays put");
    closeTo(c!.x, 200, 1e-9, "last stays put");
    closeTo(b!.x - (a!.x + a!.w), c!.x - (b!.x + b!.w), 1e-9, "gaps are equal");
  });

  test("distribute needs three nodes", () => {
    const doc = build([{ id: "a" }, { id: "b" }]);
    assert.equal(distributeNodes(doc, ["a", "b"], "h"), doc);
  });
});

describe("resizedBox", () => {
  test("pins the opposite corner for an unrotated node", () => {
    const doc = build([{ id: "a", x: 10, y: 20, w: 100, h: 50 }]);
    // Drag the SE handle: the NW corner (unit 0,0) must not move.
    const box = resizedBox(doc.nodes.a!, { x: 0, y: 0 }, 200, 80);
    assert.deepEqual(box, { x: 10, y: 20, w: 200, h: 80 });
  });

  test("pins the anchor corner for a rotated node", () => {
    const node = build([{ id: "a", x: 0, y: 0, w: 100, h: 100, rotation: Math.PI / 6 }]).nodes.a!;
    const anchor = { x: 1, y: 1 }; // Pin the SE corner, drag the NW one.
    const pinnedBefore = apply(localTransform(node), { x: anchor.x * node.w, y: anchor.y * node.h });

    const box = resizedBox(node, anchor, 40, 250);
    const resized = { ...node, ...box };
    const pinnedAfter = apply(localTransform(resized), { x: anchor.x * box.w, y: anchor.y * box.h });

    pointCloseTo(pinnedAfter, pinnedBefore, 1e-9, "anchor corner");
    closeTo(box.w, 40, 1e-9);
    closeTo(box.h, 250, 1e-9);
  });

  test("resizing about the centre keeps the centre fixed", () => {
    const node = build([{ id: "a", x: 0, y: 0, w: 100, h: 100, rotation: 0.9 }]).nodes.a!;
    const box = resizedBox(node, { x: 0.5, y: 0.5 }, 300, 20);
    const resized = { ...node, ...box };
    pointCloseTo(
      apply(localTransform(resized), { x: box.w / 2, y: box.h / 2 }),
      apply(localTransform(node), { x: 50, y: 50 }),
      1e-9,
      "centre",
    );
  });

  test("clamps to a non-zero size so the matrix never becomes singular", () => {
    const node = build([{ id: "a", w: 100, h: 100 }]).nodes.a!;
    const box = resizedBox(node, { x: 0, y: 0 }, -50, 0);
    assert.ok(box.w > 0 && box.h > 0);
  });
});

describe("scale and rotate about a pivot", () => {
  test("scaleNodesAbout keeps the pivot fixed and doubles the span", () => {
    const doc = build([
      { id: "a", x: 0, y: 0, w: 50, h: 50 },
      { id: "b", x: 100, y: 0, w: 50, h: 50 },
    ]);
    const next = scaleNodesAbout(doc, ["a", "b"], { x: 0, y: 0 }, 2, 2);
    rectCloseTo(worldBounds(next, "a"), { x: 0, y: 0, w: 100, h: 100 }, 1e-9);
    rectCloseTo(worldBounds(next, "b"), { x: 200, y: 0, w: 100, h: 100 }, 1e-9);
  });

  test("rotateNodesAbout orbits the pivot and adds to each node's own rotation", () => {
    const doc = build([{ id: "a", x: 100, y: 0, w: 20, h: 20, rotation: 0.25 }]);
    const next = rotateNodesAbout(doc, ["a"], { x: 0, y: 0 }, Math.PI / 2);
    const b = worldBounds(next, "a");
    // The centre was at (110, 10); a quarter turn sends it to (-10, 110).
    closeTo(b.x + b.w / 2, -10, 1e-8, "centre x");
    closeTo(b.y + b.h / 2, 110, 1e-8, "centre y");
    closeTo(next.nodes.a!.rotation, 0.25 + Math.PI / 2, 1e-9);
  });

  test("rotating by a full turn returns to the start", () => {
    const doc = build([{ id: "a", x: 30, y: 40, w: 20, h: 20 }]);
    const next = rotateNodesAbout(doc, ["a"], { x: 5, y: 5 }, Math.PI * 2);
    rectCloseTo(worldBounds(next, "a"), worldBounds(doc, "a"), 1e-8);
  });
});
