/**
 * Artifact scope model — shared by BOTH processes (main services resolve it; renderer
 * stores/panels display + set it). Pure (no node/electron), so it lives in src/shared.
 *
 * A scoped artifact (regex script, card script, …) is active for a turn when its scope
 * matches the active context: global (always) ⊕ world(owner === active card) ⊕
 * session(owner === active chat) ⊕ preset(owner === active preset). See
 * docs/world-card-design.md §6.
 */

import type { CardRenderMode } from './cardRenderMode'

export type ArtifactScope = 'global' | 'world' | 'session' | 'preset'

export interface ScopeContext {
  cardId?: string | null
  chatId?: string | null
  presetId?: string | null
  /**
   * The caller runs in the isolated card realm (WCV transport). ONLY set true by the WCV script
   * resolution — the inline transport (which shares the app renderer's process/DOM) leaves it unset.
   * A high-trust remote-code artifact (ADR 0017) is active ONLY when this is true, so remote-code
   * scripts can never run in the app renderer at any trust level.
   */
  isolatedRealm?: boolean
}

export interface ScopeMeta {
  scope: ArtifactScope
  owner?: string
  /** Per-artifact enable toggle; a disabled artifact never contributes at runtime. */
  disabled?: boolean
  /** Per-card render-mode override; absent = follow the global default. */
  renderMode?: CardRenderMode
  /**
   * High-trust remote-code artifact (ADR 0017): installed to RUN because its owning preset opted into
   * high trust, but pinned to the isolated WCV realm — active ONLY when `ScopeContext.isolatedRealm`.
   * Set by `setScriptHighTrust`. Absent/false = a normal artifact (active in either realm).
   */
  highTrust?: boolean
}

/** Pure scope predicate. */
export const isScopeActive = (meta: ScopeMeta | undefined, ctx: ScopeContext): boolean => {
  // A high-trust remote-code artifact is realm-gated (ADR 0017): it never runs in the app renderer,
  // only in the isolated WCV realm. This gate composes WITH the scope check below.
  if (meta?.highTrust && !ctx.isolatedRealm) return false
  const scope = meta?.scope ?? 'global'
  if (scope === 'world') return !!ctx.cardId && meta?.owner === ctx.cardId
  if (scope === 'session') return !!ctx.chatId && meta?.owner === ctx.chatId
  if (scope === 'preset') return !!ctx.presetId && meta?.owner === ctx.presetId
  return true // global (and any unknown) is always active
}
