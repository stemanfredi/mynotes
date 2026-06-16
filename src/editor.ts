// Minimal CodeMirror 6 markdown editor: state + view + lang-markdown + history,
// plus our live preview. Deliberately small — no "basic-setup" kitchen sink, just
// the extensions this app actually needs.

import { EditorView, keymap, drawSelection, highlightActiveLine } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Strikethrough } from "@lezer/markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { livePreview, followLinkAtCursor } from "./preview.ts";
import { codeLanguages } from "./code-languages.ts";

export interface Editor {
  view: EditorView;
  setDoc(doc: string): void;
}

export function createEditor(parent: HTMLElement, onChange: (doc: string) => void): Editor {
  // Suppress onChange while we load a note programmatically, so switching notes
  // never looks like a user edit (which would auto-save — and could blank a note).
  let loading = false;

  const make = (doc: string) =>
    EditorState.create({
      doc,
      extensions: [
        history(),
        keymap.of([
          { key: "Mod-Enter", run: followLinkAtCursor }, // follow a link at the cursor
          ...defaultKeymap, ...historyKeymap, indentWithTab,
        ]),
        drawSelection(),
        highlightActiveLine(),
        markdown({ codeLanguages, extensions: [Strikethrough] }),
        syntaxHighlighting(defaultHighlightStyle),
        livePreview,
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => { if (u.docChanged && !loading) onChange(u.state.doc.toString()); }),
      ],
    });

  const view = new EditorView({ state: make(""), parent });

  return {
    view,
    setDoc(doc: string) {
      loading = true;
      view.setState(make(doc));
      queueMicrotask(() => { loading = false; });
    },
  };
}
