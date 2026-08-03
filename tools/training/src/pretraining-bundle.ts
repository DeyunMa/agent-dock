import { normalizeForDedupe } from "./synthetic-contract.js";

export type BundleSplit = "train" | "validation" | "test";
export type BundleProvenance = "real_teacher_reviewed" | "synthetic_v1";

export interface BundleRecord {
  id: string;
  text: string;
  split: BundleSplit;
  provenance: BundleProvenance;
}

export interface BundleDuplicate {
  kept_id: string;
  kept_split: BundleSplit;
  kept_provenance: BundleProvenance;
  dropped_id: string;
  dropped_split: BundleSplit;
  dropped_provenance: BundleProvenance;
}

function priority(record: BundleRecord): number {
  const splitPriority = record.split === "test" ? 300 : record.split === "validation" ? 200 : 100;
  const provenancePriority = record.provenance === "real_teacher_reviewed" ? 10 : 0;
  return splitPriority + provenancePriority;
}

export function dedupeTrainingBundle<T extends BundleRecord>(
  records: readonly T[],
): { kept: T[]; dropped: BundleDuplicate[] } {
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`duplicate bundle id: ${record.id}`);
    ids.add(record.id);
  }

  const ranked = records
    .map((record, index) => ({ record, index }))
    .sort(
      (left, right) =>
        priority(right.record) - priority(left.record) ||
        left.index - right.index ||
        left.record.id.localeCompare(right.record.id),
    );
  const winnerByPrompt = new Map<string, T>();
  const dropped: BundleDuplicate[] = [];
  const droppedIds = new Set<string>();

  for (const { record } of ranked) {
    const key = normalizeForDedupe(record.text);
    const winner = winnerByPrompt.get(key);
    if (!winner) {
      winnerByPrompt.set(key, record);
      continue;
    }
    if (winner.split === "test" && record.split === "test") {
      throw new Error(`frozen real test contains duplicate prompts: ${winner.id}, ${record.id}`);
    }
    droppedIds.add(record.id);
    dropped.push({
      kept_id: winner.id,
      kept_split: winner.split,
      kept_provenance: winner.provenance,
      dropped_id: record.id,
      dropped_split: record.split,
      dropped_provenance: record.provenance,
    });
  }

  return {
    kept: records.filter((record) => !droppedIds.has(record.id)),
    dropped: dropped.sort((left, right) => left.dropped_id.localeCompare(right.dropped_id)),
  };
}
