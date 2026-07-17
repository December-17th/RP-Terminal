import type { AssetIndex } from '../worldAssets/types'

/**
 * Project Yuzu WP-C — derive the scene `SceneVocabulary` id lists from a classic worldAssets
 * `AssetIndex` (revised ADR 0004: assets flow through the ONE existing fuzzy pipeline, no manifest).
 *
 * PURE and `shared`-only (imports nothing from `src/main`, per the `shared-not-to-main`
 * dependency-cruiser rule). The main-side `sceneGenService` composes this with the effect allow-list
 * (caller-supplied) and feeds the result to `createSceneVocabulary`. Splitting the derivation out keeps
 * it unit-testable against a hand-built or fixture-derived index without touching the provider loop.
 *
 * Mapping (see `worldAssets/types.ts` for the index shape — category → name → per-type {base, moods}):
 *   - actors      = the `character` category's base names (each dialogue speaker / sprite id).
 *   - expressions = the UNION of every mood key across all of the character entries' asset types
 *                   (立绘/头像/相册 moods) — the sprite-token vocabulary.
 *   - locations   = the `location` category's names (bg ids).
 *   - cgs         = the `cg` category's names.
 *   - audio       = empty for now — there is NO audio-id convention until WP-F (the importer skips the
 *                   audio/ folder with a warning), so no audio vocabulary exists to steer the model.
 */
export interface DerivedAssetVocabulary {
  actors: string[]
  expressions: string[]
  locations: string[]
  cgs: string[]
  audio: string[]
}

export const deriveAssetVocabulary = (index: AssetIndex): DerivedAssetVocabulary => {
  const characterCat = index.character ?? {}

  const actors = Object.keys(characterCat)

  const expressions = new Set<string>()
  for (const nameEntry of Object.values(characterCat)) {
    for (const typeEntry of Object.values(nameEntry)) {
      if (!typeEntry) continue // Partial<Record<AssetType, …>> — a missing type is undefined
      for (const mood of Object.keys(typeEntry.moods)) expressions.add(mood)
    }
  }

  return {
    actors,
    expressions: [...expressions],
    locations: Object.keys(index.location ?? {}),
    cgs: Object.keys(index.cg ?? {}),
    audio: []
  }
}
