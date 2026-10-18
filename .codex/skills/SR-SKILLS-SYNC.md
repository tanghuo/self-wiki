# SR Skills Sync

Canonical propagation rules for the personal `sr-*` skill family.

## Copies

- `/Users/chenxitang/.codex/skills/`: live edit surface and canonical working copy.
- `/Users/chenxitang/.claude/skills/`: runtime mirror; do not edit directly.
- `/Users/chenxitang/GolandProjects/th-skill/skills/`: versioned backup and publish copy.

Edit and validate the Codex candidate first. When the requested maintenance scope includes existing mirrors, propagate only the changed managed files to the Claude mirror and th-skill, preserving unrelated work, then verify their content.

Commit, push, and publication are separate actions that require authorization from the user or established session context. This maintenance document does not supply that authorization.

## Managed Skills

- `sr-help`
- `sr-design-gate`
- `sr-review`
- `sr-plan-split`
- `sr-task-loop`
- `sr-task-runner`
- `sr-worktree-review-fix-loop`
- `sr-expert`

When a managed change is propagated, its `SKILL.md` must be byte-identical across the included copies. If a mirror cannot be updated within scope, report the divergence rather than claiming synchronization. Keep provider-specific CLI syntax out of the skills; inspect adapters at runtime instead.

`SR-SKILLS-SYNC.md` is kept in the Codex canonical and `th-skill`, but is not installed into Claude. Non-executable design drafts under `references/` are also Codex-only and should exist only when an active skill links to them.

## Change Checklist

1. Edit and validate the Codex candidate.
2. For included mirrors, compare their current content and copy only the changed managed files. Do not overwrite divergent or unrelated work automatically.
3. Remove a retired managed skill or stale file only when its removal is explicitly within scope; copying is not authorization to delete unrelated files.
4. Run `quick_validate.py` for every managed skill.
5. Confirm the included `SKILL.md` copies are byte-identical; report any excluded mirror that remains out of sync.
6. Confirm no repo-specific schema, credentials, paths, or business rules leaked into a global skill.
7. Review the included mirror diffs. Commit or push only when authorized; otherwise leave the changes reviewable and report that state.

The bootstrap installers copy the versioned skills into their runtime directory. They do not own day-to-day edits and must preserve unrelated personal skills.
