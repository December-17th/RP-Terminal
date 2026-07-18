/** Script-library types shared by the main script service and the renderer store/panel. */
import type { ArtifactScope } from './artifactScope'

export interface StoredScript {
  name: string
  code: string
  /**
   * The upstream Tavern-Helper script `id` (docs-confirmed `Script.id`, tavernhelper-docs-spec §1),
   * preserved verbatim on import so the script keeps its stable identity (issue 03 previously discarded
   * it, so every imported script got a fresh random file id and lost cross-turn correlation). Absent for
   * scripts authored natively in RPT. It is the sort key for runtime execution order (see
   * `getActiveScripts`) and the identity a pre-dispatch mutation attributes to (`RecordSource.id`).
   */
  id?: string
}

export interface ScriptInfo extends StoredScript {
  file: string
  scope: ArtifactScope
  owner?: string
  disabled: boolean
  /** Remote hosts this script imports from (for the grant prompt + CSP). */
  remoteHosts: string[]
  /**
   * This script loads executable code from the network at runtime (remote ES module / `<script src>` /
   * `importScripts` / fetch of a remote `.js`). Per ADR 0017 it stays INERT unless the owning preset has
   * the per-preset high-trust opt-in, and even then runs ONLY in the isolated WCV realm. Surfaced so the
   * scripts panel + import inventory can show it.
   */
  remoteCode?: boolean
  /**
   * High-trust remote-code script (ADR 0017): a remote-code script installed to RUN because its owning
   * preset opted into high trust. It is pinned to the isolated WCV realm — the inline transport never
   * loads it (`getActiveScripts` excludes it unless the ctx marks the realm as isolated). Absent/false =
   * a normal script.
   */
  highTrust?: boolean
}

/**
 * Why a runtime script is allowed to execute in the isolated WCV.
 *
 * Card/world-owned code is the only class controlled by the per-card trust decision. Ordinary
 * library and preset scripts were authorized when the user installed/imported them; remote-code
 * preset scripts require the separate per-preset high-trust grant.
 */
export type RuntimeScriptAuthorization = 'card-trust' | 'import-trust' | 'preset-high-trust'

/** Pure source-to-authorization mapping shared by IPC assembly and regression tests. */
export const resolveRuntimeScriptAuthorization = (
  scope: ArtifactScope,
  highTrust = false
): RuntimeScriptAuthorization => {
  if (scope === 'preset' && highTrust) return 'preset-high-trust'
  if (scope === 'world') return 'card-trust'
  return 'import-trust'
}

export interface RuntimeScript extends StoredScript {
  authorization: RuntimeScriptAuthorization
}
