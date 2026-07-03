# Recipes bundle for transport, reference internally

A `.rptrecipe` file embeds full copies of every agent pack it uses; internally the recipe is a list
of pack references (id + version) plus an activation preset (enabled set, world-scope overrides,
narrator choice). At import, embedded packs dedupe into the global library by id + version —
already installed → skip, new → ordinary pack install — then the activation preset applies to the
chosen world. Recipe import is therefore N pack installs plus one activation preset, not a second
import pathway.

Rules pinned with the decision:

- **Version collision:** if the recipe embeds Memory Keeper 1.2 and the library has 1.4, install
  1.2 alongside (versions are distinct library entries) and activate what the recipe pinned —
  recipes are reproducible or they are nothing. "Use your 1.4 instead" is offered as an explicit
  user choice, never a silent substitution.
- **Narrator:** the builtin narrator is referenced by well-known id; a custom narrator embeds the
  same way a pack does.

## Considered options

- **References only ("lightweight manifest").** Rejected: there is no registry to resolve from —
  user-to-user file sharing is the distribution model, so an artifact must survive alone. Same
  reasoning that made packs bundle memory templates instead of referencing them.
- **Creator's choice at export (bundle or reference).** Rejected for now: an export-dialog decision
  nobody can make meaningfully today. Reference-only export becomes a trivial additive option if a
  registry ever exists.

## Consequences

- Recipe files are fat; dedupe-by-id keeps the library clean when many recipes embed the same
  popular pack.
- Multiple versions of one pack can coexist in the library, which the library UI must group by
  lineage alongside forks (ADR 0006).
- Recipes pin versions, so they reproduce exactly — upgrades happen in the library afterward, not
  during recipe import.
