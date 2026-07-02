# 06 — Tables view editing + template export + polish

Status: ready-for-agent

## What to build

Close the loop for the player and the template author.

**Editing:** the Tables view becomes writable — edit a cell, add a row, delete a row. Every hand edit is recorded through the same op-log path as AI writes (attributed to the current floor), so manual fixes survive and rewind semantics stay consistent (a swipe past the edit's floor rolls it back — matching how AI writes behave). Deleting all rows / resetting a table is available with a confirm.

**Template export:** export a chat-assigned (or stored) template back to chatSheets v2 JSON — lossless for everything the importer consumed, so templates remain portable to the ST ecosystem. Optionally include current table data as the template's initial rows ("export with data") for sharing a seeded template.

**Polish:** empty/error states in the view, last-maintained-floor indicator per table (from the gate's durable state), i18n audit of every new string across both locales, and a `docs/sdk/` pass covering the full table-memory surface (template format, node family, injection mapping) with file:line citations per the docs policy.

Demo: fix a wrong cell the AI wrote, see the fix persist across turns and roll back on swipe; export the template and re-import it into a fresh chat.

## Acceptance criteria

- [ ] Cell edit / row add / row delete work from the Tables view, are recorded as floor-attributed ops, and replay correctly on rewind.
- [ ] Edits respect the same safety layer (registered tables only; generated statements go through the executor).
- [ ] Export produces chatSheets v2 JSON that the importer round-trips to an equivalent template; "export with data" embeds current rows as initial rows.
- [ ] Reset-table requires confirmation and is itself op-logged (or clears the table's ops — pick one deliberately and test it).
- [ ] All new strings pass through `t()` with keys in both `en.ts` and `zh.ts`.
- [ ] `docs/sdk/` documents the complete surface; behavioral claims carry file:line citations.
- [ ] `npm run typecheck && npm run check:deps && npm run test` all pass.

## Blocked by

- [03-sandboxed-sql-write-path-and-rewind.md](03-sandboxed-sql-write-path-and-rewind.md)
