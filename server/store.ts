// The note store. The filesystem IS the database — plain .md files under ./notes
// are the only source of truth. Everything here is either a thin file op or a
// derived, in-memory, throwaway index that can be rebuilt by re-scanning.

import { readdir, readFile, writeFile, mkdir, rename, rmdir, rm, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { join, dirname } from "node:path";
import { extractLinkTargets, parseWikiLinks } from "../shared/links.ts";

const NOTES_DIR = join(import.meta.dir, "..", "notes");

export interface NoteMeta { id: string; title: string; }

// Derived index: forward[id] = ids this note links to; back[id] = ids that link here.
const forward = new Map<string, Set<string>>();
const back = new Map<string, Set<string>>();
const titles = new Map<string, string>();

// --- id <-> path mapping --------------------------------------------------
// id is the path relative to NOTES_DIR without the .md extension, slash-separated.

function idToPath(id: string): string {
  if (id.includes("..") || id.startsWith("/")) throw new Error("bad id");
  return join(NOTES_DIR, id + ".md");
}

// The title IS the filename (last path segment). The body stays pure content —
// no reliance on a duplicated `# H1`, which the top bar already shows.
function titleOf(id: string): string {
  return id.split("/").pop()!.trim();
}

export function etagOf(content: string): string {
  return '"' + Bun.hash(content).toString(16) + '"';
}

// --- index ----------------------------------------------------------------

// Remove this note's outgoing edges from the backlink map.
function clearOutgoing(id: string) {
  for (const t of forward.get(id) ?? []) back.get(t)?.delete(id);
}

function reindex(id: string, content: string) {
  clearOutgoing(id);
  const targets = new Set(extractLinkTargets(content));
  forward.set(id, targets);
  for (const target of targets) {
    let sources = back.get(target);
    if (!sources) back.set(target, sources = new Set());
    sources.add(id);
  }
  titles.set(id, titleOf(id));
}

function deindex(id: string) {
  clearOutgoing(id);
  forward.delete(id);
  back.delete(id);
  titles.delete(id);
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

export async function buildIndex(): Promise<number> {
  forward.clear(); back.clear(); titles.clear();
  await mkdir(NOTES_DIR, { recursive: true });
  const entries = await readdir(NOTES_DIR, { recursive: true });
  const mdFiles = entries.filter((e) => e.endsWith(".md"));
  for (const rel of mdFiles) {
    const id = rel.replace(/\\/g, "/").replace(/\.md$/, "");
    reindex(id, await readFile(join(NOTES_DIR, rel), "utf8"));
  }
  return mdFiles.length;
}

// Keep the index honest when notes change OUTSIDE the app (SSH, vim, git pull,
// file sync). Watches notes/ recursively and re-derives the changed file's
// index entry — adding new notes, dropping deleted ones, recomputing links.
export function watchNotes(onChange?: (id: string) => void) {
  watch(NOTES_DIR, { recursive: true }, async (_event, filename) => {
    if (!filename) return;
    const rel = filename.toString().replace(/\\/g, "/");

    if (rel.endsWith(".md")) {
      const id = rel.replace(/\.md$/, "");
      try {
        reindex(id, await readFile(idToPath(id), "utf8")); // created or modified
      } catch {
        deindex(id); // deleted or renamed away
      }
      onChange?.(id);
      return;
    }

    // A directory event. Only act when the path is gone — that means a folder was
    // removed (e.g. `rm -rf folder/`, which fs.watch reports at the directory
    // level, not per-file) — and drop every note beneath it.
    try { await stat(join(NOTES_DIR, rel)); return; } catch { /* gone */ }
    for (const id of [...titles.keys()]) {
      if (id === rel || id.startsWith(rel + "/")) { deindex(id); onChange?.(id); }
    }
  });
}

// --- public ops -----------------------------------------------------------

export function listNotes(): NoteMeta[] {
  return [...titles.entries()]
    .map(([id, title]) => ({ id, title }))
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
      reindex(conflictId, content);
      return { ok: false, etag: current.etag, conflictId };
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  reindex(id, content);
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

export async function renameNote(from: string, to: string): Promise<RenameResult> {
  to = to.trim();
  if (!to || from === to) return { ok: false, reason: "same" };
  if (await readNote(to)) return { ok: false, reason: "exists" };
  const cur = await readNote(from);
  if (!cur) return { ok: false, reason: "missing" };

  // Capture who links to `from` BEFORE we touch the index.
  const referrers = [...(back.get(from) ?? [])].filter((r) => r !== from);

  // Move the file, then swap the index entry from -> to.
  await mkdir(dirname(idToPath(to)), { recursive: true });
  await rename(idToPath(from), idToPath(to));
  await pruneEmptyDirs(dirname(idToPath(from)));
  deindex(from);
  reindex(to, cur.content);

  // Rewrite [[from]] -> [[to]] in every referrer so links don't break.
  for (const r of referrers) {
    const note = await readNote(r);
    if (!note) continue;
    const updated = rewriteLinks(note.content, from, to);
    if (updated !== note.content) {
      await writeFile(idToPath(r), updated, "utf8");
      reindex(r, updated);
    }
  }
  return { ok: true, etag: etagOf(cur.content) };
}

// Rename a folder = re-prefix every note under it. Each child goes through
// renameNote, so files move AND [[links]] to them get rewritten.
export async function renameFolder(from: string, to: string): Promise<RenameResult> {
  to = to.trim();
  if (!to || from === to) return { ok: false, reason: "same" };
  const prefix = from + "/";
  const affected = [...titles.keys()].filter((id) => id.startsWith(prefix));
  if (!affected.length) return { ok: false, reason: "missing" };
  for (const id of affected) {
    if (await readNote(to + id.slice(from.length))) return { ok: false, reason: "exists" };
  }
  for (const id of affected) await renameNote(id, to + id.slice(from.length));
  return { ok: true, etag: "" };
}

// Delete a note or a whole folder (with its contents). Returns false if the id
// matches neither. Links pointing at deleted notes are left as-is (they simply
// become unresolved, recreated on next click) — same as Obsidian.
export async function deleteItem(id: string): Promise<boolean> {
  if (await readNote(id)) {
    await rm(idToPath(id));
    deindex(id);
    await pruneEmptyDirs(dirname(idToPath(id)));
    return true;
  }
  const affected = [...titles.keys()].filter((k) => k.startsWith(id + "/"));
  if (!affected.length) return false;
  for (const k of affected) deindex(k);
  await rm(idToPath(id).replace(/\.md$/, ""), { recursive: true, force: true });
  return true;
}

export function backlinks(id: string): NoteMeta[] {
  return [...(back.get(id) ?? [])]
    .map((src) => ({ id: src, title: titles.get(src) ?? src }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
