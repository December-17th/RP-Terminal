// Override → fragment-doc MATERIALIZATION (agent-packs plan WP3.2 — the keystone that makes settings
// real). Given a pack's fragment + a resolved { settingId → value } override map, produce a COPY of
// the fragment with every override applied to the node config / trigger param it targets. This is the
// missing half the WP1.4 store notes and WP2.4's flagship both flagged: the store persists + resolves
// overrides, but nothing fed them into the doc — so the flagship's backlog N + watched table were
// FIXED constants. This module closes that loop.
//
// Decisions: ADR 0005 (scope-layered overrides — resolveOverrides is the input map), rev-3 spec
// §Exposed Settings ("the effective workflow is materialized by applying overrides to the base pack at
// run time"; the override boundary rule). Pure over its inputs (no I/O), so it is unit-tested directly
// and BOTH call sites (the turn path via enabledFragmentsFor, the headless path via
// evaluateTriggers/runHeadless) route through the SAME function — settings cannot silently work in one
// path and not the other.
//
// ── TWO kinds of setting, ONE override map ─────────────────────────────────────────────────────────
//  1. CREATOR-EXPOSED settings (manifest.exposedSettings). Keyed by the creator's stable id; each
//     names a target { nodeId, path } into that node's `config`. Materialize writes the resolved value
//     there (bracket-aware set under config).
//  2. AUTO-DERIVED System trigger params. No manifest entry — every trigger attachment yields settings
//     keyed by a STABLE convention (see SYS_TRIGGER_* below). Materialize writes resolved values back
//     into the attachments-array copy (a state trigger's comparison `value`, a cadence's
//     `everyNFloors`, and — for a table-scoped state trigger — the watched `table`).
//
// UNKNOWN targets (a node/path that isn't in the fragment, an attachment index past the end) → LOG +
// SKIP, never throw (a stale override from an upgraded pack must degrade to the fragment default, not
// crash a turn). Type mismatches (a string override on a numeric setting) → skip + log. Numbers clamp
// to [min, max] when the setting pins them.

import { WorkflowDoc, NodeInstance } from '../../shared/workflow/types'
import { AttachmentDecl, TriggerAttachment } from '../../shared/workflow/attachments'
import { setPath, getPath } from '../../shared/objectPath'
import { ExposedSetting } from './agentPackStore'
import { log } from './logService'

// ── Auto-derived System trigger-param id convention (the STABLE override key) ─────────────────────
//
// Every trigger attachment auto-exposes settings keyed by its INDEX in the fragment's attachments
// array. The id convention (documented contract — it is the override key):
//
//   sys.trigger.<index>.value    the comparison value (state trigger) OR everyNFloors (cadence trigger)
//   sys.trigger.<index>.table    the watched sqlName (state trigger whose source scope is 'table' ONLY)
//
// `<index>` is the attachment's position in `doc.attachments` (INCLUDING entry/rejoin attachments — it
// is the raw array index, so the key is unambiguous). A manual trigger exposes NOTHING (no parameters).
//
// STABILITY CAVEAT (surfaced in the WP report): the index is stable ONLY as long as the fragment's
// attachment ORDER is stable across pack upgrades. A creator who reorders attachments in v2 re-points
// these ids — unlike a creator-exposed setting, whose id the creator controls explicitly. For the two
// builtin packs the trigger is the LAST attachment and the order is fixed, so the ids are stable in
// practice; a future ABI could switch to a creator-assigned trigger id if reordering becomes common.

/** Build the `sys.trigger.<index>.<field>` override key. `field` is 'value' or 'table'. */
export const sysTriggerKey = (index: number, field: 'value' | 'table'): string =>
  `sys.trigger.${index}.${field}`

/** A trigger param auto-exposed as a System setting (WP3.2). Purely derived from a trigger
 *  attachment — no manifest entry. `id` is the stable override key; `kind` tells the renderer which
 *  System-group control to draw. `defaultValue` is the fragment's own current value (so a control
 *  with no override shows the built-in default). */
export interface SystemSetting {
  id: string
  /** The attachment index this came from (renderer grouping / ordering). */
  triggerIndex: number
  /** 'trigger-value' = a state comparison value or a cadence everyNFloors (numeric or primitive);
   *  'trigger-table' = the watched sqlName of a table-scoped state trigger (string). */
  kind: 'trigger-value' | 'trigger-table'
  /** For a state trigger's value: 'number' | 'string' | 'boolean' from the literal's runtime type;
   *  for cadence: 'number'; for a table binding: 'string'. Drives the control type. */
  valueType: 'number' | 'string' | 'boolean'
  defaultValue: unknown
  /** A short label token the trigger describes itself with (e.g. 'backlog', 'every-n-floors',
   *  'watched-table') — the renderer maps it to a localized label. Never user-facing text here. */
  labelKind: 'trigger-value' | 'trigger-cadence' | 'trigger-table'
}

/** Narrow an attachment to a trigger (keeps the index alignment intact for the caller). */
const asTrigger = (att: AttachmentDecl): TriggerAttachment | null =>
  att.kind === 'trigger' ? att : null

/** Derive the auto-exposed System trigger-param settings for a fragment (WP3.2). One per trigger
 *  attachment's tunable field: the comparison value / everyNFloors (always), plus the watched table
 *  for a table-scoped state trigger. Manual triggers expose nothing. Indexes are raw attachment-array
 *  indexes (see the id-convention note above). Pure. */
export const deriveSystemSettings = (doc: WorkflowDoc): SystemSetting[] => {
  const atts = doc.attachments ?? []
  const out: SystemSetting[] = []
  atts.forEach((att, index) => {
    const trig = asTrigger(att)
    if (!trig) return
    if (trig.trigger === 'manual') return
    if (trig.trigger === 'cadence') {
      out.push({
        id: sysTriggerKey(index, 'value'),
        triggerIndex: index,
        kind: 'trigger-value',
        valueType: 'number',
        defaultValue: trig.everyNFloors,
        labelKind: 'trigger-cadence'
      })
      return
    }
    // state trigger: the comparison value (always) + the watched table (table scope only).
    const vt: SystemSetting['valueType'] =
      typeof trig.value === 'number' ? 'number' : typeof trig.value === 'boolean' ? 'boolean' : 'string'
    out.push({
      id: sysTriggerKey(index, 'value'),
      triggerIndex: index,
      kind: 'trigger-value',
      valueType: vt,
      defaultValue: trig.value,
      labelKind: 'trigger-value'
    })
    if (trig.source.scope === 'table') {
      out.push({
        id: sysTriggerKey(index, 'table'),
        triggerIndex: index,
        kind: 'trigger-table',
        valueType: 'string',
        defaultValue: trig.source.table,
        labelKind: 'trigger-table'
      })
    }
  })
  return out
}

// ── Value coercion / validation (shared by both setting kinds) ─────────────────────────────────────

/** Coerce+validate an override value against an expected runtime type, clamping numbers to [min,max]
 *  when given. Returns { ok:false } (skip + caller logs) on a type mismatch. A number override arriving
 *  as a numeric string is NOT silently coerced — the override store round-trips JSON, so a number is a
 *  number; a string is a string. Keeps the honesty rule tight (only apply what genuinely type-checks). */
const coerceValue = (
  value: unknown,
  expected: 'number' | 'string' | 'boolean',
  bounds?: { min?: number; max?: number }
): { ok: true; value: unknown } | { ok: false; reason: string } => {
  if (expected === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value))
      return { ok: false, reason: `expected number, got ${typeof value}` }
    let v = value
    if (bounds?.min != null && v < bounds.min) v = bounds.min
    if (bounds?.max != null && v > bounds.max) v = bounds.max
    return { ok: true, value: v }
  }
  if (expected === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, reason: `expected boolean, got ${typeof value}` }
    return { ok: true, value }
  }
  // string
  if (typeof value !== 'string') return { ok: false, reason: `expected string, got ${typeof value}` }
  return { ok: true, value }
}

/** The runtime type an exposed setting's control produces (enum values are strings). */
const exposedValueType = (s: ExposedSetting): 'number' | 'string' | 'boolean' =>
  s.type === 'number' ? 'number' : s.type === 'boolean' ? 'boolean' : 'string'

// ── Materialization ────────────────────────────────────────────────────────────────────────────────

/** Apply a resolved override map to a pack's fragment, returning a COPY with the overrides written to
 *  their target node config / trigger params (agent-packs plan WP3.2). Deep-clones first so the stored
 *  fragment is never mutated. With an EMPTY override map (or overrides matching no setting) the result
 *  deep-equals the input fragment — the zero-change guarantee the WP asserts.
 *
 *  @param pack   the pack — its `manifest.exposedSettings` drive creator settings; its `fragment` is copied.
 *  @param overrides  the resolved { settingId → value } map (agentPackService.resolveOverrides output).
 *
 *  Failure policy: an override whose target node/path is absent, whose attachment index is out of range,
 *  or whose value fails the setting's type check is LOGGED + SKIPPED (never thrown) — a stale override
 *  degrades to the fragment default. */
export const materializeFragment = (
  pack: { id: string; manifest: { exposedSettings?: ExposedSetting[] }; fragment: WorkflowDoc },
  overrides: Record<string, unknown>
): WorkflowDoc => {
  // Nothing to apply — return a clone anyway so callers can treat the result uniformly (still
  // deep-equal to the source; the zero-change test asserts this).
  const doc: WorkflowDoc = structuredClone(pack.fragment)
  if (!overrides || Object.keys(overrides).length === 0) return doc

  const nodeById = new Map<string, NodeInstance>(doc.nodes.map((n) => [n.id, n]))
  const exposed = pack.manifest.exposedSettings ?? []

  // ── (1) Creator-exposed settings → target node config ─────────────────────────────────────────────
  for (const setting of exposed) {
    if (!(setting.id in overrides)) continue // no override for this setting — keep the fragment default
    const raw = overrides[setting.id]
    const node = nodeById.get(setting.target.nodeId)
    if (!node) {
      log('info', `materialize ${pack.id}: setting "${setting.id}" targets unknown node "${setting.target.nodeId}" — skipping`)
      continue
    }
    // enum: the value must be one of the declared options (else skip — a stale enum value).
    if (setting.type === 'enum') {
      if (typeof raw !== 'string' || !(setting.options ?? []).includes(raw)) {
        log('info', `materialize ${pack.id}: setting "${setting.id}" value ${JSON.stringify(raw)} not in options — skipping`)
        continue
      }
    } else {
      const coerced = coerceValue(raw, exposedValueType(setting), { min: setting.min, max: setting.max })
      if (!coerced.ok) {
        log('info', `materialize ${pack.id}: setting "${setting.id}" ${coerced.reason} — skipping`)
        continue
      }
    }
    const value =
      setting.type === 'number'
        ? (coerceValue(raw, 'number', { min: setting.min, max: setting.max }) as { value: number }).value
        : raw
    if (!node.config) node.config = {}
    // The target path is RELATIVE to the node's config object (e.g. `every` → config.every, or a
    // nested `a.b[0]` → config.a.b[0]). setPath is the shared bracket-aware setter (objectPath.ts).
    setPath(node.config, setting.target.path, value)
  }

  // ── (2) Auto-derived System trigger params → attachments copy ─────────────────────────────────────
  const atts: AttachmentDecl[] = doc.attachments ?? []
  atts.forEach((att, index) => {
    if (att.kind !== 'trigger' || att.trigger === 'manual') return
    const valueKey = sysTriggerKey(index, 'value')
    if (valueKey in overrides) {
      const raw = overrides[valueKey]
      if (att.trigger === 'cadence') {
        const coerced = coerceValue(raw, 'number', { min: 1 }) // cadence N ≥ 1 (attachments.ts grammar)
        if (coerced.ok) att.everyNFloors = coerced.value as number
        else log('info', `materialize ${pack.id}: "${valueKey}" ${coerced.reason} — skipping`)
      } else {
        // state trigger comparison value: match the literal's runtime type (numeric ops need a number).
        const vt = typeof att.value === 'number' ? 'number' : typeof att.value === 'boolean' ? 'boolean' : 'string'
        const coerced = coerceValue(raw, vt)
        if (coerced.ok) att.value = coerced.value as number | string | boolean
        else log('info', `materialize ${pack.id}: "${valueKey}" ${coerced.reason} — skipping`)
      }
    }
    // The watched table binding (table-scoped state trigger only).
    if (att.kind === 'trigger' && att.trigger === 'state' && att.source.scope === 'table') {
      const tableKey = sysTriggerKey(index, 'table')
      if (tableKey in overrides) {
        const coerced = coerceValue(overrides[tableKey], 'string')
        if (coerced.ok) att.source = { ...att.source, table: coerced.value as string }
        else log('info', `materialize ${pack.id}: "${tableKey}" ${coerced.reason} — skipping`)
      }
    }
  })
  if (doc.attachments) doc.attachments = atts

  return doc
}

/** Convenience read used by tests / potential callers: does a path exist under a node's config? (Kept
 *  small; getPath is the shared bracket-aware reader.) */
export const readNodeConfigPath = (doc: WorkflowDoc, nodeId: string, path: string): unknown => {
  const node = doc.nodes.find((n) => n.id === nodeId)
  return node?.config ? getPath(node.config, path) : undefined
}
