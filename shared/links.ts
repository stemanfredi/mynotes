// Shared between client (rendering [[links]]) and server (building the backlink
// index). One definition of what a wiki-link is, so the two never disagree.

export interface WikiLink {
  /** Note id the link points at, e.g. "Ideas" or "projects/mynotes" (no #heading, no |alias). */
  target: string;
  /** Display text after `|`, falls back to the raw target (heading anchor and all). */
  label: string;
  /** `![[...]]` transclusion/embed vs plain `[[...]]` link. */
  embed: boolean;
  /** Byte offsets of the whole match within the source string. */
  start: number;
  end: number;
}

// `!?` -> optional embed marker. `[^\]\n]+?` -> inner text, no closing brackets or newlines.
const WIKILINK_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;

/** Parse every [[wikilink]] / ![[embed]] in a markdown string. */
export function parseWikiLinks(md: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const m of md.matchAll(WIKILINK_RE)) {
    const start = m.index!;
    const inner = m[2];
    const pipe = inner.indexOf("|");
    const label = pipe === -1 ? inner.trim() : inner.slice(pipe + 1).trim();
    const ref = pipe === -1 ? inner : inner.slice(0, pipe);
    // A #heading anchor is stripped from the target so the link still resolves to
    // the note. We don't navigate to headings, so the anchor isn't kept separately.
    const hash = ref.indexOf("#");
    const target = (hash === -1 ? ref : ref.slice(0, hash)).trim();
    out.push({ target, label, embed: m[1] === "!", start, end: start + m[0].length });
  }
  return out;
}

/** Just the distinct target ids — what the backlink index is built from. */
export function extractLinkTargets(md: string): string[] {
  return [...new Set(parseWikiLinks(md).map((l) => l.target).filter(Boolean))];
}
