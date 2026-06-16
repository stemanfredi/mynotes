// A minimal IndexedDB wrapper for offline support. Three stores:
//   notes   id -> { content, etag }   cached note bodies (offline reads)
//   meta    key -> value              small blobs, e.g. the cached note list
//   pending id -> { content, etag }   writes made offline, awaiting replay
// The `pending` store is keyed by note id so a second offline save of the same
// note overwrites the first — the autosave queue can never grow unbounded.
//
// Everything degrades silently: if IndexedDB is missing or a transaction fails,
// the helpers reject and callers fall through to their normal online path.

export interface CachedNote { content: string; etag: string; }

const DB = "mynotes";
const VERSION = 1;

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ["notes", "meta", "pending"]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const r = fn(db.transaction(store, mode).objectStore(store));
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(r.error);
  }));
}

export const get = <T>(store: string, key: IDBValidKey) => run<T | undefined>(store, "readonly", (s) => s.get(key));
export const put = (store: string, value: unknown, key: IDBValidKey) => run(store, "readwrite", (s) => s.put(value, key));
export const del = (store: string, key: IDBValidKey) => run(store, "readwrite", (s) => s.delete(key));

// Pending queue as [id, value] pairs, so replay can PUT each then delete it by id.
export function entries<T>(store: string): Promise<[IDBValidKey, T][]> {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, "readonly").objectStore(store);
    const keys = t.getAllKeys();
    const vals = t.getAll();
    t.transaction.oncomplete = () => resolve(keys.result.map((k, i) => [k, vals.result[i] as T]));
    t.transaction.onerror = () => reject(t.transaction.error);
  }));
}
