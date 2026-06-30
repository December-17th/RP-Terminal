// src/renderer/src/components/workspace/DuelCard.tsx
//
// TCG-style hand card for the native STS duel board (DuelView.tsx). Pure presentational: frame +
// rarity border/glow, cost orb, 70% face image (falls back to a type glyph) / 30% info strip. Token-
// driven (var(--rpt-duel-*)); see docs/superpowers/specs/2026-06-30-native-duelview-design.md.

import { FC } from 'react'

const RARITY_TOKEN: Record<string, string> = {
  普通: '--rpt-duel-rarity-common',
  优良: '--rpt-duel-rarity-uncommon',
  稀有: '--rpt-duel-rarity-rare',
  精良: '--rpt-duel-rarity-rare',
  史诗: '--rpt-duel-rarity-epic',
  传说: '--rpt-duel-rarity-legendary',
  神: '--rpt-duel-rarity-mythic'
}
const typeGlyph = (name: string, ext: { 威力?: number }): string =>
  name === '格挡' ? '🛡️' : ext.威力 != null ? '⚔️' : '✨'

export interface DuelCardProps {
  name: string
  品质?: string
  威力?: number
  关联属性?: string
  energyCost: number
  effect?: string
  faceUrl?: string
  picked: boolean
  disabled: boolean
  onClick: () => void
}

export const DuelCard: FC<DuelCardProps> = (p) => {
  const rarity = `var(${RARITY_TOKEN[p.品质 ?? '普通'] ?? '--rpt-duel-rarity-common'})`
  return (
    <button
      type="button"
      className={`rpt-duel-card${p.picked ? ' picked' : ''}`}
      style={{
        borderColor: rarity,
        boxShadow: `0 6px 16px rgba(0,0,0,.5), 0 0 12px color-mix(in srgb, ${rarity} 33%, transparent)`
      }}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      <span className="rpt-duel-card-cost">{p.energyCost}</span>
      <span
        className="rpt-duel-card-face"
        style={p.faceUrl ? { backgroundImage: `url("${p.faceUrl}")` } : undefined}
      >
        {!p.faceUrl && <span className="rpt-duel-card-glyph">{typeGlyph(p.name, p)}</span>}
      </span>
      <span className="rpt-duel-card-info">
        <span className="rpt-duel-card-name">{p.name}</span>
        <span className="rpt-duel-card-type" style={{ color: rarity }}>
          {p.品质 ?? '普通'}
          {p.关联属性 ? ` · ${p.关联属性}` : ''}
        </span>
        {(p.威力 != null || p.effect) && (
          <span className="rpt-duel-card-se">
            {p.威力 != null ? `威力 ${p.威力}` : ''}
            {p.effect ? `${p.威力 != null ? ' · ' : ''}${p.effect}` : ''}
          </span>
        )}
      </span>
    </button>
  )
}
