# Teacher review rubric

Review every sanitized prompt independently. Do not infer missing conversation
history. Output labels describe the user's latest visible request, not what an
assistant eventually did.

The historical Codex session files and the input batch files are immutable.
Reviewers only write their assigned result file under
`tools/training/work/v1/teacher-review/results/`.

## Output contract

Write one compact JSON object per input row, preserving input order:

```json
{"schema_version":1,"id":"input id","teacher_labels":{"intent":"ask","category":"AUDIT_ANALYZE","complexity":"normal"},"confidence":0.94,"reason":"read-only repository inspection"}
```

Rules:

- Exactly one output row for every input row.
- Copy `id` exactly; never copy prompt text into the result.
- `confidence` is a number from 0 to 1.
- `reason` is a short decision reason, at most 120 characters.
- Inspect every prompt semantically. Do not mechanically accept its old labels.
- Do not assign a route. The main process derives routes from reviewed labels
  and the current Router configuration.

## Intent

- `ask`: explanation, research, comparison, review, analysis, planning, or any
  read-only request. Questions such as "should/can/how do we change this" remain
  `ask` until the user authorizes the actual change.
- `do`: the user authorizes an action now: edit, create, install, run, deploy,
  commit, push, configure, operate, or otherwise mutate state. A request may
  contain questions and still be `do` when execution is explicitly authorized.
- `continue`: a standalone continuation/approval such as "继续", "开始吧", or
  "按刚才方案执行", whose concrete task depends on prior conversation.
- `control`: an explicit command to control this Router itself, such as switch
  to automatic routing, step up a tier, force max, pause, or resume routing.
  Editing a route profile, model mapping, effort, speed, or Router code/config
  is `do`, not `control`.
- `unknown`: a fragment whose speech act cannot be determined from the visible
  prompt alone. Use sparingly; uncertainty about category is not `unknown`.

## Category

- `RESEARCH_EXPLAIN`: factual/conceptual explanation, comparison, research, or
  recommendation not centered on inspecting a supplied system.
- `AUDIT_ANALYZE`: read-only inspection, review, evaluation, or verification of
  an existing repository, artifact, design, data set, or current state.
- `DIAGNOSE_FIX`: an existing malfunction, regression, failed command, broken
  UI, or incident where root cause and/or repair is the core task.
- `PLAN_DESIGN`: architecture, schema, workflow, requirements, rollout plan, or
  design trade-off before implementation.
- `IMPLEMENT_CHANGE`: editing an existing codebase, configuration, database
  schema, documentation inside a repository, or product UI/feature.
- `OPERATE_VERIFY`: installation, commands, tests, startup, deployment, Git
  operations, account/environment operations, or external-system actions.
- `CREATE_ARTIFACT`: the primary deliverable is a standalone document, diagram,
  image, presentation, report, website/content artifact, or other created asset.
  Repository feature/UI implementation remains `IMPLEMENT_CHANGE`.
- `AGENT_WORKFLOW`: Codex/agent/tool/skill/hook/MCP/router/automation behavior,
  architecture, configuration, implementation, or evaluation. This category
  wins when agent infrastructure is the main subject.
- `PASS_CONTEXT`: greeting, acknowledgement, pure continuation, quoted/context
  fragment, or a request that cannot be categorized without prior turns.

## Complexity

Judge expected reasoning and execution breadth, not prompt length:

- `simple`: one clear fact, one small action, or a tightly bounded check.
- `normal`: a typical bounded engineering question/task involving several
  considerations or files.
- `complex`: cross-component/repository work, substantial architecture,
  ambiguous diagnosis, external integration, or multi-stage verification.
- `extreme`: exceptionally broad/high-stakes work spanning many systems or
  requiring unusually deep research and coordination. This should be rare.

## Confidence

- `0.95-1.00`: explicit and unambiguous.
- `0.80-0.94`: clear dominant interpretation with minor ambiguity.
- `0.60-0.79`: plausible but context-sensitive.
- Below `0.60`: only when the visible prompt genuinely cannot support a stable
  label; usually pair with `unknown` or `PASS_CONTEXT`.
