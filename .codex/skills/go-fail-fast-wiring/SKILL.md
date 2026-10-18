---
name: go-fail-fast-wiring
description: Use when refactoring Go services to move required dependency validation to startup time, clean impossible runtime nil checks from ServiceContext, jobs, handlers, and logic code, and keep business code focused on business logic instead of wiring failures.
---

# Go Fail-Fast Wiring

## Goal

Move required dependency validation to construction and startup time.
Do not let runtime business code absorb wiring failures.

## When to use

Use this skill when:

- `ServiceContext`, jobs, handlers, or logic structs are full of `nil` checks
- business methods contain branches like `if svcCtx == nil { return nil }`
- a dependency is actually required, but the code treats it as optional
- wiring errors surface only after requests reach business logic
- `nil` is being used to mean "feature disabled"

## Core principles

- Required dependency problems belong to startup, not business runtime.
- If a required dependency is missing, fail construction or startup immediately.
- Runtime code should assume required dependencies are valid.
- Do not pollute happy paths with impossible-state guards.
- Do not use `nil` to represent optional behavior; use explicit config or noop implementations.
- Prefer local assignment-time checks over large late validation layers.

## Working approach

1. Separate required dependencies from truly optional ones.
2. Make constructors such as `NewServiceContext`, `NewXxxJob`, `NewXxxServer`, and `NewXxxLogic` enforce required dependencies.
3. Check each required dependency near the point where it is created or assigned.
4. Return `error` from constructors when required dependencies are missing.
5. Handle startup failure in `main` and stop booting.
6. Remove runtime `nil` guards that cannot happen on the normal startup path.
7. For optional capability, use explicit config flags or noop implementations.

## Preferred patterns

### 1. Fail fast during startup

Preferred:

```go
serverCtx, err := svc.NewServiceContext(c)
if err != nil {
    logx.Errorf("init service context failed: %v", err)
    panic(err)
}
```

Do not defer required dependency failures to runtime business code.

### 2. Check required dependencies at creation time

Preferred:

```go
repo, err := mysqlstore.New(c.MySQL)
if err != nil {
    return nil, err
}
if repo == nil {
    return nil, errors.New("mysql repository is nil")
}
```

Prefer checks close to assignment instead of a large late-stage validator.

### 3. Remove impossible runtime guards

If startup guarantees a valid object graph, code like this is usually dead defensive code:

```go
if j == nil || j.svcCtx == nil || j.svcCtx.RoomState == nil {
    return nil
}
```

### 4. Represent optional behavior explicitly

Avoid:

```go
if limiter == nil {
    return nil
}
```

Prefer:

```go
if !cfg.SignalRateLimit.Enabled {
    return nil
}
```

## Common smells

- `if svcCtx == nil { return nil }`
- `if repo == nil { return nil }`
- `if j == nil || j.svcCtx == nil || ...`
- production code carrying nil guards only to support half-built test objects
- large `ensureXxx` or `validateXxx` layers added to hide wiring problems instead of fixing them at construction time

## Removal criteria

Remove a runtime nil guard only when all are true:

- the object is created through a controlled constructor path
- the constructor path already guarantees required dependencies
- the value cannot be nil on the normal startup path
- the nil branch does not carry real business meaning

If any of these are false, do not remove the guard mechanically.

## Test guidance

- Do not keep meaningless runtime nil guards just to accommodate lazy test setup.
- Prefer constructors, builders, or explicit test wiring helpers.
- If tests need mocks, solve that in test setup rather than polluting production happy paths.
- For seams and nil guards that exist only because tests construct half-built objects, see go-test-seam-discipline; this skill focuses on startup-time validation of required dependencies.

## Expected outcomes

Applied well, this skill should produce:

- required dependency failures that move to startup
- shorter, cleaner business paths
- fewer impossible runtime nil branches
- explicit optional behavior
- clearer separation between wiring and business concerns
