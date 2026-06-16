// The editor's live preview, in a single pass. It renders Markdown inline —
// styling marks and hiding their syntax, rendering code blocks, quotes, links and
// images — plus the two things that aren't in the Markdown grammar: [[wikilinks]]
// and bare URLs. Syntax is revealed for editing on whatever line the cursor is on.
// The document is never mutated; these are view-only decorations.

import { syntaxTree } from "@codemirror/language";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { EditorState, Range } from "@codemirror/state";
import { parseWikiLinks } from "../shared/links.ts";
import { ImageWidget, isImage } from "./media.ts";

/** Dispatched when a rendered [[wikilink]] is clicked; main.ts navigates to it. */
export const WIKILINK_NAV = "mynotes:wikilink-nav";

const HIDE = Decoration.replace({});

// Inline styling for whole constructs (kept even on the active line).
const STYLE: Record<string, Decoration> = {
  StrongEmphasis: Decoration.mark({ class: "cm-pv cm-pv-strong" }),
  Emphasis: Decoration.mark({ class: "cm-pv cm-pv-em" }),
  InlineCode: Decoration.mark({ class: "cm-pv cm-pv-code" }),
  Strikethrough: Decoration.mark({ class: "cm-pv cm-pv-strike" }),
};

// Markdown markers hidden unless the cursor is on their line.
const MARKERS = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark", "HeaderMark", "QuoteMark"]);

const URL_RE = /https?:\/\/[^\s<>()[\]]+/g;
const urlMark = (href: string) =>
  Decoration.mark({ class: "cm-url", attributes: { "data-url": href, title: "⌘/Ctrl-click to open" } });

class WikiLinkWidget extends WidgetType {
  constructor(readonly target: string, readonly label: string, readonly embed: boolean) { super(); }
  eq(o: WikiLinkWidget) { return o.target === this.target && o.label === this.label && o.embed === this.embed; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-wikilink" + (this.embed ? " cm-wikilink--embed" : "");
    el.textContent = this.label;
    el.title = this.target;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent(WIKILINK_NAV, { detail: { target: this.target } }));
    });
    return el;
  }
  ignoreEvent() { return false; }
}

// Replaces a hidden opening fence line, showing the language as a corner label.
class LangLabel extends WidgetType {
  constructor(readonly lang: string) { super(); }
  eq(o: LangLabel) { return o.lang === this.lang; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-pv-cb-lang";
    span.textContent = this.lang;
    return span;
  }
}

/** Line numbers the cursor/selection touches — their raw markup stays visible. */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) lines.add(l);
  }
  return lines;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const revealed = (pos: number) => active.has(state.doc.lineAt(pos).number);
  const decos: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    // 1. Markdown constructs from the syntax tree.
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const name = node.name;

        // Fenced code: monospace box on every line. Off the cursor, hide the ```
        // fences (language shown as a corner label); inside, leave them editable.
        // Children skipped so the inline-marker logic ignores the ``` (CodeMark).
        if (name === "FencedCode") {
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
          let inside = false;
          for (let l = first; l <= last; l++) if (active.has(l)) { inside = true; break; }
          for (let n = first; n <= last; n++) {
            const edge = n === first ? " cm-pv-cb-open" : n === last ? " cm-pv-cb-close" : "";
            decos.push(Decoration.line({ class: "cm-pv-codeblock" + edge }).range(state.doc.line(n).from));
          }
          if (!inside) {
            const marks = node.node.getChildren("CodeMark");
            if (marks.length) {
              const openLine = state.doc.lineAt(marks[0].from);
              const info = node.node.getChild("CodeInfo");
              const lang = info ? state.doc.sliceString(info.from, info.to) : "";
              decos.push(Decoration.replace({ widget: new LangLabel(lang) }).range(openLine.from, openLine.to));
            }
            if (marks.length > 1) {
              const closeLine = state.doc.lineAt(marks[marks.length - 1].from);
              if (closeLine.length) decos.push(HIDE.range(closeLine.from, closeLine.to));
            }
          }
          return false;
        }

        // Blockquote: a left bar + indent on every line. Children still visited so
        // the `>` markers hide (QuoteMark) and inline marks render.
        if (name === "Blockquote") {
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
          for (let n = first; n <= last; n++) {
            decos.push(Decoration.line({ class: "cm-pv-quote" }).range(state.doc.line(n).from));
          }
          return;
        }

        // ![alt](url): render the image off the cursor line; raw source for editing.
        if (name === "Image") {
          const url = node.node.getChild("URL");
          if (url && !revealed(node.from)) {
            const marks = node.node.getChildren("LinkMark");
            const alt = marks.length >= 2 ? state.doc.sliceString(marks[0].to, marks[1].from) : "";
            decos.push(Decoration.replace({ widget: new ImageWidget(state.doc.sliceString(url.from, url.to), alt) }).range(node.from, node.to));
          }
          return false;
        }

        // [text](url): show the text as a clickable link (shares the cm-url class /
        // handler); hide the [, ](url) off the cursor line. Children still render.
        if (name === "Link") {
          const marks = node.node.getChildren("LinkMark"); // [ ] ( )
          const url = node.node.getChild("URL");
          if (marks.length >= 2 && url) {
            const textFrom = marks[0].to, textTo = marks[1].from;
            if (textTo > textFrom) decos.push(urlMark(state.doc.sliceString(url.from, url.to)).range(textFrom, textTo));
            if (!revealed(node.from)) {
              decos.push(HIDE.range(node.from, marks[0].to));  // "["
              decos.push(HIDE.range(marks[1].from, node.to));  // "](url)"
            }
          }
          return;
        }

        const style = STYLE[name];
        if (style) { decos.push(style.range(node.from, node.to)); return; }

        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) { decos.push(Decoration.mark({ class: `cm-pv cm-pv-h${heading[1]}` }).range(node.from, node.to)); return; }

        if (MARKERS.has(name) && !revealed(node.from)) {
          let end = node.to;
          // Hide the space after "# " / "> " too, so text starts at the margin.
          if ((name === "HeaderMark" || name === "QuoteMark") && state.doc.sliceString(end, end + 1) === " ") end++;
          if (end > node.from) decos.push(HIDE.range(node.from, end));
        }
      },
    });

    // 2. [[wikilinks]] / ![[embeds]] and bare URLs — not in the Markdown grammar.
    const text = state.doc.sliceString(from, to);
    for (const link of parseWikiLinks(text)) {
      const start = from + link.start;
      if (revealed(start)) continue;
      const widget = link.embed && isImage(link.target)
        ? new ImageWidget(link.target, link.label)
        : new WikiLinkWidget(link.target, link.label, link.embed);
      decos.push(Decoration.replace({ widget }).range(start, from + link.end));
    }
    for (const m of text.matchAll(URL_RE)) {
      const href = m[0].replace(/[.,;:!?'"]+$/, ""); // drop trailing sentence punctuation
      if (href) decos.push(urlMark(href).range(from + m.index, from + m.index + href.length));
    }
  }

  return Decoration.set(decos, true);
}

// Keyboard equivalent of clicking a link: follow the [[wikilink]] or bare URL the
// cursor sits in. Bound to Mod-Enter in the editor (Tab is taken by indentation,
// so links inside the editable doc need a key command rather than tab-focus).
export function followLinkAtCursor(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const col = state.selection.main.head - line.from;

  for (const link of parseWikiLinks(line.text)) {
    if (col >= link.start && col <= link.end) {
      window.dispatchEvent(new CustomEvent(WIKILINK_NAV, { detail: { target: link.target } }));
      return true;
    }
  }
  for (const m of line.text.matchAll(URL_RE)) {
    const start = m.index, end = start + m[0].length;
    if (col >= start && col <= end) {
      const href = m[0].replace(/[.,;:!?'"]+$/, "");
      if (href) { window.open(href, "_blank", "noopener,noreferrer"); return true; }
    }
  }
  return false;
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  {
    decorations: (v) => v.decorations,
    // Cmd/Ctrl-click a rendered URL (bare or from a [text](url) link) to open it.
    eventHandlers: {
      mousedown(e) {
        const el = (e.target as HTMLElement)?.closest?.(".cm-url");
        if (el && (e.metaKey || e.ctrlKey)) {
          const href = el.getAttribute("data-url");
          if (href) { e.preventDefault(); window.open(href, "_blank", "noopener,noreferrer"); }
        }
      },
    },
  },
);
