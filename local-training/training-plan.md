# Local classifier training plan

## Objective

Replace the latency-heavy generative classification path with a frozen local
embedding model plus small CPU classifiers, while preserving deterministic
rules and the existing 2B model as fail-open fallbacks.

## Model shape

- Frozen feature extractor: `qwen3-embedding:0.6b`, pinned by
  `model-lock.json`.
- Classifier A: five-way intent.
- Classifier B: nine-way semantic category.
- Classifier C: four-way complexity.
- Route remains a deterministic projection of reviewed category, complexity,
  and the active Router configuration. It is not a learned target.

No Qwen weight fine-tuning is planned. The first experiment uses CPU-friendly
linear classifiers and class weights.

## Data ownership and split policy

- Historical session JSONL remains read-only.
- Human/teacher-reviewed real records remain the source of truth.
- `synthetic-v1` enters train and validation only.
- The 228-record real test split is frozen and receives no synthetic records.
- Prompt text and embedding vectors do not enter Router audit JSONL.
- All derived data and future classifier artifacts live below ignored
  `local-training/work/`.

## Training-start gate

Training may start only when the generated pretraining manifest reports:

- all six synthetic batches present and schema-valid;
- every generated row independently reviewed;
- zero exact duplicate prompts;
- zero accepted semantic collisions with the real test set;
- frozen test hash recorded;
- embedding model digest verified;
- project checks and local-training tests passing.

## First training experiment

The next phase, intentionally not executed during data preparation:

1. embed train/validation/test text locally through loopback Ollama;
2. fit three independent class-weighted linear classifiers on CPU;
3. tune abstention thresholds on validation only;
4. report macro-F1, per-class precision/recall, confusion matrices, downstream
   route accuracy, cold/warm latency, and memory footprint;
5. compare against rules-only and the current 2B classifier;
6. do not switch Router runtime until the real-test and latency gates pass.

Rare labels (`control`, `extreme`, and `unknown`) must be judged by per-class
recall and confusion behavior, not aggregate accuracy.
