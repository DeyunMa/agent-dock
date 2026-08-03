# Synthetic v1 contract

`synthetic-v1` fills label boundaries that the read-only historical data cannot
cover reliably. It augments training and validation only. It never enters the
real test set and never changes Router runtime behavior.

## Non-negotiable boundaries

- Do not read or paraphrase `~/.codex/sessions/` or any real prompt dataset when
  generating examples.
- Never include real names, email addresses, paths, repository secrets, API
  keys, tokens, passwords, or copied production identifiers.
- Write generated data only to
  `tools/training/work/v1/synthetic-v1/generation/results/`.
- Every prompt must be independently understandable except records intentionally
  labeled `continue` or `unknown`.
- Use natural Chinese and Chinese/English mixed developer language. Avoid
  template-like enumeration and trivial word substitution.
- Hard-negative pairs are encouraged: similar wording with a meaningful label
  difference. Exact or cosmetic paraphrase duplicates are forbidden.
- Routes are not authored. They are derived from reviewed semantic labels and
  the current Router configuration.

## Output schema

Each generation result is JSONL with exactly these fields:

```json
{"schema_version":1,"id":"syn-v1-batch-01-001","batch_id":"batch-01","family":"router_control_positive","text":"恢复自动路由","language":"zh","difficulty":"hard","labels":{"intent":"control","category":"AGENT_WORKFLOW","complexity":"simple"},"rationale":"直接控制 Router 运行模式"}
```

The `id` sequence is local to a batch and must run from `001` to `120`.
`rationale` is at most 120 characters.

## Batch quotas

### batch-01 — Router control versus configuration

- `router_control_positive`: 90. Directly operate the current Router mode:
  restore automatic routing, step up one tier, force maximum, pause, or resume.
  Label `control` + `AGENT_WORKFLOW`.
- `router_config_change_negative`: 30. Edit models, profiles, effort, speed,
  source code, or Router configuration. Label `do` + `AGENT_WORKFLOW`.
- Include terse, polite, mixed-language, and negated forms. Do not invent
  unsupported control semantics.

### batch-02 — extreme versus complex

- `genuine_extreme`: 50. Exceptionally broad or high-stakes coordination across
  many systems, repositories, data stores, deployments, or security domains.
  Label complexity `extreme`.
- `complex_not_extreme`: 70. Substantial multi-step or cross-module work that is
  still bounded. Label complexity `complex`.
- Prompt length alone must never decide the label.

### batch-03 — continue, do, and unknown

- `continuation_context`: 45. Standalone approval or continuation whose concrete
  target depends on previous conversation. Label `continue` + `PASS_CONTEXT`.
- `explicit_action_short`: 55. Short but independently actionable mutation.
  Label `do`; choose the actual semantic category.
- `underspecified_fragment`: 20. A fragment whose speech act cannot be decided
  from visible text. Label `unknown` + `PASS_CONTEXT`.

### batch-04 — polite ask versus authorized action

- `polite_question`: 60. Requests advice, design, comparison, or review without
  authorizing mutation. Label `ask`.
- `polite_authorized_action`: 60. Questions or polite wording that still
  explicitly authorize execution now. Label `do`.
- Make paired boundaries realistic, but do not create cosmetic duplicates.

### batch-05 — neighboring engineering categories

- `agent_workflow`: 40. The main subject is Codex/agent/tool/skill/hook/MCP or
  Router behavior. Label `AGENT_WORKFLOW`.
- `implement_change`: 40. Edit a product codebase/configuration/UI where agent
  infrastructure is not the main subject. Label `IMPLEMENT_CHANGE`.
- `operate_verify`: 40. Run tests, install, start, deploy, inspect environment,
  or perform Git/external operations. Label `OPERATE_VERIFY`.

### batch-06 — underrepresented categories

- `diagnose_fix`: 30, category `DIAGNOSE_FIX`.
- `create_artifact`: 25, category `CREATE_ARTIFACT`.
- `plan_design`: 25, category `PLAN_DESIGN`.
- `audit_analyze`: 20, category `AUDIT_ANALYZE`.
- `research_explain`: 20, category `RESEARCH_EXPLAIN`.
- Mix `ask` and `do` only where the intent is semantically valid.

## Independent review

Reviewers receive shuffled records and must not inspect generator rationale as
ground truth. Each review result contains no prompt text:

```json
{"schema_version":1,"id":"syn-v1-batch-01-001","verdict":"agree","labels":{"intent":"control","category":"AGENT_WORKFLOW","complexity":"simple"},"confidence":0.98,"reason":"direct Router runtime control"}
```

- `agree`: all three labels are correct.
- `correct`: provide all three corrected labels.
- `reject`: unnatural, duplicated, unsafe, ambiguous, or unsuitable for
  supervised training.
- Use `reject` when confidence would be below `0.80`.

## Training gate

Before any classifier fitting:

1. validate exact quotas and schemas;
2. independently review every synthetic record;
3. remove rejected/low-confidence records;
4. remove exact and same-label semantic duplicates;
5. reject semantic overlap with the frozen real test set;
6. derive route metadata from current Router configuration;
7. write a manifest with source/model/config hashes;
8. keep `test-real-only.jsonl` byte-identical to the frozen real test source.

Exact deduplication is run again across the complete real + synthetic bundle.
The frozen test split always wins a collision; the conflicting train or
validation row is excluded from the bundle. A duplicate inside the frozen test
set fails closed rather than silently changing the test set.

The phase ends after the pretraining bundle and gate report are generated.
Running a fitting command is a separate, explicit step.
