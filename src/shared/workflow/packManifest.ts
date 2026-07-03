// The agent-pack MANIFEST types — the pack-meta fields + the creator-exposed-settings schema.
//
// These were born in `src/main/services/agentPackStore.ts` (WP1.4/WP3.2), but the phase-4 pack
// ENVELOPE (packEnvelope.ts) has to serialize them, and the envelope is a SHARED artifact (its Zod
// schema must be import-time verifiable from Studio's export preview AND main's import — ADR 0007,
// rev-3 spec §Envelope). `shared/*` can't import from `main`, so the manifest TYPES move here (the
// clean cut) and `agentPackStore.ts` re-exports them for source compatibility. Nothing behavioral
// moved — these are plain data types that cross IPC as JSON.
//
// Pure: no imports; safe from main, renderer, preload, and tests (like ./attachments.ts).
//
// Note (phase 5/6): the rev-3 spec §Core Object sketches `version` as a semver STRING, but the pack
// RECORD in the store (and the fragment WorkflowDoc.version) is a NUMBER, and dedupe is by
// id + version (ADR 0008). The envelope carries the identity AS STORED (number) so no coercion is
// baked in here; if/when versions become semver strings that is a deliberate manifest-schema change.

/** A creator-exposed setting (agent-packs plan WP3.2; rev-3 spec §Exposed Settings). Each has a
 *  STABLE `id` — the override key that survives pack upgrades (the override boundary rule: anything
 *  with a stable manifest id is override territory, not fork territory). Materialization writes the
 *  resolved override value into `target.nodeId`'s config at `target.path` (a dot/bracket path
 *  RELATIVE to that node's `config` object — e.g. `every` → node.config.every). Shared-safe (crosses
 *  IPC as JSON): plain data, no functions.
 *
 *  `label` is a plain string OR a per-locale map (`{ en, zh }`) — the renderer picks the active
 *  locale (falling back to `en`, then any value). Numeric settings may pin `min`/`max` (materialize
 *  clamps); enum settings pin `options` (the allowed string values). */
export interface ExposedSetting {
  id: string
  label: string | Record<string, string>
  type: 'number' | 'string' | 'boolean' | 'enum'
  default: unknown
  min?: number
  max?: number
  /** enum only: the allowed string values (the select's options). */
  options?: string[]
  /** Where the resolved value lands: a node id in the fragment + a dot/bracket path INTO that node's
   *  `config` object (materialize wraps it as `config.<path>`). Unknown node/path → skip + log. */
  target: { nodeId: string; path: string }
}

/** Minimal v0 manifest (agent-packs plan WP1.4), extended in WP3.2 with `exposedSettings`. The
 *  list/settings read side + materialization consume it. */
export interface PackManifest {
  name: string
  description?: string
  creator?: string
  /** Creator-exposed settings (WP3.2). Each carries its own stable id, type, default, and target
   *  node/path; materialization applies resolved overrides to the fragment before it runs/composes.
   *  Absent/empty = the pack exposes no creator settings (its System trigger params are still
   *  auto-derived from its trigger attachments — see agentPackMaterialize.deriveSystemSettings). */
  exposedSettings?: ExposedSetting[]
  /** Fork provenance (ADR 0006; agent-packs plan WP3.6a). Present ONLY on fork entries. Stored in
   *  STRUCTURED, LOCALE-NEUTRAL form so the UI localizes the word "fork": `base` is the source's
   *  display name (or its own `fork.base` when forking a fork — the chain flattens to the root name),
   *  and `n` is the fork counter (1-based, per source). The renderer renders e.g. `${base} (${t('fork')} ${n})`
   *  so no English literal is baked into the stored name. `name` above is still populated (a sensible
   *  neutral default) but the UI prefers this structured form when present. */
  fork?: { base: string; n: number }
}
