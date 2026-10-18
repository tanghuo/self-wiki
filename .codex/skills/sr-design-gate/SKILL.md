---
name: sr-design-gate
description: Turn rough intent or a risky repository change into a repo-grounded, implementation-ready decision record. Use when explicitly invoked; when the user asks to assess, brainstorm, clarify, or design before coding; or before implementation when material ambiguity, high blast radius, low reversibility, or financial, permission, lifecycle, schema, migration, API/proto/frontend-backend contract, external-service, retry, idempotency, audit, or recovery semantics could cause wrong implementation or costly rework. Unless explicitly invoked, skip clear local reversible fixes and refactors, ordinary code review, small documentation edits, and execution of an already approved design.
---

# SR Design Gate

## Outcome

Resolve only the decisions that could materially change implementation, safety, rollout, or recovery. Produce the smallest repo-grounded record that makes the next action safe.

## Route

Choose one route after inspecting the current repository:

- `Skip`: the change is local, reversible, and already clear. Proceed with normal implementation.
- `Inline`: a few findings or assumptions are enough; state them and continue.
- `Artifact`: important decisions need a durable design record before implementation.
- `Blocked`: a user-owned decision, missing authority, or unavailable evidence prevents a safe choice.

Risk, ambiguity, and reversibility determine the route—not file count.

## Ground First

Before asking design questions:

1. Read the relevant entry points, data model, callers, tests, configuration, and recent local changes.
2. Separate verified repository facts from inference and unknowns.
3. Identify existing authority: which layer owns validation, state transitions, persistence, permissions, retries, and recovery.
4. Narrow the unresolved decisions to those that would actually change the implementation.

Do not ask the user for facts the repository can answer cheaply.

## Grill Mode

Use Grill Mode when the user explicitly requests it, or when an important problem still contains implementation-shaping decisions that only the user or owner can make.

Borrow the durable mechanics of the original `grill-me` workflow:

- Ask exactly one load-bearing question per turn.
- Put the recommended answer first, then the decisive tradeoff.
- Order questions by dependency: later questions should benefit from earlier answers.
- Keep decisions user-owned; do not disguise a guess as consensus.
- Continue until remaining uncertainty no longer changes implementation, rollout, or recovery—not until every imaginable branch has been discussed.

After each answer, update the decision state and ask the next question only if it remains material. If inspection resolves the question, do not ask it. When Grill Mode ends, summarize agreed decisions and unresolved blockers before writing the artifact or continuing authorized implementation.

## Decision Record

For `Artifact`, use the repository's existing convention. If none exists, create a concise Markdown record containing only:

1. `Problem and goal`
2. `Current truth` with repository anchors
3. `Decisions` including rejected alternatives where the tradeoff matters
4. `Boundaries and contracts` across data, API, permissions, lifecycle, and external systems
5. `Failure, retry, idempotency, audit, rollout, and recovery` as applicable
6. `Implementation shape` with affected areas, not speculative code
7. `Acceptance and validation`
8. `Open blockers` with an owner

Omit sections that do not affect the change. Prefer one explicit boundary over a catalogue of hypothetical risks.

## Quality Gate

The design is ready when:

- material claims are anchored in current code or explicitly marked as assumptions;
- ownership and authoritative validation are clear;
- cross-layer contracts agree;
- irreversible or operationally risky transitions have rollout and recovery semantics;
- acceptance criteria can distinguish success from partial completion;
- no unresolved decision would materially change the implementation.

If the artifact is important and non-trivial, use `sr-review` for adversarial review. Use `sr-expert` only when independent expertise is likely to change the result.

## Handoff

End with the route taken, decisions made, remaining blockers, and the next authorized action. Do not create design ceremony for a change that should simply be implemented.

Maintenance rules: `/Users/chenxitang/.codex/skills/SR-SKILLS-SYNC.md`.
