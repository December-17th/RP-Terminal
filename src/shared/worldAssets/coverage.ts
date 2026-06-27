import { AssetCategoryIndex } from './types'

export interface CharacterCoverage {
  name: string
  hasAvatar: boolean // 头像 base present
  hasStandee: boolean // 立绘 base present
  moodVariants: number // total mood variant files across types
  inRoster: boolean
}

/** Names known to the live world: the 主角 + every 关系列表 key. Tolerant of missing fields. */
export function rosterFromStatData(statData: unknown): string[] {
  const names = new Set<string>()
  const sd = statData as Record<string, any> | undefined
  if (sd && typeof sd === 'object') {
    const hero = sd['主角']
    const heroName = hero && typeof hero === 'object' ? hero['姓名'] || hero['名称'] : undefined
    if (typeof heroName === 'string' && heroName.trim()) names.add(heroName.trim())
    const rel = sd['关系列表']
    if (rel && typeof rel === 'object') for (const k of Object.keys(rel)) names.add(k)
  }
  return [...names]
}

const moodCount = (e?: { moods: Record<string, string> }): number =>
  e ? Object.keys(e.moods).length : 0

/** Union of folder-discovered names and roster names → per-character coverage rows. */
export function computeCoverage(
  index: AssetCategoryIndex | undefined,
  rosterNames: string[]
): CharacterCoverage[] {
  const idx = index ?? {}
  const names = new Set<string>([...Object.keys(idx), ...rosterNames])
  const roster = new Set(rosterNames)
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const entry = idx[name]
      return {
        name,
        hasAvatar: !!entry?.['头像']?.base,
        hasStandee: !!entry?.['立绘']?.base,
        moodVariants: moodCount(entry?.['头像']) + moodCount(entry?.['立绘']),
        inRoster: roster.has(name)
      }
    })
}
