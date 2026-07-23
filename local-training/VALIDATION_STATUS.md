# Local classifier validation status

Branch: `feat/embedding-classifier`

Status: validation baseline complete; frozen test remains closed.

## Baseline v3

- Source train/validation: 2,255 / 523 records.
- Effective train/validation: 2,250 / 528 records.
- Coverage overlay: five independently reviewed synthetic `unknown` records
  moved from train to validation; prepared source files were not rewritten.
- Embedding model: `qwen3-embedding:0.6b`, digest-pinned, 1,024 dimensions.
- Input preprocessing: collapse whitespace, then keep the latest 2,000
  characters.
- Classifiers: class-weighted multinomial logistic regression.
- Regularization: intent `C=3`, category `C=1`, complexity `C=10`.
- Frozen test read: no.
- Router runtime integration changed: no.

Validation metrics:

| Target | Accuracy | Macro F1 | Weighted F1 |
|---|---:|---:|---:|
| intent | 0.8201 | 0.8087 | 0.8235 |
| category | 0.7254 | 0.6753 | 0.7262 |
| complexity | 0.6837 | 0.7335 | 0.6846 |
| projected route | 0.7689 | — | — |

Rare-label recall:

- `control`: 1.0000 on 10 validation records.
- `extreme`: 1.0000 on 9 validation records.
- `unknown`: 0.6000 on 5 reviewed synthetic validation records.

## Outer-teacher verdict

The candidate is not ready to replace Router routing decisions directly.
Category boundaries remain weak for `PLAN_DESIGN` and `AUDIT_ANALYZE`, while
complexity still over-predicts `complex` for many `normal` prompts.

The candidate remains promising as a confidence-gated supplement:

| Minimum category and complexity confidence | Coverage | Route accuracy |
|---:|---:|---:|
| 0.50 | 0.4205 | 0.8649 |
| 0.60 | 0.2121 | 0.8839 |
| 0.65 | 0.1439 | 0.8947 |
| 0.70 | 0.0852 | 0.9333 |

These figures are validation-only model-selection evidence, not frozen-test
results or production thresholds.

## Local latency gate

The exported linear heads are negligible: predicting all 528 validation
records across the three heads took about 4.5 ms in total. End-to-end latency
is dominated by Ollama embedding.

Two warm sequential passes over 15 independent Chinese/English engineering
requests produced:

| Pass | Median | P95 |
|---:|---:|---:|
| 1 | 188 ms | 1,361 ms |
| 2 | 359 ms | 1,207 ms |

This long tail does not yet meet the user-unnoticeable runtime goal. It must be
explained or removed before runtime integration; validation accuracy alone is
not sufficient.

## Gate before frozen test

1. Add a read-only rules-only and hybrid evaluator over the same validation
   records.
2. Compare the confidence-gated candidate against rules-only and the current
   2B classifier.
3. Review hard errors around `AGENT_WORKFLOW` versus `RESEARCH_EXPLAIN`,
   `AUDIT_ANALYZE` versus `DIAGNOSE_FIX`, and `normal` versus `complex`.
4. Diagnose the Ollama embedding P95 latency and benchmark the actual hybrid
   request path.
5. Refit only if the review produces contract-level label fixes or targeted
   hard negatives.
6. Open the 228-record real-only frozen test once, after the validation gate is
   stable.

Private model files, embeddings, predictions, and prompt text remain under
ignored `local-training/work/v1/`.
