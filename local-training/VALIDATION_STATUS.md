# Local classifier validation status

Branch: `feat/embedding-classifier`

Status: validation baseline integrated into Router 1.3; frozen test remains closed.

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
- Router runtime integration changed: yes, after the validation comparison below.

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

## Earlier confidence-gate experiment

Before comparing complete decision architectures, the candidate was evaluated
as a confidence-gated supplement:

| Minimum category and complexity confidence | Coverage | Route accuracy |
|---:|---:|---:|
| 0.50 | 0.4205 | 0.8649 |
| 0.60 | 0.2121 | 0.8839 |
| 0.65 | 0.1439 | 0.8947 |
| 0.70 | 0.0852 | 0.9333 |

These figures are validation-only evidence, not frozen-test results or
production thresholds. The later full comparison showed that confidence
fallback to semantic rules reduces route accuracy, so Router 1.3 does not use
these thresholds.

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

## Router 1.3 runtime smoke

After integration, 15 evenly distributed validation records were classified
through the installed `EmbeddingClassifier` and full `RouterEngine` without
printing prompt text:

- TypeScript classifier versus exported Python predictions: 15/15 exact across
  intent, category, and complexity; P50 136 ms, P95 875 ms.
- Warm full RouterEngine projection: 15/15 intent matches and 15/15 route
  matches; P50 196 ms, P95 680 ms.
- A deliberately cold 50 ms startup window returned `warming / native` for all
  requests, confirming bounded fail-open rather than blocking Codex.

## Router combination without 2B

The 528-record validation set was replayed through the legacy deterministic
projection and the candidate projection without calling the 2B model.

| Decision design | Route accuracy |
|---|---:|
| Legacy semantic-rule projection | 0.4489 |
| Legacy rules-first merge with embedding | 0.5511 |
| Embedding primary | 0.7689 |
| Embedding primary plus current hard-rule guards | 0.7670 |

Intent follows the same pattern:

| Intent design | Accuracy |
|---|---:|
| Rules only | 0.4830 |
| Rules first, embedding fallback | 0.7992 |
| Embedding primary | 0.8201 |

Embedding outperformed rules in every route-confidence segment, including the
lowest-confidence segment below 0.3 (0.6176 versus 0.3529). Returning
low-confidence records to semantic rules therefore reduced validation
accuracy.

Router 1.3 implements this result: embedding is the primary semantic decision
module, the 2B classifier and runtime semantic rules are removed, and
deterministic code remains only for controls, explicit suppression, manual
model overrides, protocol safety, sticky continuity, and fail-open behavior.

The private reproducible report is written to
`local-training/work/v1/reports/hybrid-validation.json`.

## Gate before frozen test

1. Review hard errors around `AGENT_WORKFLOW` versus `RESEARCH_EXPLAIN`,
   `AUDIT_ANALYZE` versus `DIAGNOSE_FIX`, and `normal` versus `complex`.
2. Diagnose the Ollama embedding P95 latency and benchmark the actual
   embedding-primary request path.
3. ~~Implement the embedding-primary Router behind fail-open controls without
   retaining the legacy semantic merge or the 2B classifier.~~ Completed in 1.3.
4. ~~Verify the CLI and Desktop protocol adapters before making it the
   default.~~ Completed with real classifier math plus end-to-end fake Codex
   protocol backends; live Codex model discovery passes `doctor`.
5. Refit only if the review produces contract-level label fixes or targeted
   hard negatives.
6. Open the 228-record real-only frozen test once, after the validation gate is
   stable.

Private model files, embeddings, predictions, and prompt text remain under
ignored `local-training/work/v1/`.
