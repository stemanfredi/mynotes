// App orchestration: owns the current note + the note list, wires the editor and
// sidebar together, and handles the top bar (rename), the search/create box, and
// the daily-note button. Tree rendering lives in sidebar.ts; this file is state.

import "./styles.css";
import { $, el } from "./dom.ts";
import { createEditor } from "./editor.ts";
import { createSidebar } from "./sidebar.ts";
import { WIKILINK_NAV } from "./wikilink.ts";
import * as api from "./api.ts";

const backlinksEl = $("#backlinks");
const titleEl = $<HTMLInputElement>("#note-title");
const statusEl = $("#status");
const searchEl = $<HTMLInputElement>("#search");

let currentId: string | null = null;
let allNotes: api.NoteMeta[] = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const setStatus = (s: string) => { statusEl.textContent = s; };

const editor = createEditor($("#editor"), scheduleSave);
const sidebar = createSidebar({ listEl: $("#note-list"), onOpen: openNote, onRename: commitRename });
const syncSidebar = () => sidebar.update(allNotes, currentId, searchEl.value);

async function refreshList() {
  allNotes = await api.listNotes();
  syncSidebar();
}

// --- note session ---------------------------------------------------------

async function openNote(id: string) {
  let content: string;
  try { content = await api.getNote(id); }
  catch { content = ""; await api.saveNote(id, content); } // create-on-open; title lives in the top bar
  currentId = id;
  titleEl.value = id;
  editor.setDoc(content);
  setStatus("saved");
  await refreshList();
  showBacklinks(id);
}

function scheduleSave(doc: string) {
  if (!currentId) return;
  setStatus("editing…");
  clearTimeout(saveTimer);
  const id = currentId;
  saveTimer = setTimeout(async () => {
    const res = await api.saveNote(id, doc);
    if (!res.ok) return setStatus(`conflict → saved as “${res.conflictId}”`);
    setStatus("saved");
    await refreshList();
    showBacklinks(id);
  }, 500);
}

async function showBacklinks(id: string) {
  const links = await api.getBacklinks(id);
  backlinksEl.replaceChildren(
    ...(links.length
      ? links.map((n) => el("li", { textContent: n.title, onclick: () => openNote(n.id) }))
      : [el("li", { className: "muted", textContent: "No backlinks" })]),
  );
}

// Rename a note or folder, then follow it for the open note + top bar. Shared by
// the title field and the sidebar's inline rename.
async function commitRename(from: string, to: string) {
  const res = await api.renameNote(from, to);
  if (!res.ok) { setStatus(`rename failed: ${res.reason}`); syncSidebar(); return; }
  if (currentId === from) currentId = to;
  else if (currentId?.startsWith(from + "/")) currentId = to + currentId.slice(from.length);
  if (currentId) titleEl.value = currentId;
  setStatus("renamed");
  await refreshList();
  if (currentId) showBacklinks(currentId);
}

// --- top bar, search, daily note ------------------------------------------

// [[wikilink]] click -> open (creating the target if missing).
window.addEventListener(WIKILINK_NAV, (e) => openNote((e as CustomEvent).detail.target));

// Search box doubles as quick-create: filter live; Enter opens an exact match or
// creates a note named after the typed term.
searchEl.oninput = syncSidebar;
searchEl.onkeydown = (e) => {
  if (e.key !== "Enter") return;
  const name = searchEl.value.trim();
  if (!name) return;
  const hit = allNotes.find((n) => n.id.toLowerCase() === name.toLowerCase());
  searchEl.value = "";
  openNote(hit ? hit.id : name);
};

// "+" creates (or opens) today's daily note, e.g. 2026-06-15.
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
$("#new-note").onclick = () => openNote(today());

// Click the title to rename the open note. Enter/blur commits, Esc cancels.
titleEl.onkeydown = (e) => {
  if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); }
  else if (e.key === "Escape") { titleEl.value = currentId ?? ""; titleEl.blur(); }
};
titleEl.onblur = () => {
  const next = titleEl.value.trim();
  if (!currentId || !next || next === currentId) { titleEl.value = currentId ?? ""; return; }
  commitRename(currentId, next);
};

// Boot: open the first note (or a Welcome stub).
(async () => {
  await refreshList();
  await openNote(allNotes[0]?.id ?? "Welcome");
})();
