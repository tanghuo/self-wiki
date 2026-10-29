---
name: naming-discipline
description: Use when reviewing or refactoring names so identifiers, helper names, Redis keys, and wire-level terms follow one consistent semantic shape instead of drifting by local convenience.
---

# Naming Discipline

## Goal

Keep naming consistent across the codebase.
Names should expose domain, action, and ownership clearly, instead of mixing multiple ideas into one token.

## Core principles

- Prefer one stable naming shape per concept family.
- Name by semantic ownership, not by local convenience.
- Keep domain and action separate when they are different pieces of meaning.
- Match nearby conventions unless there is a strong reason to introduce a new shape.
- Do not invent a new naming style for one isolated case.
- Rename the surrounding identifiers and file names when a type’s role changes; do not leave historical names that describe an old responsibility.
- Keep exported type names, held field names, and file names aligned when they refer to the same concept.

## Database naming

- Name a column for the entity and key it actually stores. Verify whether it holds a surrogate key, UUID, or business identifier before proposing a name.
- Distinguish identifiers with different meanings; preserve established names where the contract is already clear.
- Naming work does not select a key type, change relationships, or authorize a schema migration. Those decisions require the current data model and task requirements.

## Redis keys

- Choose a hash tag only after identifying the keys that must share a slot. A fixed domain tag sends all matching entities to one slot.
- Keep the action or sub-resource path outside the tag. Use no tag when co-location is unnecessary.

## Decision rule

Choose names that make these questions obvious:

1. What domain does this belong to?
2. What action, sub-resource, or stronger contract is this?
3. Who owns the meaning of this name?
4. Does this name match the surrounding naming pattern?

If the answers are being compressed into one awkward token, the naming is probably doing too much.

## Refactoring rule

For local identifiers within the authorized scope, when renaming for correctness:

- update the type name
- update the main holder field names
- update constructor names where needed
- update file names when the old file name preserves outdated meaning

Keep related local names coherent. Database columns, serialized fields, events, public APIs, and Redis keys are compatibility contracts: inspect their consumers and migration needs before changing them. Do not expand a local rename into a protocol or storage migration.

## Review checklist

1. Does the type name describe the current responsibility, not the historical one?
2. Do the holder field names and constructor names match the same concept family?
3. Does the file name still point to an outdated role such as `registry.go` after the type became a manager or coordinator?
4. Are we preserving an old name only because renaming the rest feels inconvenient?
