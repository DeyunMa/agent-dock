import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_TRAINING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

export async function assertSafeOutputPath(
  outputPath: string,
  allowedRoot: string,
): Promise<void> {
  const resolvedRoot = resolve(allowedRoot);
  const resolvedOutput = resolve(outputPath);
  if (!isInside(resolvedRoot, resolvedOutput)) {
    throw new Error(`output path must remain inside ${resolvedRoot}`);
  }
  const realRoot = await realpath(resolvedRoot);
  const segments = relative(resolvedRoot, resolvedOutput).split(sep).filter(Boolean);
  let current = resolvedRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`output path contains symlink: ${current}`);
      const actual = await realpath(current);
      if (!isInside(realRoot, actual)) throw new Error(`output path escapes allowed root: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function assertSeparatedTrees(
  sourceRoot: string,
  outputRoot: string,
  allowedOutputRoot: string,
): Promise<void> {
  await assertSafeOutputPath(outputRoot, allowedOutputRoot);
  const sourceReal = await realpath(resolve(sourceRoot));
  const allowedReal = await realpath(resolve(allowedOutputRoot));
  const projectedOutputReal = resolve(
    allowedReal,
    relative(resolve(allowedOutputRoot), resolve(outputRoot)),
  );
  if (
    isInside(sourceReal, projectedOutputReal) ||
    isInside(projectedOutputReal, sourceReal)
  ) {
    throw new Error("source and output directory trees must not overlap");
  }
}

export async function writePrivateAtomically(
  path: string,
  content: string,
): Promise<void> {
  await assertSafeOutputPath(path, LOCAL_TRAINING_ROOT);
  await ensurePrivateDirectory(dirname(path));
  await assertSafeOutputPath(path, LOCAL_TRAINING_ROOT);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function hardenPrivateTree(root: string): Promise<void> {
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`private work root must not be a symlink: ${root}`);
  if (!info.isDirectory()) throw new Error(`private work root must be a directory: ${root}`);
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`private work tree contains symlink: ${path}`);
    if (entry.isDirectory()) {
      await hardenPrivateTree(path);
    } else if (entry.isFile()) {
      await chmod(path, 0o600);
    }
  }
}
