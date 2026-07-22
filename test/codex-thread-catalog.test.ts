import assert from "node:assert/strict";
import test from "node:test";
import { LocalCodexThreadCatalog } from "../src/control/codex-thread-catalog.js";

const fakeCodex = new URL("./fixtures/fake-codex.mjs", import.meta.url).pathname;

test("thread catalog resolves metadata for the exact Codex thread id", async (t) => {
  const catalog = new LocalCodexThreadCatalog();
  t.after(() => catalog.close());

  assert.deepEqual(await catalog.read("thread-exact", fakeCodex), {
    id: "thread-exact",
    name: "Fake Router Session",
    preview: "Inspect and fix the Router timing",
    cwd: "/tmp/fake-project",
    source: "vscode",
    createdAt: 100,
    updatedAt: 200,
    recencyAt: 300,
  });
});
