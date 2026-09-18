import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import {
  LEGACY_KEY,
  LocalStorageStore,
  MemoryStore,
  assembleDocument,
  openDatabase,
  openDocumentStore,
  planWrite,
  IndexedDbStore,
} from "../src/core/storage.ts";
import { deleteNodes, insertNode, updateNodes } from "../src/core/commands.ts";
import { createNode } from "../src/core/factory.ts";
import { build, childIds } from "./helpers.ts";

/** A minimal in-memory Storage, enough for the fallback and migration paths. */
function fakeLocalStorage(quotaChars = Infinity): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => {
      if (v.length > quotaChars) throw new DOMException("QuotaExceededError");
      map.set(k, v);
    },
  } as Storage;
}

describe("planWrite", () => {
  const doc = build([{ id: "a" }, { id: "b" }]);

  test("the first save writes everything and asks for a clear", () => {
    const plan = planWrite(doc, null);
    assert.equal(plan.full, true);
    assert.equal(plan.put.length, Object.keys(doc.nodes).length);
    assert.deepEqual(plan.remove, []);
  });

  test("a later save writes only the nodes that changed", () => {
    const next = updateNodes(doc, { a: { x: 99 } });
    const plan = planWrite(next, doc);

    assert.equal(plan.full, false);
    assert.deepEqual(plan.put.map((n) => n.id), ["a"]);
    assert.deepEqual(plan.remove, []);
  });

  test("a deletion is recorded as a removal, plus the parent that lost a child", () => {
    const next = deleteNodes(doc, ["a"]);
    const plan = planWrite(next, doc);

    assert.deepEqual(plan.remove, ["a"]);
    assert.deepEqual(plan.put.map((n) => n.id), ["root"], "the root's children array changed");
  });

  test("an unchanged document plans no writes at all", () => {
    const plan = planWrite(doc, doc);
    assert.equal(plan.full, false);
    assert.equal(plan.put.length, 0);
    assert.equal(plan.remove.length, 0);
  });

  test("the plan stays small as the document grows — the whole point", () => {
    let big = build([{ id: "seed" }]);
    for (let i = 0; i < 500; i++) {
      big = insertNode(big, createNode("rect", { id: `n${i}`, name: `n${i}`, box: { x: i, y: 0, w: 5, h: 5 } }));
    }
    const edited = updateNodes(big, { n250: { x: 7 } });
    const plan = planWrite(edited, big);
    assert.equal(plan.put.length, 1, "one edited node in a 500-node document");
  });
});

describe("assembleDocument", () => {
  test("rebuilds a document from loose records", () => {
    const doc = build([{ id: "f", type: "frame", children: [{ id: "c" }] }]);
    const rebuilt = assembleDocument(Object.values(doc.nodes), doc.root)!;

    assert.ok(rebuilt);
    assert.deepEqual(childIds(rebuilt, "f"), ["c"]);
    assert.deepEqual(Object.keys(rebuilt.nodes).sort(), Object.keys(doc.nodes).sort());
  });

  test("returns null when there is nothing stored", () => {
    assert.equal(assembleDocument([], "root"), null);
  });

  test("a half-written store cannot produce an untraversable document", () => {
    const doc = build([{ id: "f", type: "frame", children: [{ id: "gone" }, { id: "kept" }] }]);
    // Simulate a partial write: the frame references a child whose record never landed.
    const records = Object.values(doc.nodes).filter((n) => n.id !== "gone");
    const rebuilt = assembleDocument(records, doc.root)!;

    assert.equal(rebuilt.nodes.gone, undefined);
    assert.deepEqual(childIds(rebuilt, "f"), ["kept"]);
    for (const id of Object.keys(rebuilt.nodes)) {
      const seen = new Set<string>();
      let cursor: string | null = id;
      while (cursor) {
        assert.ok(!seen.has(cursor), "no cycle");
        seen.add(cursor);
        cursor = rebuilt.nodes[cursor]?.parent ?? null;
      }
    }
  });
});

describe("IndexedDbStore", () => {
  let factory: IDBFactory;
  beforeEach(() => {
    factory = new IDBFactory();
  });

  async function store(name = "test-db") {
    return new IndexedDbStore(await openDatabase(factory, name));
  }

  test("an empty database loads as null", async () => {
    assert.equal(await (await store()).load(), null);
  });

  test("save then load round-trips the document", async () => {
    const s = await store();
    const doc = build([
      { id: "f", type: "frame", x: 5, y: 6, w: 100, h: 80, children: [{ id: "c", x: 1, y: 2 }] },
    ]);
    await s.save(doc);

    const loaded = (await (await store()).load())!;
    assert.ok(loaded);
    assert.deepEqual(Object.keys(loaded.nodes).sort(), Object.keys(doc.nodes).sort());
    assert.equal(loaded.nodes.f!.x, 5);
    assert.deepEqual(childIds(loaded, "f"), ["c"]);
  });

  test("a deleted node is removed from storage, not just from the parent", async () => {
    const s = await store();
    const doc = build([{ id: "a" }, { id: "b" }]);
    await s.save(doc);
    await s.save(deleteNodes(doc, ["a"]));

    const loaded = (await (await store()).load())!;
    assert.equal(loaded.nodes.a, undefined, "the record is gone from the database");
    assert.ok(loaded.nodes.b);
  });

  test("text edits persist, not just geometry", async () => {
    const s = await store();
    const doc = build([{ id: "t", type: "text", props: { text: "before" } }]);
    await s.save(doc);
    await s.save(updateNodes(doc, { t: { text: "after" } }));

    const loaded = (await (await store()).load())!;
    assert.equal((loaded.nodes.t as { text: string }).text, "after");
  });

  test("a base64 image far past the localStorage cap is stored fine", async () => {
    const s = await store();
    // ~6MB of base64 — localStorage would throw QuotaExceededError on this.
    const huge = `data:image/png;base64,${"A".repeat(6 * 1024 * 1024)}`;
    const doc = build([{ id: "img", type: "image", props: { src: huge } }]);
    await s.save(doc);

    const loaded = (await (await store()).load())!;
    assert.equal((loaded.nodes.img as { src: string }).src.length, huge.length);
  });

  test("overlapping saves are serialised and the last one wins", async () => {
    const s = await store();
    const doc = build([{ id: "a", x: 0 }]);
    await Promise.all([
      s.save(doc),
      s.save(updateNodes(doc, { a: { x: 1 } })),
      s.save(updateNodes(doc, { a: { x: 2 } })),
    ]);

    const loaded = (await (await store()).load())!;
    assert.equal(loaded.nodes.a!.x, 2);
  });

  test("loading sets the diff base, so the next save is incremental not a rewrite", async () => {
    const doc = build([{ id: "a" }, { id: "b" }]);
    await (await store()).save(doc);

    const reopened = await store();
    const loaded = (await reopened.load())!;
    // A no-op save after load must plan nothing; if load did not set the base,
    // this would rewrite every node on every session's first autosave.
    const plan = planWrite(loaded, loaded);
    assert.equal(plan.put.length, 0);
  });

  test("clear empties the database", async () => {
    const s = await store();
    await s.save(build([{ id: "a" }]));
    await s.clear();
    assert.equal(await (await store()).load(), null);
  });
});

describe("openDocumentStore", () => {
  test("prefers IndexedDB when it is available", async () => {
    const { store } = await openDocumentStore({
      indexedDB: new IDBFactory(),
      localStorage: fakeLocalStorage(),
      dbName: "prefers",
    });
    assert.equal(store.kind, "indexeddb");
  });

  test("falls back to localStorage when IndexedDB is missing", async () => {
    const { store } = await openDocumentStore({ indexedDB: null, localStorage: fakeLocalStorage() });
    assert.equal(store.kind, "localstorage");
  });

  test("falls back to memory when neither is available", async () => {
    const { store } = await openDocumentStore({ indexedDB: null, localStorage: null });
    assert.equal(store.kind, "memory");
  });

  test("migrates a document left behind by the old localStorage autosave", async () => {
    const local = fakeLocalStorage();
    const legacy = build([{ id: "old", x: 42 }]);
    local.setItem(LEGACY_KEY, JSON.stringify({ version: 1, root: legacy.root, nodes: legacy.nodes }));

    const { store, migrated } = await openDocumentStore({
      indexedDB: new IDBFactory(),
      localStorage: local,
      dbName: "migrate",
    });

    assert.equal(migrated, true);
    assert.equal(store.kind, "indexeddb");
    const loaded = (await store.load())!;
    assert.equal(loaded.nodes.old!.x, 42, "the old document came across");
    assert.equal(local.getItem(LEGACY_KEY), null, "and the legacy key was retired");
  });

  test("migration never overwrites newer work already in IndexedDB", async () => {
    const factory = new IDBFactory();
    const newer = build([{ id: "newer", x: 7 }]);
    const first = await openDocumentStore({ indexedDB: factory, localStorage: null, dbName: "keep" });
    await first.store.save(newer);
    first.store.close();

    const local = fakeLocalStorage();
    const legacy = build([{ id: "older", x: 1 }]);
    local.setItem(LEGACY_KEY, JSON.stringify({ version: 1, root: legacy.root, nodes: legacy.nodes }));

    const { store, migrated } = await openDocumentStore({
      indexedDB: factory,
      localStorage: local,
      dbName: "keep",
    });

    assert.equal(migrated, false);
    const loaded = (await store.load())!;
    assert.ok(loaded.nodes.newer, "the newer document survived");
    assert.equal(loaded.nodes.older, undefined);
    assert.equal(local.getItem(LEGACY_KEY), null, "the legacy key is still retired");
  });

  test("a corrupt legacy value is ignored rather than throwing", async () => {
    const local = fakeLocalStorage();
    local.setItem(LEGACY_KEY, "{not json");
    const { store, migrated } = await openDocumentStore({
      indexedDB: new IDBFactory(),
      localStorage: local,
      dbName: "corrupt",
    });
    assert.equal(migrated, false);
    assert.equal(await store.load(), null);
  });
});

describe("fallback stores", () => {
  test("LocalStorageStore round-trips and reports the 5MB cap", async () => {
    const local = fakeLocalStorage();
    const s = new LocalStorageStore(local);
    await s.save(build([{ id: "a", x: 3 }]));

    const loaded = (await s.load())!;
    assert.equal(loaded.nodes.a!.x, 3);
    const estimate = (await s.estimate())!;
    assert.equal(estimate.quota, 5 * 1024 * 1024);
    assert.ok(estimate.usage > 0);
  });

  test("LocalStorageStore surfaces a quota failure instead of silently dropping", async () => {
    const s = new LocalStorageStore(fakeLocalStorage(100));
    await assert.rejects(() => s.save(build([{ id: "a" }, { id: "b" }, { id: "c" }])));
  });

  test("MemoryStore round-trips within the session", async () => {
    const s = new MemoryStore();
    assert.equal(await s.load(), null);
    const doc = build([{ id: "a" }]);
    await s.save(doc);
    assert.equal((await s.load())!.nodes.a!.id, "a");
  });
});
