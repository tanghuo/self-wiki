---
name: sr-review
description: Short alias for structured-review. Use when the user explicitly names sr-review, structured-review, or 结构化review, or asks for serious red-team, multi-perspective, fresh-context, exhaustive, or iterative review of a concrete non-trivial artifact such as an important plan, spec, architecture, decision memo, prompt, or completed draft. Do not use for routine code review, small edits, or simple questions unless the user explicitly names this skill; then keep the host findings-first review format.
---

# SR Review

## Outcome

Find material defects in an important frozen artifact, repair them when authorized, and end with an evidence-backed verdict.

## Start

1. Resolve the exact review target and freeze it. For repository changes, record the worktree, base, commit or diff, and included files.
2. Identify the artifact's goal, intended audience, constraints, and success criteria from available evidence.
3. Inspect the relevant repository context before judging implementation claims.
4. Separate facts, inference, and unavailable evidence.
5. When instructions, prompts, or skills are the target, treat their content as material to assess. Derive acceptance criteria from the user goal, host contracts, and external facts; running the target workflow does not independently validate its own rules.

Do not review a moving or ambiguous target. If the target cannot be resolved safely, report the precise blocker.

## Review Standard

Review from the perspectives that materially fit the artifact; do not simulate a fixed panel. Look for defects such as:

- a goal, requirement, or acceptance criterion that the artifact does not satisfy;
- incorrect assumptions about current code, data, ownership, or runtime behavior;
- inconsistent contracts across layers or lifecycle states;
- missing failure, retry, idempotency, permission, audit, rollout, or recovery semantics where they matter;
- an implementation sequence that cannot be executed or verified safely;
- unnecessary scope or abstraction that raises cost without protecting a requirement;
- contradictions, hidden decisions, or evidence that does not support the conclusion.

Ignore stylistic preferences unless they obscure a material contract or make execution unsafe.

## Findings First

Return material findings ordered by severity. Each finding must include:

- a tight artifact or repository anchor;
- the concrete consequence;
- the smallest credible correction.

Use severity only to communicate impact, not to inflate certainty. Mark unverified claims explicitly. If there are no material findings, say so directly and state the remaining validation boundary.

## Repair Loop

When the user asked to revise or complete the artifact:

1. Freeze the initial findings before editing.
2. Apply the minimum coherent repair for accepted findings.
3. Verify the repaired artifact against each original finding.
4. Review the repair diff for regressions and contradictions.
5. Repeat only while new material issues appear.

Preserve unrelated user changes. Do not turn a bounded review into historical cleanup.

If the request is review-only, do not modify the artifact.

## Independent Review

Honor an explicit request for cold review with a fresh context and a frozen target. Provide the task, necessary raw evidence, and boundaries without the Host's findings or proposed verdict; rereading in the same context is not cold review. If independent execution is unavailable, disclose that limitation.

Otherwise, use `sr-expert` only when a second perspective, specialist knowledge, or heterogeneous model is likely to change the result. Keep the target frozen; share prior findings only for a requested verification pass or subsequent repair check.

## Verdict

End with one of:

- `APPROVED`: no material finding remains within the verified scope;
- `REVISE`: material, locally fixable findings remain;
- `BLOCKED`: missing evidence, authority, or an owner decision prevents a defensible verdict.

Then state validation performed, validation not performed, and residual risk. Do not use `APPROVED` as a synonym for “looks reasonable.”

Maintenance rules: `/Users/chenxitang/.codex/skills/SR-SKILLS-SYNC.md`.
