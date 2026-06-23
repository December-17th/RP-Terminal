/**
 * Artifact scope model — shared by BOTH processes (main services resolve it; renderer
 * stores/panels display + set it). Pure (no node/electron), so it lives in src/shared.
 *
 * A scoped artifact (regex script, card script, …) is active for a turn when its scope
 * matches the active context: global (always) ⊕ world(owner === active card) ⊕
 * session(owner === active chat). See docs/world-card-design.md §6.
 */

import type { CardRenderMode } from './cardRenderMode'

export type ArtifactScope = 'global' | 'world' | 'session'

export interface ScopeContext {
  cardId?: string | null
  chatId?: string | null
}

export interface ScopeMeta {
  scope: ArtifactScope
  owner?: string
  /** Per-artifact enable toggle; a disabled artifact never contributes at runtime. */
  disabled?: boolean
  /** Per-card render-mode override; absent = follow the global default. */
  renderMode?: CardRenderMode
}

/** Pure scope predicate. */
export const isScopeActive = (meta: ScopeMeta | undefined, ctx: ScopeContext): boolean => {
  const scope = meta?.scope ?? 'global'
  if (scope === 'world') return !!ctx.cardId && meta?.owner === ctx.cardId
  if (scope === 'session') return !!ctx.chatId && meta?.owner === ctx.chatId
  return true // global (and any unknown) is always active
}
