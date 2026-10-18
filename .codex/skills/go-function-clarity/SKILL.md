---
name: go-function-clarity
description: Use when refactoring Go code to keep functions small, single-purpose, and readable, and to treat return-style debates as structure problems before syntax preferences.
---

# Go Function Clarity

## Goal

Keep Go functions small, direct, and single-purpose.
Treat confusion around `named result`, bare `return`, or repeated `return x, y, z` as a signal to inspect function shape first.
Do not use return syntax to compensate for mixed responsibilities.

## When to use

Use this skill when:

- a function is hard to review because readers must hold too much state in mind
- one function is doing multiple unrelated jobs
- a style debate starts around `named result` or bare `return`
- repeated explicit returns look noisy, but changing style would not really improve understanding
- result variables are mutated far from the final return
- a boolean return is technically correct but semantically vague

## Core principles

- Function clarity matters more than return-style consistency.
- If return style feels like the main readability issue, first ask whether the function owns too many jobs.
- `named result` is a readability tool, not a compression trick.
- Bare `return` is fine when result names and control flow are both obvious.
- Explicit `return ...` is better when readers would otherwise need to scan the whole function.
- Repeated explicit returns are often cheaper than hidden state.
- If a boolean return carries real meaning, name it semantically or redesign the return shape.

## Working approach

1. Ask what jobs the function is doing, not just what syntax it uses.
2. Split unrelated work before tuning return style.
3. Keep state local so readers do not have to remember far-away assignments.
4. After structure is clear, choose the return style that minimizes reader effort.
5. Use `named result` only when names materially improve the contract.
6. Use bare `return` only when the function is short enough that returned values are obvious.
7. If a `bool` return keeps causing interpretation questions, rename it or change the API shape.

## Preferred patterns

### 1. Fix function shape before fixing return style

Preferred:

```go
room, err := s.GetRoom(ctx, roomID)
if err != nil {
    return nil, err
}

if err := validateHost(room, claims.UserID); err != nil {
    return nil, err
}

return buildResponse(room), nil
```

Avoid keeping loading, authorization, normalization, side effects, and response construction in one long function and then debating whether bare `return` would make it cleaner.

### 2. Use `named result` when the contract becomes clearer

Preferred:

```go
func (s *Store) ResolveOwner(ctx context.Context, roomID int64) (lease OwnerLease, found bool, err error) {
    return s.registry.GetRoomOwner(ctx, roomID)
}
```

Here `found` names the normal lookup outcome; construction guarantees the required registry. Do not demonstrate return syntax by silently converting a missing dependency into `found=false, err=nil`. The forwarding body is illustrative and does not by itself justify adding a wrapper.

### 3. Do not use `named result` to hide a long mutable function

Avoid:

```go
func doWork(...) (resp *Response, ok bool, err error) {
    // dozens of lines
    // resp, ok, err changed in many branches
    return
}
```

If readers must track multiple assignments across a long function, split the function instead.

### 4. Repetition in returns is not automatically a smell

This is often fine:

```go
if err != nil {
    return nil, err
}
if room == nil {
    return nil, xerr.New(xerr.CodeNotFound, "room not found")
}
```

Do not remove simple explicit returns just because they repeat.

### 5. Give booleans semantic names

Preferred:

```go
func GetRoomOwner(...) (lease OwnerLease, found bool, err error)
func ClaimRoomOwner(...) (claimed bool, err error)
```

Avoid bare `(OwnerLease, bool, error)` when the meaning of the boolean is easy to lose in review.
If the boolean still feels weak, consider a stronger API such as `(*OwnerLease, error)` or `error`.

## Decision rule

Choose return style only after the function is structurally sound.

- If the function is short, focused, and names clarify the contract, `named result` is good.
- If bare `return` causes confusion, first ask whether the function should be split.
- If explicit returns are repetitive but obvious, prefer the obvious code.
- If a `bool` return needs explanation in review, name it or redesign the return shape.

## Review guidance

When reviewing:

- do not argue about bare versus explicit return before checking whether the function has too many jobs
- prefer comments like "this function now has three jobs" over style-only comments when structure is the real problem
- accept either return style when the function is already small and clear
- push harder on semantic clarity for booleans than on stylistic uniformity

## Expected outcomes

Applied well, this skill should produce:

- smaller functions with clearer ownership
- return statements that match function shape instead of compensating for it
- fewer style-only debates
- better semantic naming for returned values
- code that is easier to read without memorizing intermediate state
