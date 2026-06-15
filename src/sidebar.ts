// The note-tree sidebar: renders notes as a folder tree, owns expand/collapse
// state, and handles row interactions (click = open/toggle, double-click =
// rename). It calls back to the app via onOpen / onRename; it does not know about
// the editor, the server, or app state beyond what update() is given.

import { el } from "./dom.ts";
import { buildTree, ancestors, type TreeNode } from "./tree.ts";
import type { NoteMeta } from "./api.ts";

export interface SidebarOptions {
  listEl: HTMLElement;
  onOpen: (id: string) => void;
  onRename: (from: string, to: string) => void;
  onDelete: (id: string) => void;
}

// Single-click acts (open/toggle); double-click renames. The native dblclick
// event is unreliable here because the single-click handler re-renders the list
// and destroys the row, so we defer the single action and cancel it on a second
// click within the window.
const DBLCLICK_MS = 220;

export function createSidebar({ listEl, onOpen, onRename, onDelete }: SidebarOptions) {
  const expanded = new Set<string>(); // folder paths the user has opened
  let notes: NoteMeta[] = [];
  let currentId: string | null = null;
  let query = "";

  function update(nextNotes: NoteMeta[], nextCurrentId: string | null, nextQuery: string) {
    notes = nextNotes;
    currentId = nextCurrentId;
    query = nextQuery;
    render();
  }

  function render() {
    const q = query.trim().toLowerCase();
    const shown = q ? notes.filter((n) => n.title.toLowerCase().includes(q)) : notes;

    // Folders open for this render: the remembered set, plus auto-expand to keep
    // the active note visible and to reveal search matches.
    const open = new Set(expanded);
    if (currentId) for (const a of ancestors(currentId)) open.add(a);
    if (q) for (const n of shown) for (const a of ancestors(n.id)) open.add(a);

    listEl.replaceChildren();
    renderNodes(buildTree(shown), 0, open);
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
      // toggling is reliable; notes get an empty gutter so names line up.
      const chev = el("span", { className: isFolder ? "chevron" : "chevron spacer" });
      if (isFolder) {
        chev.textContent = ">";
        chev.onclick = (e) => { e.stopPropagation(); toggle(child.path); };
      }

      const name = el("span", { className: "name", textContent: child.name });

      // Delete button, hover-revealed on the right. Confirms first; for folders
      // it warns that contents go too.
      const del = el("span", { className: "row-del", textContent: "×", title: "Delete" });
      del.onclick = (e) => {
        e.stopPropagation();
        const what = isFolder ? `folder “${child.name}” and its contents` : `“${child.name}”`;
        if (confirm(`Delete ${what}?`)) onDelete(child.path);
      };

      const li = el("li", {
        className: isFolder ? `folder${isOpen ? " open" : ""}` : `note${child.note!.id === currentId ? " active" : ""}`,
      }, chev, name, del);
      li.style.paddingLeft = `${depth * 0.85 + 0.3}rem`;

      const single = isFolder ? () => toggle(child.path) : () => onOpen(child.note!.id);
      wireRow(name, single, () => startRename(li, child));
      listEl.append(li);
      if (isOpen) renderNodes(child, depth + 1, open);
    }
  }

  function toggle(path: string) {
    if (expanded.has(path)) expanded.delete(path); else expanded.add(path);
    render();
  }

  function startRename(li: HTMLLIElement, node: TreeNode) {
    const from = node.path;
    const input = el("input", { className: "rename-input", value: node.name });
    li.replaceChildren(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (!commit || !name || name === node.name) return render(); // nothing to do, restore
      const slash = from.lastIndexOf("/");
      const to = slash === -1 ? name : from.slice(0, slash + 1) + name; // keep the parent path
      remapExpanded(from, to); // keep the renamed folder open
      onRename(from, to);
    };

    input.onclick = (e) => e.stopPropagation();
    input.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    };
    input.onblur = () => finish(true);
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

  return { update };
}

function wireRow(el: HTMLElement, onSingle: () => void, onDouble: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  el.onclick = () => {
    if (timer) { clearTimeout(timer); timer = undefined; onDouble(); return; }
    timer = setTimeout(() => { timer = undefined; onSingle(); }, DBLCLICK_MS);
  };
}
