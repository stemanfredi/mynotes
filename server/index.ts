// The entire backend: a folder of .md files + a derived link index, exposed over
// a handful of HTTP endpoints. No database, no framework. Run: bun server/index.ts
import { join } from "node:path";
import { buildIndex, watchNotes, listNotes, readNote, writeNote, renameNote, renameFolder, deleteItem, backlinks, vaultFile, writeVaultFile, searchContent } from "./store.ts";

const PORT = Number(process.env.PORT ?? 8911);
// Interface to bind. Unset -> Bun's default 0.0.0.0 (all interfaces). Behind a
// reverse proxy, set HOST=127.0.0.1 so only the proxy can reach the app.
const HOST = process.env.HOST;
// Built client (only present after `bun run build`). In one-process prod, the
// server serves it so the app + /api share one origin — which the service worker
// needs. In dev, Vite serves the client and proxies /api here, so this is unused.
const DIST = join(import.meta.dir, "..", "dist");

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", ...init?.headers } });

const count = await buildIndex();
watchNotes((id) => console.log(`mynotes: reindexed ${id} (external change)`));

const server = Bun.serve({
  port: PORT,
  hostname: HOST, // undefined -> 0.0.0.0; set HOST=127.0.0.1 to bind localhost only
  fetch: (req) =>
    route(req).catch((err) => {
      console.error("mynotes:", err); // malformed input, fs errors, etc. — never crash
      return new Response("internal error", { status: 500 });
    }),
});

console.log(`mynotes: indexed ${count} note(s), listening on ${server.url}`);

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const param = (prefix: string) => decodeURIComponent(pathname.slice(prefix.length));
  const notFound = () => new Response("not found", { status: 404 });

  // GET /api/notes -> [{id,title}]
  if (pathname === "/api/notes" && req.method === "GET") return json(listNotes());

  // GET /api/search?q= -> [{id,line,text}] full-text body search (empty q -> [])
  if (pathname === "/api/search" && req.method === "GET")
    return json(await searchContent(url.searchParams.get("q") ?? ""));

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

  // GET|PUT /api/file/<path> -> raw vault file (embedded images, etc.). PUT
  // stores an uploaded asset; .md files must use /api/note (ETag-guarded, indexed).
  if (pathname.startsWith("/api/file/")) {
    const rel = param("/api/file/");
    if (req.method === "GET") {
      let file;
      try { file = vaultFile(rel); } catch { return new Response("bad path", { status: 400 }); }
      return (await file.exists()) ? new Response(file) : notFound();
    }
    if (req.method === "PUT") {
      if (rel.endsWith(".md")) return new Response("use /api/note for notes", { status: 400 });
      try { await writeVaultFile(rel, await req.arrayBuffer()); }
      catch { return new Response("bad path", { status: 400 }); }
      return json({ path: rel });
    }
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

  // Static client (prod single-origin): serve the requested asset from dist/, or
  // fall back to the SPA shell. URL parsing normalises away any ../ traversal.
  if (req.method === "GET" && !pathname.startsWith("/api/")) {
    const rel = pathname === "/" ? "index.html" : pathname.slice(1);
    for (const candidate of [rel, "index.html"]) {
      const file = Bun.file(join(DIST, candidate));
      if (await file.exists()) return new Response(file);
    }
  }

  return notFound();
}
