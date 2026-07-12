import type { AssetIndex, AssetType } from './types'

export type SceneAssetType = Extract<AssetType, '背景' | '全景'>

export interface SceneAssetHit {
  status: 'hit'
  indexPos: number
  filename: string
  usedVariant: string | null
  match: 'exact-alias' | 'hierarchy' | 'suffix' | 'leaf'
  matchedSegments: number
}

export interface SceneAssetMiss {
  status: 'miss'
}

export interface SceneAssetAmbiguous {
  status: 'ambiguous'
  candidates: string[]
  matchedSegments: number
}

export type SceneAssetResolution = SceneAssetHit | SceneAssetMiss | SceneAssetAmbiguous

interface NormalizedLocation {
  value: string
  segments: string[]
}

interface Candidate {
  indexPos: number
  filename: string
  variant: string | null
  path: NormalizedLocation
  exact: boolean
  terminalDepth: number
  matchedSegments: number
  matchedCharacters: number
  match: 'hierarchy' | 'suffix'
}

const LOCATION_SEPARATOR = /[‐‑‒–—―－/\>|／＞｜]+/g
const TRAILING_PUNCTUATION = /[\s。．.!！?？,，;；:：]+$/g

/** Normalize harmless model-authored variations without rewriting meaningful CJK characters. */
export function normalizeSceneLocation(input: string): NormalizedLocation {
  const value = String(input ?? '')
    .normalize('NFKC')
    .trim()
    .replace(TRAILING_PUNCTUATION, '')
    .replace(LOCATION_SEPARATOR, '-')
    .split('-')
    .map((segment) => segment.trim().toLocaleLowerCase())
    .filter(Boolean)
    .join('-')
  return { value, segments: value ? value.split('-') : [] }
}

const commonSuffixLength = (a: string[], b: string[]): number => {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

/** Match selectively-authored hierarchy segments in their original order. The candidate may stop at an
 *  ancestor; terminalDepth lets ranking prefer the closest available ancestor before broader fallbacks. */
const orderedHierarchyMatch = (
  query: string[],
  candidate: string[]
): { matchedSegments: number; terminalDepth: number } | null => {
  if (!candidate.length) return null
  let queryPos = 0
  let terminalDepth = -1
  for (const segment of candidate) {
    while (queryPos < query.length && query[queryPos] !== segment) queryPos++
    if (queryPos >= query.length) return null
    terminalDepth = queryPos
    queryPos++
  }
  return { matchedSegments: candidate.length, terminalDepth }
}

const suffixCharacterCount = (segments: string[], n: number): number =>
  n ? segments.slice(-n).join('-').length : 0

const compareCandidate = (a: Candidate, b: Candidate): number =>
  Number(b.exact) - Number(a.exact) ||
  b.terminalDepth - a.terminalDepth ||
  b.matchedSegments - a.matchedSegments ||
  b.matchedCharacters - a.matchedCharacters

/**
 * Resolve a model-authored hierarchical location against location assets only.
 *
 * Base filenames may selectively include any location levels in their original order. A key may identify
 * the current location or stop at an ancestor, providing inherited scene fallback (for example a palace
 * background for rooms inside it). Full-location variants remain searchable for backward compatibility.
 */
export function resolveSceneAsset(input: {
  indexes: AssetIndex[]
  location: string
  type: SceneAssetType
}): SceneAssetResolution {
  const query = normalizeSceneLocation(input.location)
  if (!query.segments.length) return { status: 'miss' }

  const candidates: Candidate[] = []
  input.indexes.forEach((index, indexPos) => {
    const entries = index.location ?? {}
    for (const [name, byType] of Object.entries(entries)) {
      const entry = byType[input.type]
      if (!entry) continue
      const normalizedName = normalizeSceneLocation(name)
      const add = (
        filename: string,
        variant: string | null,
        path: NormalizedLocation,
        allowLegacySuffix: boolean
      ): void => {
        const hierarchy = orderedHierarchyMatch(query.segments, path.segments)
        const suffixLength = allowLegacySuffix ? commonSuffixLength(query.segments, path.segments) : 0
        const hierarchyLength = hierarchy?.matchedSegments ?? 0
        const matchedSegments = Math.max(hierarchyLength, suffixLength)
        if (!matchedSegments) return
        const useHierarchy = hierarchyLength >= suffixLength
        candidates.push({
          indexPos,
          filename,
          variant,
          path,
          exact: query.value === path.value,
          terminalDepth: useHierarchy ? (hierarchy?.terminalDepth ?? -1) : query.segments.length - 1,
          matchedSegments,
          matchedCharacters: suffixCharacterCount(path.segments, matchedSegments),
          match: useHierarchy ? 'hierarchy' : 'suffix'
        })
      }

      if (entry.base) add(entry.base, null, normalizedName, false)
      for (const [variant, filename] of Object.entries(entry.moods)) {
        const alias = normalizeSceneLocation(variant)
        if (
          alias.segments.length >= 2 &&
          alias.segments.at(-1) === normalizedName.segments.at(-1)
        ) {
          add(filename, variant, alias, true)
        }
      }
    }
  })

  if (!candidates.length) return { status: 'miss' }
  candidates.sort(compareCandidate)
  const best = candidates[0]
  const tied = candidates.filter(
    (candidate) =>
      candidate.exact === best.exact &&
      candidate.terminalDepth === best.terminalDepth &&
      candidate.matchedSegments === best.matchedSegments &&
      candidate.matchedCharacters === best.matchedCharacters
  )
  const distinct = new Map(tied.map((candidate) => [`${candidate.indexPos}/${candidate.filename}`, candidate]))
  if (distinct.size > 1) {
    return {
      status: 'ambiguous',
      candidates: [...distinct.values()].map((candidate) => candidate.filename),
      matchedSegments: best.matchedSegments
    }
  }

  return {
    status: 'hit',
    indexPos: best.indexPos,
    filename: best.filename,
    usedVariant: best.variant,
    match:
      best.exact
        ? 'exact-alias'
        : best.matchedSegments === 1 && best.terminalDepth === query.segments.length - 1
          ? 'leaf'
          : best.match,
    matchedSegments: best.matchedSegments
  }
}
