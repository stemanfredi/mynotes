// App orchestration: owns the current note + the note list, wires the editor and
// sidebar together, and handles the top bar (rename), the search/create box, and
// the daily-note button. Tree rendering lives in sidebar.ts; this file is state.

import "./styles.css";
import { $, el } from "./dom.ts";
import { createEditor } from "./editor.ts";
import { createSidebar } from "./sidebar.ts";
import { WIKILINK_NAV } from "./preview.ts";
import * as api from "./api.ts";

const backlinksEl = $("#backlinks");
const titleEl = $<HTMLInputElement>("#note-title");
const statusEl = $("#status");
const searchEl = $<HTMLInputElement>("#search");
const menuToggleEl = $("#menu-toggle");
const backdropEl = $("#nav-backdrop");

let currentId: string | null = null;
let allNotes: api.NoteMeta[] = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const setStatus = (s: string) => { statusEl.textContent = s; };

const editor = createEditor($("#editor"), scheduleSave);
const sidebar = createSidebar({ listEl: $("#note-list"), onOpen: openNote, onRename: commitRename, onDelete: deleteItem });
const syncSidebar = () => sidebar.update(allNotes, currentId, searchEl.value);

async function refreshList() {
  allNotes = await api.listNotes();
  syncSidebar();
}

// --- note session ---------------------------------------------------------

// Open a note WITHOUT ever writing to it. Only fetches if the note is known to
// exist (avoids a 404 for a name you're about to create); a missing/ghost note
// opens as an unsaved blank, created lazily on first edit.
async function openNote(id: string) {
  let content: string | null = null;
  if (allNotes.some((n) => n.id === id)) {
    try {
      content = await api.getNote(id);
    } catch {
      setStatus("couldn't open — try again"); // network/5xx: never blank, leave as-is
      return;
    }
  }
  currentId = id;
  setNav(false); // close the mobile drawer once a note is chosen
  titleEl.value = id;
  editor.setDoc(content ?? "");
  setStatus(content === null ? "new note" : "saved");
  await refreshList();
  showBacklinks(id);
}

// Explicitly create-or-open a note: write an empty file if it doesn't exist (so
// it appears in the sidebar immediately), then open it. Used by deliberate create
// actions (search-Enter, the + button, clicking a [[new link]]).
async function createNote(id: string) {
  if (!allNotes.some((n) => n.id === id)) {
    await api.saveNote(id, "");
    await refreshList();
  }
  await openNote(id);
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

// Delete a note or folder. If the open note went away (directly or inside a
// deleted folder), fall back to another note or an empty editor.
async function deleteItem(id: string) {
  const hitCurrent = currentId === id || currentId?.startsWith(id + "/");
  if (!(await api.deleteItem(id))) { setStatus("delete failed"); return; }
  setStatus("deleted");
  if (hitCurrent) currentId = null;
  await refreshList();
  if (!hitCurrent) return;
  const next = allNotes[0]?.id;
  if (next) { openNote(next); return; }
  titleEl.value = "";
  editor.setDoc("");
  backlinksEl.replaceChildren();
}

// --- top bar, search, daily note ------------------------------------------

// [[wikilink]] click -> open the target, creating it if it doesn't exist.
window.addEventListener(WIKILINK_NAV, (e) => createNote((e as CustomEvent).detail.target));

// Search box doubles as quick-create: filter live; Enter opens an exact match or
// creates a note named after the typed term.
searchEl.oninput = syncSidebar;
searchEl.onkeydown = (e) => {
  if (e.key !== "Enter") return;
  const name = searchEl.value.trim();
  if (!name) return;
  const hit = allNotes.find((n) => n.id.toLowerCase() === name.toLowerCase());
  searchEl.value = "";
  hit ? openNote(hit.id) : createNote(name);
};

// "+" creates (or opens) today's daily note, e.g. 2026-06-15.
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
$("#new-note").onclick = () => createNote(today());

// Mobile drawer: ☰ toggles the sidebar; the backdrop (and opening a note) close
// it. No-ops on wide layouts, where the sidebar is always visible and ☰ is hidden.
const setNav = (open: boolean) => {
  document.body.classList.toggle("nav-open", open);
  menuToggleEl.setAttribute("aria-expanded", String(open));
};
menuToggleEl.onclick = () => setNav(!document.body.classList.contains("nav-open"));
backdropEl.onclick = () => setNav(false);

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
