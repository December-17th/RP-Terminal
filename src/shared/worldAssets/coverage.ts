import { AssetCategoryIndex, AssetType } from './types'

export interface CharacterCoverage {
  name: string
  hasAvatar: boolean // 头像 base present
  hasStandee: boolean // 立绘 base present
  hasStandeeBg: boolean // 立绘bg base present
  hasGallery: boolean // 相册 base or any slot present
  galleryCount: number // 相册 files = base (0/1) + slot variants
  moodVariants: number // total mood variant files across 头像 + 立绘 + 立绘bg
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
      const gallery = entry?.['相册']
      const galleryCount = moodCount(gallery) + (gallery?.base ? 1 : 0)
      return {
        name,
        hasAvatar: !!entry?.['头像']?.base,
        hasStandee: !!entry?.['立绘']?.base,
        hasStandeeBg: !!entry?.['立绘bg']?.base,
        hasGallery: galleryCount > 0,
        galleryCount,
        moodVariants:
          moodCount(entry?.['头像']) + moodCount(entry?.['立绘']) + moodCount(entry?.['立绘bg']),
        inRoster: roster.has(name)
      }
    })
}

/** One name's per-type coverage: does the type have a base file, and how many variants. */
export interface NameTypeCoverage {
  hasBase: boolean
  variants: number
}
export interface NameRow {
  name: string
  types: Partial<Record<AssetType, NameTypeCoverage>>
}

/** Generic, roster-free rollup of a single category index into per-name rows (name-sorted).
 *  Each row carries only the types that name actually has. Used by the location/CG grids where
 *  there is no roster concept — {@link computeCoverage} stays the character-specific view. */
export function nameRows(index: AssetCategoryIndex | undefined): NameRow[] {
  const idx = index ?? {}
  return Object.keys(idx)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const entry = idx[name] ?? {}
      const types: NameRow['types'] = {}
      for (const type of Object.keys(entry) as AssetType[]) {
        const te = entry[type]
        if (!te) continue
        types[type] = { hasBase: !!te.base, variants: Object.keys(te.moods).length }
      }
      return { name, types }
    })
}
