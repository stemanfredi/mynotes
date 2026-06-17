// The note store. The filesystem IS the database — plain .md files under ./notes
// are the only source of truth. Everything here is either a thin file op or a
// derived, in-memory, throwaway index that can be rebuilt by re-scanning.

import { readdir, readFile, writeFile, mkdir, rename, rmdir, rm, stat } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { extractLinkTargets, parseWikiLinks } from "../shared/links.ts";

// Vault location: defaults to ./notes, overridable via NOTES_DIR (used by tests
// and to point the server at a different folder).
const NOTES_DIR = process.env.NOTES_DIR ?? join(import.meta.dir, "..", "notes");

export interface NoteMeta { id: string; title: string; }

// --- id <-> path mapping --------------------------------------------------
// id is the path relative to NOTES_DIR without the .md extension, slash-separated.

// Resolve a vault-relative path, rejecting traversal outside NOTES_DIR.
function vaultPath(rel: string): string {
  if (rel.includes("..") || rel.startsWith("/")) throw new Error("bad path");
  return join(NOTES_DIR, rel);
}

const idToPath = (id: string) => vaultPath(id + ".md");

// The title IS the filename (last path segment). The body stays pure content —
// no reliance on a duplicated `# H1`, which the top bar already shows.
function titleOf(id: string): string {
  return id.split("/").pop()!.trim();
}

export function etagOf(content: string): string {
  return '"' + Bun.hash(content).toString(16) + '"';
}

// A raw vault file (e.g. an embedded image), as a Bun.file for streaming.
// Existence is checked by the caller.
export const vaultFile = (rel: string) => Bun.file(vaultPath(rel));

// Write a raw (non-note) vault file, e.g. a pasted/dropped image. Creates parent
// dirs. Path is validated by vaultPath. Notes go through writeNote instead, so
// they stay ETag-guarded and indexed — callers must reject .md here.
export async function writeVaultFile(rel: string, bytes: ArrayBuffer): Promise<void> {
  const path = vaultPath(rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, new Uint8Array(bytes));
}

// Note ids directly or transitively under a folder, e.g. "proj" -> ["proj/a", ...].
const notesUnder = async (folder: string) => (await listIds()).filter((id) => id.startsWith(folder + "/"));

// Every note id in the vault (recursive), slash-separated, no .md extension.
// This is a plain readdir — no bodies read — so listing scales to any vault size
// and is always current; it underpins listNotes/notesUnder/search.
async function listIds(): Promise<string[]> {
  await mkdir(NOTES_DIR, { recursive: true });
  const entries = await readdir(NOTES_DIR, { recursive: true });
  return entries.filter((e) => e.endsWith(".md")).map((e) => e.replace(/\\/g, "/").replace(/\.md$/, ""));
}

// --- link index: cached, kept live two ways (no watcher) -------------------
// The .md files are authoritative; the backlink graph is derived and cached, kept
// current from two directions:
//   • in-app writes update the one changed entry in place (`record`) — no scan;
//   • external edits (vim, git, SSH) are caught by `sync`, a throttled reconcile
//     that re-reads only files whose mtime moved since it last looked.
// So backlinks stays O(1) on the hot path and the cost of noticing outside changes
// is ~O(files changed), never O(whole vault) — it scales to thousands of notes.

interface Indexed { mtime: number; targets: Set<string>; } // a note's outgoing links
const index = new Map<string, Indexed>();      // id -> last-seen mtime + link targets
let back = new Map<string, Set<string>>();      // id -> ids linking to it (derived)

// In-app writes keep the index live themselves (see `record`), so disk is polled
// for EXTERNAL edits only this often — bounding the cost of `sync` on busy reads.
const RECONCILE_MS = 1000;
let reconciledAt = 0;

// Invert `index` into the backlink map. Pure in-memory; no I/O.
function rebuildBack() {
  back = new Map();
  for (const [id, { targets }] of index) {
    for (const t of targets) {
      let sources = back.get(t);
      if (!sources) back.set(t, sources = new Set());
      sources.add(id);
    }
  }
}

// Record a note's current links in the index from content already in hand — the
// in-app write path, so a save/rename never triggers a vault scan. Caller calls
// rebuildBack once it's done recording. Stores the real mtime so a later reconcile
// won't re-read this file needlessly.
async function record(id: string, content: string) {
  try { index.set(id, { mtime: (await stat(idToPath(id))).mtimeMs, targets: new Set(extractLinkTargets(content)) }); }
  catch { index.delete(id); }
}

// Reconcile the cached index with what's on disk — this is what catches edits
// made OUTSIDE the app (vim, git, SSH). One readdir + a stat per file finds what
// changed; bodies are re-read ONLY for new/modified files (usually none), so the
// steady-state cost is ~O(files changed), not O(vault). Throttled, because in-app
// writes already keep the index current; `force` skips the throttle for the rare
// paths that must see disk right now (startup, rename).
async function sync(force = false): Promise<void> {
  if (!force && Date.now() - reconciledAt < RECONCILE_MS) return;
  reconciledAt = Date.now();
  await mkdir(NOTES_DIR, { recursive: true });
  const rels = (await readdir(NOTES_DIR, { recursive: true })).filter((e) => e.endsWith(".md"));
  const seen = new Set<string>();
  let changed = false;
  for (const rel of rels) {
    const id = rel.replace(/\\/g, "/").replace(/\.md$/, "");
    seen.add(id);
    let mtime: number;
    try { mtime = (await stat(join(NOTES_DIR, rel))).mtimeMs; } catch { continue; }
    if (index.get(id)?.mtime === mtime) continue; // unchanged since last reconcile
    try {
      const targets = new Set(extractLinkTargets(await readFile(join(NOTES_DIR, rel), "utf8")));
      index.set(id, { mtime, targets });
      changed = true;
    } catch { /* vanished mid-scan; the prune below or a later reconcile drops it */ }
  }
  for (const id of [...index.keys()]) if (!seen.has(id)) { index.delete(id); changed = true; }
  if (changed) rebuildBack();
}

// Rewrite every [[from]] / ![[from#h|alias]] in `content` to point at `to`,
// preserving the embed marker, heading, and alias. Done from the end backwards
// so earlier match offsets stay valid as lengths change.
function rewriteLinks(content: string, from: string, to: string): string {
  const hits = parseWikiLinks(content).filter((l) => l.target === from).reverse();
  let out = content;
  for (const l of hits) {
    const raw = out.slice(l.start, l.end).replace(/^(!?\[\[)\s*[^\]#|]*/, `$1${to}`);
    out = out.slice(0, l.start) + raw + out.slice(l.end);
  }
  return out;
}

// Warm the index from disk and return the note count (for the startup banner).
// The first sync reads every body once; later syncs re-read only what changed.
export async function buildIndex(): Promise<number> {
  index.clear();
  await sync(true);
  return index.size;
}

// --- public ops -----------------------------------------------------------

export async function listNotes(): Promise<NoteMeta[]> {
  return (await listIds())
    .map((id) => ({ id, title: titleOf(id) }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export async function readNote(id: string): Promise<{ content: string; etag: string } | null> {
  try {
    const content = await readFile(idToPath(id), "utf8");
    return { content, etag: etagOf(content) };
  } catch { return null; }
}

export interface WriteResult { ok: boolean; etag: string; conflictId?: string; }

export async function writeNote(id: string, content: string, ifMatch?: string): Promise<WriteResult> {
  const path = idToPath(id);
  // Last-write-wins guarded by ETag: if the caller's base version is stale, we
  // DON'T merge — we park their copy as a conflict file (Obsidian/Dropbox style).
  if (ifMatch) {
    const current = await readNote(id);
    if (current && current.etag !== ifMatch) {
      const stamp = new Date().toISOString().slice(0, 10);
      const conflictId = `${id} (conflict ${stamp})`;
      await writeFile(idToPath(conflictId), content, "utf8");
      await record(conflictId, content); rebuildBack();
      return { ok: false, etag: current.etag, conflictId };
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  await record(id, content); rebuildBack();
  return { ok: true, etag: etagOf(content) };
}

export type RenameResult =
  | { ok: true; etag: string }
  | { ok: false; reason: "exists" | "missing" | "same" };

// After moving a file out of a directory, remove any parent dirs left empty —
// so a folder rename doesn't strand the old (now empty) directory on disk.
async function pruneEmptyDirs(dir: string) {
  while (dir.startsWith(NOTES_DIR) && dir !== NOTES_DIR) {
    try {
      if ((await readdir(dir)).length) break; // still has files -> stop
      await rmdir(dir);
      dir = dirname(dir);
    } catch { break; }
  }
}

// Move one note and rewrite [[links]] to it, keeping the index in step without a
// rescan. Assumes the index is already reconciled (the caller does that once) and
// the move is valid — so it's safe to call in a tight loop for a folder rename.
async function moveNote(from: string, to: string, content: string) {
  const referrers = [...(back.get(from) ?? [])].filter((r) => r !== from);
  await mkdir(dirname(idToPath(to)), { recursive: true });
  await rename(idToPath(from), idToPath(to));
  await pruneEmptyDirs(dirname(idToPath(from)));
  index.delete(from);
  await record(to, content);
  for (const r of referrers) {
    const note = await readNote(r);
    if (!note) continue;
    const updated = rewriteLinks(note.content, from, to);
    if (updated !== note.content) { await writeFile(idToPath(r), updated, "utf8"); await record(r, updated); }
  }
  rebuildBack();
}

export async function renameNote(from: string, to: string): Promise<RenameResult> {
  to = to.trim();
  if (!to || from === to) return { ok: false, reason: "same" };
  if (await readNote(to)) return { ok: false, reason: "exists" };
  const cur = await readNote(from);
  if (!cur) return { ok: false, reason: "missing" };

  // Force a reconcile first so we don't miss a referrer added outside the app
  // since the last poll (a missed one would leave a broken [[link]]).
  await sync(true);
  await moveNote(from, to, cur.content);
  return { ok: true, etag: etagOf(cur.content) };
}

// Rename a folder = re-prefix every note under it (files move AND [[links]] to
// them get rewritten). Reconciles ONCE up front, then moves each child off the
// warm index — so the cost is independent of vault size, not O(children × vault).
export async function renameFolder(from: string, to: string): Promise<RenameResult> {
  to = to.trim();
  if (!to || from === to) return { ok: false, reason: "same" };
  const affected = await notesUnder(from);
  if (!affected.length) return { ok: false, reason: "missing" };
  for (const id of affected) {
    if (await readNote(to + id.slice(from.length))) return { ok: false, reason: "exists" };
  }
  await sync(true);
  for (const id of affected) {
    const cur = await readNote(id);
    if (cur) await moveNote(id, to + id.slice(from.length), cur.content);
  }
  return { ok: true, etag: "" };
}

// Delete a note or a whole folder (with its contents). Returns false if the id
// matches neither. Links pointing at deleted notes are left as-is (they simply
// become unresolved, recreated on next click) — same as Obsidian.
export async function deleteItem(id: string): Promise<boolean> {
  if (await readNote(id)) {
    await rm(idToPath(id));
    await pruneEmptyDirs(dirname(idToPath(id)));
    index.delete(id); rebuildBack();
    return true;
  }
  const affected = await notesUnder(id);
  if (!affected.length) return false;
  // Delete the notes, then prune the dirs they emptied. Any non-note files (e.g.
  // assets) under the folder are left in place.
  for (const k of affected) await rm(idToPath(k));
  for (const k of affected) await pruneEmptyDirs(dirname(idToPath(k)));
  for (const k of affected) index.delete(k);
  rebuildBack();
  return true;
}

export async function backlinks(id: string): Promise<NoteMeta[]> {
  await sync();
  return [...(back.get(id) ?? [])]
    .map((src) => ({ id: src, title: titleOf(src) }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

// --- content search -------------------------------------------------------
// Full-text search of note BODIES. The filesystem IS the index: ripgrep scans
// the vault on demand (no index to build or keep in sync). If `rg` isn't on the
// host we fall back to an in-process scan — same result shape, just slower.

export interface SearchHit { id: string; line: number; text: string; }

const MAX_HITS = 50;
const snippet = (line: string) => line.trim().slice(0, 200);
const idOfMdPath = (path: string) => relative(NOTES_DIR, path).replace(/\\/g, "/").replace(/\.md$/, "");

export async function searchContent(q: string): Promise<SearchHit[]> {
  q = q.trim();
  if (!q) return [];
  return (await ripgrep(q)) ?? scan(q); // rg when available, else in-process
}

// Query is passed as an argv element (after `--`), never through a shell, so it
// can't be interpreted as a flag or injected. `-F` = literal, `-i` = case-insensitive.
async function ripgrep(q: string): Promise<SearchHit[] | null> {
  let proc;
  try {
    proc = Bun.spawn(["rg", "--json", "-i", "-F", "--max-count", "5", "--", q, NOTES_DIR], { stderr: "ignore" });
  } catch {
    return null; // rg not installed -> caller falls back to scan()
  }
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) > 1) return null; // 0 = matches, 1 = none, >1 = real error -> fall back

  const hits: SearchHit[] = [];
  for (const raw of out.split("\n")) {
    if (!raw || hits.length >= MAX_HITS) break;
    let ev: any;
    try { ev = JSON.parse(raw); } catch { continue; }
    if (ev.type !== "match") continue;
    const path: string = ev.data?.path?.text ?? "";
    if (!path.endsWith(".md")) continue; // ignore assets and other non-notes
    hits.push({ id: idOfMdPath(path), line: ev.data.line_number ?? 0, text: snippet(ev.data.lines?.text ?? "") });
  }
  return hits;
}

async function scan(q: string): Promise<SearchHit[]> {
  const needle = q.toLowerCase();
  const hits: SearchHit[] = [];
  for (const id of (await listIds()).sort()) {
    if (hits.length >= MAX_HITS) break;
    const note = await readNote(id);
    if (!note) continue;
    const lines = note.content.split("\n");
    const i = lines.findIndex((l) => l.toLowerCase().includes(needle));
    if (i !== -1) hits.push({ id, line: i + 1, text: snippet(lines[i]) });
  }
  return hits;
}
