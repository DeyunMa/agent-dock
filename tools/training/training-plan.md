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
  `tools/training/work/`.

## Training-start gate

Training may start only when the generated pretraining manifest reports:

- all six synthetic batches present and schema-valid;
- every generated row independently reviewed;
- zero exact duplicate prompts;
- zero accepted semantic collisions with the real test set;
- frozen test hash recorded;
- embedding model digest verified;
- project checks and local-training tests passing.

## Validation experiment

Completed without reading the frozen test:

1. embedded train/validation text locally through loopback Ollama;
2. fit three independent class-weighted linear classifiers on CPU;
3. tuned per-target regularization and inspected confidence thresholds on
   validation only;
4. reported macro-F1, per-class precision/recall, confusion matrices,
   downstream route accuracy, and local resource use.

Completed after the baseline:

1. compared rules-only, the legacy rules-first merge, confidence fallback, and
   embedding-primary projection without calling the 2B classifier;
2. confirmed that every confidence fallback to semantic rules reduced route
   accuracy;
3. integrated embedding-primary routing in 1.3 with fail-open hard controls;
4. verified TypeScript predictions against 15 exported validation predictions
   and exercised both protocol adapters without opening the frozen test.

Still required before a frozen-test run:

1. finish the teacher review of ambiguous category and complexity boundaries;
2. stabilize the validation contract and targeted hard negatives;
3. open the frozen test once for the final generalization measurement.

The outer teacher reviews validation mistakes after the baseline fit, before
the frozen test is opened. Only after labels, hard negatives, and abstention
thresholds are stable may one final real-test evaluation run.

Rare labels (`control`, `extreme`, and `unknown`) must be judged by per-class
recall and confusion behavior, not aggregate accuracy.
