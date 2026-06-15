// Thin fetch wrapper over the server's five endpoints. Tracks the per-note ETag
// so saves can use If-Match for last-write-wins conflict detection.

export interface NoteMeta { id: string; title: string; }

const etags = new Map<string, string>();

export async function listNotes(): Promise<NoteMeta[]> {
  return (await fetch("/api/notes")).json();
}

export async function getNote(id: string): Promise<string> {
  const res = await fetch(`/api/note/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`getNote ${id}: ${res.status}`);
  const etag = res.headers.get("etag");
  if (etag) etags.set(id, etag);
  return res.text();
}

export type SaveResult =
  | { ok: true }
  | { ok: false; conflict: true; conflictId: string };

export async function saveNote(id: string, content: string): Promise<SaveResult> {
  const headers: Record<string, string> = { "content-type": "text/markdown" };
  const prev = etags.get(id);
  if (prev) headers["if-match"] = prev;
  const res = await fetch(`/api/note/${encodeURIComponent(id)}`, { method: "PUT", headers, body: content });
  if (res.status === 409) {
    const { etag, conflictId } = await res.json();
    etags.set(id, etag); // adopt server's version so the next save is clean
    return { ok: false, conflict: true, conflictId };
  }
  const { etag } = await res.json();
  if (etag) etags.set(id, etag);
  return { ok: true };
}

export async function getBacklinks(id: string): Promise<NoteMeta[]> {
  return (await fetch(`/api/backlinks/${encodeURIComponent(id)}`)).json();
}

export type RenameResult = { ok: true } | { ok: false; reason: string };

export async function renameNote(from: string, to: string): Promise<RenameResult> {
  const res = await fetch("/api/rename", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: "error" }));
    return { ok: false, reason: error };
  }
  const { etag } = await res.json();
  if (etag) etags.set(to, etag); // carry the version onto the new id
  etags.delete(from);
  return { ok: true };
}
