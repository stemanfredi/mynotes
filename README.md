# mynotes

A deliberately minimal "Obsidian for the web." A folder of plain Markdown files
on the server, a web editor in front of it. No database, no CRDT, no framework.

## Architecture

```
Browser (Vite-built vanilla TS app)            Server (Bun, single script)
┌──────────────────────────────┐   fetch()    ┌────────────────────────────────┐
│ CodeMirror 6 editor          │ ───────────> │ GET  /api/notes                │
│  └ live-preview decorations  │              │ GET  /api/search?q= (full-text)│
│ sidebar folder tree          │              │ GET  /api/note/:id   (ETag)    │
│ content search + image paste │              │ PUT  /api/note/:id   (If-Match)│
│ shared/links.ts ─────────────┼──────┐       │ DELETE /api/note/:id           │
│ offline cache + write queue  │      │       │ POST /api/rename   {from,to}   │
└──────────────────────────────┘      │       │ GET  /api/backlinks/:id        │
                                      │       │ GET|PUT /api/file/:path        │
                                      │       │                                │
           same parser, both sides ───┘       │ notes/**.md  ← source of truth │
                                              │ cached link index (no DB),     │
                                              │ mtime-reconciled, no watcher   │
                                              └────────────────────────────────┘
```

`shared/links.ts` defines `[[wikilink]]` syntax once and is imported by **both**
the client (rendering) and the server (indexing), so they can never disagree.

## Project layout

```
shared/links.ts        wiki-link parsing — shared by client and server
server/store.ts        the vault: file ops + cached link index, mtime-reconciled
server/index.ts        HTTP routing over Bun.serve
src/api.ts             typed fetch wrapper: ETag conflict detection + offline cache/queue
src/editor.ts          CodeMirror 6 setup (+ paste/drop image upload)
src/preview.ts         live preview: Markdown + [[wikilinks]] + URLs, one pass
src/code-languages.ts  lazy-loaded languages for fenced-code highlighting
src/media.ts           image embed helpers (isImage, ImageWidget)
src/idb.ts             IndexedDB cache + offline write queue (notes/meta/pending)
src/tree.ts            pure: flat note ids -> folder tree
src/sidebar.ts         the note-tree component (render, expand/collapse, rename, DnD)
src/dom.ts             $ / el DOM helpers
src/main.ts            app orchestration: state, editor + sidebar wiring, top bar
```

## Design decisions

- **Storage**: server-side folder of standard `.md` files. The filesystem is the
  database. The backlink index is cached in memory and kept live two ways: in-app
  writes update the changed entry in place, and a throttled mtime reconcile re-reads
  only files that changed on disk — so external edits (SSH, vim, git) are picked up
  within ~1s and backlinks stays cheap at thousands of notes. No watcher.
- **Sync model**: single user, many devices, no live collaboration. Saves use
  `If-Match`/ETag → last-write-wins; a stale write is parked as a
  `note (conflict YYYY-MM-DD).md` copy instead of being merged.
- **Title = filename**: the body is pure Markdown content; renaming a note or
  folder moves the file(s) and rewrites `[[links]]` to them.
- **Build**: Vite, chosen specifically because Rollup dedupes `@codemirror/state`
  (the no-build esm.sh path can load two copies and break the editor). Vite is a
  bundler, not a framework — the app code is plain vanilla TS.
- **Search**: ripgrep over the vault on demand — the filesystem is the index, so
  there's nothing to build or keep in sync (an in-process scan covers hosts
  without `rg`).
- **Images**: paste or drop into the editor stores the file under `assets/` and
  inserts a Markdown link.
- **Offline**: a service worker caches the app shell; `src/idb.ts` caches notes
  and queues edits, replaying them on reconnect — a stale replay parks the same
  conflict copy as any other late write.

## Markdown support

The editor is live-preview: Markdown renders inline as you type, and the raw
syntax of the line under the cursor stays visible to edit. Files are never
rewritten — they remain byte-for-byte standard Markdown.

The ordinary syntax just works — headings, **bold**, *italic*, ~~strikethrough~~,
`inline code`, blockquotes. The parts with behavior specific to this app:

- **Fenced code** is syntax-highlighted, with each language's parser lazy-loaded on
  first use — JS/TS, Python, JSON, HTML, CSS, SQL, YAML, Rust, Go, Markdown. Off the
  cursor, the opening fence line collapses to a small language label in the corner.
- **`[[wikilinks]]`** link between notes — click to open, creating the note if it
  doesn't exist; `[[note|alias]]` and `[[note#heading]]` are understood, and
  backlinks are tracked automatically (shown in the right panel).
- **Links & URLs** — `[text](url)` and bare URLs are styled as links; Cmd/Ctrl-click
  (or Mod-Enter with the cursor on them) opens them in a new tab.
- **Tables** (GFM pipe tables) render as a real grid when the cursor is outside, and
  return to raw Markdown when you click in. Delimiter-row alignment (`:--` `--:`
  `:-:`) is honored. Cells are plain text — inline Markdown inside a cell isn't formatted.
- **Images** embed inline — `![alt](path)` and `![[image]]`, served from the vault.
  Paste or drop an image onto the editor to upload it (saved under `assets/`) and
  insert the link.

## Run it

**Requirements:** [Bun](https://bun.com) to run. Full-text content search shells
out to [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) when it's on the
server's `PATH` — it's optional, with a slower in-process scan as a fallback when
`rg` is absent. Install it with `apt install ripgrep` (Debian/Ubuntu),
`brew install ripgrep` (macOS), or your platform's equivalent.

```sh
bun install
bun run dev          # Bun API (:8911) + Vite client (:5180) together
```

Then open http://localhost:5180. Edit a note, watch it persist to
`notes/<id>.md`, and click a `[[wikilink]]` to navigate.

Environment overrides (all optional):

```sh
PORT=9000 bun run dev                      # API port (default 8911)
HOST=127.0.0.1 bun run serve               # bind one interface (default 0.0.0.0); use localhost behind a proxy
NOTES_DIR=/path/to/vault bun run dev       # vault location (default ./notes)
DEV_HOST=notes.example.com bun run dev     # serve dev behind a reverse proxy / tunnel:
                                           # allows that Host header + routes HMR over TLS (:443)
```

```sh
bun test             # unit + HTTP integration tests (run against a temp vault)
```

CI (`.github/workflows/ci.yml`) runs typecheck + tests + build on every push to
`main` and every PR — it activates automatically once the repo has a GitHub remote.

### Production

```sh
bun run build        # -> dist/ (static client + service worker)
bun run serve        # one process: Bun serves the API *and* the built client
```

Serving the client and the API from one origin is what lets the service worker
cache the app for offline use — open the served URL, not Vite's dev port.

## Roadmap

- [ ] Live-refresh an open note when its file changes on disk (SSE/WebSocket)
- [ ] Read-mode render + `![[transclusion]]` resolution
- [ ] Graph view over the link index

