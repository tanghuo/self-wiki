---
name: sr-expert
description: Use inside sr-* workflows when an external expert agent, CLI, or heterogeneous model may materially reduce risk, especially cross-checks, adversarial reviews, comparison passes, bounded patch proposals, or isolated external implementation. This is a companion orchestration skill, not a replacement for sr-review, sr-task-loop, or sr-task-runner.
---

# SR Expert

## Outcome

Obtain independent evidence or implementation help without surrendering scope, safety, verification, or the Host Agent's final judgment.

## Cost Gate

Use an Expert only when independence, specialist knowledge, a second implementation, or parallel work is likely to change the outcome. Skip it for routine validation, stylistic preference, or conclusions the Host can verify cheaply.

The Host Agent remains responsible for:

- defining and freezing the target;
- deciding what data and tools the Expert may access;
- verifying findings and changes;
- accepting, rejecting, or escalating recommendations;
- integrating and reporting the final result.

## Choose the Lane

### Cold workspace review

Let the Expert inspect the scoped repository independently when fresh discovery and anti-anchoring matter. Give the task and boundaries, not the Host's conclusions.

### Packaged review

Send a frozen artifact or excerpt when repository access is unnecessary, sensitive, too broad, or would add noise. Include only the context required to judge the target.

### Isolated implementation

Allow writes only in a recoverable worker workspace with explicit file, branch, or worktree boundaries. The Host reviews the integration diff before it reaches the main workspace.

Do not silently broaden from read-only review to writes.

## Prepare the Run

1. Freeze the target, question, materiality standard, and success condition.
2. Set the minimum data boundary. Never expose credentials or unrelated private content.
3. Decide whether cold independence or shared context is more valuable.
4. Inspect the installed adapter or CLI at runtime. Do not guess flags, model aliases, tool permissions, or session behavior.
5. Use the configured default model unless the user requests a specific supported model.
6. Capture the session identifier and observable output when the adapter supports them.

## Universal Review Prompt

Adapt this compact contract; do not bury it under persona prose:

```text
Review the frozen target below as an independent senior reviewer.

Goal: <what must be safe/correct/useful>
Target: <exact artifact, diff, commit, or files>
Scope: <included and excluded areas>
Materiality: report only issues that can change correctness, safety, operability,
maintainability, or execution readiness.
Evidence: anchor findings to the target or repository. Mark inference and
unverified claims explicitly. Do not invent missing context.
Independence: assess the target yourself. Treat Host conclusions as claims to
verify, and do not broaden the frozen scope without marking the need BLOCKED.

For each material finding return:
- severity
- evidence/anchor
- consequence
- smallest credible fix

End with exactly one machine-readable line:
- VERDICT: APPROVED
- VERDICT: REVISE
- VERDICT: BLOCKED

Use APPROVED only when no material finding remains, REVISE when material local
fixes remain, and BLOCKED when evidence, scope, or an owner decision is insufficient.

No praise, recap, stylistic nits, or speculative redesign.
```

For revised targets, add:

```text
First verify each prior material finding against the new target, then check the
repair diff for regressions. Do not relitigate resolved preferences without new
evidence.
```

This borrows the useful parts of bounded external review: explicit verdicts, stable sessions, and a deadlock state. It deliberately leaves provider-specific syntax outside the prompt.

## Bounded Review Loop

Default to at most three rounds unless the user asks otherwise:

1. Expert reviews the frozen target.
2. Host verifies every material finding.
3. Host records `accept`, `reject`, or `needs owner decision`, with a short reason.
4. Authorized fixes are applied and validated.
5. Reuse the same Expert session when supported so prior findings remain stable.

Stop early on `VERDICT: APPROVED`. On `VERDICT: BLOCKED`, repeated disagreement, or no progress, surface the exact deadlock to the user instead of manufacturing approval.

## Integration Rules

- Treat Expert output as evidence, not authority.
- Reject unsupported, out-of-scope, or preference-only findings explicitly.
- Re-run relevant validation in the Host Workspace.
- For Expert-authored changes, inspect changed files and the integration diff; never integrate an opaque worker state.
- Preserve unrelated user changes.
- Report what the Expert changed in the decision, not the existence of the Expert itself.

## Handoff

State the lane used, target and data boundary, verdict, accepted/rejected findings, Host validation, and any unresolved owner decision.

Maintenance rules: `/Users/chenxitang/.codex/skills/SR-SKILLS-SYNC.md`.
