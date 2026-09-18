import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ImportError, deserialize, fromJSON, serialize, toJSON } from "../src/core/serialize.ts";
import { worldBounds } from "../src/core/document.ts";
import { build, childIds, fields, rectCloseTo } from "./helpers.ts";
import { sampleDocument } from "../src/sample.ts";

describe("round trip", () => {
  test("a document survives export and import unchanged", () => {
    const doc = build([
      {
        id: "f",
        type: "frame",
        x: 10,
        y: 20,
        w: 300,
        h: 200,
        rotation: 0.4,
        children: [
          { id: "a", type: "rect", x: 5, y: 5, w: 50, h: 50, props: { fill: { color: "#ff0000" }, radius: 8 } },
          { id: "t", type: "text", x: 0, y: 80, w: 200, h: 40, props: { text: "hello\nworld", fontSize: 18, align: "center" } },
        ],
      },
    ]);

    const { doc: restored, warnings } = fromJSON(toJSON(doc));
    assert.deepEqual(warnings, []);
    assert.deepEqual(Object.keys(restored.nodes).sort(), Object.keys(doc.nodes).sort());
    assert.deepEqual(childIds(restored, "f"), ["a", "t"], "z-order is preserved");

    rectCloseTo(worldBounds(restored, "a"), worldBounds(doc, "a"), 1e-2, "world position of a");
    const text = fields(restored, "t");
    assert.equal(text.text, "hello\nworld");
    assert.equal(text.align, "center");
    assert.equal(text.fontSize, 18);
    assert.equal((fields(restored, "a").fill as { color: string }).color, "#ff0000");
  });

  test("the full sample document round-trips", () => {
    const doc = sampleDocument();
    const { doc: restored } = fromJSON(toJSON(doc));
    assert.equal(Object.keys(restored.nodes).length, Object.keys(doc.nodes).length);
  });

  test("export rounds geometry so files stay readable", () => {
    const doc = build([{ id: "a", x: 1 / 3, y: 0, w: 10, h: 10 }]);
    const out = serialize(doc).nodes.a as { x: number };
    assert.equal(out.x, 0.33);
  });
});

describe("malformed input is survivable", () => {
  test("non-JSON throws a typed error", () => {
    assert.throws(() => fromJSON("{nope"), ImportError);
  });

  test("a top-level non-object throws", () => {
    assert.throws(() => deserialize([1, 2, 3]), ImportError);
    assert.throws(() => deserialize({ version: 1 }), ImportError);
  });

  test("nodes of unknown type are dropped with a warning", () => {
    const { doc, warnings } = deserialize({
      nodes: { a: { type: "wormhole" }, b: { type: "rect", x: 0, y: 0, w: 10, h: 10 } },
    });
    assert.equal(doc.nodes.a, undefined);
    assert.ok(doc.nodes.b);
    assert.ok(warnings.some((w) => w.includes("wormhole")));
  });

  test("missing children are dropped and orphans become top-level", () => {
    const { doc, warnings } = deserialize({
      nodes: {
        f: { type: "frame", children: ["ghost", "real"] },
        real: { type: "rect" },
        orphan: { type: "rect" },
      },
    });
    assert.deepEqual(childIds(doc, "f"), ["real"]);
    assert.ok(warnings.some((w) => w.includes("ghost")));
    assert.deepEqual(childIds(doc, doc.root).sort(), ["f", "orphan"]);
  });

  test("a node claimed by two parents is kept by the first only", () => {
    const { doc, warnings } = deserialize({
      nodes: {
        f1: { type: "frame", children: ["shared"] },
        f2: { type: "frame", children: ["shared"] },
        shared: { type: "rect" },
      },
    });
    const total = childIds(doc, "f1").length + childIds(doc, "f2").length;
    assert.equal(total, 1, "the node appears under exactly one parent");
    assert.equal(doc.nodes.shared!.parent === "f1" || doc.nodes.shared!.parent === "f2", true);
    assert.ok(warnings.some((w) => w.includes("two parents")));
  });

  test("a parent cycle is broken rather than hanging the traversal", () => {
    const { doc, warnings } = deserialize({
      nodes: {
        a: { type: "frame", children: ["b"] },
        b: { type: "frame", children: ["a"] },
      },
    });
    // Whatever the resolution, walking up from every node must terminate.
    for (const id of Object.keys(doc.nodes)) {
      const seen = new Set<string>();
      let cursor: string | null = id;
      while (cursor) {
        assert.ok(!seen.has(cursor), `cycle still reachable from ${id}`);
        seen.add(cursor);
        cursor = doc.nodes[cursor]?.parent ?? null;
      }
    }
    assert.ok(warnings.some((w) => w.toLowerCase().includes("cycle")));
  });

  test("a node cannot be its own child", () => {
    const { doc } = deserialize({ nodes: { a: { type: "frame", children: ["a"] } } });
    assert.deepEqual(childIds(doc, "a"), []);
  });

  test("garbage field values fall back to defaults instead of poisoning the model", () => {
    const { doc } = deserialize({
      nodes: {
        a: {
          type: "rect",
          x: "banana",
          y: NaN,
          w: -5,
          h: null,
          rotation: "spin",
          opacity: 17,
          visible: "yes",
          radius: -3,
        },
      },
    });
    const a = fields(doc, "a");
    assert.equal(a.x, 0);
    assert.equal(a.y, 0);
    assert.ok((a.w as number) > 0, "width is clamped positive");
    assert.equal(a.rotation, 0);
    assert.equal(a.opacity, 1, "opacity is clamped into 0..1");
    assert.equal(a.visible, true);
    assert.equal(a.radius, 0);
  });

  test("the synthesised root cannot be overwritten by the file", () => {
    const { doc } = deserialize({ nodes: { root: { type: "rect", w: 5, h: 5 } } });
    assert.equal(doc.nodes.root!.type, "frame");
    assert.equal(doc.nodes.root!.parent, null);
  });

  test("remote image sources are stripped, data URLs are kept", () => {
    const { doc, warnings } = deserialize({
      nodes: {
        remote: { type: "image", src: "https://example.com/tracker.png" },
        inline: { type: "image", src: "data:image/png;base64,AAAA" },
      },
    });
    assert.equal(fields(doc, "remote").src, "");
    assert.equal(fields(doc, "inline").src, "data:image/png;base64,AAAA");
    assert.ok(warnings.some((w) => w.includes("non-data image")));
  });

  test("a newer file version imports with a warning rather than failing", () => {
    const { warnings } = deserialize({ version: 99, nodes: { a: { type: "rect" } } });
    assert.ok(warnings.some((w) => w.includes("99")));
  });

  test("an empty document is valid", () => {
    const { doc } = deserialize({ nodes: {} });
    assert.deepEqual(childIds(doc, doc.root), []);
  });
});
