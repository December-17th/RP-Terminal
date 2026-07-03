// Pure display-derivation for the Agents pack DETAIL panel's settings (agent-packs plan WP3.2).
// Side-effect-free + React-free so it is unit-testable directly under Node (test/agentPackSettingsDisplay
// .test.ts) — the detail panel (AgentPackDetail.tsx) renders these shapes, adding only DOM + t().
//
// What lives here (the pieces the WP asks be extracted + tested):
//   · label resolution for a setting (per-locale map | plain string | a System labelKind token).
//   · provenance → chip token (which i18n key the "default / this world / this chat" chip uses).
//   · the reset target: which scope a reset-to-default clears (the NEAREST override scope), and what
//     the value falls back to afterward (the next scope down — "clearing chat reveals world").
//
// Grounding: agentPackService.PackSettingView / ResolvedOverride (the IPC payload shape, mirrored in
// preload index.d.ts), ADR 0005 (scope tiers global<world<chat), rev-3 §Exposed Settings.

/** The IPC payload shape for one setting (mirrors agentPackService.PackSettingView). Redeclared here
 *  (not imported from main) so this pure module stays renderer-only + node-testable. */
export interface PackSettingView {
  id: string
  kind: 'pack' | 'system'
  label?: string | Record<string, string>
  labelKind?: 'trigger-value' | 'trigger-cadence' | 'trigger-table'
  type: 'number' | 'string' | 'boolean' | 'enum'
  default: unknown
  min?: number
  max?: number
  options?: string[]
  resolved: {
    value: unknown
    provenance: 'default' | 'global' | 'world' | 'chat'
    globalValue?: unknown
    worldValue?: unknown
    chatValue?: unknown
  }
}

/** The scope a write/reset targets. `world` is the subtle default; `chat` is the per-chat exception. */
export type WriteScope = 'world' | 'chat'

// ── Label resolution ────────────────────────────────────────────────────────────────────────────────

/** Resolve a creator setting's display label for `locale`. A per-locale map picks the locale, falling
 *  back to `en`, then any value; a plain string is used as-is; a missing label yields the setting id
 *  (a last-resort so the control is never nameless). Pure. */
export function resolveSettingLabel(
  label: string | Record<string, string> | undefined,
  locale: string,
  fallbackId: string
): string {
  if (label == null) return fallbackId
  if (typeof label === 'string') return label
  return label[locale] ?? label.en ?? Object.values(label)[0] ?? fallbackId
}

/** The i18n key a System setting's label maps to (System params carry a labelKind token, never text).
 *  The renderer looks this key up via t(). */
export function systemLabelKey(labelKind: PackSettingView['labelKind']): string {
  switch (labelKind) {
    case 'trigger-cadence':
      return 'agents.settings.sys.cadence'
    case 'trigger-table':
      return 'agents.settings.sys.watchedTable'
    case 'trigger-value':
    default:
      return 'agents.settings.sys.triggerValue'
  }
}

// ── Provenance chip ───────────────────────────────────────────────────────────────────────────────

/** The i18n key for a resolved value's provenance chip: default / global / this world / this chat.
 *  (ADR 0005 tiers — the chip mirrors which scope won.) */
export function provenanceChipKey(provenance: PackSettingView['resolved']['provenance']): string {
  switch (provenance) {
    case 'chat':
      return 'agents.settings.prov.chat'
    case 'world':
      return 'agents.settings.prov.world'
    case 'global':
      return 'agents.settings.prov.global'
    case 'default':
    default:
      return 'agents.settings.prov.default'
  }
}

/** Whether a reset-to-default control should be shown: only when an override actually applies (i.e.
 *  provenance is not 'default'). Resetting a defaulted setting is a no-op, so the control hides. */
export function canReset(setting: PackSettingView): boolean {
  return setting.resolved.provenance !== 'default'
}

// ── Reset planning (clearing the nearest scope reveals the next one down) ───────────────────────────

/** Which scope a reset-to-default clears — the NEAREST override scope in effect (chat > world >
 *  global). Returns null when the setting is already at its default (nothing to clear). This is the
 *  scope passed to clearAgentPackOverride. */
export function nearestOverrideScope(
  setting: PackSettingView
): 'chat' | 'world' | 'global' | null {
  const p = setting.resolved.provenance
  return p === 'default' ? null : p
}

/** After clearing the nearest scope, what value + provenance the setting would resolve to (the next
 *  scope down; ultimately the schema default). Pure preview for a "clearing chat reveals world" hint —
 *  the renderer refetches the real state after the clear, but this drives the confirm copy. */
export function valueAfterReset(setting: PackSettingView): {
  value: unknown
  provenance: PackSettingView['resolved']['provenance']
} {
  const r = setting.resolved
  // Drop the current nearest scope, then resolve nearest-wins over the remaining scopes.
  if (r.provenance === 'chat') {
    if (r.worldValue !== undefined) return { value: r.worldValue, provenance: 'world' }
    if (r.globalValue !== undefined) return { value: r.globalValue, provenance: 'global' }
    return { value: setting.default, provenance: 'default' }
  }
  if (r.provenance === 'world') {
    if (r.globalValue !== undefined) return { value: r.globalValue, provenance: 'global' }
    return { value: setting.default, provenance: 'default' }
  }
  // clearing global (or already default) → the schema default
  return { value: setting.default, provenance: 'default' }
}

/** Whether a setting has any control-usable state (guards a defensive render). A boolean/number/string/
 *  enum always does; this is here mainly as the single place a future disabled-state check would live. */
export function settingIsRenderable(setting: PackSettingView): boolean {
  return (
    setting.type === 'number' ||
    setting.type === 'string' ||
    setting.type === 'boolean' ||
    setting.type === 'enum'
  )
}
