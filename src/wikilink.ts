// The signature feature: Obsidian-style live preview of [[wikilinks]], built on
// CodeMirror 6's view-only *replacing* decorations. The raw markdown is never
// touched — it stays byte-for-byte the document. We just paint over it, and the
// paint lifts the moment your cursor enters a link so you can edit the source.

import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { parseWikiLinks } from "../shared/links.ts";

/** Fired when the user clicks a rendered link. main.ts listens and navigates. */
export const WIKILINK_NAV = "mynotes:wikilink-nav";

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

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = view.state.selection.main;
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const link of parseWikiLinks(text)) {
      const start = from + link.start;
      const end = from + link.end;
      // Reveal the raw [[...]] whenever the selection touches it, so editing works.
      if (sel.from <= end && sel.to >= start) continue;
      builder.add(start, end, Decoration.replace({
        widget: new WikiLinkWidget(link.target, link.label, link.embed),
      }));
    }
  }
  return builder.finish();
}

export const wikiLinkLivePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
