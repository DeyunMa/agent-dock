# Local training workspace

This directory contains every repository-owned input, script, artifact, and
report used to prepare the local Router classifier.

## Data ownership

- `~/.codex/sessions/**/*.jsonl` is a read-only source of truth.
- The preparation script never writes to, moves, or deletes a session file.
- Raw unredacted prompts are never copied into this repository.
- Sanitized local data is written under `local-training/work/` and is ignored
  by Git.
- Model weights remain in Ollama's managed model store. `model-lock.json`
  records the exact model expected by this workspace.
- Model verification only sends sanitized samples to a loopback Ollama endpoint.
  It stores neither prompt text nor embedding vectors in its report.

If the redaction contract expands after a local data review, scrub every
existing derived artifact without touching historical sessions:

```bash
pnpm training:scrub-derived
```

## Prepare a dataset

```bash
pnpm training:prepare
```

The default output is `local-training/work/v1/`:

```text
all.jsonl
trainable-seed.jsonl
review.jsonl
splits/train.jsonl
splits/validation.jsonl
splits/test.jsonl
manifest.json
reports/review.md
```

`trainable-seed.jsonl` is only a deterministic seed set. It is not treated as
final supervised truth until the review and teacher-label stages are complete.

Optional overrides:

```bash
pnpm training:prepare -- \
  --source /path/to/read-only/sessions \
  --output /absolute/path/inside/local-training/work
```

The output path must remain inside this `local-training/` directory.

## Install and verify the embedding model

```bash
ollama pull qwen3-embedding:0.6b
pnpm training:verify-model
```

The verifier checks the installed model digest and 1024-dimensional output,
then measures one cold request and ten warm requests from sanitized local
samples. Its report is written to:

```text
local-training/work/v1/reports/model-smoke.json
```

For privacy, verification refuses non-loopback Ollama hosts.

## Prepare teacher-review batches

```bash
pnpm training:prepare-review
```

This creates twelve deterministic review inputs under
`local-training/work/v1/teacher-review/input/`. Reviewers follow
`review-rubric.md`, write only labels and short reasons, and never copy prompt
text into their result files. Routes are derived later from the reviewed
semantic labels and the current Router configuration.

After all twelve result files are present:

```bash
pnpm training:merge-review
```

The merge fails closed on missing rows, duplicate IDs, changed batch inputs,
invalid labels, extra result fields, or attempts to persist prompt text in a
review result. Merged datasets and reports remain under the ignored
`local-training/work/` directory.

High-impact first-pass decisions receive a second independent review:

```bash
pnpm training:prepare-adjudication
pnpm training:apply-adjudication
```

The adjudication set includes every low-confidence/unknown record, every
continuation, every original `ask` promoted to `do`, and every `control` or
`extreme` label. Final outputs are written under
`local-training/work/v1/teacher-review/adjudication/final/`.

## Prepare synthetic hard-boundary data

The frozen real data has no accepted `control` examples and only two `extreme`
examples. `synthetic-v1` adds reviewed hard-boundary examples without copying
historical prompts or contaminating the real test set.

```bash
pnpm training:prepare-synthetic
```

The generation and review contract is
[`synthetic-v1.md`](./synthetic-v1.md). Generated and reviewed JSONL remains
under ignored `local-training/work/v1/synthetic-v1/`.

After all six generation result files are present:

```bash
pnpm training:prepare-synthetic-review
```

Four independent reviewers write label-only verdicts. The final preparation
step validates those verdicts, performs exact and semantic deduplication, checks
the frozen real test set for leakage, and emits a pretraining bundle:

```bash
pnpm training:finalize-pretraining
```

This command prepares data only. It does not fit or activate a classifier.
The training-start gates and next experiment are documented in
[`training-plan.md`](./training-plan.md).

Generation and semantic review are intentionally human/agent-supervised rather
than hidden API calls inside a package script. The exact local execution
provenance is stored in ignored
`local-training/work/v1/synthetic-v1/provenance.json`; finalization hashes that
file alongside every batch input and result. A new run must create six
generation results, four independent review results, and its own provenance
record before `training:finalize-pretraining` can succeed.

## Train the validation baseline

The first training run fits three CPU logistic-regression classifiers. It reads
only train and validation; the frozen test file is intentionally unopened.
Embedding input collapses whitespace and keeps the latest 2,000 characters,
matching the Router's tail-focused low-latency classification contract.
If a reviewed label is absent from validation, the training view moves the
minimum required reviewed synthetic records from train to validation without
rewriting the prepared source bundle.

Create the ignored local Python environment:

```bash
python3 -m venv local-training/work/venv
local-training/work/venv/bin/python -m pip install -r local-training/requirements.txt
pnpm training:test-python
```

Run the baseline:

```bash
pnpm training:train-baseline
```

Embedding vectors, model JSON, validation predictions, and the teacher report
are written with owner-only permissions under:

```text
local-training/work/v1/embedding-cache/
local-training/work/v1/training-runs/baseline-v3/
```

The exported models contain only coefficients, intercepts, class names, and
model/data hashes. They do not use pickle or joblib. Do not run the frozen test
until the validation teacher loop is complete.

## Validate

```bash
pnpm test:training
pnpm check
```
