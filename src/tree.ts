// Turning a flat list of note ids ("folder/sub/note") into a folder tree.
// Pure data — no DOM, no state — so it's trivial to reason about and test.
import type { NoteMeta } from "./api.ts";

export interface TreeNode {
  name: string;                      // last path segment, shown in the sidebar
  path: string;                      // full id up to here ("folder/sub")
  children: Map<string, TreeNode>;
  note?: NoteMeta;                   // set on leaves (a real note lives here)
}

export function buildTree(notes: NoteMeta[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const note of notes) {
    const parts = note.id.split("/");
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join("/"), children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    });
    node.note = note;
  }
  return root;
}

// The folder paths above an id: "a/b/note" -> ["a", "a/b"].
export function ancestors(id: string): string[] {
  const parts = id.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}
