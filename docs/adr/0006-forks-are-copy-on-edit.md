# Forks are copy-on-edit, never in-place detach

**Status: Superseded by ADR 0019 (2026-07-18).**

Editing an installed pack's fragment in Workflow Studio creates a **new library entry** (the fork)
with upstream lineage recorded; the world where the edit happened repoints its activation to the
fork, and the pristine install remains untouched for every other world. Overrides carry over to the
fork at creation — the fork keeps the same stable manifest ids unless the editor deletes their
targets — so forking never resets the user's settings. No prompt, no choice: the edit *is* the
fork.

## Considered options

- **In-place detach (the install itself becomes the fork).** Rejected: with activation being
  per-world (ADR 0005), tweaking a pack inside one world would silently change behavior in every
  other world using it — the exact surprise the scoping model exists to prevent. It also destroys
  the pristine artifact that upstream-diffing needs.
- **Prompt at edit time ("fork a copy, or edit for everyone?").** Rejected: a modal decision
  average users can't make and advanced users resent. Studio offers "apply this fork to other
  worlds" afterward instead.

## Consequences

- Fork creation is non-destructive and needs no confirmation; worst case the user deletes the copy
  and repoints activation.
- The library accumulates fork entries and must group them by lineage ("Plot Planner — 2 forks")
  or it turns into clutter.
- "Edit everywhere" is deliberate extra work: repoint other worlds to the fork, or apply-to-all
  from Studio.
- Upstream-version diffing stays possible for forks because the original artifact is never
  mutated.
