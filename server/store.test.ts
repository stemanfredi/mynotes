import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the store at a throwaway vault BEFORE importing it (NOTES_DIR is read at
// module load). The watcher is never started here — we drive the store directly.
const NOTES = await mkdtemp(join(tmpdir(), "mynotes-test-"));
process.env.NOTES_DIR = NOTES;
const store = await import("./store.ts");

const ids = () => store.listNotes().map((n) => n.id);
const exists = (rel: string) => stat(join(NOTES, rel)).then(() => true, () => false);

beforeEach(async () => {
  for (const e of await readdir(NOTES)) await rm(join(NOTES, e), { recursive: true, force: true });
  await store.buildIndex();
});
afterAll(() => rm(NOTES, { recursive: true, force: true }));

describe("write / read", () => {
  test("writes a file and reads it back with a matching etag", async () => {
    const res = await store.writeNote("Hello", "# hi");
    expect(res.ok).toBe(true);
    const note = await store.readNote("Hello");
    expect(note?.content).toBe("# hi");
    expect(note?.etag).toBe(res.etag);
    expect(await exists("Hello.md")).toBe(true);
  });

  test("readNote returns null for a missing note", async () => {
    expect(await store.readNote("nope")).toBeNull();
  });

  test("rejects ids containing '..'", async () => {
    expect(store.writeNote("../escape", "x")).rejects.toThrow();
  });
});

describe("listNotes", () => {
  test("lists ids/titles sorted by title", async () => {
    await store.writeNote("Beta", "");
    await store.writeNote("Alpha", "");
    await store.writeNote("nested/Gamma", "");
    expect(store.listNotes()).toEqual([
      { id: "Alpha", title: "Alpha" },
      { id: "Beta", title: "Beta" },
      { id: "nested/Gamma", title: "Gamma" }, // title is the filename, not the path
    ]);
  });
});

describe("backlink index", () => {
  test("indexes [[links]] into backlinks", async () => {
    await store.writeNote("A", "see [[B]]");
    await store.writeNote("B", "i am b");
    expect(store.backlinks("B").map((n) => n.id)).toEqual(["A"]);
    expect(store.backlinks("A")).toEqual([]);
  });

  test("recomputes when a note's links change", async () => {
    await store.writeNote("A", "see [[B]]");
    expect(store.backlinks("B").map((n) => n.id)).toEqual(["A"]);
    await store.writeNote("A", "no links anymore");
    expect(store.backlinks("B")).toEqual([]);
  });
});

describe("renameNote", () => {
  test("moves the file and rewrites links to it", async () => {
    await store.writeNote("A", "see [[B]]");
    await store.writeNote("B", "b");
    const res = await store.renameNote("B", "C");
    expect(res.ok).toBe(true);
    expect(await exists("B.md")).toBe(false);
    expect(await exists("C.md")).toBe(true);
    expect((await store.readNote("A"))?.content).toBe("see [[C]]");
    expect(store.backlinks("C").map((n) => n.id)).toEqual(["A"]);
  });

  test("preserves alias and heading when rewriting", async () => {
    await store.writeNote("A", "[[B|label]] and [[B#head]]");
    await store.writeNote("B", "b");
    await store.renameNote("B", "C");
    expect((await store.readNote("A"))?.content).toBe("[[C|label]] and [[C#head]]");
  });

  test("rejects renaming onto an existing note", async () => {
    await store.writeNote("A", "");
    await store.writeNote("B", "");
    expect(await store.renameNote("A", "B")).toEqual({ ok: false, reason: "exists" });
  });

  test("rejects a no-op rename", async () => {
    await store.writeNote("A", "");
    expect((await store.renameNote("A", "A")).ok).toBe(false);
  });
});

describe("renameFolder", () => {
  test("re-prefixes children, rewrites links, and prunes the old dir", async () => {
    await store.writeNote("proj/a", "see [[proj/b]]");
    await store.writeNote("proj/b", "b");
    await store.writeNote("Out", "ref [[proj/a]]");

    const res = await store.renameFolder("proj", "project");
    expect(res.ok).toBe(true);
    expect(ids()).toContain("project/a");
    expect(ids()).not.toContain("proj/a");
    expect(await exists("proj")).toBe(false); // old dir gone
    expect((await store.readNote("project/a"))?.content).toBe("see [[project/b]]");
    expect((await store.readNote("Out"))?.content).toBe("ref [[project/a]]");
  });

  test("returns 'missing' when no notes are under the folder", async () => {
    expect(await store.renameFolder("ghost", "x")).toEqual({ ok: false, reason: "missing" });
  });
});

describe("deleteItem", () => {
  test("deletes a note and prunes its emptied parent dir", async () => {
    await store.writeNote("folder/only", "x");
    expect(await store.deleteItem("folder/only")).toBe(true);
    expect(await exists("folder/only.md")).toBe(false);
    expect(await exists("folder")).toBe(false);
    expect(ids()).not.toContain("folder/only");
  });

  test("deletes a folder with nested content", async () => {
    await store.writeNote("trash/a", "a");
    await store.writeNote("trash/sub/b", "b");
    expect(await store.deleteItem("trash")).toBe(true);
    expect(await exists("trash")).toBe(false);
    expect(ids().filter((id) => id.startsWith("trash"))).toEqual([]);
  });

  test("returns false for a missing id", async () => {
    expect(await store.deleteItem("ghost")).toBe(false);
  });
});

describe("conflicts (last-write-wins)", () => {
  test("parks a stale write as a conflict copy and keeps the current note", async () => {
    const v1 = await store.writeNote("Note", "v1");
    await store.writeNote("Note", "v2"); // another device gets there first
    const res = await store.writeNote("Note", "v3", v1.etag); // stale base
    expect(res.ok).toBe(false);
    expect(res.conflictId).toMatch(/^Note \(conflict /);
    expect((await store.readNote("Note"))?.content).toBe("v2");
    expect((await store.readNote(res.conflictId!))?.content).toBe("v3");
  });

  test("accepts a write with the current etag", async () => {
    const v1 = await store.writeNote("Note", "v1");
    const res = await store.writeNote("Note", "v2", v1.etag);
    expect(res.ok).toBe(true);
    expect((await store.readNote("Note"))?.content).toBe("v2");
  });
});

describe("buildIndex", () => {
  test("returns the count and indexes existing files from disk", async () => {
    await store.writeNote("one", "[[two]]");
    await store.writeNote("two", "");
    const count = await store.buildIndex(); // rescan from disk
    expect(count).toBe(2);
    expect(store.backlinks("two").map((n) => n.id)).toEqual(["one"]);
  });
});
