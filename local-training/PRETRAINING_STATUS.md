# Pretraining status

Branch: `feat/embedding-classifier`

This document records the preparation milestone before any local classifier is
fit. Runtime Router behavior is intentionally unchanged during this phase.

## Completed baseline

- Historical `~/.codex/sessions/**/*.jsonl` is read-only.
- 2,365 sanitized real prompts received two review passes.
- 2,292 real records are trainable.
- The 228-record real test split is frozen.
- `qwen3-embedding:0.6b` is installed and digest-pinned.
- Local-training artifacts remain below ignored `local-training/work/`.

## Synthetic v1 target

- 720 hard-boundary records across six disjoint generation batches.
- Coverage focuses on Router controls, `extreme`, `continue/do/unknown`,
  polite `ask/do`, neighboring engineering categories, and underrepresented
  categories.
- Every record receives a separate shuffled review with no generator rationale
  in the review input.

## Training-start checklist

- [x] Versioned generation and review contract
- [x] Deterministic batch manifests
- [x] Strict schema, quota, label-family, dedupe, and redaction validation
- [x] Six generation batches produced
- [x] 720 generation rows pass the main process hard validation
- [x] Independent review complete: 670 agree, 48 corrected, 2 rejected
- [x] Semantic dedupe and frozen-test collision check complete
- [x] Pretraining bundle and immutable hashes emitted
- [x] Full repository verification complete: 64 Router tests + 21 preparation tests

## Prepared bundle

- Accepted synthetic records: 718
- Combined train records: 2,255 (1,645 real + 610 synthetic)
- Combined validation records: 523 (416 real + 107 synthetic)
- Frozen real-only test records: 228
- Full-bundle exact duplicates removed: 4
- Full-bundle exact duplicates remaining: 0
- Accepted frozen-test collisions: 0
- Highest same-label synthetic similarity: 0.911925
- Highest cross-label synthetic similarity: 0.939029
- Highest synthetic-to-real-test similarity: 0.823417
- Classifier training executed: no

No classifier fitting or Router runtime integration belongs to this milestone.
The final counts and hashes are generated in
`local-training/work/v1/pretraining-v1/manifest.json`.
