---
name: sr-task-runner
description: Run a directory or batch of task markdown files through sr-task-loop with dependency-aware scheduling, safe parallelism, checkpoint reviews, validation, and final integration review. Use for 批量执行小任务, run tasks, task runner, or looping over tasks created by sr-plan-split.
---

# SR Task Runner

## Outcome

Execute a task set in dependency order, using `sr-task-loop` as the unit of work, while keeping integration states valid and reviewable.

## Start

1. Read the task overview, every task header, source design, repository instructions, and current worktree.
2. Build the dependency DAG and reject missing dependencies, cycles, duplicate ownership, or tasks whose scope is not execution-ready.
3. Identify shared files, contracts, migrations, checkpoints, and final validation.
4. Preserve unrelated existing changes and choose an integration baseline.

Do not repair major design gaps inside the runner. Route them to `sr-design-gate` or `sr-plan-split`.

## Scheduling

At each wave, select pending tasks whose dependencies are complete.

- Run serially when tasks touch the same contract, files, schema transition, generated output, or mutable external state.
- Parallelize only independent tasks, and only in isolated recoverable workspaces when concurrent writers are involved.
- Keep final integration and authoritative validation in the Host Workspace.
- A completed task must leave consumers a valid handoff; do not integrate half of an atomic contract change.

When agent or worker tools are unavailable, run the same DAG serially. Correctness does not depend on parallelism.

## Execution Wave

For each selected task:

1. Invoke the `sr-task-loop` contract with the frozen task and current dependency handoffs.
2. Inspect its changed files, task status, validation, and residual findings.
3. Integrate only reviewed, scoped changes.
4. Run shared validation needed to prove the wave works together.
5. Update the task overview and recompute the ready set.

At explicit checkpoints or after high-risk contract waves, run an integration review before scheduling consumers.

Use `sr-expert` only when explicitly requested or when an independent specialist review is likely to change a high-risk integration decision. Keep Expert work bounded and verify it in the Host Workspace.

## Failure Handling

- `task blocked`: leave it incomplete, record the blocker, and do not schedule dependents.
- `validation regression`: stop the affected wave, identify whether it is task-caused or baseline, repair authorized defects, and revalidate.
- `integration conflict`: resolve only when the intended combined behavior is clear; otherwise stop for design or owner input.
- `worker drift`: reject or isolate out-of-scope changes rather than absorbing them.

Independent branches may continue when a blocked task cannot affect them and the task contract permits it.

## Finish

Before declaring the batch complete:

- all required tasks are complete and the DAG has no stranded node;
- source requirements reconcile to completed tasks;
- cross-task contracts, migrations, rollout, and recovery paths are coherent;
- final repository validation and integration review have no unresolved material finding;
- task files and overview reflect actual results.

End with completed and blocked tasks, integration decisions, validation performed and skipped, residual risk, and repository state. Do not commit or publish unless authorized.

Maintenance rules: `/Users/chenxitang/.codex/skills/SR-SKILLS-SYNC.md`.
