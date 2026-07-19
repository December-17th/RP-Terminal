/**
 * The shape gate for a bundled Agent preset envelope (ADR 0021 §5).
 *
 * SHARED deliberately. The envelope is opaque at the contract layer, so `parseAgentDefinition`
 * accepts any object — which let the Agent editor save a bundle like `{preset: {}}` that the
 * main-side parser then rejects at runtime, degrading the Agent to plain rendering forever with
 * nothing in the UI to say so. The editor must refuse that at save time, and the only way for the
 * editor's check and the runtime's parse to stay honest is to share ONE definition of
 * "can this envelope produce a preset". This module is it: `presetService.presetFromEnvelope`
 * unwraps through `agentPresetRoot`, and the renderer's `validateDraft` gates on
 * `inspectAgentPresetEnvelope`.
 *
 * Pure and dependency-free so both processes can import it (`shared/*` may not reach main/renderer).
 */

/**
 * Select the single `prompt_order` list ST's Prompt Manager would resolve against.
 * `prompt_order` is an array of `{ character_id, order: [{ identifier, enabled }] }`;
 * ST resolves order via the dummy character id 100001, so prefer that record, else
 * the first entry that carries an `order` array, else the first entry outright.
 *
 * Returns that entry's `order` array (possibly empty), or `null` when there is no
 * usable `prompt_order` at all (caller then falls back to the raw `prompts` order).
 *
 * SHARED so `parseStPreset`, `computePresetInventory` and the editor's envelope gate all resolve
 * against the exact same list — the four MUST NOT drift (a first-seen union across every list
 * reports wrong enabled counts on dual-order-list presets). `stPresetParser` re-exports this.
 */
export const selectPromptOrder = (
  raw: any
): Array<{ identifier: string; enabled?: boolean }> | null => {
  if (!Array.isArray(raw?.prompt_order)) return null
  const block =
    raw.prompt_order.find((o: any) => o?.character_id === 100001 && Array.isArray(o?.order)) ||
    raw.prompt_order.find((o: any) => Array.isArray(o?.order)) ||
    raw.prompt_order[0]
  return block && Array.isArray(block.order) ? block.order : null
}

/**
 * Unwrap an envelope to the object a preset parser would actually read, most specific first:
 *   1. `importedView` — the normalized snapshot written at import (ADR 0018);
 *   2. `parsed` — the nothing-dropped raw JSON (the usual case);
 *   3. the value itself — a bare ST or native preset with no envelope wrapper.
 * Then unwraps the top-level-array-wrapping-a-preset shape seen in the wild.
 */
export const agentPresetRoot = (envelope: unknown): Record<string, any> | null => {
  if (!envelope || typeof envelope !== 'object') return null
  const wrapper = envelope as Record<string, any>
  const candidate =
    wrapper.importedView && typeof wrapper.importedView === 'object'
      ? wrapper.importedView
      : wrapper.parsed !== undefined
        ? wrapper.parsed
        : envelope
  const root = Array.isArray(candidate)
    ? candidate.find((entry) => entry && typeof entry === 'object')
    : candidate
  return root && typeof root === 'object' && !Array.isArray(root)
    ? (root as Record<string, any>)
    : null
}

export type AgentPresetEnvelopeProblem = 'not-an-object' | 'no-prompts' | 'no-usable-prompts'

export interface AgentPresetEnvelopeInspection {
  usable: boolean
  problem?: AgentPresetEnvelopeProblem
}

/**
 * Can this envelope produce a preset with at least one prompt block?
 *
 * Mirrors what `parseStPreset` actually requires: a `prompts` ARRAY (its hard precondition), and at
 * least one identifier reachable — either from a prompt object or from `prompt_order`, because an
 * order entry yields a block even with no matching prompt object. An envelope failing this is
 * guaranteed inert at runtime, which is exactly what the editor must refuse to save.
 */
export const inspectAgentPresetEnvelope = (envelope: unknown): AgentPresetEnvelopeInspection => {
  const root = agentPresetRoot(envelope)
  if (!root) return { usable: false, problem: 'not-an-object' }
  if (!Array.isArray(root.prompts)) return { usable: false, problem: 'no-prompts' }
  const identifiable = (entry: unknown): boolean =>
    !!entry &&
    typeof entry === 'object' &&
    typeof (entry as { identifier?: unknown }).identifier === 'string' &&
    (entry as { identifier: string }).identifier.trim().length > 0
  const fromPrompts = root.prompts.some(identifiable)
  const fromOrder = (selectPromptOrder(root) ?? []).some(identifiable)
  return fromPrompts || fromOrder ? { usable: true } : { usable: false, problem: 'no-usable-prompts' }
}
