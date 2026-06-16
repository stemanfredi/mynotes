import { test, expect, describe } from "bun:test";
import { parseWikiLinks, extractLinkTargets } from "./links.ts";

describe("parseWikiLinks", () => {
  test("parses a plain link", () => {
    const links = parseWikiLinks("see [[Foo]] here");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ target: "Foo", label: "Foo", embed: false });
  });

  test("parses alias, heading, and embed", () => {
    expect(parseWikiLinks("[[A|B]]")[0]).toMatchObject({ target: "A", label: "B" });
    expect(parseWikiLinks("[[A#H]]")[0]).toMatchObject({ target: "A", heading: "H", label: "A#H" });
    expect(parseWikiLinks("![[Img]]")[0]).toMatchObject({ target: "Img", embed: true });
  });

  test("handles a path target with alias", () => {
    expect(parseWikiLinks("[[dir/note|shown]]")[0]).toMatchObject({ target: "dir/note", label: "shown" });
  });

  test("reports byte offsets", () => {
    const [l] = parseWikiLinks("x [[Foo]]");
    expect("x [[Foo]]".slice(l.start, l.end)).toBe("[[Foo]]");
  });

  test("ignores unterminated / empty brackets", () => {
    expect(parseWikiLinks("[[ no close")).toHaveLength(0);
    expect(parseWikiLinks("text without links")).toHaveLength(0);
  });
});

describe("extractLinkTargets", () => {
  test("returns distinct targets only", () => {
    expect(extractLinkTargets("[[A]] [[A]] [[B|x]] ![[A]]")).toEqual(["A", "B"]);
  });
});
