// Image rendering helpers, shared by the markdown-image and wikilink-embed paths.
import { WidgetType } from "@codemirror/view";

export const isImage = (name: string) => /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i.test(name);

// Absolute/remote/data URLs are used as-is; everything else is a vault-relative
// path served by the server's /api/file route.
const fileSrc = (path: string) =>
  /^(https?:|data:)/i.test(path) ? path : "/api/file/" + path.split("/").map(encodeURIComponent).join("/");

export class ImageWidget extends WidgetType {
  constructor(readonly path: string, readonly alt: string) { super(); }
  eq(o: ImageWidget) { return o.path === this.path && o.alt === this.alt; }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-img";
    img.src = fileSrc(this.path);
    img.alt = this.alt;
    return img;
  }
  ignoreEvent() { return false; } // let clicks through so the cursor can land to edit
}
