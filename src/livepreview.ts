// Obsidian-style live preview for standard Markdown marks. Walks the markdown
// syntax tree and, for each construct, styles the content (bold/italic/inline
// code/headings) and HIDES the surrounding markers (**, *, `, #) — except on the
// line the cursor is on, where the raw markup is revealed so you can edit it.
//
// Wikilinks are handled separately in wikilink.ts (they aren't in the markdown
// grammar); this covers everything the parser does understand.

import { syntaxTree } from "@codemirror/language";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Range } from "@codemirror/state";

const HIDE = Decoration.replace({});

// Whole-construct styling (applied even on the active line).
const CONTENT: Record<string, Decoration> = {
  StrongEmphasis: Decoration.mark({ class: "cm-pv cm-pv-strong" }),
  Emphasis: Decoration.mark({ class: "cm-pv cm-pv-em" }),
  InlineCode: Decoration.mark({ class: "cm-pv cm-pv-code" }),
  Strikethrough: Decoration.mark({ class: "cm-pv cm-pv-strike" }),
};

// Marker tokens to hide when the cursor isn't on their line.
const MARKERS = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark", "HeaderMark"]);

function build(view: EditorView): DecorationSet {
  const { state } = view;

  // Lines touched by any selection — markers on these stay visible for editing.
  const active = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) active.add(l);
  }

  const decos: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const content = CONTENT[node.name];
        if (content) { decos.push(content.range(node.from, node.to)); return; }

        const heading = /^ATXHeading(\d)$/.exec(node.name);
        if (heading) {
          decos.push(Decoration.mark({ class: `cm-pv cm-pv-h${heading[1]}` }).range(node.from, node.to));
          return;
        }

        if (MARKERS.has(node.name) && !active.has(state.doc.lineAt(node.from).number)) {
          let end = node.to;
          // Hide the space after "# " too, so the heading text starts at the margin.
          if (node.name === "HeaderMark" && state.doc.sliceString(end, end + 1) === " ") end++;
          if (end > node.from) decos.push(HIDE.range(node.from, end));
        }
      },
    });
  }
  return Decoration.set(decos, true);
}

export const markdownLivePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
