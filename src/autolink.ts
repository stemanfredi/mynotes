// Clickable autolinks for bare http(s):// URLs. A mark decoration styles them;
// Cmd/Ctrl-click opens them in a new tab. Plain click still places the cursor, so
// URLs remain editable (this editor has no separate reading mode).

import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Range } from "@codemirror/state";

// Stop at whitespace and bracketing chars so trailing ) ] etc. aren't swallowed.
const URL_RE = /https?:\/\/[^\s<>()[\]]+/g;

function build(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const m of text.matchAll(URL_RE)) {
      const url = m[0].replace(/[.,;:!?'"]+$/, ""); // drop trailing sentence punctuation
      if (!url) continue;
      const start = from + m.index;
      decos.push(
        Decoration.mark({
          class: "cm-url",
          attributes: { "data-url": url, title: "⌘/Ctrl-click to open" },
        }).range(start, start + url.length),
      );
    }
  }
  return Decoration.set(decos, true);
}

export const autoLink = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(e) {
        const el = (e.target as HTMLElement)?.closest?.(".cm-url");
        if (el && (e.metaKey || e.ctrlKey)) {
          const url = el.getAttribute("data-url");
          if (url) {
            e.preventDefault();
            window.open(url, "_blank", "noopener,noreferrer");
          }
        }
      },
    },
  },
);
