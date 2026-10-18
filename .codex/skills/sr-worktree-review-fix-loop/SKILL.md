---
name: sr-worktree-review-fix-loop
description: Use when the user says `循环结构化review` and asks to repeatedly review and fix the current worktree, main workspace, dirty diff, latest local changes, or unstaged/staged code changes until no material issues remain. This wraps sr-review for code/worktree changes instead of replacing it.
---

# SR Worktree Review Fix Loop

## Outcome

Review the intended current changes, fix authorized material defects, validate, and repeat until no new material issue remains.

## Freeze the Target

1. Read repository instructions and inspect status, diff, staged diff, recent commits, and relevant untracked files.
2. Resolve what “current changes” means from the user's request and repository evidence.
3. Record the base, included files, exclusions, and unrelated user changes that must be preserved.

Do not silently include historical or concurrent work. If the target remains materially ambiguous after inspection, ask for direction.

## Loop

1. Apply the `sr-review` standard to the frozen target and relevant repository context.
2. Freeze material findings before editing.
3. Repair the smallest coherent set of accepted findings.
4. Run focused validation, then broader checks in proportion to risk.
5. Re-review every original finding and the repair diff for regressions.
6. Repeat only if new material findings appear.

The user's request for a fix loop authorizes local repairs within the frozen target. It does not authorize unrelated refactors, commits, pushes, destructive cleanup, or external state changes.

Use `sr-expert` when the user explicitly requests an external or heterogeneous review, or when independent specialist evidence is likely to change a high-risk conclusion. Keep its target aligned with the frozen Host target and verify accepted findings locally.

## Stop Conditions

Stop with:

- `APPROVED`: no material finding remains within the verified target;
- `BLOCKED`: a required fix needs owner input, unavailable evidence, new authority, or an unsafe expansion of scope;
- `REVISE`: only when the user requested review without authorizing available local fixes.

Do not loop on cosmetic preferences or manufacture new scope to avoid closing.

## Handoff

Lead with remaining findings, if any. Then state repairs made, validation performed and not performed, target/base, residual risk, and worktree state. Preserve unrelated changes and report any environment-caused validation limit precisely.

Maintenance rules: `/Users/chenxitang/.codex/skills/SR-SKILLS-SYNC.md`.
