/**
 * Document persistence.
 *
 * The editor autosaves after every change, so the storage layer has two jobs:
 * hold a document far larger than a string, and write only what changed.
 *
 * **Why IndexedDB and not localStorage.** A design file is not small. The
 * starter scene is ~4 KB, a real screen ~150 KB, a multi-screen file ~1 MB —
 * and a single pasted photo is inlined as a base64 `data:` URL, which costs
 * +33% on top of the original bytes. Two screenshots exceed localStorage's
 * ~5 MB origin cap on their own. IndexedDB is disk-backed (typically a large
 * fraction of free space), stores structured objects without a JSON round trip,
 * and runs off the main thread.
 *
 * **Incremental writes.** localStorage can only replace the whole value, so
 * every autosave re-serialised every node — a synchronous main-thread stall
 * that grows with the document. Here, `diffDocuments` (the same reference
 * comparison the undo system is built on) yields exactly which nodes changed
 * since the last successful save, so a typical autosave writes one or two
 * records regardless of document size.
 *
 * **Fallbacks.** IndexedDB is unavailable in some private-browsing modes and
 * can be disabled outright. `openDocumentStore` degrades to localStorage, then
 * to memory, so autosave never becomes a hard failure.
 *
 * Note: no TypeScript parameter properties in this file. The unit tests run
 * straight against these sources under `node --test`, whose type stripping
 * erases types but cannot synthesise the field assignments they imply.
 */

import type { Document, NodeId, SceneNode } from "./types.ts";
import { diffDocuments } from "./history.ts";
import { deserialize } from "./serialize.ts";

export const DB_NAME = "figma-lite";
export const DB_VERSION = 1;
export const NODE_STORE = "nodes";
export const META_STORE = "meta";
/** The key localStorage used before IndexedDB; read once, then retired. */
export const LEGACY_KEY = "figma-lite:document";

export type StoreKind = "indexeddb" | "localstorage" | "memory";

export interface StorageUsage {
  usage: number;
  quota: number;
}

export interface DocumentStore {
  readonly kind: StoreKind;
  /** Returns the stored document, or null when nothing is saved yet. */
  load(): Promise<Document | null>;
  /** Persists the document, writing only what changed since the last save. */
  save(doc: Document): Promise<void>;
  clear(): Promise<void>;
  estimate(): Promise<StorageUsage | null>;
  close(): void;
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

export function openDatabase(factory: IDBFactory, name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(NODE_STORE)) db.createObjectStore(NODE_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB"));
    // Another tab holding an older version open would block the upgrade
    // indefinitely; failing fast lets the caller fall back instead of hanging.
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"));
  });
}

class IndexedDbStore implements DocumentStore {
  readonly kind = "indexeddb" as const;

  /** The last document known to be on disk, and the base for the next diff. */
  private lastSaved: Document | null = null;
  /** Serialises overlapping autosaves; concurrent writes would interleave. */
  private queue: Promise<void> = Promise.resolve();

  private readonly db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  async load(): Promise<Document | null> {
    const tx = this.db.transaction([NODE_STORE, META_STORE], "readonly");
    const records = (await promisify(tx.objectStore(NODE_STORE).getAll())) as SceneNode[];
    const meta = (await promisify(tx.objectStore(META_STORE).get("root"))) as
      | { key: string; value: NodeId }
      | undefined;
    await transactionDone(tx);

    const doc = assembleDocument(records, meta?.value);
    // Remember what is on disk so the first autosave is a diff, not a rewrite.
    this.lastSaved = doc;
    return doc;
  }

  save(doc: Document): Promise<void> {
    this.queue = this.queue.then(
      () => this.write(doc),
      () => this.write(doc),
    );
    return this.queue;
  }

  private async write(doc: Document): Promise<void> {
    const plan = planWrite(doc, this.lastSaved);
    if (!plan.full && plan.put.length === 0 && plan.remove.length === 0) return;

    const tx = this.db.transaction([NODE_STORE, META_STORE], "readwrite");
    const nodes = tx.objectStore(NODE_STORE);
    if (plan.full) nodes.clear();
    for (const node of plan.put) nodes.put(node);
    for (const id of plan.remove) nodes.delete(id);
    tx.objectStore(META_STORE).put({ key: "root", value: plan.root });

    await transactionDone(tx);
    // Only advance the base after the transaction commits, so a failed write
    // is retried in full rather than silently skipped by the next diff.
    this.lastSaved = doc;
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction([NODE_STORE, META_STORE], "readwrite");
    tx.objectStore(NODE_STORE).clear();
    tx.objectStore(META_STORE).clear();
    await transactionDone(tx);
    this.lastSaved = null;
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

// --- localStorage fallback --------------------------------------------------

/** The old whole-document store, kept as a fallback and a migration source. */
class LocalStorageStore implements DocumentStore {
  readonly kind = "localstorage" as const;
  private readonly storage: Storage;
  private readonly key: string;

  constructor(storage: Storage, key = LEGACY_KEY) {
    this.storage = storage;
    this.key = key;
  }

  async load(): Promise<Document | null> {
    const raw = this.storage.getItem(this.key);
    if (!raw) return null;
    try {
      return deserialize(JSON.parse(raw)).doc;
    } catch {
      return null;
    }
  }

  async save(doc: Document): Promise<void> {
    // No incremental path exists here: localStorage can only replace the value.
    this.storage.setItem(this.key, JSON.stringify({ version: 1, root: doc.root, nodes: doc.nodes }));
  }

  async clear(): Promise<void> {
    this.storage.removeItem(this.key);
  }

  async estimate(): Promise<StorageUsage | null> {
    // A hard 5 MB origin cap, measured in UTF-16 code units.
    const raw = this.storage.getItem(this.key) ?? "";
    return { usage: raw.length * 2, quota: 5 * 1024 * 1024 };
  }

  close(): void {}
}

class MemoryStore implements DocumentStore {
  readonly kind = "memory" as const;
  private doc: Document | null = null;

  async load(): Promise<Document | null> {
    return this.doc;
  }
  async save(doc: Document): Promise<void> {
    this.doc = doc;
  }
  async clear(): Promise<void> {
    this.doc = null;
  }
  async estimate(): Promise<StorageUsage | null> {
    return null;
  }
  close(): void {}
}

// --- Construction and migration --------------------------------------------

export interface OpenOptions {
  /** Injectable for tests; defaults to the global implementations. */
  indexedDB?: IDBFactory | null;
  localStorage?: Storage | null;
  dbName?: string;
}

export interface OpenResult {
  store: DocumentStore;
  /** Set when a document was carried over from the old localStorage store. */
  migrated: boolean;
}

/**
 * Opens the best store available, migrating any document left behind by the
 * previous localStorage-based autosave.
 */
export async function openDocumentStore(options: OpenOptions = {}): Promise<OpenResult> {
  const idb = options.indexedDB === undefined ? safeIndexedDB() : options.indexedDB;
  const local = options.localStorage === undefined ? safeLocalStorage() : options.localStorage;

  if (idb) {
    try {
      const db = await openDatabase(idb, options.dbName ?? DB_NAME);
      const store = new IndexedDbStore(db);
      const migrated = await migrateLegacy(store, local);
      return { store, migrated };
    } catch {
      // Private browsing, disabled storage, or a blocked upgrade. Fall through.
    }
  }

  if (local) return { store: new LocalStorageStore(local), migrated: false };
  return { store: new MemoryStore(), migrated: false };
}

/**
 * Moves a pre-IndexedDB document across, once. The legacy key is only removed
 * after the new store has committed, so an interrupted migration retries rather
 * than losing the document.
 */
async function migrateLegacy(store: DocumentStore, local: Storage | null): Promise<boolean> {
  if (!local) return false;
  const raw = local.getItem(LEGACY_KEY);
  if (!raw) return false;

  try {
    // Never overwrite newer work already in IndexedDB.
    if (await store.load()) {
      local.removeItem(LEGACY_KEY);
      return false;
    }
    const doc = deserialize(JSON.parse(raw)).doc;
    await store.save(doc);
    local.removeItem(LEGACY_KEY);
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

export { IndexedDbStore, LocalStorageStore, MemoryStore };
