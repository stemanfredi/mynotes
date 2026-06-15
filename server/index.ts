// The entire backend: a folder of .md files + a derived link index, exposed over
// a handful of HTTP endpoints. No database, no framework. Run: bun server/index.ts
import { buildIndex, watchNotes, listNotes, readNote, writeNote, renameNote, renameFolder, deleteItem, backlinks } from "./store.ts";

const PORT = Number(process.env.PORT ?? 8911);

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", ...init?.headers } });

const count = await buildIndex();
watchNotes((id) => console.log(`mynotes: reindexed ${id} (external change)`));
console.log(`mynotes: indexed ${count} note(s), listening on http://localhost:${PORT}`);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // GET /api/notes -> [{id,title}]
    if (pathname === "/api/notes" && req.method === "GET") return json(listNotes());

    // POST /api/rename  {from, to} -> moves the file(s) + rewrites [[links]].
    // If `from` is an existing note it's a note rename; otherwise a folder rename.
    if (pathname === "/api/rename" && req.method === "POST") {
      const { from, to } = await req.json();
      const f = String(from), t = String(to);
      const res = (await readNote(f)) ? await renameNote(f, t) : await renameFolder(f, t);
      if (!res.ok) return json({ error: res.reason }, { status: res.reason === "exists" ? 409 : 400 });
      return json({ id: t, etag: res.etag }, res.etag ? { headers: { etag: res.etag } } : undefined);
    }

    // GET /api/backlinks/<id>
    if (pathname.startsWith("/api/backlinks/") && req.method === "GET")
      return json(backlinks(decodeURIComponent(pathname.slice("/api/backlinks/".length))));

    // GET|PUT /api/note/<id>
    if (pathname.startsWith("/api/note/")) {
      const id = decodeURIComponent(pathname.slice("/api/note/".length));
      if (req.method === "GET") {
        const note = await readNote(id);
        if (!note) return new Response("not found", { status: 404 });
        return new Response(note.content, {
          headers: { "content-type": "text/markdown; charset=utf-8", etag: note.etag },
        });
      }
      if (req.method === "PUT") {
        const body = await req.text();
        const res = await writeNote(id, body, req.headers.get("if-match") ?? undefined);
        if (!res.ok) return json({ conflict: true, etag: res.etag, conflictId: res.conflictId }, { status: 409 });
        return json({ etag: res.etag }, { headers: { etag: res.etag } });
      }
      // DELETE removes a note or a folder (with its contents).
      if (req.method === "DELETE") {
        return (await deleteItem(id)) ? json({ ok: true }) : new Response("not found", { status: 404 });
      }
    }

    return new Response("not found", { status: 404 });
  },
});
