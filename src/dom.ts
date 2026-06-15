// Two tiny DOM helpers so the rest of the UI code reads declaratively.

export const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

// el("li", { className: "note", onclick }, "text") — assign any element property
// via props, append string/Node children. Keeps render code free of createElement
// boilerplate.
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}
