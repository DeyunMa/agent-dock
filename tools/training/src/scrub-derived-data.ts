import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSensitiveText } from "./redaction.js";
import { hardenPrivateTree, writePrivateAtomically as writeAtomically } from "./private-files.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const trainingDirectory = resolve(scriptDirectory, "..");
const projectDirectory = resolve(trainingDirectory, "../..");
const workDirectory = resolve(trainingDirectory, "work/v1");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = redactValue(item);
    }
    if (typeof result.text === "string" && typeof result.chars === "number") {
      result.chars = result.text.length;
    }
    return result;
  }
  return value;
}

async function walk(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await walk(path)));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".jsonl") ||
        entry.name.endsWith(".json") ||
        entry.name.endsWith(".md"))
    ) {
      paths.push(path);
    }
  }
  return paths.sort();
}

function scrubJsonl(raw: string, path: string): string {
  const lines = raw.split("\n").filter(Boolean);
  return (
    lines
      .map((line, index) => {
        try {
          return JSON.stringify(redactValue(JSON.parse(line)));
        } catch {
          throw new Error(`Invalid JSON at ${path}:${index + 1}`);
        }
      })
      .join("\n") + "\n"
  );
}

async function updateDatasetManifest(): Promise<void> {
  const manifestPath = resolve(workDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    output_sha256?: Record<string, string>;
  };
  const [all, trainable, review] = await Promise.all([
    readFile(resolve(workDirectory, "all.jsonl"), "utf8"),
    readFile(resolve(workDirectory, "trainable-seed.jsonl"), "utf8"),
    readFile(resolve(workDirectory, "review.jsonl"), "utf8"),
  ]);
  manifest.output_sha256 = {
    all: sha256(all),
    trainable_seed: sha256(trainable),
    review: sha256(review),
  };
  await writeAtomically(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function main(): Promise<void> {
  await hardenPrivateTree(workDirectory);
  const changedFiles: string[] = [];
  for (const path of await walk(workDirectory)) {
    const raw = await readFile(path, "utf8");
    let scrubbed: string;
    if (path.endsWith(".jsonl")) {
      scrubbed = scrubJsonl(raw, path);
    } else if (path.endsWith(".json")) {
      scrubbed = `${JSON.stringify(redactValue(JSON.parse(raw)), null, 2)}\n`;
    } else {
      scrubbed = redactSensitiveText(raw);
    }
    if (scrubbed !== raw) {
      await writeAtomically(path, scrubbed);
      changedFiles.push(relative(projectDirectory, path));
    }
  }
  await updateDatasetManifest();
  process.stdout.write(
    `${JSON.stringify(
      {
        changed_files: changedFiles.length,
        paths: changedFiles,
        historical_sessions_modified: false,
      },
      null,
      2,
    )}\n`,
  );
  await hardenPrivateTree(workDirectory);
}

await main();
