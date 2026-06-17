// The note-tree sidebar: renders notes as a folder tree, owns expand/collapse
// state, and handles row interactions (click = open/toggle). It calls back to the
// app via onOpen / onRename; it does not know about the editor, the server, or app
// state beyond what update() is given.
//
// Accessibility: the list is an ARIA `tree` with `treeitem` rows. Exactly one row
// is in the tab order (roving tabindex); arrows move between rows, Right/Left
// expand/collapse folders, Enter/Space open or toggle, F2 renames, Delete removes.
// Renaming is F2 (keyboard) or the title bar; mouse adds click and drag-and-drop.

import { el } from "./dom.ts";
import { buildTree, ancestors, type TreeNode } from "./tree.ts";
import type { NoteMeta } from "./api.ts";

export interface SidebarOptions {
  listEl: HTMLElement;
  onOpen: (id: string) => void;
  onRename: (from: string, to: string) => void;
  onDelete: (id: string) => void;
}

export function createSidebar({ listEl, onOpen, onRename, onDelete }: SidebarOptions) {
  const expanded = new Set<string>(); // folder paths the user has opened
  let notes: NoteMeta[] = [];
  let currentId: string | null = null;
  let query = "";
  let dragging: string | null = null; // path of the row being dragged
  let focusPath: string | null = null; // row that holds the single tab stop

  listEl.setAttribute("role", "tree");
  listEl.setAttribute("aria-label", "Notes");

  function update(nextNotes: NoteMeta[], nextCurrentId: string | null, nextQuery: string) {
    notes = nextNotes;
    currentId = nextCurrentId;
    query = nextQuery;
    render();
  }

  function render() {
    // Only steal focus back into the tree on re-render if it was already here
    // (e.g. mid keyboard-navigation) — never when the user is typing elsewhere.
    const restore = listEl.contains(document.activeElement);

    const q = query.trim().toLowerCase();
    const shown = q ? notes.filter((n) => n.title.toLowerCase().includes(q)) : notes;

    // Folders open for this render: the remembered set, plus auto-expand to keep
    // the active note visible and to reveal search matches.
    const open = new Set(expanded);
    if (currentId) for (const a of ancestors(currentId)) open.add(a);
    if (q) for (const n of shown) for (const a of ancestors(n.id)) open.add(a);

    listEl.replaceChildren();
    renderNodes(buildTree(shown), 0, open);

    // Roving tabindex: one row is tabbable — the one last focused if it survived,
    // else the active note, else the first row.
    const rows = rowEls();
    const want = rows.find((r) => r.dataset.path === focusPath)
      ?? rows.find((r) => r.getAttribute("aria-selected") === "true")
      ?? rows[0];
    if (want) {
      setTabStop(want);
      if (restore) want.focus();
    } else {
      focusPath = null;
    }
  }

  function renderNodes(node: TreeNode, depth: number, open: Set<string>) {
    const kids = [...node.children.values()].sort((a, b) => {
      const af = a.children.size > 0, bf = b.children.size > 0;
      if (af !== bf) return af ? -1 : 1;          // folders before notes
      return a.name.localeCompare(b.name);
    });
    for (const child of kids) {
      const isFolder = child.children.size > 0;
      const isOpen = isFolder && open.has(child.path);

      // Chevron in its own gutter with an IMMEDIATE click (no debounce) so
      // toggling is reliable; notes get an empty gutter so names line up. The
      // icon is decorative for AT — expansion is conveyed by aria-expanded.
      const chev = el("span", { className: isFolder ? "chevron" : "chevron spacer" });
      chev.setAttribute("aria-hidden", "true");
      if (isFolder) {
        chev.textContent = ">";
        chev.onclick = (e) => { e.stopPropagation(); toggle(child.path); };
      }

      // Drag the row by its name to move it (into a folder, or out to the root).
      const name = el("span", { className: "name", textContent: child.name, draggable: true });
      name.ondragstart = (e) => {
        dragging = child.path;
        e.dataTransfer!.setData("text/plain", child.path);
        e.dataTransfer!.effectAllowed = "move";
      };
      name.ondragend = () => { dragging = null; };

      // Delete button, hover-revealed on the right. Decorative for AT (the row
      // handles Delete); confirms first, and for folders warns contents go too.
      const del = el("span", { className: "row-del", textContent: "×", title: "Delete" });
      del.setAttribute("aria-hidden", "true");
      del.onclick = (e) => { e.stopPropagation(); requestDelete(li); };

      const li = el("li", {
        className: isFolder ? `folder${isOpen ? " open" : ""}` : `note${child.note!.id === currentId ? " active" : ""}`,
      }, chev, name, del) as HTMLLIElement;
      li.style.paddingLeft = `${depth * 0.85 + 0.6}rem`;

      // ARIA tree wiring + the data the keyboard handler reads off the row.
      li.setAttribute("role", "treeitem");
      li.setAttribute("aria-level", String(depth + 1));
      li.dataset.path = child.path;
      li.dataset.name = child.name;
      li.dataset.folder = String(isFolder);
      if (isFolder) li.setAttribute("aria-expanded", String(isOpen));
      if (!isFolder) {
        li.dataset.id = child.note!.id;
        if (child.note!.id === currentId) li.setAttribute("aria-selected", "true");
      }

      // Folders are drop targets: dropping a row here moves it inside.
      if (isFolder) {
        li.ondragover = (e) => {
          if (!moveTarget(dragging, child.path)) return; // not preventing default => no drop
          e.preventDefault();
          e.dataTransfer!.dropEffect = "move";
          li.classList.add("drop-target");
        };
        li.ondragleave = () => li.classList.remove("drop-target");
        li.ondrop = (e) => {
          e.preventDefault();
          e.stopPropagation(); // don't also trigger the root drop on listEl
          li.classList.remove("drop-target");
          moveInto(e.dataTransfer!.getData("text/plain"), child.path);
        };
      }

      name.onclick = isFolder ? () => toggle(child.path) : () => onOpen(child.note!.id);
      listEl.append(li);
      if (isOpen) renderNodes(child, depth + 1, open);
    }
  }

  function toggle(path: string) {
    if (expanded.has(path)) expanded.delete(path); else expanded.add(path);
    render();
  }

  function startRename(li: HTMLLIElement, from: string, currentName: string) {
    const input = el("input", { className: "rename-input", value: currentName });
    li.replaceChildren(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (!commit || !name || name === currentName) return render(); // nothing to do, restore
      const slash = from.lastIndexOf("/");
      const to = slash === -1 ? name : from.slice(0, slash + 1) + name; // keep the parent path
      remapExpanded(from, to); // keep the renamed folder open
      focusPath = to; // follow the row to its new name
      onRename(from, to);
    };

    input.onclick = (e) => e.stopPropagation();
    input.onkeydown = (e) => {
      e.stopPropagation(); // don't let the tree handler see typing/arrows
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    };
    input.onblur = () => finish(true);
  }

  // Confirm + delete, off a row element (shared by the × button and the Delete key).
  function requestDelete(li: HTMLLIElement) {
    const isFolder = li.dataset.folder === "true";
    const name = li.dataset.name ?? "";
    const what = isFolder ? `folder “${name}” and its contents` : `“${name}”`;
    if (confirm(`Delete ${what}?`)) onDelete(li.dataset.path!);
  }

  // When a folder is renamed, move its remembered expansion state to the new path.
  function remapExpanded(from: string, to: string) {
    for (const p of [...expanded]) {
      if (p === from || p.startsWith(from + "/")) {
        expanded.delete(p);
        expanded.add(to + p.slice(from.length));
      }
    }
  }

  // The new id if `from` were dropped into `targetFolder` ("" = root), or null if
  // the move is invalid (a no-op, or a folder into itself/a descendant).
  function moveTarget(from: string | null, targetFolder: string): string | null {
    if (!from || targetFolder === from || targetFolder.startsWith(from + "/")) return null;
    const leaf = from.split("/").pop()!;
    const to = targetFolder ? `${targetFolder}/${leaf}` : leaf;
    return to === from ? null : to;
  }

  // Move = rename to a new path; the server moves the file(s) and rewrites links.
  function moveInto(from: string, targetFolder: string) {
    const to = moveTarget(from, targetFolder);
    if (!to) return;
    if (targetFolder) remapExpanded(from, to);
    onRename(from, to);
  }

  // --- keyboard: roving tabindex over the visible rows -----------------------

  const rowEls = () => [...listEl.querySelectorAll<HTMLLIElement>('li[role="treeitem"]')];

  // Make `li` the single tabbable row (the roving tab stop) and remember it.
  function setTabStop(li: HTMLLIElement) {
    for (const r of rowEls()) r.tabIndex = -1;
    li.tabIndex = 0;
    focusPath = li.dataset.path ?? null;
  }

  function focusRow(li: HTMLLIElement | undefined) {
    if (!li) return;
    setTabStop(li);
    li.focus();
  }

  // Keep the tab stop on whatever row focus lands on (mouse click, programmatic).
  listEl.addEventListener("focusin", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[role="treeitem"]');
    if (li?.dataset.path) setTabStop(li);
  });

  listEl.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest(".rename-input")) return; // typing a new name
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[role="treeitem"]');
    if (!li) return;
    const path = li.dataset.path!;
    const isFolder = li.dataset.folder === "true";
    const isOpen = li.getAttribute("aria-expanded") === "true";
    const rows = rowEls();
    const idx = rows.indexOf(li);

    switch (e.key) {
      case "ArrowDown": e.preventDefault(); focusRow(rows[idx + 1]); break;
      case "ArrowUp": e.preventDefault(); focusRow(rows[idx - 1]); break;
      case "Home": e.preventDefault(); focusRow(rows[0]); break;
      case "End": e.preventDefault(); focusRow(rows[rows.length - 1]); break;
      case "ArrowRight":
        if (isFolder) {
          e.preventDefault();
          if (!isOpen) { focusPath = path; toggle(path); } // expand (re-renders, refocuses)
          else focusRow(rows[idx + 1]);                    // step into first child
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (isFolder && isOpen) { focusPath = path; toggle(path); } // collapse
        else if (path.includes("/")) {                              // jump to parent
          focusRow(rows.find((r) => r.dataset.path === path.slice(0, path.lastIndexOf("/"))));
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (isFolder) { focusPath = path; toggle(path); }
        else onOpen(li.dataset.id!);
        break;
      case "F2": e.preventDefault(); startRename(li, path, li.dataset.name ?? ""); break;
      case "Delete": e.preventDefault(); requestDelete(li); break;
    }
  });

  // The empty list area is a drop target for moving a row out to the root.
  listEl.ondragover = (e) => { if (e.target === listEl && dragging) e.preventDefault(); };
  listEl.ondrop = (e) => {
    if (e.target !== listEl) return;
    e.preventDefault();
    moveInto(e.dataTransfer!.getData("text/plain"), "");
  };

  return { update };
}
