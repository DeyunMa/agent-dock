> 历史工具读取归档 `resources/router-v2.toml`（可用 `AGENT_DOCK_TRAINING_CONFIG` 指定其他 v2 文件），不读取现役 v3 配置。

> 已退役的 v1.3 离线训练档案。v1.4 运行时使用 Jev API，不再安装或调用这些分类头。下文为历史实验流程，不能用于覆盖当前运行配置。旧分类头保存在 `resources/classifier-v1/`（相对此目录）。

# Local training workspace

This directory contains every repository-owned input, script, artifact, and
report used to prepare the local Router classifier.

## Data ownership

- `~/.codex/sessions/**/*.jsonl` is a read-only source of truth.
- The preparation script never writes to, moves, or deletes a session file.
- Raw unredacted prompts are never copied into this repository.
- Sanitized local data is written under `tools/training/work/` and is ignored
  by Git.
- Embedding weights remain in Ollama's managed model store. Training runs and
  candidate heads remain under ignored `tools/training/work/`. The explicitly
  released heads are promoted to `resources/router/classifier-v1/` and copied with
  owner-only permissions to `~/.agent-dock/classifier-v1/` during install.
  `model-lock.json` records the exact embedding model expected by this workspace.
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

The default output is `tools/training/work/v1/`:

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
The weighted rules used to create and compare that historical seed live under
`tools/training/src/legacy-rules.ts` and
`tools/training/resources/legacy-router-rules.json`; Router 1.3 runtime does
not import them.

Optional overrides:

```bash
pnpm training:prepare -- \
  --source /path/to/read-only/sessions \
  --output /absolute/path/inside/tools/training/work
```

The output path must remain inside this `tools/training/` directory.

## Install and verify the embedding model

```bash
ollama pull qwen3-embedding:0.6b
pnpm training:verify-model
```

The verifier checks the installed model digest and 1024-dimensional output,
then measures one cold request and ten warm requests from sanitized local
samples. Its report is written to:

```text
tools/training/work/v1/reports/model-smoke.json
```

For privacy, verification refuses non-loopback Ollama hosts.

## Prepare teacher-review batches

```bash
pnpm training:prepare-review
```

This creates twelve deterministic review inputs under
`tools/training/work/v1/teacher-review/input/`. Reviewers follow
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
`tools/training/work/` directory.

High-impact first-pass decisions receive a second independent review:

```bash
pnpm training:prepare-adjudication
pnpm training:apply-adjudication
```

The adjudication set includes every low-confidence/unknown record, every
continuation, every original `ask` promoted to `do`, and every `control` or
`extreme` label. Final outputs are written under
`tools/training/work/v1/teacher-review/adjudication/final/`.

## Prepare synthetic hard-boundary data

The frozen real data has no accepted `control` examples and only two `extreme`
examples. `synthetic-v1` adds reviewed hard-boundary examples without copying
historical prompts or contaminating the real test set.

```bash
pnpm training:prepare-synthetic
```

The generation and review contract is
[`synthetic-v1.md`](./synthetic-v1.md). Generated and reviewed JSONL remains
under ignored `tools/training/work/v1/synthetic-v1/`.

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
`tools/training/work/v1/synthetic-v1/provenance.json`; finalization hashes that
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
python3 -m venv tools/training/work/venv
tools/training/work/venv/bin/python -m pip install -r tools/training/requirements.txt
pnpm training:test-python
```

Run the baseline:

```bash
pnpm training:train-baseline
pnpm training:evaluate-hybrid
```

Embedding vectors, model JSON, validation predictions, and the teacher report
are written with owner-only permissions under:

```text
tools/training/work/v1/embedding-cache/
tools/training/work/v1/training-runs/baseline-v3/
```

The exported models contain only coefficients, intercepts, class names, and
model/data hashes. They do not use pickle or joblib. Do not run the frozen test
until the validation teacher loop is complete.

The validated `baseline-v3` heads currently published with Router 1.3 live in
`resources/router/classifier-v1/`. They contain coefficients, intercepts, class names,
model metadata, and training hashes, but no prompt text, session identifiers,
embedding vectors, or local paths.

Install the published heads into the Router runtime with:

```bash
./scripts/local/install.sh
```

By default the installer reads only `resources/router/classifier-v1/`. A local
candidate can be tested without publishing it by setting
`AGENT_DOCK_CLASSIFIER_SOURCE` to an absolute model directory. The installer
never reads or changes source sessions, prepared prompt data, the frozen test,
or historical Router JSONL.

## Validate

```bash
pnpm test:training
pnpm check
```
