# mynotes

A deliberately minimal "Obsidian for the web." A folder of plain Markdown files
on the server, a web editor in front of it. No database, no CRDT, no framework.

## Architecture

```
Browser (Vite-built vanilla TS PWA)            Server (Bun, single script)
┌──────────────────────────────┐   fetch()    ┌────────────────────────────────┐
│ CodeMirror 6 editor          │ ───────────▶ │ GET  /api/notes                │
│  └ live-preview decorations  │              │ GET  /api/note/:id   (ETag)    │
│ markdown-it (read render)*   │              │ PUT  /api/note/:id   (If-Match)│
│ shared/links.ts ─────────────┼──────┐       │ GET  /api/backlinks/:id        │
└──────────────────────────────┘      │       │ GET  /api/search?q=            │
                                       │       │                                │
            same parser, both sides ───┘       │ notes/**.md  ← source of truth │
                                               │ in-memory link index (no DB)   │
                                               └────────────────────────────────┘
```

`shared/links.ts` defines `[[wikilink]]` syntax once and is imported by **both**
the client (rendering) and the server (indexing), so they can never disagree.

\* markdown-it is wired in `package.json` for a future read-only render mode; the
editor itself uses CodeMirror decorations for live preview.

## Design decisions

- **Storage**: server-side folder of standard `.md` files. The filesystem is the
  database — rebuildable in-memory index, no separate store.
- **Sync model**: single user, many devices, no live collaboration. Saves use
  `If-Match`/ETag → last-write-wins; a stale write is parked as a
  `note (conflict YYYY-MM-DD).md` copy instead of being merged.
- **Build**: Vite, chosen specifically because Rollup dedupes `@codemirror/state`
  (the no-build esm.sh path can load two copies and break the editor). Vite is a
  bundler, not a framework — the app code is plain vanilla TS.

## Run it

```sh
bun install          # or: npm install
bun run dev          # Bun server (:8787) + Vite client (:5173) together
```

Then open http://localhost:5173. Edit a note, watch it persist to
`notes/<id>.md`, and click a `[[wikilink]]` to navigate.

(The Bun API server listens on `:8911` by default; override with `PORT=...`.)

### Production

```sh
bun run build        # -> dist/ (static client)
bun run serve        # Bun server; put dist/ behind any static host or the server
```

## Roadmap

- [ ] Read-mode render via markdown-it + `![[transclusion]]` resolution
- [ ] Offline: service worker + IndexedDB dirty-queue
- [ ] Graph view over the link index
- [ ] Full-text search UI
