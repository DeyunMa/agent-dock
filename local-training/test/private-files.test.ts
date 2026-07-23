import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  assertSafeOutputPath,
  assertSeparatedTrees,
  writePrivateAtomically,
} from "../src/private-files.js";

test("private output rejects a pre-existing symlink component", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "codex-router-private-"));
  try {
    const realDirectory = resolve(root, "real");
    await mkdir(realDirectory);
    await symlink(realDirectory, resolve(root, "link"));
    await assert.rejects(
      assertSafeOutputPath(resolve(root, "link/output.jsonl"), root),
      /contains symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private atomic writes use owner-only file and directory modes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "codex-router-private-"));
  try {
    const path = resolve(root, "nested/output.jsonl");
    await assert.rejects(
      writePrivateAtomically(path, "{}\n"),
      /output path must remain inside/,
    );
    const localPath = resolve(
      process.cwd(),
      "local-training/work/private-files-test/output.jsonl",
    );
    await writePrivateAtomically(localPath, "{}\n");
    assert.equal(await readFile(localPath, "utf8"), "{}\n");
    assert.equal((await stat(localPath)).mode & 0o777, 0o600);
    assert.equal((await stat(resolve(localPath, ".."))).mode & 0o777, 0o700);
    await rm(resolve(process.cwd(), "local-training/work/private-files-test"), {
      recursive: true,
      force: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source and output trees must remain disjoint for direct callers", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "codex-router-private-"));
  try {
    const source = resolve(root, "source");
    await mkdir(source);
    await assert.rejects(
      assertSeparatedTrees(source, resolve(source, "derived"), root),
      /must not overlap/,
    );
    await assert.rejects(
      assertSeparatedTrees(source, root, root),
      /must not overlap/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
