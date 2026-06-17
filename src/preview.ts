// The editor's live preview, in a single pass. It renders Markdown inline —
// styling marks and hiding their syntax, rendering code blocks, quotes, links and
// images — plus the two things that aren't in the Markdown grammar: [[wikilinks]]
// and bare URLs. GFM tables are rendered as block widgets by a companion
// StateField (`tableField`), since they span multiple lines (which a ViewPlugin's
// decorations may not). Syntax is revealed for editing on whatever line the cursor
// is on. The document is never mutated; these are all view-only decorations.

import { syntaxTree } from "@codemirror/language";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { StateField } from "@codemirror/state";
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
// URL_RE greedily swallows trailing sentence punctuation; drop it before using.
const trimUrl = (match: string) => match.replace(/[.,;:!?'"]+$/, "");
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

/** First and last line NUMBERS a block node spans. node.to is exclusive, so step
 *  back one (clamped) to land on the node's last line — the one subtle bit, once. */
function blockLines(state: EditorState, node: { from: number; to: number }): [number, number] {
  return [state.doc.lineAt(node.from).number, state.doc.lineAt(Math.max(node.from, node.to - 1)).number];
}

/** Does the selection touch any line in [first, last]? (i.e. reveal the raw source.) */
function anyActive(active: Set<number>, first: number, last: number): boolean {
  for (let l = first; l <= last; l++) if (active.has(l)) return true;
  return false;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const revealed = (pos: number) => active.has(state.doc.lineAt(pos).number);
  const decos: Range<Decoration>[] = [];
  // Tables are rendered by `tableField` (a StateField — a plugin can't replace
  // across line breaks). Record their spans so this pass never decorates inside
  // one, which would overlap the table's block widget.
  const tableRanges: [number, number][] = [];
  const inTable = (pos: number) => tableRanges.some(([f, t]) => pos >= f && pos < t);

  for (const { from, to } of view.visibleRanges) {
    // 1. Markdown constructs from the syntax tree.
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const name = node.name;

        // Tables: owned by tableField. Record the span and don't descend, so no
        // inline decoration lands inside the block widget's replaced range.
        if (name === "Table") { tableRanges.push([node.from, node.to]); return false; }

        // Fenced code: monospace box on every line. Off the cursor, hide the ```
        // fences (language shown as a corner label); inside, leave them editable.
        // Children skipped so the inline-marker logic ignores the ``` (CodeMark).
        if (name === "FencedCode") {
          const [first, last] = blockLines(state, node);
          const inside = anyActive(active, first, last);
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
          const [first, last] = blockLines(state, node);
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
      if (revealed(start) || inTable(start)) continue;
      const widget = link.embed && isImage(link.target)
        ? new ImageWidget(link.target, link.label)
        : new WikiLinkWidget(link.target, link.label, link.embed);
      decos.push(Decoration.replace({ widget }).range(start, from + link.end));
    }
    for (const m of text.matchAll(URL_RE)) {
      const pos = from + m.index;
      if (inTable(pos)) continue;
      const href = trimUrl(m[0]);
      if (href) decos.push(urlMark(href).range(pos, pos + href.length));
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
      const href = trimUrl(m[0]);
      if (href) { window.open(href, "_blank", "noopener,noreferrer"); return true; }
    }
  }
  return false;
}

// ── Tables (GFM) ────────────────────────────────────────────────────────────
// Rendered as a real HTML grid when the cursor is outside; the raw Markdown
// returns the moment the cursor enters any of its lines. Because this replaces a
// multi-line range with one block widget — which a ViewPlugin may not do — it
// lives in a StateField (see `tableField`).

class TableWidget extends WidgetType {
  constructor(readonly head: string[], readonly align: string[], readonly rows: string[][]) { super(); }
  eq(o: TableWidget) { return JSON.stringify(this) === JSON.stringify(o); }
  toDOM() {
    const table = document.createElement("table");
    table.className = "cm-pv-table";
    const cell = (tag: "th" | "td", text: string, i: number) => {
      const c = document.createElement(tag);
      c.textContent = text;
      if (this.align[i]) c.style.textAlign = this.align[i];
      return c;
    };
    const headRow = table.createTHead().insertRow();
    this.head.forEach((t, i) => headRow.append(cell("th", t, i)));
    const body = table.createTBody();
    for (const row of this.rows) {
      const tr = body.insertRow();
      row.forEach((t, i) => tr.append(cell("td", t, i)));
    }
    return table;
  }
  ignoreEvent() { return false; } // let clicks through so the cursor can land to edit
}

// Split a `| a | b |` row into trimmed cell strings (tolerating missing edge pipes).
const tableCells = (line: string) =>
  line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

function buildTables(state: EditorState): DecorationSet {
  const active = activeLines(state);
  const decos: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      const [first, last] = blockLines(state, node);
      if (anyActive(active, first, last)) return false; // editing -> raw
      const fromPos = state.doc.line(first).from, toPos = state.doc.line(last).to;

      const lines = state.doc.sliceString(fromPos, toPos).split("\n");
      if (lines.length < 2) return false; // header + delimiter at minimum
      const align = tableCells(lines[1]).map((c) => {
        const l = c.startsWith(":"), r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : "";
      });
      const widget = new TableWidget(tableCells(lines[0]), align, lines.slice(2).filter((l) => l.trim()).map(tableCells));
      decos.push(Decoration.replace({ widget, block: true }).range(fromPos, toPos));
      return false;
    },
  });
  return Decoration.set(decos, true);
}

// Block-level table decorations. A StateField (not the ViewPlugin) because it
// replaces across line breaks; recomputed on edits and when the selection moves
// (so a table reveals its source as the cursor enters it).
export const tableField = StateField.define<DecorationSet>({
  create: buildTables,
  update(value, tr) {
    return tr.docChanged || !tr.startState.selection.eq(tr.state.selection) ? buildTables(tr.state) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

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
