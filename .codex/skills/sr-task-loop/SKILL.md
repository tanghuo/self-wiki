---
name: sr-task-loop
description: "Execute one task markdown file through a disciplined implementation loop: read context, implement the minimum viable change, validate, spec-review, code-review, fix, and update the task. Use for 单任务闭环, task loop, or one task from an sr-plan-split task directory."
---

# SR Task Loop

## Outcome

Move one task file from `pending` to `completed` with the minimum coherent implementation, proportionate validation, and no unresolved material review finding.

## Start

1. Read the task, source design, dependency handoffs, repository instructions, and current worktree.
2. Confirm dependencies are complete and the task owns an observable outcome.
3. Freeze the task scope and record unrelated existing changes that must be preserved.
4. If a material design decision is missing, stop and route it to `sr-design-gate`; do not improvise a contract.

If the repository provides a local task or review command, inspect its help and use it. Do not assume flags or modes from memory.

## Loop

1. Implement the smallest coherent change that satisfies the task.
2. Run the closest relevant validation first, then broader checks in proportion to risk.
3. Review against the task requirements and source design.
4. Review the changed code for correctness, failure paths, boundaries, regressions, and unnecessary complexity.
5. Fix accepted material findings and validate again.
6. Re-review the repair diff and original findings.

Repeat only while new material issues appear. Do not chase cosmetic preferences or expand into unrelated cleanup.

Use `sr-expert` only when explicitly requested by the user or runner, or when independent expertise is likely to change a high-risk result. The Host still verifies and integrates the Expert's output.

## Validation

Validation must prove the task's acceptance criteria as directly as practical. Report separately:

- checks passed;
- checks failed because of the change;
- checks blocked by environment or unrelated baseline failures;
- checks not run and why.

Do not mark the task complete merely because compilation or a narrow unit test passed when its observable outcome remains unverified.

## Complete

Update the task file only after:

- requirements and acceptance criteria are satisfied;
- dependencies and handoffs remain valid;
- no material Host or accepted Expert finding remains;
- relevant validation passed or the user explicitly accepted a documented limitation.

Record status, implementation summary, changed files, validation, and residual risk in the task's existing convention. Preserve unrelated work and do not commit unless the user or runner authorizes it.

End with the outcome, material decisions, changed files, validation boundary, and task status.

Maintenance rules: `/Users/chenxitang/.codex/skills/SR-SKILLS-SYNC.md`.
