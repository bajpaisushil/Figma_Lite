// Installs the IndexedDB globals Node lacks — notably IDBKeyRange, which the
// store uses to address one document's nodes as a contiguous key range.
import "fake-indexeddb/auto";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import {
  ACTIVE_KEY,
  DOC_STORE,
  IndexedDbLibrary,
  LEGACY_LOCAL_KEY,
  LocalStorageLibrary,
  MemoryLibrary,
  applyPlanToSizes,
  assembleDocument,
  formatBytes,
  measureDocument,
  openDatabase,
  openLibrary,
  planWrite,
  uniqueName,
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
      if (v.length > quotaChars) throw new Error("QuotaExceededError");
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
    const plan = planWrite(updateNodes(doc, { a: { x: 99 } }), doc);
    assert.equal(plan.full, false);
    assert.deepEqual(plan.put.map((n) => n.id), ["a"]);
  });

  test("a deletion is recorded as a removal, plus the parent that lost a child", () => {
    const plan = planWrite(deleteNodes(doc, ["a"]), doc);
    assert.deepEqual(plan.remove, ["a"]);
    assert.deepEqual(plan.put.map((n) => n.id), ["root"]);
  });

  test("an unchanged document plans no writes at all", () => {
    const plan = planWrite(doc, doc);
    assert.equal(plan.put.length + plan.remove.length, 0);
  });

  test("the plan stays small as the document grows — the whole point", () => {
    let big = build([{ id: "seed" }]);
    for (let i = 0; i < 500; i++) {
      big = insertNode(big, createNode("rect", { id: `n${i}`, name: `n${i}`, box: { x: i, y: 0, w: 5, h: 5 } }));
    }
    const plan = planWrite(updateNodes(big, { n250: { x: 7 } }), big);
    assert.equal(plan.put.length, 1, "one edited node in a 500-node document");
  });
});

describe("size accounting", () => {
  test("measureDocument totals every node", () => {
    const doc = build([{ id: "a" }, { id: "b" }]);
    const { sizes, total } = measureDocument(doc);
    assert.equal(sizes.size, Object.keys(doc.nodes).length);
    assert.ok(total > 0);
  });

  test("a running total tracks edits without re-measuring the document", () => {
    const doc = build([{ id: "a" }, { id: "b" }]);
    const { sizes, total } = measureDocument(doc);

    // Growing a node's text grows the total by exactly that much.
    const grown = updateNodes(doc, { a: { name: "x".repeat(1000) } });
    const after = applyPlanToSizes(planWrite(grown, doc), sizes, total);
    assert.ok(after > total + 900, `expected ~1000 more bytes, went from ${total} to ${after}`);

    // And the incremental total agrees with measuring from scratch.
    assert.equal(after, measureDocument(grown).total);
  });

  test("deleting nodes subtracts their size", () => {
    const doc = build([{ id: "a" }, { id: "b" }]);
    const { sizes, total } = measureDocument(doc);
    const trimmed = deleteNodes(doc, ["a"]);
    const after = applyPlanToSizes(planWrite(trimmed, doc), sizes, total);
    assert.equal(after, measureDocument(trimmed).total);
    assert.ok(after < total);
  });

  test("formatBytes is readable at every scale", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(1024 * 1024 * 2.5), "2.5 MB");
    assert.equal(formatBytes(1024 ** 3 * 8.4), "8.40 GB");
  });
});

describe("assembleDocument", () => {
  test("rebuilds a document from loose records", () => {
    const doc = build([{ id: "f", type: "frame", children: [{ id: "c" }] }]);
    const rebuilt = assembleDocument(Object.values(doc.nodes), doc.root)!;
    assert.deepEqual(childIds(rebuilt, "f"), ["c"]);
  });

  test("returns null when there is nothing stored", () => {
    assert.equal(assembleDocument([], "root"), null);
  });

  test("a half-written store cannot produce an untraversable document", () => {
    const doc = build([{ id: "f", type: "frame", children: [{ id: "gone" }, { id: "kept" }] }]);
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

describe("uniqueName", () => {
  test("only suffixes when it has to", () => {
    assert.equal(uniqueName("Untitled", []), "Untitled");
    assert.equal(uniqueName("Untitled", ["Untitled"]), "Untitled 2");
    assert.equal(uniqueName("Untitled", ["Untitled", "Untitled 2"]), "Untitled 3");
    assert.equal(uniqueName("Untitled", ["Untitled 2"]), "Untitled");
  });
});

describe("IndexedDbLibrary", () => {
  let factory: IDBFactory;
  beforeEach(() => {
    factory = new IDBFactory();
  });

  const open = async (name = "lib") => new IndexedDbLibrary(await openDatabase(factory, name));

  test("an empty library lists nothing", async () => {
    assert.deepEqual(await (await open()).list(), []);
  });

  test("create, load and list round-trip a design", async () => {
    const lib = await open();
    const doc = build([{ id: "f", type: "frame", x: 5, children: [{ id: "c" }] }]);
    const summary = await lib.create("My design", doc);

    assert.equal(summary.name, "My design");
    assert.ok(summary.bytes > 0);
    assert.equal(summary.nodeCount, Object.keys(doc.nodes).length);

    const reopened = await open();
    const listed = await reopened.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.name, "My design");

    const loaded = (await reopened.load(summary.id))!;
    assert.equal(loaded.nodes.f!.x, 5);
    assert.deepEqual(childIds(loaded, "f"), ["c"]);
  });

  test("documents are isolated — deleting one leaves the others intact", async () => {
    const lib = await open();
    const a = await lib.create("A", build([{ id: "na" }]));
    const b = await lib.create("B", build([{ id: "nb" }]));

    await lib.remove(a.id);

    const reopened = await open();
    assert.deepEqual((await reopened.list()).map((d) => d.name), ["B"]);
    assert.equal(await reopened.load(a.id), null, "the deleted design is gone");
    const kept = (await reopened.load(b.id))!;
    assert.ok(kept.nodes.nb, "and its nodes went with it, not B's");
  });

  test("saving one design does not disturb another", async () => {
    const lib = await open();
    const a = await lib.create("A", build([{ id: "na", x: 1 }]));
    const b = await lib.create("B", build([{ id: "nb", x: 2 }]));

    await lib.save(a.id, build([{ id: "na", x: 99 }]));

    assert.equal((await lib.load(a.id))!.nodes.na!.x, 99);
    assert.equal((await lib.load(b.id))!.nodes.nb!.x, 2);
  });

  test("a deleted node is removed from storage, not just from its parent", async () => {
    const lib = await open();
    const doc = build([{ id: "a" }, { id: "b" }]);
    const summary = await lib.create("d", doc);
    await lib.save(summary.id, deleteNodes(doc, ["a"]));

    const loaded = (await (await open()).load(summary.id))!;
    assert.equal(loaded.nodes.a, undefined);
    assert.ok(loaded.nodes.b);
  });

  test("a base64 image far past the localStorage cap is stored fine", async () => {
    const lib = await open();
    // ~6MB of base64 — localStorage would throw QuotaExceededError on this.
    const huge = `data:image/png;base64,${"A".repeat(6 * 1024 * 1024)}`;
    const summary = await lib.create("big", build([{ id: "img", type: "image", props: { src: huge } }]));

    const loaded = (await (await open()).load(summary.id))!;
    assert.equal((loaded.nodes.img as { src: string }).src.length, huge.length);
    const listed = (await (await open()).list())[0]!;
    assert.ok(listed.bytes > 6_000_000, `size is reported (${listed.bytes})`);
  });

  test("overlapping saves are serialised and the last one wins", async () => {
    const lib = await open();
    const doc = build([{ id: "a", x: 0 }]);
    const summary = await lib.create("d", doc);

    await Promise.all([
      lib.save(summary.id, updateNodes(doc, { a: { x: 1 } })),
      lib.save(summary.id, updateNodes(doc, { a: { x: 2 } })),
      lib.save(summary.id, updateNodes(doc, { a: { x: 3 } })),
    ]);
    assert.equal((await (await open()).load(summary.id))!.nodes.a!.x, 3);
  });

  test("loading sets the diff base, so the next save is incremental not a rewrite", async () => {
    const lib = await open();
    const summary = await lib.create("d", build([{ id: "a" }, { id: "b" }]));

    const reopened = await open();
    const loaded = (await reopened.load(summary.id))!;
    // If load did not set the base, every session's first autosave would
    // rewrite every node in the document.
    assert.equal(planWrite(loaded, loaded).put.length, 0);
  });

  test("rename updates the summary without touching the nodes", async () => {
    const lib = await open();
    const summary = await lib.create("Before", build([{ id: "a", x: 4 }]));
    await lib.rename(summary.id, "After");

    const reopened = await open();
    assert.equal((await reopened.list())[0]!.name, "After");
    assert.equal((await reopened.load(summary.id))!.nodes.a!.x, 4);
  });

  test("the active document id persists and is cleared when that design is deleted", async () => {
    const lib = await open();
    const summary = await lib.create("d", build([{ id: "a" }]));
    await lib.setActiveId(summary.id);
    assert.equal(await (await open()).activeId(), summary.id);

    await lib.remove(summary.id);
    assert.equal(await (await open()).activeId(), null);
  });

  test("list is ordered by most recently updated", async () => {
    const lib = await open();
    const a = await lib.create("A", build([{ id: "na" }]));
    await lib.create("B", build([{ id: "nb" }]));
    await lib.save(a.id, build([{ id: "na", x: 5 }]));

    assert.equal((await lib.list())[0]!.name, "A", "A was touched last");
  });

  test("clearAll empties the library", async () => {
    const lib = await open();
    await lib.create("A", build([{ id: "a" }]));
    await lib.clearAll();

    const reopened = await open();
    assert.deepEqual(await reopened.list(), []);
    assert.equal(await reopened.activeId(), null);
  });
});

describe("schema upgrade", () => {
  /** Builds a v1 database by hand: a single document in a node-keyed store. */
  function seedV1(factory: IDBFactory, name: string, nodes: unknown[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("nodes", { keyPath: "id" });
        db.createObjectStore("meta", { keyPath: "key" });
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["nodes", "meta"], "readwrite");
        for (const node of nodes) tx.objectStore("nodes").put(node);
        tx.objectStore("meta").put({ key: "root", value: "root" });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  }

  test("a v1 single-document database becomes the library's first design", async () => {
    const factory = new IDBFactory();
    const legacy = build([{ id: "old", x: 42 }]);
    await seedV1(factory, "upgrade", Object.values(legacy.nodes));

    const lib = new IndexedDbLibrary(await openDatabase(factory, "upgrade"));
    const listed = await lib.list();

    assert.equal(listed.length, 1, "one design carried across");
    assert.equal(listed[0]!.name, "Untitled");
    const loaded = (await lib.load(listed[0]!.id))!;
    assert.equal(loaded.nodes.old!.x, 42, "the work survived the upgrade");
    assert.equal(await lib.activeId(), listed[0]!.id, "and it opens on next boot");
  });

  test("upgrading an empty v1 database just leaves an empty library", async () => {
    const factory = new IDBFactory();
    await seedV1(factory, "empty-upgrade", []);
    const lib = new IndexedDbLibrary(await openDatabase(factory, "empty-upgrade"));
    assert.deepEqual(await lib.list(), []);
  });

  test("the upgraded database still has the v2 stores and no v1 leftovers", async () => {
    const factory = new IDBFactory();
    await seedV1(factory, "stores", Object.values(build([{ id: "x" }]).nodes));
    const db = await openDatabase(factory, "stores");

    assert.ok(db.objectStoreNames.contains(DOC_STORE));
    assert.ok(!db.objectStoreNames.contains("nodes"), "the v1 store was dropped");
    const tx = db.transaction("meta", "readonly");
    const active = await new Promise((resolve, reject) => {
      const r = tx.objectStore("meta").get(ACTIVE_KEY);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    assert.ok(active, "the migrated design is marked active");
  });
});

describe("openLibrary", () => {
  test("prefers IndexedDB when it is available", async () => {
    const { library } = await openLibrary({
      indexedDB: new IDBFactory(),
      localStorage: fakeLocalStorage(),
      dbName: "prefers",
    });
    assert.equal(library.kind, "indexeddb");
  });

  test("falls back to localStorage when IndexedDB is missing", async () => {
    const { library } = await openLibrary({ indexedDB: null, localStorage: fakeLocalStorage() });
    assert.equal(library.kind, "localstorage");
  });

  test("falls back to memory when neither is available", async () => {
    const { library } = await openLibrary({ indexedDB: null, localStorage: null });
    assert.equal(library.kind, "memory");
  });

  test("migrates the document left behind by the original localStorage autosave", async () => {
    const local = fakeLocalStorage();
    const legacy = build([{ id: "old", x: 42 }]);
    local.setItem(LEGACY_LOCAL_KEY, JSON.stringify({ version: 1, root: legacy.root, nodes: legacy.nodes }));

    const { library, migrated } = await openLibrary({
      indexedDB: new IDBFactory(),
      localStorage: local,
      dbName: "migrate",
    });

    assert.equal(migrated, true);
    const listed = await library.list();
    assert.equal(listed.length, 1);
    assert.equal((await library.load(listed[0]!.id))!.nodes.old!.x, 42);
    assert.equal(local.getItem(LEGACY_LOCAL_KEY), null, "the legacy key was retired");
    assert.equal(await library.activeId(), listed[0]!.id);
  });

  test("a corrupt legacy value is ignored rather than throwing", async () => {
    const local = fakeLocalStorage();
    local.setItem(LEGACY_LOCAL_KEY, "{not json");
    const { library, migrated } = await openLibrary({
      indexedDB: new IDBFactory(),
      localStorage: local,
      dbName: "corrupt",
    });
    assert.equal(migrated, false);
    assert.deepEqual(await library.list(), []);
  });
});

describe("fallback libraries", () => {
  test("localStorage holds a whole library and reports the 5MB cap", async () => {
    const lib = new LocalStorageLibrary(fakeLocalStorage());
    const a = await lib.create("A", build([{ id: "na", x: 3 }]));
    await lib.create("B", build([{ id: "nb" }]));

    assert.equal((await lib.list()).length, 2);
    assert.equal((await lib.load(a.id))!.nodes.na!.x, 3);

    const estimate = (await lib.estimate())!;
    assert.equal(estimate.quota, 5 * 1024 * 1024);
    assert.ok(estimate.usage > 0);
  });

  test("localStorage surfaces a quota failure instead of silently dropping", async () => {
    const lib = new LocalStorageLibrary(fakeLocalStorage(200));
    await assert.rejects(() => lib.create("A", build([{ id: "a" }, { id: "b" }, { id: "c" }])));
  });

  test("localStorage survives a corrupt value by starting empty", async () => {
    const storage = fakeLocalStorage();
    storage.setItem("figma-lite:library", "{broken");
    const lib = new LocalStorageLibrary(storage);
    assert.deepEqual(await lib.list(), []);
  });

  test("memory holds a library within the session", async () => {
    const lib = new MemoryLibrary();
    const a = await lib.create("A", build([{ id: "na" }]));
    assert.equal((await lib.list()).length, 1);
    await lib.remove(a.id);
    assert.deepEqual(await lib.list(), []);
  });
});
