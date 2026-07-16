import type { Scene } from './sceneDraftSchema'
import { NARRATION_SPEAKER, type P0Context } from './fixtureContext'

/**
 * Project Yuzu WP-P0 — total-failure degrade path.
 *
 * When both the first attempt and the single repair fail to produce a valid scene, we don't drop the
 * turn: we wrap whatever text the model DID return as a single narration-only beat. This is the "at
 * least the story keeps moving" floor the engine falls back to. The result is a schema-valid Scene by
 * construction (it never re-enters validation — it IS the escape hatch).
 */
export const toProseFallbackScene = (rawText: string, ctx: P0Context): Scene => ({
  scene_id: 'fallback',
  header: {
    location: ctx.locations[0] ?? 'unknown',
    present: []
  },
  beats: [
    {
      speaker: NARRATION_SPEAKER,
      line: rawText
    }
  ],
  next: { choices: [] }
})
