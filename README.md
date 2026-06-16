# mynotes

A deliberately minimal "Obsidian for the web." A folder of plain Markdown files
on the server, a web editor in front of it. No database, no CRDT, no framework.

## Architecture

```
Browser (Vite-built vanilla TS app)            Server (Bun, single script)
┌──────────────────────────────┐   fetch()    ┌────────────────────────────────┐
│ CodeMirror 6 editor          │ ───────────▶ │ GET  /api/notes                │
│  └ live-preview decorations  │              │ GET  /api/note/:id   (ETag)    │
│ sidebar folder tree          │              │ PUT  /api/note/:id   (If-Match)│
│ shared/links.ts ─────────────┼──────┐       │ DELETE /api/note/:id           │
│ inline images via /api/file  │      │       │ POST /api/rename   {from,to}   │
└──────────────────────────────┘      │       │ GET  /api/backlinks/:id        │
                                       │       │ GET  /api/file/:path  (images) │
                                       │       │                                │
            same parser, both sides ───┘       │ notes/**.md  ← source of truth │
                                               │ in-memory link index (no DB),  │
                                               │ kept live by a notes/ watcher  │
                                               └────────────────────────────────┘
```

`shared/links.ts` defines `[[wikilink]]` syntax once and is imported by **both**
the client (rendering) and the server (indexing), so they can never disagree.

## Project layout

```
shared/links.ts        wiki-link parsing — shared by client and server
server/store.ts        the vault: file ops + derived in-memory link index + watcher
server/index.ts        HTTP routing over Bun.serve
src/api.ts             typed fetch wrapper (tracks ETags for conflict detection)
src/editor.ts          CodeMirror 6 setup
src/preview.ts         live preview: Markdown + [[wikilinks]] + URLs, one pass
src/code-languages.ts  lazy-loaded languages for fenced-code highlighting
src/media.ts           image embed helpers (isImage, fileSrc, ImageWidget)
src/tree.ts            pure: flat note ids -> folder tree
src/sidebar.ts         the note-tree component (render, expand/collapse, rename, DnD)
src/dom.ts             $ / el DOM helpers
src/main.ts            app orchestration: state, editor + sidebar wiring, top bar
```

## Design decisions

- **Storage**: server-side folder of standard `.md` files. The filesystem is the
  database — a rebuildable in-memory index, no separate store. External edits
  (SSH, vim, git) are picked up by a recursive `notes/` watcher.
- **Sync model**: single user, many devices, no live collaboration. Saves use
  `If-Match`/ETag → last-write-wins; a stale write is parked as a
  `note (conflict YYYY-MM-DD).md` copy instead of being merged.
- **Title = filename**: the body is pure Markdown content; renaming a note or
  folder moves the file(s) and rewrites `[[links]]` to them.
- **Build**: Vite, chosen specifically because Rollup dedupes `@codemirror/state`
  (the no-build esm.sh path can load two copies and break the editor). Vite is a
  bundler, not a framework — the app code is plain vanilla TS.

## Run it

```sh
bun install
bun run dev          # Bun API (:8911) + Vite client (:5180) together
```

Then open http://localhost:5180. Edit a note, watch it persist to
`notes/<id>.md`, and click a `[[wikilink]]` to navigate. Override the API port
with `PORT=...` and the vault location with `NOTES_DIR=...`.

```sh
bun test             # unit + HTTP integration tests (run against a temp vault)
```

CI (`.github/workflows/ci.yml`) runs typecheck + tests + build on every push to
`main` and every PR — it activates automatically once the repo has a GitHub remote.

### Production

```sh
bun run build        # -> dist/ (static client)
bun run serve        # Bun API; put dist/ behind any static host or the server
```

## Roadmap

- [ ] Live-refresh an open note when its file changes on disk (SSE/WebSocket)
- [ ] Read-mode render + `![[transclusion]]` resolution
- [ ] Offline: service worker + IndexedDB dirty-queue
- [ ] Graph view over the link index
- [ ] Full-text (content) search

