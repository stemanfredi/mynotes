// Minimal CodeMirror 6 markdown editor: state + view + lang-markdown + history,
// plus our wiki-link live preview. Deliberately small — no "basic-setup" kitchen
// sink, just the extensions this app actually needs.

import { EditorView, keymap, drawSelection, highlightActiveLine } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { wikiLinkLivePreview } from "./wikilink.ts";
import { markdownLivePreview } from "./livepreview.ts";
import { codeLanguages } from "./code-languages.ts";

export interface Editor {
  view: EditorView;
  setDoc(doc: string): void;
}

export function createEditor(parent: HTMLElement, onChange: (doc: string) => void): Editor {
  const make = (doc: string) =>
    EditorState.create({
      doc,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        drawSelection(),
        highlightActiveLine(),
        markdown({ codeLanguages }),
        syntaxHighlighting(defaultHighlightStyle),
        markdownLivePreview,
        wikiLinkLivePreview,
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => { if (u.docChanged) onChange(u.state.doc.toString()); }),
      ],
    });

  const view = new EditorView({ state: make(""), parent });

  return {
    view,
    setDoc(doc: string) { view.setState(make(doc)); },
  };
}
