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
const searchResultsEl = $("#search-results");
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
    setStatus(res.queued ? "offline — queued" : "saved");
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

// Search box does three things off one field: live-filter the tree by title,
// full-text search note bodies (results below the tree), and Enter to quick-create.
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const clearSearchResults = () => { clearTimeout(searchTimer); searchResultsEl.replaceChildren(); };

function scheduleContentSearch() {
  clearTimeout(searchTimer);
  const q = searchEl.value.trim();
  if (!q) return clearSearchResults();
  searchTimer = setTimeout(async () => {
    const hits = await api.searchContent(q); // resolves to [] on error, never throws
    if (searchEl.value.trim() !== q) return; // a newer keystroke superseded this one
    searchResultsEl.replaceChildren(...hits.map((h) =>
      el("li", { className: "search-hit", onclick: () => openNote(h.id) },
        el("div", { className: "sr-title", textContent: h.id.split("/").pop() || h.id }),
        el("div", { className: "sr-snippet", textContent: h.text }))));
  }, 200);
}

searchEl.oninput = () => { syncSidebar(); scheduleContentSearch(); };
searchEl.onkeydown = (e) => {
  if (e.key !== "Enter") return;
  const name = searchEl.value.trim();
  if (!name) return;
  const hit = allNotes.find((n) => n.id.toLowerCase() === name.toLowerCase());
  searchEl.value = "";
  clearSearchResults();
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

// Offline ↔ online: when the connection returns, replay queued writes and refresh;
// when it drops, say so. (Saves made offline are queued by the api layer.)
window.addEventListener("offline", () => setStatus("offline"));
window.addEventListener("online", async () => {
  await api.flushPending();
  await refreshList();
  if (currentId) showBacklinks(currentId);
  setStatus("saved");
});

// Service worker: prod only (in dev it would fight Vite's HMR). Caches the app
// shell + assets so a reload boots offline; the api layer handles data offline.
if (import.meta.env.PROD && "serviceWorker" in navigator)
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

// Boot: replay anything queued from a previous offline session, then open the
// first note (or a Welcome stub).
(async () => {
  if (navigator.onLine) api.flushPending().catch(() => {});
  await refreshList();
  await openNote(allNotes[0]?.id ?? "Welcome");
})();
