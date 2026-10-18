---
name: sr-plan-split
description: Split a serious implementation plan, PRD, RFC, or large design doc into execution-ready task markdown files using sr-review standards. Use when the user asks to 拆任务, 拆小任务, split a plan, turn a方案md into tasks, or prepare a big plan for sr-task-runner/sr-task-loop execution.
---

# SR Plan Split

## Outcome

Convert one approved non-trivial design into the smallest dependency-aware set of task files that another session can execute without rediscovering material decisions.

## Readiness Gate

Before splitting, inspect the source artifact and relevant repository context. Continue only if:

- the goal, scope, authoritative behavior, and acceptance criteria are clear;
- cross-layer contracts and important lifecycle decisions agree;
- rollout, migration, recovery, permission, audit, retry, or idempotency semantics are defined where applicable;
- no unresolved decision would materially change task boundaries or implementation.

Repair small omissions inline when authorized. Use `sr-design-gate` for unresolved design choices and `sr-review` for a serious but reviewable draft. Return `BLOCKED` when an owner decision is required.

## Split Rules

- Split by independently verifiable outcome, not by arbitrary file count or layer.
- Keep tightly coupled schema, contract, and compatibility changes together when separating them would create an invalid intermediate state.
- Make dependencies explicit and acyclic.
- Avoid task fragments that only add a helper, test, or cleanup with no standalone outcome.
- Assign shared foundations before consumers; isolate migrations, external contracts, and rollout steps when they need separate control.
- Preserve the source artifact's requirements exactly. Do not invent scope to make the plan look complete.

## Output

Use the repository's task convention. If none exists, create:

```text
tasks/
  README.md
  001-<slug>.md
  002-<slug>.md
```

`README.md` contains the source artifact, task table, dependency order, shared constraints, checkpoints, and completion definition.

Each task file contains only:

```markdown
# <task title>

Status: pending
Depends on: <task ids or none>

## Outcome
<observable result>

## Scope
- In: <owned behavior/files/contracts>
- Out: <important exclusions>

## Repository context
- <anchors and current behavior>

## Requirements
- <must hold after completion>

## Acceptance and validation
- <observable criteria>
- `<commands or checks>`

## Handoff
- <compatibility, rollout, recovery, or next-task facts>
```

Omit empty sections. Include exact file paths only when repository evidence supports them.

## Reconciliation

Before finishing, map every material source requirement to at least one task or shared constraint, then check the reverse: every task must trace to an approved requirement. Resolve gaps, duplication, invalid intermediate states, and dependency cycles.

End with the output directory, task count, dependency shape, readiness verdict, and any validation assumptions. Do not start implementation unless the user also authorized it.

Maintenance rules: `/Users/chenxitang/.codex/skills/SR-SKILLS-SYNC.md`.
