---
name: sr-help
description: Use when the user asks what the sr-* skills are, which sr skill to use, how sr workflows relate, runner vs loop differences, recommended sr workflow maps, or examples of when not to use a skill. This is a routing and explanation skill, not an execution workflow.
---

# SR Help

## Outcome

Route the request to the smallest `sr-*` workflow that owns it. Do not execute another skill's work from this router.

## Map

| Intent | Skill |
|---|---|
| Clarify an important ambiguous or risky change before coding | `sr-design-gate` |
| Seriously challenge or revise a concrete non-trivial artifact | `sr-review` |
| Turn an approved large design into executable task files | `sr-plan-split` |
| Execute one task file through implementation and review | `sr-task-loop` |
| Schedule and integrate a directory or batch of task files | `sr-task-runner` |
| Repeatedly review and fix the current worktree | `sr-worktree-review-fix-loop` |
| Add an independent external model or specialist lane | `sr-expert` with one of the workflows above |

## Routing Rules

- Use the user's explicit skill name when supplied.
- Prefer one owning skill. Compose only when the output of one is the input of another.
- Do not run a design gate for a clear local reversible fix.
- Do not use `sr-review` for routine code review unless explicitly requested.
- Use `sr-task-loop` for one task; use `sr-task-runner` only when scheduling or integration across multiple tasks matters.
- `sr-expert` is a companion, not a standalone replacement for Host review.
- Plan readiness is checked inside `sr-plan-split`; there is no separate readiness skill.

## Common Flows

```text
ambiguous risky change -> sr-design-gate -> optional sr-review -> implementation
approved large design -> sr-plan-split -> sr-task-runner -> sr-task-loop units
one prepared task -> sr-task-loop
dirty worktree loop -> sr-worktree-review-fix-loop
important independent check -> owning workflow + sr-expert
```

Answer routing questions with a recommendation and one short reason. Mention alternatives only when the boundary is genuinely ambiguous.

Maintenance rules: `/Users/chenxitang/.codex/skills/SR-SKILLS-SYNC.md`.
