// Obsidian-style live preview for standard Markdown marks. Walks the markdown
// syntax tree and, for each construct, styles the content (bold/italic/inline
// code/headings) and HIDES the surrounding markers (**, *, `, #) — except on the
// line the cursor is on, where the raw markup is revealed so you can edit it.
//
// Wikilinks are handled separately in wikilink.ts (they aren't in the markdown
// grammar); this covers everything the parser does understand.

import { syntaxTree } from "@codemirror/language";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import { ImageWidget } from "./media.ts";

const HIDE = Decoration.replace({});

// Whole-construct styling (applied even on the active line).
const CONTENT: Record<string, Decoration> = {
  StrongEmphasis: Decoration.mark({ class: "cm-pv cm-pv-strong" }),
  Emphasis: Decoration.mark({ class: "cm-pv cm-pv-em" }),
  InlineCode: Decoration.mark({ class: "cm-pv cm-pv-code" }),
  Strikethrough: Decoration.mark({ class: "cm-pv cm-pv-strike" }),
};

// Marker tokens to hide when the cursor isn't on their line.
const MARKERS = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark", "HeaderMark", "QuoteMark"]);

// Replaces a hidden opening fence line, showing the language as a corner label.
class LangLabel extends WidgetType {
  constructor(readonly lang: string) { super(); }
  eq(other: LangLabel) { return other.lang === this.lang; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-pv-cb-lang";
    span.textContent = this.lang;
    return span;
  }
}

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
        // Fenced code: a monospace code-box background on every line. When the
        // cursor is OUTSIDE the block, hide the ``` fence lines and show the
        // language as a corner label; inside, leave them raw so they're editable.
        // Skip children (the ``` are CodeMark nodes — don't let the inline marker
        // logic touch them).
        if (node.name === "FencedCode") {
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
          let cursorInside = false;
          for (let l = first; l <= last; l++) if (active.has(l)) { cursorInside = true; break; }

          for (let n = first; n <= last; n++) {
            const line = state.doc.line(n);
            const edge = n === first ? " cm-pv-cb-open" : n === last ? " cm-pv-cb-close" : "";
            decos.push(Decoration.line({ class: "cm-pv-codeblock" + edge }).range(line.from));
          }

          if (!cursorInside) {
            const marks = node.node.getChildren("CodeMark"); // opening (and closing) ```
            if (marks.length) {
              const openLine = state.doc.lineAt(marks[0].from);
              const info = node.node.getChild("CodeInfo");
              const lang = info ? state.doc.sliceString(info.from, info.to) : "";
              decos.push(Decoration.replace({ widget: new LangLabel(lang) }).range(openLine.from, openLine.to));
            }
            if (marks.length > 1) {
              const closeLine = state.doc.lineAt(marks[marks.length - 1].from);
              if (closeLine.length) decos.push(Decoration.replace({}).range(closeLine.from, closeLine.to));
            }
          }
          return false;
        }

        // Blockquote: a left bar + indent on every line. Children are still
        // visited so the `>` markers get hidden (QuoteMark) and inline marks work.
        if (node.name === "Blockquote") {
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
          for (let n = first; n <= last; n++) {
            decos.push(Decoration.line({ class: "cm-pv-quote" }).range(state.doc.line(n).from));
          }
          return;
        }

        // Markdown image ![alt](url): replace with the rendered image off the
        // cursor line; reveal the raw source when editing that line.
        if (node.name === "Image") {
          const url = node.node.getChild("URL");
          if (url && !active.has(state.doc.lineAt(node.from).number)) {
            const marks = node.node.getChildren("LinkMark");
            const alt = marks.length >= 2 ? state.doc.sliceString(marks[0].to, marks[1].from) : "";
            decos.push(Decoration.replace({ widget: new ImageWidget(state.doc.sliceString(url.from, url.to), alt) }).range(node.from, node.to));
          }
          return false;
        }

        // Markdown link [text](url): style the text as a clickable link (reusing
        // the autolink's cm-url class/handler) and hide the [, ](url) machinery
        // off the cursor line. Children still render so [**bold**](url) works.
        if (node.name === "Link") {
          const marks = node.node.getChildren("LinkMark"); // [ ] ( )
          const url = node.node.getChild("URL");
          if (marks.length >= 2 && url) {
            const textFrom = marks[0].to, textTo = marks[1].from;
            if (textTo > textFrom) {
              const href = state.doc.sliceString(url.from, url.to);
              decos.push(Decoration.mark({
                class: "cm-url",
                attributes: { "data-url": href, title: "⌘/Ctrl-click to open" },
              }).range(textFrom, textTo));
            }
            if (!active.has(state.doc.lineAt(node.from).number)) {
              decos.push(HIDE.range(node.from, marks[0].to));   // "["
              decos.push(HIDE.range(marks[1].from, node.to));   // "](url)"
            }
          }
          return;
        }

        const content = CONTENT[node.name];
        if (content) { decos.push(content.range(node.from, node.to)); return; }

        const heading = /^ATXHeading(\d)$/.exec(node.name);
        if (heading) {
          decos.push(Decoration.mark({ class: `cm-pv cm-pv-h${heading[1]}` }).range(node.from, node.to));
          return;
        }

        if (MARKERS.has(node.name) && !active.has(state.doc.lineAt(node.from).number)) {
          let end = node.to;
          // Hide the space after "# " / "> " too, so text starts at the margin.
          if ((node.name === "HeaderMark" || node.name === "QuoteMark") && state.doc.sliceString(end, end + 1) === " ") end++;
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
