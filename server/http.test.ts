// Integration test: boots the REAL server (index.ts) as a subprocess on a
// throwaway vault — including the notes/ watcher — and drives it over HTTP. This
// covers what the unit tests can't: routing, ETag headers, and behaviour that
// only manifests with the watcher running (external edits; folder delete, which
// once 500'd with EBUSY).

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let proc: ReturnType<typeof Bun.spawn>;
let NOTES = "";
let base = "";

const PORT = "8921"; // off the dev server's 8911

const notes = () => fetch(`${base}/api/notes`).then((r) => r.json());
const put = (id: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/note/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown", ...headers },
    body,
  });

async function until(pred: () => Promise<boolean>, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return;
    await Bun.sleep(50);
  }
  throw new Error("condition not met in time");
}

beforeAll(async () => {
  NOTES = await mkdtemp(join(tmpdir(), "mynotes-http-"));
  base = `http://localhost:${PORT}`;
  proc = Bun.spawn(["bun", join(import.meta.dir, "index.ts")], {
    env: { ...process.env, PORT, NOTES_DIR: NOTES },
    stdout: "ignore",
    stderr: "inherit",
  });
  await until(async () => {
    try { return (await fetch(`${base}/api/notes`)).ok; } catch { return false; }
  }, 8000);
});

afterAll(async () => {
  proc.kill();
  await proc.exited;
  await rm(NOTES, { recursive: true, force: true });
});

describe("notes CRUD + headers", () => {
  test("starts with an empty vault", async () => {
    expect(await notes()).toEqual([]);
  });

  test("PUT then GET round-trips with an ETag and markdown content-type", async () => {
    expect((await put("crud/note", "# hi")).status).toBe(200);
    const res = await fetch(`${base}/api/note/crud%2Fnote`);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe("# hi");
  });

  test("GET a missing note is 404", async () => {
    expect((await fetch(`${base}/api/note/missing`)).status).toBe(404);
  });
});

describe("backlinks + rename over HTTP", () => {
  test("rename rewrites links and moves the note", async () => {
    await put("rn/a", "see [[rn/b]]");
    await put("rn/b", "b");
    expect(await fetch(`${base}/api/backlinks/${encodeURIComponent("rn/b")}`).then((r) => r.json()))
      .toEqual([{ id: "rn/a", title: "a" }]);

    const res = await fetch(`${base}/api/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "rn/b", to: "rn/c" }),
    });
    expect(res.status).toBe(200);
    expect((await fetch(`${base}/api/note/${encodeURIComponent("rn/b")}`)).status).toBe(404);
    expect(await fetch(`${base}/api/note/${encodeURIComponent("rn/a")}`).then((r) => r.text())).toBe("see [[rn/c]]");
  });
});

describe("conflict (If-Match)", () => {
  test("a stale write returns 409 with a conflict copy", async () => {
    const v1 = (await put("cf/n", "v1")).headers.get("etag")!;
    await put("cf/n", "v2"); // newer write lands first
    const res = await put("cf/n", "v3", { "if-match": v1 });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.conflict).toBe(true);
    expect(body.conflictId).toMatch(/^cf\/n \(conflict /);
  });
});

describe("delete with the watcher live", () => {
  test("deleting a folder with nested content returns 200 (not EBUSY 500)", async () => {
    await put("del/x", "x");
    await put("del/sub/y", "y");
    const res = await fetch(`${base}/api/note/del`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await notes()).some((n: { id: string }) => n.id.startsWith("del"))).toBe(false);
  });
});

describe("vault file serving", () => {
  test("serves a raw file, 404s missing, 400s traversal", async () => {
    await writeFile(join(NOTES, "pic.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const ok = await fetch(`${base}/api/file/pic.svg`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("svg");
    expect((await fetch(`${base}/api/file/nope.png`)).status).toBe(404);
    expect((await fetch(`${base}/api/file/..%2Fsecret`)).status).toBe(400);
  });
});

describe("the notes/ watcher", () => {
  test("an external file create then delete is reflected in the index", async () => {
    await writeFile(join(NOTES, "external.md"), "# made outside the app");
    await until(async () => (await notes()).some((n: { id: string }) => n.id === "external"));

    await rm(join(NOTES, "external.md"));
    await until(async () => !(await notes()).some((n: { id: string }) => n.id === "external"));
  });
});
