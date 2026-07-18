import { getIndex } from '../worldAssetService'
import {
  deriveAssetVocabulary,
  type DerivedAssetVocabulary
} from '../../../shared/yuzu/assetVocabulary'
import { createSceneVocabulary, type SceneVocabulary } from '../../../shared/yuzu/sceneSchema'
import { YSS_GRAMMAR_PROMPT, renderVocabularyBlock } from '../../../shared/yuzu/sceneGrammar'

/**
 * Project Yuzu (ADR 0008 §7) — the VN-mode prompt overlay appended to the CLASSIC assembled prompt when a
 * session is in VN play mode (WP-S1). It is a single system-block string composed of three parts, in order:
 *   1. a short framing that constrains the reply to exactly one Yuzu Scene Script (YSS) document;
 *   2. {@link YSS_GRAMMAR_PROMPT} — the shared grammar (which, post-Y1, already teaches the MVU effect form);
 *   3. the concrete legal asset ids ({@link renderVocabularyBlock}), derived from the chat's world assets.
 *
 * Main-side (may read worldAssetService) but the composition pieces are all `shared/yuzu` so the grammar the
 * model is taught stays in lock-step with the parser. Deterministic: lorebook ids are sorted and every id
 * list is deduped + sorted, so the overlay is snapshot-stable. Fail-soft: an id with no assets (or one whose
 * index read throws) contributes nothing; zero assets still yields a valid overlay (empty vocab lists).
 */

/** The VN-mode framing line — constrains the response shape without re-teaching the grammar (that's
 *  {@link YSS_GRAMMAR_PROMPT}). Kept terse so it reads as one instruction at the volatile tail. */
export const VN_MODE_FRAMING =
  'You are writing the next scene of a visual novel. Respond with EXACTLY one YSS scene document and nothing else — no preamble, no commentary, no code fences. The scene continues directly from the current story state.'

/** Union of two derived vocabularies (each field a deduped, sorted id list). */
const mergeDerived = (
  a: DerivedAssetVocabulary,
  b: DerivedAssetVocabulary
): DerivedAssetVocabulary => ({
  actors: [...a.actors, ...b.actors],
  expressions: [...a.expressions, ...b.expressions],
  locations: [...a.locations, ...b.locations],
  cgs: [...a.cgs, ...b.cgs],
  audio: [...a.audio, ...b.audio]
})

/** Dedupe + sort a list so the overlay is deterministic regardless of index iteration order. */
const norm = (ids: string[]): string[] => [...new Set(ids)].sort()

/**
 * Build the concrete `SceneVocabulary` for a chat's lorebook ids: the union of each active book's world-
 * asset index, deduped + sorted so it is snapshot-stable. Fail-soft — an id with no assets (or one whose
 * index read throws) contributes nothing. This is the SINGLE derivation shared by both the S1 prompt overlay
 * ({@link buildVnOverlay}, which renders it as steering text) and the S2 acceptance gate (`vnGate`, which
 * cross-checks the model's scene against it), so what the model is told and what the ladder validates never
 * drift apart.
 */
export const buildVnVocabulary = (profileId: string, lorebookIds: string[]): SceneVocabulary => {
  const empty: DerivedAssetVocabulary = {
    actors: [],
    expressions: [],
    locations: [],
    cgs: [],
    audio: []
  }
  // Sort ids up front so merges (and thus the rendered block) are order-independent.
  const merged = [...lorebookIds].sort().reduce((acc, id) => {
    let derived: DerivedAssetVocabulary
    try {
      derived = deriveAssetVocabulary(getIndex(profileId, id))
    } catch {
      derived = empty // fail-soft: a missing/unreadable index contributes nothing
    }
    return mergeDerived(acc, derived)
  }, empty)

  return createSceneVocabulary({
    actors: norm(merged.actors),
    expressions: norm(merged.expressions),
    locations: norm(merged.locations),
    cgs: norm(merged.cgs),
    audio: norm(merged.audio)
  })
}

/**
 * Build the VN-mode overlay for a chat's lorebook ids. `lorebookIds` are the session's active books
 * (`GenContext.lorebookIds`); the derived vocabulary is the union of each book's asset index. Returns a
 * single string (framing + grammar + vocabulary) suitable for appending to the prompt's memory tail.
 */
export const buildVnOverlay = (profileId: string, lorebookIds: string[]): string => {
  const vocab = buildVnVocabulary(profileId, lorebookIds)
  return [VN_MODE_FRAMING, YSS_GRAMMAR_PROMPT, renderVocabularyBlock(vocab)].join('\n\n')
}
