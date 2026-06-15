// App shell: sidebar (note list) + editor + backlinks panel. Wires the editor to
// the API with debounced autosave, and resolves [[wikilink]] clicks to navigation
// (creating the target note on the fly if it doesn't exist yet).

import "./styles.css";
import { createEditor } from "./editor.ts";
import { WIKILINK_NAV } from "./wikilink.ts";
import * as api from "./api.ts";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const listEl = $("#note-list");
const backlinksEl = $("#backlinks");
const titleEl = $<HTMLInputElement>("#note-title");
const statusEl = $("#status");
const searchEl = $<HTMLInputElement>("#search");

let currentId: string | null = null;
let allNotes: api.NoteMeta[] = [];
const expanded = new Set<string>(); // folder paths the user has opened in the tree
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const editor = createEditor($("#editor"), (doc) => scheduleSave(doc));

function setStatus(s: string) { statusEl.textContent = s; }

function scheduleSave(doc: string) {
  if (!currentId) return;
  setStatus("editing…");
  clearTimeout(saveTimer);
  const id = currentId;
  saveTimer = setTimeout(async () => {
    const res = await api.saveNote(id, doc);
    if (res.ok) { setStatus("saved"); refreshList(); refreshBacklinks(id); }
    else setStatus(`conflict → saved as “${res.conflictId}”`);
  }, 500);
}

async function refreshList() {
  allNotes = await api.listNotes();
  renderList();
}

// A note id like "folder/note" becomes a nested tree. Folders are intermediate
// path segments; the leaf carries the note.
interface TreeNode { name: string; path: string; children: Map<string, TreeNode>; note?: api.NoteMeta; }

function buildTree(notes: api.NoteMeta[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const n of notes) {
    const parts = n.id.split("/");
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) { child = { name: part, path: parts.slice(0, i + 1).join("/"), children: new Map() }; node.children.set(part, child); }
      node = child;
      if (i === parts.length - 1) node.note = n;
    });
  }
  return root;
}

// ["a/b/note"] -> ["a", "a/b"] : the folder paths above a note.
function ancestors(id: string): string[] {
  const parts = id.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

// Render the tree, filtered by whatever is in the search box.
function renderList() {
  const q = searchEl.value.trim().toLowerCase();
  const shown = q ? allNotes.filter((n) => n.title.toLowerCase().includes(q)) : allNotes;
  const root = buildTree(shown);

  // Folders open for THIS render: the user-expanded set, plus auto-expand to keep
  // the active note visible and to reveal search matches (without changing state).
  const open = new Set(expanded);
  if (currentId) for (const a of ancestors(currentId)) open.add(a);
  if (q) for (const n of shown) for (const a of ancestors(n.id)) open.add(a);

  listEl.innerHTML = "";
  renderNodes(root, 0, open);
}

function renderNodes(node: TreeNode, depth: number, open: Set<string>) {
  const kids = [...node.children.values()].sort((a, b) => {
    const af = a.children.size > 0, bf = b.children.size > 0;
    if (af !== bf) return af ? -1 : 1;             // folders before notes
    return a.name.localeCompare(b.name);
  });
  for (const child of kids) {
    const isFolder = child.children.size > 0;
    const isOpen = isFolder && open.has(child.path);
    const li = document.createElement("li");
    li.style.paddingLeft = `${depth * 0.85 + 0.3}rem`;
    li.className = isFolder
      ? "folder" + (isOpen ? " open" : "")
      : "note" + (child.note!.id === currentId ? " active" : "");

    // Chevron lives in its own left gutter with an IMMEDIATE click handler — no
    // debounce — so expanding/collapsing is always reliable. Notes get an empty
    // gutter of the same width so their names line up under folder names.
    const chev = document.createElement("span");
    chev.className = "chevron" + (isFolder ? "" : " spacer");
    if (isFolder) {
      chev.textContent = ">";
      chev.onclick = (e) => { e.stopPropagation(); toggle(child.path); };
    }

    // The name is the open/rename target (single-click vs double-click).
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = child.name;
    if (isFolder) wireRow(name, () => toggle(child.path), () => startRename(li, child));
    else wireRow(name, () => openNote(child.note!.id), () => startRename(li, child));

    li.append(chev, name);
    listEl.appendChild(li);
    if (isOpen) renderNodes(child, depth + 1, open);
  }
}

function toggle(path: string) {
  if (expanded.has(path)) expanded.delete(path); else expanded.add(path);
  renderList();
}

// Single-click acts (open/toggle), double-click renames. We can't rely on the
// native dblclick event because the single-click handler re-renders the list and
// destroys the row before the second click. So defer the single action briefly;
// a second click within the window cancels it and triggers rename instead.
const DBLCLICK_MS = 220;
function wireRow(el: HTMLElement, onSingle: () => void, onDouble: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  el.onclick = () => {
    if (timer) { clearTimeout(timer); timer = undefined; onDouble(); return; }
    timer = setTimeout(() => { timer = undefined; onSingle(); }, DBLCLICK_MS);
  };
}

// Double-click a row -> edit its name inline. Works for notes and folders; the
// server figures out which and rewrites links / re-prefixes children as needed.
function startRename(li: HTMLLIElement, node: TreeNode) {
  const from = node.path;
  li.onclick = null;
  li.textContent = "";
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = node.name;
  li.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const cancel = () => { if (!done) { done = true; renderList(); } };
  const commit = async () => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (!name || name === node.name) return renderList();
    const slash = from.lastIndexOf("/");
    const to = slash === -1 ? name : from.slice(0, slash + 1) + name; // keep the parent path
    const res = await api.renameNote(from, to);
    if (!res.ok) { setStatus(`rename failed: ${res.reason}`); return renderList(); }
    // follow the rename for the open note + remembered expansion state
    if (currentId === from) currentId = to;
    else if (currentId?.startsWith(from + "/")) currentId = to + currentId.slice(from.length);
    for (const p of [...expanded]) {
      if (p === from || p.startsWith(from + "/")) { expanded.delete(p); expanded.add(to + p.slice(from.length)); }
    }
    if (currentId) titleEl.value = currentId;
    setStatus("renamed");
    refreshList();
    if (currentId) refreshBacklinks(currentId);
  };

  input.onclick = (e) => e.stopPropagation(); // don't trigger the row's open/toggle
  input.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  };
  input.onblur = commit;
}

async function refreshBacklinks(id: string) {
  const links = await api.getBacklinks(id);
  backlinksEl.innerHTML = links.length ? "" : "<li class='muted'>No backlinks</li>";
  for (const n of links) {
    const li = document.createElement("li");
    li.textContent = n.title;
    li.onclick = () => openNote(n.id);
    backlinksEl.appendChild(li);
  }
}

async function openNote(id: string) {
  let content: string;
  try { content = await api.getNote(id); }
  catch { content = ""; await api.saveNote(id, content); } // create-on-open: empty, title lives in the top bar
  currentId = id;
  titleEl.value = id;
  editor.setDoc(content);
  setStatus("saved");
  refreshList();
  refreshBacklinks(id);
}

// [[wikilink]] click -> open (and create if missing) the target note.
window.addEventListener(WIKILINK_NAV, (e) => openNote((e as CustomEvent).detail.target));

// Search box doubles as a quick-create: filter live, and on Enter open an exact
// match or — if nothing matches — create a note named after the typed term.
searchEl.oninput = renderList;
searchEl.onkeydown = (e) => {
  if (e.key !== "Enter") return;
  const name = searchEl.value.trim();
  if (!name) return;
  const hit = allNotes.find((n) => n.id.toLowerCase() === name.toLowerCase());
  searchEl.value = "";
  openNote(hit ? hit.id : name); // openNote() creates the note if it doesn't exist
};

// "+" creates (or opens) today's daily note, named like 2026-06-15.
$("#new-note").onclick = () => {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  openNote(today);
};

// Click the title to rename. Commit on Enter or blur; the server moves the file
// and rewrites [[links]] in other notes so nothing breaks. Esc cancels.
titleEl.onkeydown = (e) => {
  if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); }
  else if (e.key === "Escape") { titleEl.value = currentId ?? ""; titleEl.blur(); }
};
titleEl.onblur = async () => {
  const next = titleEl.value.trim();
  if (!currentId || !next || next === currentId) { titleEl.value = currentId ?? ""; return; }
  const res = await api.renameNote(currentId, next);
  if (res.ok) { currentId = next; setStatus("renamed"); refreshList(); refreshBacklinks(next); }
  else { setStatus(`rename failed: ${res.reason}`); titleEl.value = currentId; }
};

// Boot: load the list and open the first note (or a Welcome stub).
(async () => {
  const notes = await api.listNotes();
  await refreshList();
  await openNote(notes[0]?.id ?? "Welcome");
})();
