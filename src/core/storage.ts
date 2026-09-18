/**
 * Document persistence: a library of saved designs.
 *
 * **Why IndexedDB and not localStorage.** A design file is not small. The
 * starter scene is ~4 KB, a real screen ~150 KB, a multi-screen file ~1 MB —
 * and a pasted photo is inlined as a base64 `data:` URL, costing +33% on top of
 * the original bytes. Two screenshots exceed localStorage's ~5 MB origin cap on
 * their own. IndexedDB is disk-backed, stores structured objects without a JSON
 * round trip, and runs off the main thread.
 *
 * **Incremental writes.** localStorage can only replace the whole value, so
 * every autosave re-serialised every node — a synchronous main-thread stall
 * that grows with the document. Here, `diffDocuments` (the same reference
 * comparison the undo system is built on) yields exactly which nodes changed
 * since the last successful save, so a typical autosave writes one or two
 * records regardless of document size.
 *
 * **Schema.** Nodes live in one store keyed by `[docId, nodeId]`, so a
 * document's nodes are a contiguous key range — listing or deleting a design
 * never scans the others.
 *
 * **Fallbacks.** IndexedDB is unavailable in some private-browsing modes and
 * can be disabled outright. `openLibrary` degrades to localStorage, then to
 * memory, so saving never becomes a hard failure.
 *
 * Note: no TypeScript parameter properties in this file. The unit tests run
 * straight against these sources under `node --test`, whose type stripping
 * erases types but cannot synthesise the field assignments they imply.
 */

import type { Document, NodeId, SceneNode } from "./types.ts";
import { diffDocuments } from "./history.ts";
import { deserialize } from "./serialize.ts";

export const DB_NAME = "figma-lite";
export const DB_VERSION = 2;
/** v2 node store, keyed by [docId, id]. */
export const NODE_STORE = "docnodes";
/** v1 node store, keyed by id. Read once during upgrade, then dropped. */
export const LEGACY_NODE_STORE = "nodes";
export const DOC_STORE = "documents";
export const META_STORE = "meta";
export const ACTIVE_KEY = "activeDocumentId";
/** The key the pre-IndexedDB autosave used. */
export const LEGACY_LOCAL_KEY = "figma-lite:document";

export type StoreKind = "indexeddb" | "localstorage" | "memory";

export interface StorageUsage {
  usage: number;
  quota: number;
}

export interface DocumentSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  /** Approximate stored size in bytes, tracked incrementally as nodes change. */
  bytes: number;
}

export interface DocumentLibrary {
  readonly kind: StoreKind;
  list(): Promise<DocumentSummary[]>;
  load(id: string): Promise<Document | null>;
  /** Persists a document, writing only what changed since its last save. */
  save(id: string, doc: Document, name?: string): Promise<void>;
  create(name: string, doc: Document): Promise<DocumentSummary>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  clearAll(): Promise<void>;
  activeId(): Promise<string | null>;
  setActiveId(id: string | null): Promise<void>;
  /** Whole-origin usage from the browser, when it will tell us. */
  estimate(): Promise<StorageUsage | null>;
  close(): void;
}

// --- Sizing -----------------------------------------------------------------

/** Approximate stored size of one node. Base64 is ASCII, so this tracks images well. */
export function nodeBytes(node: SceneNode): number {
  return JSON.stringify(node).length;
}

/** Per-node sizes for a whole document, used as the base for incremental totals. */
export function measureDocument(doc: Document): { sizes: Map<NodeId, number>; total: number } {
  const sizes = new Map<NodeId, number>();
  let total = 0;
  for (const node of Object.values(doc.nodes)) {
    const size = nodeBytes(node);
    sizes.set(node.id, size);
    total += size;
  }
  return { sizes, total };
}

// --- Write planning ---------------------------------------------------------

export interface WritePlan {
  put: SceneNode[];
  remove: NodeId[];
  root: NodeId;
  /** True when the store must be emptied first — there is no trustworthy base. */
  full: boolean;
}

/**
 * Works out the minimal set of records to write. Pure, so the interesting part
 * of incremental saving is testable without a database.
 */
export function planWrite(doc: Document, since: Document | null): WritePlan {
  if (!since) {
    return { put: Object.values(doc.nodes), remove: [], root: doc.root, full: true };
  }

  const delta = diffDocuments(since, doc);
  if (!delta) return { put: [], remove: [], root: doc.root, full: false };

  const put: SceneNode[] = [];
  const remove: NodeId[] = [];
  for (const [id, node] of Object.entries(delta.after)) {
    if (node === null) remove.push(id);
    else put.push(node);
  }
  return { put, remove, root: doc.root, full: false };
}

/** Applies a plan to a running size tally, so totals stay O(changed). */
export function applyPlanToSizes(
  plan: WritePlan,
  sizes: Map<NodeId, number>,
  total: number,
): number {
  let next = plan.full ? 0 : total;
  if (plan.full) sizes.clear();

  for (const node of plan.put) {
    const size = nodeBytes(node);
    next += size - (sizes.get(node.id) ?? 0);
    sizes.set(node.id, size);
  }
  for (const id of plan.remove) {
    next -= sizes.get(id) ?? 0;
    sizes.delete(id);
  }
  return Math.max(0, next);
}

/** Rebuilds a document from loose records, reusing the importer's validation. */
export function assembleDocument(records: SceneNode[], root: NodeId | undefined): Document | null {
  if (records.length === 0) return null;
  const nodes: Record<string, unknown> = {};
  for (const record of records) {
    if (record && typeof record.id === "string") nodes[record.id] = record;
  }
  // Routing through `deserialize` means a half-written or corrupted database
  // cannot produce a document that hangs a traversal — it gets the same cycle
  // breaking and dangling-reference pruning that file import gets.
  const { doc } = deserialize({ nodes, root });
  return doc;
}

let idCounter = 0;
export function newDocumentId(): string {
  idCounter += 1;
  return `doc-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** "Untitled", "Untitled 2", … — never collides with an existing name. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!names.has(candidate)) return candidate;
  }
}

// --- IndexedDB --------------------------------------------------------------

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** All node keys for one document form the range [docId, ""] … [docId, "￿"]. */
function documentRange(docId: string): IDBKeyRange {
  return IDBKeyRange.bound([docId, ""], [docId, "￿"]);
}

export function openDatabase(factory: IDBFactory, name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      if (!tx) return;

      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(NODE_STORE)) {
        db.createObjectStore(NODE_STORE, { keyPath: ["docId", "id"] });
      }

      // v1 held a single document in a store keyed by node id. Carry it across
      // as the library's first design rather than dropping someone's work.
      const upgradingFromV1 =
        (event as IDBVersionChangeEvent).oldVersion >= 1 &&
        db.objectStoreNames.contains(LEGACY_NODE_STORE);

      if (upgradingFromV1) {
        const legacy = tx.objectStore(LEGACY_NODE_STORE);
        const all = legacy.getAll() as IDBRequest<SceneNode[]>;
        const rootRequest = tx.objectStore(META_STORE).get("root") as IDBRequest<
          { key: string; value: NodeId } | undefined
        >;

        // Without a handler the request error aborts the versionchange
        // transaction, the upgrade never commits, and every later load falls
        // back to localStorage. Losing the legacy document is better than that.
        all.onerror = () => {
          if (db.objectStoreNames.contains(LEGACY_NODE_STORE)) {
            db.deleteObjectStore(LEGACY_NODE_STORE);
          }
        };
        all.onsuccess = () => {
          const records = all.result ?? [];
          if (records.length > 0) {
            const docId = `doc-legacy-${(event as IDBVersionChangeEvent).oldVersion}`;
            const nodes = tx.objectStore(NODE_STORE);
            let bytes = 0;
            for (const record of records) {
              nodes.put({ ...record, docId });
              bytes += nodeBytes(record);
            }
            const now = Date.now();
            tx.objectStore(DOC_STORE).put({
              id: docId,
              name: "Untitled",
              createdAt: now,
              updatedAt: now,
              nodeCount: records.length,
              bytes,
            } satisfies DocumentSummary);
            tx.objectStore(META_STORE).put({
              key: ACTIVE_KEY,
              value: docId,
            });
            void rootRequest;
          }
          db.deleteObjectStore(LEGACY_NODE_STORE);
        };
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Without this, this tab's open connection blocks a newer tab's upgrade
      // forever, and that tab silently degrades to localStorage.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB"));
    // Another tab holding an older version open would block the upgrade
    // indefinitely; failing fast lets the caller fall back instead of hanging.
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"));
  });
}

interface SaveBase {
  doc: Document;
  sizes: Map<NodeId, number>;
  total: number;
}

class IndexedDbLibrary implements DocumentLibrary {
  readonly kind = "indexeddb" as const;
  private readonly db: IDBDatabase;
  /** Per-document diff base: what is on disk, and its per-node sizes. */
  private readonly bases = new Map<string, SaveBase>();
  /** Serialises overlapping autosaves; concurrent writes would interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  /** Runs `work` after any in-flight write, whether that write succeeded or not. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<DocumentSummary[]> {
    const tx = this.db.transaction(DOC_STORE, "readonly");
    const rows = (await promisify(tx.objectStore(DOC_STORE).getAll())) as DocumentSummary[];
    await transactionDone(tx);
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<Document | null> {
    const tx = this.db.transaction([NODE_STORE, DOC_STORE], "readonly");
    const records = (await promisify(
      tx.objectStore(NODE_STORE).getAll(documentRange(id)),
    )) as (SceneNode & { docId: string })[];
    const summary = (await promisify(tx.objectStore(DOC_STORE).get(id))) as DocumentSummary | undefined;
    await transactionDone(tx);
    if (!summary) return null;

    // The composite key adds a `docId` field to each record; strip it so the
    // document model stays exactly what the rest of the app expects.
    const nodes = records.map(({ docId: _docId, ...node }) => node as SceneNode);
    const doc = assembleDocument(nodes, undefined);
    if (!doc) return null;

    // Remember what is on disk so the next save is a diff, not a rewrite.
    const measured = measureDocument(doc);
    this.bases.set(id, { doc, sizes: measured.sizes, total: measured.total });
    return doc;
  }

  save(id: string, doc: Document, name?: string): Promise<void> {
    return this.enqueue(() => this.write(id, doc, name));
  }

  private async write(id: string, doc: Document, name?: string): Promise<void> {
    // Read the summary in its own transaction first. Another tab may have
    // deleted this design since our diff base was captured — writing a diff
    // against a document that no longer exists would recreate it as a partial,
    // corrupt one whose summary describes nodes that were never written.
    const existing = await this.readSummary(id);
    const base = existing ? (this.bases.get(id) ?? null) : null;
    if (!existing) this.bases.delete(id);

    const plan = planWrite(doc, base?.doc ?? null);
    const nothingToDo = !plan.full && plan.put.length === 0 && plan.remove.length === 0;
    if (nothingToDo && !name) return;

    // Work on a copy: `applyPlanToSizes` mutates, and a write that aborts must
    // leave the base exactly as it was so the retry recomputes the full delta.
    const sizes = new Map(base ? base.sizes : []);
    const total = applyPlanToSizes(plan, sizes, base?.total ?? 0);

    const now = Date.now();
    const summary: DocumentSummary = {
      id,
      name: name ?? existing?.name ?? "Untitled",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      nodeCount: Object.keys(doc.nodes).length,
      bytes: total,
    };

    const tx = this.db.transaction([NODE_STORE, DOC_STORE], "readwrite");
    const nodes = tx.objectStore(NODE_STORE);
    if (plan.full) nodes.delete(documentRange(id));
    for (const node of plan.put) nodes.put({ ...node, docId: id });
    for (const nodeId of plan.remove) nodes.delete([id, nodeId]);
    tx.objectStore(DOC_STORE).put(summary);

    await transactionDone(tx);
    // Only adopt the new base after the transaction commits.
    this.bases.set(id, { doc, sizes, total });
  }

  private async readSummary(id: string): Promise<DocumentSummary | undefined> {
    const tx = this.db.transaction(DOC_STORE, "readonly");
    const row = (await promisify(tx.objectStore(DOC_STORE).get(id))) as DocumentSummary | undefined;
    await transactionDone(tx);
    return row;
  }

  async create(name: string, doc: Document): Promise<DocumentSummary> {
    const id = newDocumentId();
    await this.save(id, doc, name);
    const summary = await this.enqueue(() => this.readSummary(id));
    if (!summary) throw new Error("Could not create document");
    return summary;
  }

  rename(id: string, name: string): Promise<void> {
    return this.enqueue(async () => {
      const tx = this.db.transaction(DOC_STORE, "readwrite");
      const docs = tx.objectStore(DOC_STORE);
      const existing = (await promisify(docs.get(id))) as DocumentSummary | undefined;
      if (existing) docs.put({ ...existing, name, updatedAt: Date.now() });
      await transactionDone(tx);
    });
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const tx = this.db.transaction([NODE_STORE, DOC_STORE, META_STORE], "readwrite");
      tx.objectStore(NODE_STORE).delete(documentRange(id));
      tx.objectStore(DOC_STORE).delete(id);

      const active = (await promisify(tx.objectStore(META_STORE).get(ACTIVE_KEY))) as
        | { key: string; value: string | null }
        | undefined;
      if (active?.value === id) tx.objectStore(META_STORE).delete(ACTIVE_KEY);

      await transactionDone(tx);
      this.bases.delete(id);
    });
  }

  clearAll(): Promise<void> {
    return this.enqueue(async () => {
      const tx = this.db.transaction([NODE_STORE, DOC_STORE, META_STORE], "readwrite");
      tx.objectStore(NODE_STORE).clear();
      tx.objectStore(DOC_STORE).clear();
      tx.objectStore(META_STORE).clear();
      await transactionDone(tx);
      this.bases.clear();
    });
  }

  async activeId(): Promise<string | null> {
    const tx = this.db.transaction(META_STORE, "readonly");
    const row = (await promisify(tx.objectStore(META_STORE).get(ACTIVE_KEY))) as
      | { key: string; value: string }
      | undefined;
    await transactionDone(tx);
    return row?.value ?? null;
  }

  setActiveId(id: string | null): Promise<void> {
    return this.enqueue(async () => {
      const tx = this.db.transaction(META_STORE, "readwrite");
      const meta = tx.objectStore(META_STORE);
      if (id === null) meta.delete(ACTIVE_KEY);
      else meta.put({ key: ACTIVE_KEY, value: id });
      await transactionDone(tx);
    });
  }

  async estimate(): Promise<StorageUsage | null> {
    try {
      const estimate = await navigator.storage?.estimate?.();
      if (!estimate || estimate.usage === undefined || estimate.quota === undefined) return null;
      return { usage: estimate.usage, quota: estimate.quota };
    } catch {
      return null;
    }
  }

  close(): void {
    this.db.close();
  }
}

// --- Fallbacks --------------------------------------------------------------

interface Shelf {
  documents: Record<string, DocumentSummary>;
  nodes: Record<string, Record<string, SceneNode>>;
  active: string | null;
}

const EMPTY_SHELF: Shelf = { documents: {}, nodes: {}, active: null };

/**
 * A whole-library-in-one-value store, shared by the localStorage and memory
 * fallbacks. Writes are not incremental — neither backend can be — which is
 * exactly the limitation IndexedDB exists to remove.
 */
abstract class ShelfLibrary implements DocumentLibrary {
  abstract readonly kind: StoreKind;
  protected abstract read(): Shelf;
  protected abstract write(shelf: Shelf): void;

  async list(): Promise<DocumentSummary[]> {
    return Object.values(this.read().documents).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<Document | null> {
    const shelf = this.read();
    if (!shelf.documents[id]) return null;
    return assembleDocument(Object.values(shelf.nodes[id] ?? {}), undefined);
  }

  async save(id: string, doc: Document, name?: string): Promise<void> {
    const shelf = this.read();
    const existing = shelf.documents[id];
    const now = Date.now();
    const nodes: Record<string, SceneNode> = {};
    let bytes = 0;
    for (const node of Object.values(doc.nodes)) {
      nodes[node.id] = node;
      bytes += nodeBytes(node);
    }
    shelf.nodes[id] = nodes;
    shelf.documents[id] = {
      id,
      name: name ?? existing?.name ?? "Untitled",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      nodeCount: Object.keys(doc.nodes).length,
      bytes,
    };
    this.write(shelf);
  }

  async create(name: string, doc: Document): Promise<DocumentSummary> {
    const id = newDocumentId();
    await this.save(id, doc, name);
    return this.read().documents[id]!;
  }

  async rename(id: string, name: string): Promise<void> {
    const shelf = this.read();
    const existing = shelf.documents[id];
    if (!existing) return;
    shelf.documents[id] = { ...existing, name, updatedAt: Date.now() };
    this.write(shelf);
  }

  async remove(id: string): Promise<void> {
    const shelf = this.read();
    delete shelf.documents[id];
    delete shelf.nodes[id];
    if (shelf.active === id) shelf.active = null;
    this.write(shelf);
  }

  async clearAll(): Promise<void> {
    this.write({ documents: {}, nodes: {}, active: null });
  }

  async activeId(): Promise<string | null> {
    return this.read().active;
  }

  async setActiveId(id: string | null): Promise<void> {
    const shelf = this.read();
    shelf.active = id;
    this.write(shelf);
  }

  abstract estimate(): Promise<StorageUsage | null>;
  close(): void {}
}

class LocalStorageLibrary extends ShelfLibrary {
  readonly kind = "localstorage" as const;
  private readonly storage: Storage;
  private readonly key: string;

  constructor(storage: Storage, key = "figma-lite:library") {
    super();
    this.storage = storage;
    this.key = key;
  }

  protected read(): Shelf {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return structuredCloneShelf(EMPTY_SHELF);
      const parsed = JSON.parse(raw) as Shelf;
      return {
        documents: parsed.documents ?? {},
        nodes: parsed.nodes ?? {},
        active: parsed.active ?? null,
      };
    } catch {
      return structuredCloneShelf(EMPTY_SHELF);
    }
  }

  protected write(shelf: Shelf): void {
    this.storage.setItem(this.key, JSON.stringify(shelf));
  }

  async estimate(): Promise<StorageUsage | null> {
    // A hard 5 MB origin cap, measured in UTF-16 code units.
    const raw = this.storage.getItem(this.key) ?? "";
    return { usage: raw.length * 2, quota: 5 * 1024 * 1024 };
  }
}

class MemoryLibrary extends ShelfLibrary {
  readonly kind = "memory" as const;
  private shelf: Shelf = structuredCloneShelf(EMPTY_SHELF);

  protected read(): Shelf {
    return this.shelf;
  }
  protected write(shelf: Shelf): void {
    this.shelf = shelf;
  }
  async estimate(): Promise<StorageUsage | null> {
    return null;
  }
}

function structuredCloneShelf(shelf: Shelf): Shelf {
  return { documents: { ...shelf.documents }, nodes: { ...shelf.nodes }, active: shelf.active };
}

// --- Construction and migration --------------------------------------------

export interface OpenOptions {
  /** Injectable for tests; defaults to the global implementations. */
  indexedDB?: IDBFactory | null;
  localStorage?: Storage | null;
  dbName?: string;
}

export interface OpenResult {
  library: DocumentLibrary;
  /** Set when a document was carried over from the pre-library autosave. */
  migrated: boolean;
}

/**
 * Opens the best library available, migrating any document left behind by the
 * original localStorage autosave.
 */
export async function openLibrary(options: OpenOptions = {}): Promise<OpenResult> {
  const idb = options.indexedDB === undefined ? safeIndexedDB() : options.indexedDB;
  const local = options.localStorage === undefined ? safeLocalStorage() : options.localStorage;

  if (idb) {
    try {
      const db = await openDatabase(idb, options.dbName ?? DB_NAME);
      const library = new IndexedDbLibrary(db);
      const migrated = await migrateLegacyLocal(library, local);
      return { library, migrated };
    } catch {
      // Private browsing, disabled storage, or a blocked upgrade. Fall through.
    }
  }

  if (local) {
    const library = new LocalStorageLibrary(local);
    const migrated = await migrateLegacyLocal(library, local);
    return { library, migrated };
  }
  return { library: new MemoryLibrary(), migrated: false };
}

/**
 * Moves a pre-library document across, once. The legacy key is only removed
 * after the new store has committed, so an interrupted migration retries rather
 * than losing the document.
 */
async function migrateLegacyLocal(library: DocumentLibrary, local: Storage | null): Promise<boolean> {
  if (!local) return false;
  const raw = local.getItem(LEGACY_LOCAL_KEY);
  if (!raw) return false;

  try {
    const doc = deserialize(JSON.parse(raw)).doc;
    const existing = await library.list();
    const summary = await library.create(uniqueName("Untitled", existing.map((d) => d.name)), doc);
    await library.setActiveId(summary.id);
    local.removeItem(LEGACY_LOCAL_KEY);
    return true;
  } catch {
    return false;
  }
}

function safeIndexedDB(): IDBFactory | null {
  try {
    return typeof indexedDB !== "undefined" ? indexedDB : null;
  } catch {
    return null;
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** Formats bytes for display: "2.4 MB", "918 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export { IndexedDbLibrary, LocalStorageLibrary, MemoryLibrary };
