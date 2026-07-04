# One pack, one graph, many attachments

A pack's fragment is a single graph that may declare **multiple attachments**: several checkpoint
entries (branch or inline) and/or headless triggers. The motivating case is async memory: a
headless compactor (trigger: unsummarized backlog exceeds N), an inline history-trimmer at
`context-ready` (trimming *transforms* the main flow, so it cannot be a branch), and a branch
rejoining at `prompt-assembly` to inject the memory-table export — one system, three attachments.

The rule pinned with this: **the gate is per-pack**. Enabling or disabling a pack opens or closes
all of its entry edges as one act, because the pack is the unit the user reasons about ("my memory
system: on or off"). Only capability denial (ADR 0007) closes a subset, and that subset is
capability-shaped, never attachment-shaped.

## Considered options

- **One pack = one attachment; compound systems ship as several packs in a recipe.** Rejected as
  the forced default: the user would see three toggles that only make sense together, and turning
  one off silently breaks the others' assumptions — the cross-run coordination smell ADR 0001
  rejected. Creators who genuinely want independently-toggleable pieces can still ship separate
  packs; the choice becomes expressive rather than forced.

## Consequences

- Effective-graph composition splices several entry edges from one fragment; the engine cost over
  single-attachment is trivial.
- Capability derivation runs over the whole fragment once; the trace attributes all three kinds of
  activity to one pack.
- Pieces of a compound pack share settings, prompts, and internal wiring naturally, instead of
  coordinating through recipe bindings.
