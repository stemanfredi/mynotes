// Thin fetch wrapper over the server's HTTP endpoints, made offline-aware: reads
// fall back to an IndexedDB cache and writes queue for replay when the server is
// unreachable (see idb.ts). Per-note ETags drive last-write-wins conflict
// detection — and the SAME ETag rides a queued write on replay, so an offline
// edit that lost a race still gets parked as a server-side conflict copy.

import * as idb from "./idb.ts";

export interface NoteMeta { id: string; title: string; }

const etags = new Map<string, string>();

// Best-effort mirror of a note body into the offline cache — never blocks or throws.
const cacheNote = (id: string, content: string, etag: string) =>
  idb.put("notes", { content, etag }, id).catch(() => {});

// GET a JSON array, or [] when the server is unreachable (offline-tolerant read).
async function fetchList<T>(url: string): Promise<T[]> {
  try { return await (await fetch(url)).json(); }
  catch { return []; }
}

export async function listNotes(): Promise<NoteMeta[]> {
  try {
    const list: NoteMeta[] = await (await fetch("/api/notes")).json();
    idb.put("meta", list, "notes").catch(() => {});
    return list;
  } catch {
    return (await idb.get<NoteMeta[]>("meta", "notes").catch(() => undefined)) ?? [];
  }
}

// Returns the note's content, or null if it doesn't exist (404). Offline: serves
// the cached body if we have one, else rethrows so the caller shows "couldn't open"
// (never a misleading blank).
export async function getNote(id: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/note/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getNote ${id}: ${res.status}`);
    const etag = res.headers.get("etag") ?? "";
    if (etag) etags.set(id, etag);
    const content = await res.text();
    cacheNote(id, content, etag);
    return content;
  } catch (err) {
    const cached = await idb.get<idb.CachedNote>("notes", id).catch(() => undefined);
    if (!cached) throw err;
    if (cached.etag) etags.set(id, cached.etag);
    return cached.content;
  }
}

export type SaveResult =
  | { ok: true; queued?: true }
  | { ok: false; conflict: true; conflictId: string };

// PUT a note to the server. Throws on network/5xx so saveNote can queue it.
async function putNote(id: string, content: string, ifMatch?: string): Promise<SaveResult> {
  const headers: Record<string, string> = { "content-type": "text/markdown" };
  if (ifMatch) headers["if-match"] = ifMatch;
  const res = await fetch(`/api/note/${encodeURIComponent(id)}`, { method: "PUT", headers, body: content });
  if (res.status === 409) {
    const { etag, conflictId } = await res.json();
    etags.set(id, etag); // adopt server's version so the next save is clean
    return { ok: false, conflict: true, conflictId };
  }
  if (!res.ok) throw new Error(`saveNote ${id}: ${res.status}`);
  const { etag } = await res.json();
  if (etag) { etags.set(id, etag); cacheNote(id, content, etag); }
  return { ok: true };
}

export async function saveNote(id: string, content: string): Promise<SaveResult> {
  const base = etags.get(id);
  try {
    return await putNote(id, content, base);
  } catch {
    // Offline: cache the body and queue the write (keyed by id, so it collapses
    // with any earlier offline save of this note). The base ETag is queued too,
    // so replay still detects a server-side change.
    cacheNote(id, content, base ?? "");
    await idb.put("pending", { content, etag: base ?? "" }, id).catch(() => {});
    return { ok: true, queued: true };
  }
}

// Replay queued offline writes oldest-first. Each goes out with its stored ETag as
// If-Match, so a write that raced a server-side change parks a conflict copy — our
// normal conflict model, reused for free. Stops on the first failure (still offline).
export async function flushPending(): Promise<void> {
  const queued = await idb.entries<idb.CachedNote>("pending").catch(() => [] as [IDBValidKey, idb.CachedNote][]);
  for (const [id, { content, etag }] of queued) {
    try {
      await putNote(String(id), content, etag || undefined);
      await idb.del("pending", id).catch(() => {}); // saved or parked as a conflict — either way, done
    } catch {
      break; // still offline
    }
  }
}

// Backlinks are server-computed; offline -> [] (stale, not wrong).
export function getBacklinks(id: string): Promise<NoteMeta[]> {
  return fetchList<NoteMeta>(`/api/backlinks/${encodeURIComponent(id)}`);
}

// Upload a raw file (e.g. a pasted/dropped image) to a vault-relative path.
// Returns the stored path, ready to drop into a Markdown ![](…) link.
export async function uploadFile(path: string, body: Blob): Promise<string> {
  const url = "/api/file/" + path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(url, { method: "PUT", body });
  if (!res.ok) throw new Error(`uploadFile ${path}: ${res.status}`);
  return (await res.json()).path;
}

export interface SearchHit { id: string; line: number; text: string; }

// Full-text search of note bodies (server-side, via ripgrep). Empty query / offline -> [].
export function searchContent(q: string): Promise<SearchHit[]> {
  return fetchList<SearchHit>(`/api/search?q=${encodeURIComponent(q)}`);
}

// Delete a note or a folder (with its contents). Returns whether it existed.
// Offline: returns false (no delete queue in v1) — the caller reports it.
export async function deleteItem(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/note/${encodeURIComponent(id)}`, { method: "DELETE" });
    etags.delete(id);
    idb.del("notes", id).catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
}

export type RenameResult = { ok: true } | { ok: false; reason: string };

export async function renameNote(from: string, to: string): Promise<RenameResult> {
  let res: Response;
  try {
    res = await fetch("/api/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
  } catch {
    return { ok: false, reason: "offline" }; // rename rewrites links server-side; not queued in v1
  }
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: "error" }));
    return { ok: false, reason: error };
  }
  const { etag } = await res.json();
  if (etag) etags.set(to, etag); // carry the version onto the new id
  etags.delete(from);
  return { ok: true };
}
