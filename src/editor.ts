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
import { uploadFile } from "./api.ts";

export interface Editor {
  view: EditorView;
  setDoc(doc: string): void;
}

// A vault-relative asset path for a pasted/dropped file: assets/<timestamp>-<name>.
// Sanitises the name and guarantees an extension (clipboard images may be nameless).
function assetPath(file: File): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let name = file.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/\.\w+$/.test(name)) name = `${name || "pasted"}.${file.type.split("/")[1] || "png"}`;
  return `assets/${stamp}-${name}`;
}

// Upload each image and insert a Markdown image link at the cursor. Sequential so
// multiple files keep their order; failures are skipped (autosave persists the rest).
async function insertImages(view: EditorView, files: FileList) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    try {
      const path = await uploadFile(assetPath(file), file);
      view.dispatch(view.state.replaceSelection(`![](${path})`));
    } catch { /* skip this file, keep going */ }
  }
}

// True when a paste/drop carries at least one image, so the editor should handle
// it (store + insert a link) instead of pasting raw bytes/text.
const hasImage = (files: FileList | undefined) => !!files && [...files].some((f) => f.type.startsWith("image/"));

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
        // Paste or drop an image -> store it in the vault, insert ![](path).
        EditorView.domEventHandlers({
          paste(e, view) {
            if (!hasImage(e.clipboardData?.files)) return false;
            e.preventDefault();
            void insertImages(view, e.clipboardData!.files);
            return true;
          },
          drop(e, view) {
            if (!hasImage(e.dataTransfer?.files)) return false;
            e.preventDefault();
            void insertImages(view, e.dataTransfer!.files);
            return true;
          },
        }),
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
