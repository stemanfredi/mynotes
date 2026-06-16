// The entire backend: a folder of .md files + a derived link index, exposed over
// a handful of HTTP endpoints. No database, no framework. Run: bun server/index.ts
import { buildIndex, watchNotes, listNotes, readNote, writeNote, renameNote, renameFolder, deleteItem, backlinks, vaultFile } from "./store.ts";

const PORT = Number(process.env.PORT ?? 8911);

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", ...init?.headers } });

const count = await buildIndex();
watchNotes((id) => console.log(`mynotes: reindexed ${id} (external change)`));

const server = Bun.serve({
  port: PORT,
  fetch: (req) =>
    route(req).catch((err) => {
      console.error("mynotes:", err); // malformed input, fs errors, etc. — never crash
      return new Response("internal error", { status: 500 });
    }),
});

console.log(`mynotes: indexed ${count} note(s), listening on ${server.url}`);

async function route(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  const param = (prefix: string) => decodeURIComponent(pathname.slice(prefix.length));
  const notFound = () => new Response("not found", { status: 404 });

  // GET /api/notes -> [{id,title}]
  if (pathname === "/api/notes" && req.method === "GET") return json(listNotes());

  // POST /api/rename {from, to} -> moves the file(s) + rewrites [[links]]. If
  // `from` is an existing note it's a note rename; otherwise a folder rename.
  if (pathname === "/api/rename" && req.method === "POST") {
    const { from, to } = await req.json();
    const f = String(from), t = String(to);
    const res = (await readNote(f)) ? await renameNote(f, t) : await renameFolder(f, t);
    if (!res.ok) return json({ error: res.reason }, { status: res.reason === "exists" ? 409 : 400 });
    return json({ id: t, etag: res.etag }, res.etag ? { headers: { etag: res.etag } } : undefined);
  }

  // GET /api/backlinks/<id> -> [{id,title}]
  if (pathname.startsWith("/api/backlinks/") && req.method === "GET")
    return json(backlinks(param("/api/backlinks/")));

  // GET /api/file/<path> -> raw vault file (embedded images, etc.)
  if (pathname.startsWith("/api/file/") && req.method === "GET") {
    let file;
    try { file = vaultFile(param("/api/file/")); } catch { return new Response("bad path", { status: 400 }); }
    return (await file.exists()) ? new Response(file) : notFound();
  }

  // GET|PUT|DELETE /api/note/<id>
  if (pathname.startsWith("/api/note/")) {
    const id = param("/api/note/");
    if (req.method === "GET") {
      const note = await readNote(id);
      return note
        ? new Response(note.content, { headers: { "content-type": "text/markdown; charset=utf-8", etag: note.etag } })
        : notFound();
    }
    if (req.method === "PUT") {
      const res = await writeNote(id, await req.text(), req.headers.get("if-match") ?? undefined);
      if (!res.ok) return json({ conflict: true, etag: res.etag, conflictId: res.conflictId }, { status: 409 });
      return json({ etag: res.etag }, { headers: { etag: res.etag } });
    }
    if (req.method === "DELETE") return (await deleteItem(id)) ? json({ ok: true }) : notFound();
  }

  return notFound();
}
