// src/shared/thRuntime/presetShape.ts
//
// Pure mappers between the Host's normalized preset view (`HostPresetView`) and TavernHelper's
// `getPreset('in_use')` shape. Living in the SHARED runtime means BOTH transports (inline + WCV)
// inherit identical behavior — a transport only supplies the data (via `host.preset()`), never the
// mapping. Clean-room: the target shape is reconstructed from the first-party TavernHelper docs
// (`tavernhelper-docs-spec-2026-07-17.md` §7 — docs-confirmed), not from JSR source.
import type { HostPresetPrompt, HostPresetView } from './hostPrimitives'

/** One prompt in the TavernHelper-facing `getPreset` shape. */
export type ThPresetPrompt = HostPresetPrompt

/**
 * The TavernHelper `Preset` shape a card gets from `getPreset('in_use')` (docs-confirmed spec §7):
 * `settings` (sampler/generation params), `prompts` (the active/defined prompt list with ids, roles,
 * positions, enabled states — the control surface a card toggles), `prompts_unused` (defined-but-unused),
 * and `extensions` (extra binding data). The legacy `{ name, parameters }` fields cards already read are
 * ALSO kept on the object so nothing that read `getPreset().name`/`.parameters` regresses.
 */
export interface ThPresetView {
  name: string
  /** TH `settings` — the sampler/generation parameters. */
  settings: Record<string, unknown>
  /** Legacy alias RPT cards already read (identical value to `settings`). */
  parameters: Record<string, unknown>
  prompts: ThPresetPrompt[]
  prompts_unused: ThPresetPrompt[]
  extensions: Record<string, unknown>
}

/**
 * Map the Host's normalized preset view into the TavernHelper `getPreset` shape. Returns null when no
 * preset is active. The prompts are FRESH objects (a card mutating `prompt.enabled` then calling
 * `replacePreset` never corrupts the runtime's own state — the write path re-reads the base view).
 */
export function mapPresetToThShape(view: HostPresetView | null): ThPresetView | null {
  if (!view) return null
  const cloneP = (p: HostPresetPrompt): ThPresetPrompt => ({ ...p })
  return {
    name: view.name,
    settings: { ...view.parameters },
    parameters: { ...view.parameters },
    prompts: (view.prompts || []).map(cloneP),
    prompts_unused: (view.prompts_unused || []).map(cloneP),
    extensions: { ...view.extensions }
  }
}

/** A prompt entry as it comes back from a card's mutated `getPreset` object (fields all optional/loose). */
type IncomingPrompt = {
  id?: unknown
  identifier?: unknown
  enabled?: unknown
  role?: unknown
  content?: unknown
  name?: unknown
  marker?: unknown
  injection_depth?: unknown
  injection_order?: unknown
}

const promptId = (p: IncomingPrompt): string | null => {
  const id = typeof p?.identifier === 'string' ? p.identifier : typeof p?.id === 'string' ? p.id : null
  return id && id.length ? id : null
}

/**
 * Merge a card's mutated preset object back onto the current normalized view, producing a FULL normalized
 * preset the transport can persist (`host.savePreset`). This is the parity-preserving write path: it
 * starts from `base` (so a card that toggled one prompt never drops the rest), matches incoming prompts to
 * base prompts by identifier, and applies ONLY the card-editable fields (`enabled`, `role`, `content`,
 * `name`, `marker`, `injection_depth`, `injection_order`). `name`/`parameters` are overlaid from the
 * incoming object when present. Prompts the incoming object omits keep their base values; a base prompt not
 * in the incoming list survives unchanged. Unknown incoming prompts (no matching base id) are ignored — a
 * card cannot invent prompts through this seam.
 *
 * The returned shape is a plain object mirroring the normalized `Preset` (`{ name, parameters, prompts }`);
 * the transport is responsible for schema-validating it before writing (main uses `PresetSchema.parse`).
 */
export function mergePresetView(
  base: HostPresetView,
  incoming: unknown
): {
  name: string
  parameters: Record<string, unknown>
  prompts: Array<HostPresetPrompt>
} {
  const inc = (incoming && typeof incoming === 'object' ? incoming : {}) as {
    name?: unknown
    settings?: unknown
    parameters?: unknown
    prompts?: unknown
  }
  const incParams =
    inc.settings && typeof inc.settings === 'object'
      ? (inc.settings as Record<string, unknown>)
      : inc.parameters && typeof inc.parameters === 'object'
        ? (inc.parameters as Record<string, unknown>)
        : null

  const incById = new Map<string, IncomingPrompt>()
  if (Array.isArray(inc.prompts)) {
    for (const p of inc.prompts as IncomingPrompt[]) {
      const id = promptId(p)
      if (id && !incById.has(id)) incById.set(id, p)
    }
  }

  const prompts: HostPresetPrompt[] = (base.prompts || []).map((b) => {
    const p = incById.get(b.identifier)
    if (!p) return { ...b }
    return {
      ...b,
      enabled: typeof p.enabled === 'boolean' ? p.enabled : b.enabled,
      role:
        p.role === 'system' || p.role === 'user' || p.role === 'assistant' ? p.role : b.role,
      content: typeof p.content === 'string' ? p.content : b.content,
      name: typeof p.name === 'string' ? p.name : b.name,
      marker: typeof p.marker === 'string' ? p.marker : b.marker,
      injection_depth:
        p.injection_depth === null || typeof p.injection_depth === 'number'
          ? (p.injection_depth as number | null)
          : b.injection_depth,
      injection_order:
        typeof p.injection_order === 'number' ? p.injection_order : b.injection_order
    }
  })

  return {
    name: typeof inc.name === 'string' && inc.name ? inc.name : base.name,
    parameters: { ...base.parameters, ...(incParams || {}) },
    prompts
  }
}
