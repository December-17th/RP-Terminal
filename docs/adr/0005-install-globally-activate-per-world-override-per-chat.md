# Install globally, activate per world, override per chat

**Status: Superseded by ADR 0019 (2026-07-18).**

An agent pack import creates exactly one user-owned copy in a **global library**. Whether the pack
runs — its gate state — is decided **per world**, with an optional **per-chat** exception; exposed-
setting overrides layer the same way (global default → per-world → per-chat, nearest wins). This
mirrors the workflow selection tiers that already exist (session → world → global → builtin,
`src/main/services/workflowService.ts:198-295`), so users learn one scoping model, not two.

Card-bundled packs install into the same library: the cartridge carries the pack artifact plus a
*suggested activation* for its own world. There is one install concept regardless of arrival path
(standalone file or card), which keeps upgrade logic, override reapplication, and the import UI
single-pathed.

## Considered options

- **Install per world.** Rejected: the same planner used in five worlds becomes five divergent
  copies with five override sets; upgrades multiply.
- **Install and activate globally.** Rejected: enabling the memory keeper for a long campaign
  shouldn't drag it into every one-shot; per-world difference would then require forking.

## Consequences

- Upgrades touch one artifact; per-world behavior differences live entirely in overrides and
  activation, which are reapplied by stable id after upgrade.
- Three-layer override resolution is real machinery, and the settings UI must show provenance
  ("set for this chat, overriding this world") or debugging becomes guesswork.
- The Agents workspace inside a world is a filtered view of the library ("enabled here?"), not a
  separate collection.
