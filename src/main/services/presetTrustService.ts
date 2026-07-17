/**
 * Per-preset high-trust opt-in (ADR 0017 / issue 19). Lives in its own module (not `presetService`) so
 * `presetService` stays free of a `pluginService` dependency — pluginService already reaches
 * chatService → characterService → presetService, and folding the grant read into presetService would
 * close that import cycle. This module sits ABOVE all three, so it composes them without a cycle.
 *
 * Importing a preset is the trust act for all non-remote content; a preset's REMOTE-CODE scripts are the
 * one exception — dropped INERT at import and made runnable only by this explicit opt-in, and even then
 * ONLY inside the isolated WCV realm (the high-trust script is realm-gated by `isScopeActive`).
 */
import * as pluginService from './pluginService'
import * as scriptService from './scriptService'
import { readEnvelope, collectPresetScripts } from './presetService'

/** Raw script source from a TH/native script object (`content` is TH's key; `code` is ours). */
const scriptSource = (s: unknown): string => {
  const o = (s ?? {}) as { content?: unknown; code?: unknown }
  return typeof o.content === 'string' ? o.content : typeof o.code === 'string' ? o.code : ''
}

/**
 * Grant key for a preset's high-trust opt-in. Presets aren't cards, but the per-card grant store
 * (`pluginService`) is a plain keyed JSON — a `preset:<id>` key gives per-preset trust its own home
 * without a new store, and can never collide with a real card id (a bare uuid).
 */
export const presetGrantKey = (presetId: string): string => `preset:${presetId}`

/** Whether a preset has the high-trust opt-in (its remote-code scripts are installed to run). */
export const isPresetHighTrust = (profileId: string, presetId: string): boolean =>
  pluginService.getGrants(profileId, presetGrantKey(presetId)).highTrust === true

/**
 * Set (or clear) a preset's high-trust opt-in.
 *
 * ON: record the grant (`highTrust` + `remoteScripts`, the latter for the isolated-realm network fetch +
 *   CSP allow-list — NEVER `trusted`, which would grant app-renderer/main/key reach) and INSTALL each
 *   remote-code script from the lossless envelope as a preset-scoped, high-trust script
 *   (`setScriptHighTrust`). A high-trust script is realm-gated by `isScopeActive`: the inline transport
 *   never resolves it; only the isolated WCV realm does. Idempotent (a fresh install replaces any prior
 *   high-trust scripts for this preset).
 * OFF: clear the grant and remove the installed high-trust scripts for this preset.
 *
 * Returns the number of high-trust scripts installed (ON) or removed (OFF). Requires the envelope (a
 * pre-envelope import has no raw to re-derive the remote-code scripts from → 0 installed).
 */
export const setPresetHighTrust = (profileId: string, presetId: string, on: boolean): number => {
  pluginService.setGrants(profileId, presetGrantKey(presetId), {
    highTrust: on || undefined,
    remoteScripts: on || undefined,
    decided: true
  })
  // Remove any high-trust scripts previously installed for this preset (both the OFF path and a clean
  // re-install ON go through here first, so ON stays idempotent).
  let removed = 0
  for (const s of scriptService.listScripts(profileId)) {
    if (s.highTrust && s.scope === 'preset' && s.owner === presetId) {
      scriptService.deleteScript(profileId, s.file)
      removed++
    }
  }
  if (!on) return removed

  const env = readEnvelope(profileId, presetId)
  if (!env) return 0
  let installed = 0
  for (const rawScript of collectPresetScripts(env.parsed)) {
    if (!scriptService.hasRemoteCodeLoad(scriptSource(rawScript))) continue // only remote-code ones
    const [s] = scriptService.normalizeImportedScripts(rawScript)
    if (!s) continue
    const file = scriptService.saveScript(
      profileId,
      { name: s.name, code: s.code, id: s.id },
      'preset',
      presetId
    )
    scriptService.setScriptHighTrust(profileId, file, true)
    if (!s.enabled) scriptService.setScriptDisabled(profileId, file, true)
    installed++
  }
  return installed
}
