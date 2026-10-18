---
name: db-operation-discipline
description: Use when reviewing or refactoring database read/write code so transaction scope stays small, locking is deliberate, and data consistency boundaries remain clear.
---

# DB Operation Discipline

## Goal

Keep database operations correct and simple while avoiding unnecessarily large transactions.

## Core rules

- Prefer smaller transactions by default. Keep only the minimum set of reads, locks, and writes inside one transaction. Do not pull unrelated queries, loops, network calls, or bulk cleanup into the same transaction unless the consistency boundary truly requires it.
- Avoid loops inside transactions unless they are truly necessary and tightly bounded. As a default rule, do not iterate over many rows while holding transaction locks. Prefer batching, pre-aggregation, or repeated small transactions over one large transaction that locks rows and then loops through them.
- Treat cleanup, compensation, reconciliation, and stale-data handling differently from hot-path writes. For these flows, do not default to one giant transaction over the whole dataset. Prefer querying candidate ids first, then processing one record or a small batch at a time, with each transaction scoped to one state transition and its directly coupled side effects. Do not require whole-batch atomicity unless the business semantics explicitly require it.
- When using conditional updates as an optimistic lock, idempotency guard, or state-transition guard, always check whether the update actually affected the expected rows. Do not treat “no SQL error” as success. A conditional update that changes 0 rows must be handled explicitly.

## Enum storage

- For stable, small database enums, prefer numeric storage such as `tinyint` rather than `varchar`.
- Keep wire-level or domain-level readable strings in code and protocols, and map them to numeric database values at the repository/model boundary.
- Use textual columns for enums only when the value set is intentionally open-ended, operationally configured, or expected to evolve outside normal code releases.

## Relationship keys

- For internal table-to-table relationships, prefer internal numeric primary keys or foreign-key-shaped numeric columns rather than business strings.
- Keep public IDs, request IDs, order numbers, and other wire-facing identifiers for external contracts, idempotency, or tracing only when they solve a concrete problem; do not duplicate them into every related table by default.
- At the repository/model boundary, make it explicit which identifiers are internal join keys and which are external-facing identifiers, so database structure does not drift toward protocol convenience.
