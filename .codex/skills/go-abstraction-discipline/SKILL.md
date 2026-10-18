---
name: go-abstraction-discipline
description: Use when refactoring Go code to remove low-value abstractions (thin wrappers, single-use helpers/constants, forwarding layers, leftover migration scaffolding), keep public method sets small with contract-strengthening siblings that earn their place, keep business checks at the business layer, and place abstractions on the layer that owns the semantics.
---

# Go Abstraction Discipline

## Goal

Keep Go production code local and direct unless an abstraction adds real semantic value.
Do not extract helpers, constants, wrappers, or structs just to make code look tidier.
Place abstractions on the layer or type that owns the meaning.

## When to use

Use this skill when you see any of these:

- a helper is single-use and mostly forwards to another call
- a wrapper mixes business validation with locking, Redis, HTTP, or other low-level capability
- a constant, helper, or package error has no meaning outside one call site
- a small block was extracted, but readers now have to jump around to understand something simple
- error translation happens in a low-level helper even though the business layer owns the meaning
- a generic helper exists only because several methods share a similar signature
- a caller-layer helper was added even though the contract clearly belongs on the callee type
- callers repeatedly rebuild the same derived lookup or view from one type
- a derived struct or slice is precomputed even though it can be assembled later from canonical data
- unrelated side effects interrupt a local value-construction flow
- a helper or method returns implementation-process state that callers do not actually need
- a struct exists only to bundle values that callers immediately unpack
- the public API has grown `GetX`/`RequireX` (or exported `X` plus private `x`) pairs where one only forwards to the other
- a transition layer or historical name survived after the migration it served finished

## Core principles

- Keep logic local by default.
- Extract only when the abstraction has real reusable semantics.
- Business validation belongs in the business layer.
- Low-level utilities should express low-level capability, not business policy.
- Prefer semantic ownership over repetition site.
- Prefer capability abstractions over caller-side wrappers.
- Signature similarity is not semantic equivalence.
- If behavior is a stricter form of an existing contract, prefer a sibling method on the same owner.
- If a derived lookup or view is a natural capability of a type, prefer a method on that type over a caller-layer helper.
- Prefer deriving lightweight view data at the use site rather than storing mirrored intermediate objects.
- Keep local construction flow contiguous.
- Distinguish input normalization from validation; do not hide missing required input behind synthetic empty values.
- Keep tolerant parsing at tolerant boundaries; use stricter parsers for stricter internal contracts.
- Let each method do only its own job.
- Do not leak procedural state into interfaces unless callers truly need it.
- Do not bundle values into a struct when callers immediately split them back out.
- Return shapes should match what callers need, not the callee's internal steps.

## Working approach

1. Identify what the code is really doing at the call site.
2. Separate business checks from low-level mechanics.
3. Ask who owns the meaning of the repeated behavior.
4. Ask whether the abstraction has meaning outside this one place.
5. Inline wrappers that only forward params, rename errors, or hide one obvious call.
6. Keep low-level primitives small and honest.
7. If behavior strengthens an existing contract, prefer a sibling method on the same owner.
8. If callers keep rebuilding the same derived lookup from one type, consider a method on that type.
9. If a struct is mostly copied from canonical data plus one local item, prefer deriving it on demand.
10. If a block is building one value, keep declaration, population, and final use adjacent.
11. If a parser is permissive for compatibility, confine that permissiveness to the actual boundary.
12. Ask whether the method is loading, validating, repairing, or requiring, and keep it to one job.
13. Remove returned fields or values that callers do not use for meaningful decisions.
14. Flatten returned bundles that every caller immediately unpacks.

## Good abstractions

These usually earn their place:

- a helper reused in multiple places with the same stable semantics
- a capability primitive such as `MustAcquireLock`
- a sibling method that strengthens an existing contract on the same type, such as `GetRoom` and `MustGetRoom`
- a method on a domain type that exposes a natural derived capability, such as `snapshot.MemberSet()`
- a boundary abstraction around storage, RPC, HTTP, time, randomness, or OS interaction
- a helper that encodes a real domain concept beyond one call site
- a shared parser, encoder, validator, or transformer with multiple consumers
- a tolerant parser explicitly owned by an external or compatibility boundary
- a derived view object with its own lifecycle, persistence meaning, or multiple stable consumers
- a small method whose checks and fallback behavior match its name and return contract
- a return shape whose fields are all needed by real callers

## Bad abstractions

These are often negative-value abstractions:

- a `lockRoomMembership` helper that checks one business param, builds one key, calls one lock API, and rewrites one error
- a single-use constant, helper, or package error with no standalone meaning
- a helper whose main effect is making the reader jump elsewhere for a few obvious lines
- a low-level wrapper that absorbs business semantics it does not own
- a generic helper created only because several layers share a similar function signature
- a caller-layer helper that builds a lookup or view from another type when the capability belongs on that type
- a precomputed notice or view struct whose fields are mostly copied from canonical data and one item, then only used to build later payloads
- an async notify, log, or other best-effort side effect inserted into the middle of local value construction
- a helper that turns missing required client payload into `{}` only so later unmarshal or validation fails differently
- a permissive parser reused in a stricter internal contract just because the input type matches
- a read helper that quietly becomes a validator, repairer, or hard requirement even though its contract only says "get" or "lookup"
- a returned `claimed`, `created`, `loaded`, or similar flag that callers do not use for meaningful branching
- a broad `Result` or `Route` struct introduced only to carry a few values that callers immediately unpack
- an exported `GetX` that only forwards to `loadX`, or an exported `X` paired with a private `x` where one only forwards
- a sibling API or wrapper added only for naming symmetry, with no caller-visible contract difference
- a leftover migration or transition layer, or a type/file name frozen from an old responsibility

## Decision rule

Keep an abstraction only if at least one of these is true:

- it is reused in more than one meaningful call site
- it captures a stable capability with its own semantics
- it encodes a real domain concept
- it materially reduces total reader effort
- it improves production composition, not just style
- it sits on the layer or type that owns the meaning

If none are true, keep the logic inline.

## Preferred patterns

### 1. Keep business checks at the call site

Preferred:

```go
if claims.UserID <= 0 {
    return nil, xerr.New(xerr.CodeUnauthorized, "unauthorized")
}

release, err := l.svcCtx.Locker.MustAcquireLock(ctx, fmt.Sprintf("room_membership:%d", claims.UserID), 5*time.Second)
if err != nil {
    return nil, err
}
defer release()
```

Avoid pushing `claims.UserID <= 0` into a lock helper. This example assumes one independent lock key. If the lock implementation operates on related Redis keys, verify its required shared-slot group before choosing a hash tag. Do not rename a deployed lock key without preserving coordination during rollout.

### 2. Keep low-level helpers low-level

Preferred:

```go
func (r *Registry) MustAcquireLock(ctx context.Context, businessKey string, ttl time.Duration) (func(), error)
```

This expresses lock capability.
It should not decide authorization or business conflict wording.

### 3. Put stronger contracts next to the original contract

Preferred:

```go
func (s *Service) GetRoom(ctx context.Context, roomID int64) (*Room, error)
func (s *Service) MustGetRoom(ctx context.Context, roomID int64) (*Room, error)
```

Avoid a caller-side `mustGetRoom` helper when the owner type already owns room-loading semantics.

### 4. Put natural derived capability on the owner type

Preferred:

```go
members := snapshot.MemberSet()
```

Prefer this over a caller-layer `roomMemberSet(snapshot)` helper when the derived lookup is a natural capability of `RoomStateSnapshot`.

### 5. Inline thin wrappers

Avoid helpers that only:

- check one caller-owned parameter
- build one obvious string
- call one underlying method
- rewrite one error
- return the same values

That usually adds indirection without meaning.

### 6. Do not promote tiny locals too early

Avoid extracting single-use constants, errors, and helper names unless they become shared concepts.

### 7. Do not abstract across layers just because signatures match

Avoid unifying repo, domain, and logic calls merely because they all look like `func(ctx, id) (*T, error)`.
Repeated signatures do not imply repeated semantics.

### 8. Derive lightweight payloads at the use site

Preferred:

```go
for _, target := range order.Targets {
    payload := map[string]any{
        "orderNo": order.OrderNo,
        "giftId": order.GiftID,
        "senderUserId": order.SenderUserID,
        "targetSeq": target.TargetSeq,
        "toUserId": target.ReceiverUserID,
        "receiverSeatNo": target.ReceiverSeatNo,
    }
}
```

Avoid an intermediate `GiftSendNotice`-like object when it only mirrors canonical data plus one item.

### 9. Keep value construction contiguous

Preferred:

```go
dispatches := make([]DispatchInstruction, 0, len(targets))
for _, target := range targets {
    dispatches = append(dispatches, buildDispatch(target))
}
response := buildResponse(dispatches)
notifyBestEffort()
return response, nil
```

Avoid unrelated side effects between declaration, population, and final use of a local value.

### 10. Do not hide missing required input behind `{}` 

Preferred:

```go
if len(bytes.TrimSpace(env.Payload)) == 0 {
    return nil, xerr.New(xerr.CodeInvalidArgument, "payload is required")
}
if err := json.Unmarshal(env.Payload, &payload); err != nil {
    return nil, xerr.Wrap(xerr.CodeInvalidArgument, "invalid payload", err)
}
```

Use empty-object fallback only when it is a real boundary contract, not as a band-aid for invalid required input.

### 11. Match parser strictness to the boundary contract

Preferred:

```go
func parseActiveRoomID(value string) (int64, error) {
    roomID, err := strconv.ParseInt(value, 10, 64)
    if err != nil || roomID <= 0 {
        return 0, fmt.Errorf("invalid active room id %q", value)
    }
    return roomID, nil
}
```

Use flexible helpers such as `ParseFlexibleInt64JSON` only where the boundary truly accepts multiple shapes.
Do not widen strict internal storage contracts by reusing tolerant parsers.

### 12. Let the method do only its own job

Preferred:

```go
func (r *Registry) GetUserActiveRoom(ctx context.Context, userID int64) (int64, error) {
    if userID <= 0 {
        return 0, nil
    }

    value, err := r.client.Get(ctx, r.userActiveRoomKey(userID)).Result()
    if err == redis.Nil {
        return 0, nil
    }
    if err != nil {
        return 0, err
    }

    roomID, err := strconv.ParseInt(value, 10, 64)
    if err != nil || roomID <= 0 {
        return 0, nil
    }
    return roomID, nil
}
```

If stronger semantics are needed, add a different method whose contract explicitly owns them.

### 13. Do not leak implementation-process state through returns

Preferred:

```go
func (s *Store) ClaimOwnerOrGetCurrent(ctx context.Context, roomID int64, candidate OwnerLease, ttl time.Duration) (OwnerLease, error)
```

If callers only need the effective owner lease, return that lease.
Do not also return `claimed bool` unless callers truly branch on it.

### 14. Do not bundle values that callers immediately unpack

Preferred:

```go
owner, local, err := registry.ResolveForMutation(ctx, roomID)
```

Avoid:

```go
type MutationRoute struct {
    Local bool
    Owner OwnerLease
}
```

when every caller immediately does `route.Owner` and `route.Local`.

### 15. Keep the public API smaller than the implementation surface

Preferred:

```go
func (s *Service) MustGetRoomSnapshot(ctx context.Context, roomID int64) (*RoomSnapshot, error) {
    snapshot, err := s.loadRoomSnapshot(ctx, roomID)
    if err != nil {
        return nil, err
    }
    if snapshot == nil {
        return nil, xerr.New(xerr.CodeNotFound, "room not found")
    }
    return snapshot, nil
}
```

A `MustX` sibling earns its place only when it strengthens the contract, such as turning absence into `not found`.
Do not add a `GetX` that only forwards to `loadX` with identical semantics just so the pair looks symmetrical.
Do not keep both an exported `X` and a private `x` when one only forwards to the other; put the implementation on the single form callers actually use.
Prefer the smallest reversible API: add a weaker sibling later if a real caller appears.
Use one verb for one idea; do not mix `Must*` and `Require*` for the same strengthening.

### 16. Remove leftover migration scaffolding and stale names

Transition layers added during a refactor should be deleted once the real architecture is in place.
Do not let exported wrappers, helper layers, or type and file names freeze a historical shape after the responsibility moved.
If a name reflects an old implementation instead of the current job, rename it.

## Common smells

- single-use helpers with names broader than their real value
- wrappers that mainly rename an underlying call
- business validation hidden inside infra helpers
- abstractions added near repeated callers instead of near semantic owners
- intermediate structs that duplicate canonical aggregate data
- local construction blocks interrupted by unrelated side effects
- required client payload normalized instead of rejected at the boundary
- tolerant parsers leaking into strict internal code
- methods silently enforcing stronger semantics than their names imply
- returns that describe callee internals instead of caller needs
- public API pairs (`GetX`/`RequireX`, exported `X`/private `x`) where one only forwards to the other
- migration scaffolding or historical names left in place after the responsibility changed

## Refactoring pattern

When an abstraction looks suspicious:

1. Inline it mentally or literally.
2. Separate business checks from infrastructure calls.
3. Ask which layer or type owns the repeated meaning.
4. Keep business checks in the caller.
5. Keep infra primitives capability-focused.
6. If the behavior strengthens an existing method, add a sibling method on the same owner.
7. If callers keep rebuilding the same lookup or view from one type, consider a method on that type.
8. Re-extract only what has real reuse or meaning.
9. If a payload or view can be derived cheaply from canonical data, do not store a mirrored form unless it clearly earns its place.
10. If a method only promises to fetch or look up data, do not make it validate, repair, or hard-fail for a different contract.
11. Remove unused procedural returns and flatten bundles that callers immediately unpack.

## User intent rule

If the user names the target layer or owner explicitly, treat that as a strong design constraint.
Only move the abstraction elsewhere when there is a clear technical reason.

## Expected outcomes

Applied well, this skill should produce:

- fewer low-value helpers and constants
- business code that reads in one pass
- lower-level utilities with cleaner responsibility boundaries
- abstractions that feel earned rather than decorative
- helper placement that matches semantic ownership
- less mirrored intermediate data
- fewer needless context switches inside short local flows
- boundary validation and parser strictness that match the real contract
- methods and interfaces that expose caller-needed semantics instead of implementation breadcrumbs
