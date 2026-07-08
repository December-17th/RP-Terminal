// src/renderer/src/components/workspace/useDuelAssets.ts
//
// Resolve the duel's importable art (card faces / unit avatars / fight background) via the existing
// World Assets host API, async, keyed by id/name. Returns lookups; a missing asset → undefined (the
// caller falls back to a glyph/gradient). Renderer-only; reuses the same assetUrl path the assets
// workspace view uses (src/renderer/src/components/workspace/AssetsView.tsx).
//
// Face-key scheme: `face(abilityId)` is keyed by the card's full abilityId (e.g. "主角/火球术"), NOT
// the trailing display name — this matches CardInstance.abilityId in shared/combat/deckbuilder, so
// DuelCard (Task 3) can call `face(card.abilityId)` directly with no extra parsing on either side.
// The asset lookup itself still resolves by the trailing name (lorebook entries are keyed by the bare
// character/ability name, e.g. "火球术"), but that split happens inside this hook only.

import { useEffect, useState } from 'react'
import type { DuelState } from '../../../../shared/combat/deckbuilder'
import { lorebookIdsForWorld } from '../../stores/assetStore'
import { useCharacterStore } from '../../stores/characterStore'
import { useLorebookStore } from '../../stores/lorebookStore'

export interface DuelAssets {
  /** Resolve a card face (立绘) by the card's full abilityId, e.g. card.abilityId from DuelState.cards. */
  face: (abilityId: string) => string | undefined
  /** Resolve a unit avatar (头像) by combatant display name (Combatant.name). */
  avatar: (combatantName: string) => string | undefined
  /** Fight background (背景), v1 fixed scene name; undefined falls back to the gradient. */
  background: string | undefined
}

const api = (): typeof window.api => window.api

export const useDuelAssets = (profileId: string, state: DuelState | null): DuelAssets => {
  const activeCharacterId = useCharacterStore((s) => s.activeCharacter?.id ?? null)
  const sessionIds = useLorebookStore((s) => s.sessionIds)
  const [urls, setUrls] = useState<Record<string, string>>({})

  const combatantIdsKey = state ? state.combatants.map((c) => c.id).join(',') : ''
  const abilityIdsKey = state ? Object.values(state.cards).map((c) => c.abilityId).join(',') : ''

  useEffect(() => {
    if (!state) return
    const lorebookIds = lorebookIdsForWorld(activeCharacterId, sessionIds)
    if (!lorebookIds.length) return
    let cancelled = false
    const want: Array<[string, 'character' | 'location', string, string]> = []
    // card faces: one per unique ability in the deck (立绘), keyed by full abilityId; resolved by
    // the trailing display name since asset entries live under the bare name.
    const abilityIds = new Set(Object.values(state.cards).map((c) => c.abilityId))
    for (const aid of abilityIds) {
      const name = aid.includes('/') ? aid.split('/').pop()! : aid
      want.push([`face:${aid}`, 'character', name, '立绘'])
    }
    // unit avatars (头像 by combatant name)
    for (const c of state.combatants) want.push([`ava:${c.name}`, 'character', c.name, '头像'])
    // fight background (背景). v1 key: a fixed '战斗' scene name; falls back to the gradient if absent.
    want.push(['bg', 'location', '战斗', '背景'])

    void Promise.all(
      want.map(async ([key, scope, name, type]) => {
        try {
          const u = await api().assetUrl(profileId, lorebookIds, scope, name, type)
          return u ? ([key, u] as const) : null
        } catch {
          return null
        }
      })
    ).then((pairs) => {
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const p of pairs) if (p) next[p[0]] = p[1]
      setUrls(next)
    })
    return () => {
      cancelled = true
    }
    // re-resolve when the duel identity changes (new mock/build), not every state tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, activeCharacterId, sessionIds, combatantIdsKey, abilityIdsKey])

  return {
    face: (abilityId) => urls[`face:${abilityId}`],
    avatar: (name) => urls[`ava:${name}`],
    background: urls['bg']
  }
}
