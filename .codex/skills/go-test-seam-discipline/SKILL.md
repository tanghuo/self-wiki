---
name: go-test-seam-discipline
description: Use when refactoring Go code so tests do not dictate production structure, especially when function fields, local interfaces, nil guards, injected seams, convenience constructors, or fallback implementations exist only to support tests rather than real runtime boundaries.
---

# Go Test Seam Discipline

## Goal

Keep production code shaped by runtime semantics, not by test convenience.
Tests should adapt to production design more often than production design should adapt to tests.

## When to use

Use this skill when:

- logic structs expose function fields only so tests can stub internals
- local interfaces exist with exactly one production implementation and one fake used only in tests
- runtime nil guards exist mainly because tests instantiate half-built objects
- constructors or helpers are overly flexible only to support unit tests
- production code gained extra indirection with no runtime meaning
- the code feels "testable" but no longer reads like the real system

## Core principles

- Tests are consumers of production code, not the primary architects of production structure.
- Introduce abstractions when production has a real boundary, not just because tests want an easier seam.
- Prefer seams at true runtime boundaries: storage, RPC, Redis, HTTP, time, randomness, OS, external services.
- Keep test-only fakes, fallback implementations, fixtures, and convenience adapters in test code such as `_test.go` helpers, not in production packages.
- Avoid seams around internal business steps that have no production variability.
- Do not add runtime nil guards just to tolerate broken test objects.
- Do not keep production code paths, constructors, interfaces, or fallback implementations whose only purpose is making tests easier to write.
- Do not keep default constructors or convenience wiring in production code when they exist only to auto-assemble test-only dependencies.
- It is acceptable for tests to be slightly more verbose if production code stays clearer.

## Working approach

1. Identify whether a seam exists for production reasons or only for test injection.
2. If the seam is test-only, remove it from production structs and methods.
3. Let constructors build fully valid objects with real dependencies.
4. Rewrite tests to use builders, fixtures, or fakes at real boundaries.
5. Test behavior through public methods whenever possible.
6. Keep private helpers private unless production truly needs an abstraction.

## Good seams

These usually earn their place:

- repository or store interfaces
- external RPC or HTTP clients
- Redis or message queue clients
- clock or time provider
- random or ID generator
- filesystem or OS interaction
- feature-flagged runtime behavior with real production variation

## Bad seams

These are often signs that tests are driving production design too hard:

- function fields on production structs only used by tests
- local interfaces wrapping a single real access path
- "state" abstractions that only exist so tests can bypass setup
- nil-tolerant runtime code added because tests construct incomplete objects
- constructor options added only for tests, with no production meaning
- helper layers whose main purpose is hiding test setup cost
- fallback mutators, local in-memory variants, or fake implementations left in production code only so tests can call a simpler constructor
- production constructors that silently create substitute dependencies rather than requiring the real runtime dependency graph

## Decision rule

Keep a seam only if at least one is true:

- there are multiple meaningful production implementations
- it represents a real external or unstable boundary
- it improves production composition, not just test setup
- runtime behavior legitimately needs substitution

One production implementation plus a test fake is not sufficient reason to remove a seam; apply these boundary criteria first. If none are true, the seam is probably test-driven accidental complexity.

## Preferred testing patterns

### 1. Use builders in tests

If a struct needs many valid dependencies, build test helpers that create a valid object graph.
Do not weaken production invariants to make tests shorter.

### 2. Fake real boundaries, not internal steps

Prefer mocking a repository or RPC client over mocking internal helper methods.

### 3. Test through public behavior

If a helper exists only to support a public method, prefer testing the public method.
Only extract and mock internals when production meaning truly exists.

### 4. Accept some setup cost

A little more setup in tests is often cheaper than permanently distorting production design.

### 5. Put fake wiring in test helpers

Preferred:

- production constructor requires the real runtime dependency such as a mutator, dispatcher, or coordinator
- `_test.go` helper assembles a fake or lightweight implementation for tests

Avoid:

- production constructor creates a fake, fallback, or local implementation only because tests want a shorter call

## Common smells

- `type xxxState interface { ... }` with one real impl and one test fake
- function fields on production structs only for tests
- `if l.dep == nil { return nil }` in business code
- tests creating half-built production objects directly
- constructors becoming configurable in ways runtime never uses
- production code carrying a fallback implementation that is only exercised by tests
- a no-arg or reduced-arg constructor whose main value is avoiding test setup

## Refactoring pattern

When a seam is test-only:

1. Remove the seam from the production struct.
2. Restore direct use of the real dependency in production code.
3. Keep constructor invariants strict.
4. Move any fake, fallback, or convenience implementation into `_test.go` helpers or test fixtures instead of leaving it in production code.
5. Replace test stubs with a builder, fixture, or fake boundary dependency.
6. Re-run tests and keep only abstractions with real runtime value.

## Hard line

- Test code is test code; production code is production code.
- Do not mix test-motivated behavior into production code.
- If a piece of code exists only to help tests, it belongs in test files unless it also has clear runtime value.
- If a constructor, helper, or implementation exists only to save test setup, move that convenience into test helpers and delete it from production code.

## Review checklist

1. Would this code path still exist if there were no tests?
2. Is this constructor expressing real runtime wiring, or hiding test setup?
3. Can the fake or fallback live in `_test.go` instead?
4. Did production code gain a new branch, interface, or helper solely because tests wanted it?
5. Are tests being asked to adapt to production structure, or is production structure being bent for tests?

## Expected outcomes

Applied well, this skill should produce:

- production code that reads more directly
- fewer internal-only interfaces and function fields
- fewer runtime nil guards added for tests
- abstraction boundaries that match real runtime boundaries
- production and test code each carrying their own proper complexity
