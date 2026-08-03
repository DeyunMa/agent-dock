import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SYNTHETIC_BATCH_SPECS,
  SYNTHETIC_SCHEMA_VERSION,
  sha256,
} from "./synthetic-contract.js";
import {
  ensurePrivateDirectory,
  hardenPrivateTree,
  writePrivateAtomically as writeAtomically,
} from "./private-files.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "../../..");
const root = resolve(projectDirectory, "tools/training/work/v1/synthetic-v1");
const generationDirectory = resolve(root, "generation");
const assignmentsDirectory = resolve(generationDirectory, "assignments");
const resultsDirectory = resolve(generationDirectory, "results");
const contractPath = resolve(projectDirectory, "tools/training/synthetic-v1.md");

async function main(): Promise<void> {
  const contract = await readFile(contractPath, "utf8");
  await ensurePrivateDirectory(assignmentsDirectory);
  await ensurePrivateDirectory(resultsDirectory);

  for (const spec of SYNTHETIC_BATCH_SPECS) {
    await writeAtomically(
      resolve(assignmentsDirectory, `${spec.id}.json`),
      `${JSON.stringify(
        {
          schema_version: SYNTHETIC_SCHEMA_VERSION,
          batch: spec,
          output: `tools/training/work/v1/synthetic-v1/generation/results/${spec.id}.jsonl`,
          contract: "tools/training/synthetic-v1.md",
        },
        null,
        2,
      )}\n`,
    );
  }

  const manifest = {
    schema_version: SYNTHETIC_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    contract: "tools/training/synthetic-v1.md",
    contract_sha256: sha256(contract),
    total_target: SYNTHETIC_BATCH_SPECS.reduce((sum, spec) => sum + spec.target, 0),
    batches: SYNTHETIC_BATCH_SPECS,
  };
  await writeAtomically(
    resolve(generationDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await hardenPrivateTree(root);
  process.stdout.write(
    `${JSON.stringify({ root, batches: SYNTHETIC_BATCH_SPECS.length, target: manifest.total_target })}\n`,
  );
}

await main();
