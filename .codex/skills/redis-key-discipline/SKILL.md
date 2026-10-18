---
name: redis-key-discipline
description: Use when designing or refactoring Redis keys to preserve naming, cluster slot boundaries, and compatibility with existing stored keys.
---

# Redis Key Discipline

Choose key names from the operations and entity boundaries they must support.

## Slot boundaries

- Identify which keys a transaction, Lua script, or multi-key command must access in the same slot before choosing a hash tag.
- Put the stable identity of that shared group inside `{}`; keep operation and sub-resource names outside it. For operations scoped to one room, a room ID can be the tag. For another operation, determine its actual group instead of assuming room or user scope.
- Omit hash tags when no co-location requirement exists. A fixed tag such as `{room}` sends every matching key to one slot; use it only when whole-domain co-location is deliberate and its capacity implications are acceptable.
- Preserve nearby naming conventions where they do not conflict with the required operations. Do not extract one-off key helpers unless they carry shared semantics.

## Examples

When keys for the same room must share a slot:

```text
room:{<roomID>}:state
room:{<roomID>}:members
```

When an independent request key has no multi-key co-location requirement:

```text
gift:send_request:<userID>:<requestID>
```

These examples describe different contracts; do not switch between them merely for appearance. Verify related keys share a slot and that unrelated entity groups are not all forced into one slot. Different tags can still hash to the same slot by collision.

## Existing keys

Changing a key or hash tag changes its storage identity and possibly its slot. Before an authorized change, inspect readers, writers, Lua/multi-key operations, TTLs, and rolling-release compatibility. Locks, deduplication, and idempotency keys must preserve their coordination boundary; a rename is not a cosmetic refactor.
