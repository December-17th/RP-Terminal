import { AssetCategory, AssetIndex, AssetType } from './types'
import { normalizeMood } from './mood'

export interface ResolveInput {
  indexes: AssetIndex[]
  category: AssetCategory
  name: string
  type: AssetType
  mood?: string
}
export interface ResolvedAsset {
  indexPos: number
  filename: string
  usedMood: string | null
}

export function resolveAsset(input: ResolveInput): ResolvedAsset | null {
  const { indexes, category, name, type, mood } = input
  for (let pos = 0; pos < indexes.length; pos++) {
    const entry = indexes[pos]?.[category]?.[name]?.[type]
    if (!entry) continue
    if (mood) {
      const want = normalizeMood(mood)
      for (const [key, filename] of Object.entries(entry.moods)) {
        if (normalizeMood(key) === want) return { indexPos: pos, filename, usedMood: key }
      }
    }
    if (entry.base) return { indexPos: pos, filename: entry.base, usedMood: null }
  }
  return null
}
