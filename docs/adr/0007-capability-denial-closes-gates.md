# Capability denial closes gates, not nodes

When a user denies a derived capability (e.g. table writes), the runtime closes the entry edges of
every sub-path that reaches a node requiring it — the same gate mechanism used for disabling a pack
(ADR 0002), computed by the same reachability analysis, surfaced with the same cascade warning
("denying table writes turns off the memory-update path; the recall path keeps working"). If
denial covers the entire fragment, the UI states plainly that it is equivalent to disabling the
pack.

Capabilities themselves are derived mechanically: node types map to read/write capabilities
(`table.apply` → writes tables; `vars.save`/`mvu.set`/`apply.state` → writes variables;
`lorebook.select`/`lorebook.entries` → reads lorebooks; `llm.sample` → calls an LLM; ...), while
"injects prompt context" derives from a rejoin edge at the prompt-assembly checkpoint and "runs
headless" from a declared trigger. No lorebook-write node exists today, so no pack can derive that
capability until one does.

## Considered options

- **All-or-nothing: denial blocks activation entirely.** Rejected as the primary mode: a pack that
  reads tables for recall and writes them for upkeep would be unusable read-only, though
  all-or-nothing falls out for free when denial happens to cover the whole graph.
- **Runtime failure: denied nodes throw when reached.** Rejected: paths die midway with
  half-applied side effects; gating means denied paths never start.

## Consequences

- Reachability analysis is now *enforcement*, not advice — a table-write node reachable through a
  path the analysis misses is a security hole. The derivation must live in `shared/` validation
  with tests, shared by Studio's export preview and main-process import.
- Denial state is just more gate state, stored and scoped like activation (per world, ADR 0005).
- Degraded-but-useful packs are a supported pattern; creators can design read and write halves as
  separate sub-paths knowing denial severs them cleanly.
