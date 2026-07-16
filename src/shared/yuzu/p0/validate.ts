import { SceneSchema, type Scene } from './sceneDraftSchema'
import {
  buildVocabulary,
  NARRATION_SPEAKER,
  type P0Context,
  type Vocabulary
} from './fixtureContext'
import type { ExtractFailReason } from './extractJson'

/**
 * Project Yuzu WP-P0 — validation + failure classification.
 *
 * Two stages: (1) zod parse against the DRAFT scene schema (shape), then (2) a vocabulary cross-check
 * (every asset id must be in the fixture vocabulary; every effect must be in the allow-list; choices
 * must be {text,intent} only). Keeping the vocab check OUT of the schema is deliberate — it lets us
 * tell a SCHEMA failure apart from a VOCAB failure in the histogram.
 */

/** The shape of a single problem, for the failure histogram. String-valued for easy JSONL/aggregation. */
export const FailureShape = {
  NO_JSON_FOUND: 'NO_JSON_FOUND',
  JSON_PARSE_ERROR: 'JSON_PARSE_ERROR',
  THINK_WRAPPED: 'THINK_WRAPPED',
  FENCED: 'FENCED',
  EXTRA_PROSE: 'EXTRA_PROSE',
  SCHEMA_MISSING_FIELD: 'SCHEMA_MISSING_FIELD',
  SCHEMA_WRONG_TYPE: 'SCHEMA_WRONG_TYPE',
  UNKNOWN_ASSET_ID: 'UNKNOWN_ASSET_ID',
  DISALLOWED_EFFECT: 'DISALLOWED_EFFECT',
  BAD_CHOICE_SHAPE: 'BAD_CHOICE_SHAPE',
  TRUNCATED: 'TRUNCATED',
  EMPTY_OUTPUT: 'EMPTY_OUTPUT',
  OTHER: 'OTHER'
} as const
export type FailureShape = (typeof FailureShape)[keyof typeof FailureShape]

/** Map an extractJson failure reason to a FailureShape. */
export const mapExtractReason = (reason: ExtractFailReason): FailureShape => {
  switch (reason) {
    case 'EMPTY':
      return FailureShape.EMPTY_OUTPUT
    case 'NO_JSON':
      return FailureShape.NO_JSON_FOUND
    case 'TRUNCATED':
      return FailureShape.TRUNCATED
    case 'PARSE_ERROR':
      return FailureShape.JSON_PARSE_ERROR
  }
}

/** Observations (not failures per se) derived from extractJson's `applied[]` — tracked even on success
 *  so the histogram shows how often providers wrap/fence/bury their JSON. */
export const observationsFromApplied = (applied: string[]): FailureShape[] => {
  const out: FailureShape[] = []
  if (applied.includes('think')) out.push(FailureShape.THINK_WRAPPED)
  if (applied.includes('fence')) out.push(FailureShape.FENCED)
  if (applied.includes('slice')) out.push(FailureShape.EXTRA_PROSE)
  return out
}

const uniq = (xs: FailureShape[]): FailureShape[] => [...new Set(xs)]

/** Resolve a value along a zod issue path; returns undefined if any step is missing. */
const resolvePath = (value: unknown, path: readonly PropertyKey[]): unknown => {
  let cur: unknown = value
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<PropertyKey, unknown>)[key]
  }
  return cur
}

export type ValidateResult =
  | { ok: true; scene: Scene }
  | { ok: false; failures: FailureShape[]; detail: string }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Cross-check that resolved scene ids are all in the vocabulary + effects in the allow-list. */
const vocabCheck = (
  scene: Scene,
  rawValue: unknown,
  vocab: Vocabulary
): { failures: FailureShape[]; detail: string[] } => {
  const failures: FailureShape[] = []
  const detail: string[] = []
  const badAsset = (kind: string, id: string): void => {
    failures.push(FailureShape.UNKNOWN_ASSET_ID)
    detail.push(`unknown ${kind} id "${id}"`)
  }

  if (!vocab.locations.has(scene.header.location)) badAsset('location', scene.header.location)
  for (const p of scene.header.present) if (!vocab.actors.has(p)) badAsset('present-actor', p)

  for (const beat of scene.beats) {
    if (beat.bg !== undefined && !vocab.locations.has(beat.bg)) badAsset('bg', beat.bg)
    if (beat.cg != null && !vocab.cgs.has(beat.cg)) badAsset('cg', beat.cg)
    if (
      beat.speaker !== undefined &&
      beat.speaker !== NARRATION_SPEAKER &&
      !vocab.actors.has(beat.speaker)
    )
      badAsset('speaker', beat.speaker)
    for (const sp of beat.sprites ?? []) {
      if (!vocab.actors.has(sp.actor)) badAsset('sprite.actor', sp.actor)
      if (sp.expression !== undefined && !vocab.expressions.has(sp.expression))
        badAsset('expression', sp.expression)
    }
    for (const key of ['music', 'ambience', 'sfx'] as const) {
      const id = beat.audio?.[key]
      if (id !== undefined && !vocab.audio.has(id)) badAsset(`audio.${key}`, id)
    }
    for (const eff of beat.effects ?? []) {
      if (!vocab.effects.has(eff.type)) {
        failures.push(FailureShape.DISALLOWED_EFFECT)
        detail.push(`disallowed effect type "${eff.type}"`)
      }
    }
  }

  // Choices must be {text,intent} ONLY. zod strips extra keys, so inspect the RAW value for mechanics.
  if (scene.next.kind === 'choice' && isRecord(rawValue)) {
    const rawNext = (rawValue as Record<string, unknown>).next
    const rawChoices = isRecord(rawNext) ? rawNext.choices : undefined
    if (Array.isArray(rawChoices)) {
      for (const c of rawChoices) {
        if (isRecord(c)) {
          const extra = Object.keys(c).filter((k) => k !== 'text' && k !== 'intent')
          if (extra.length) {
            failures.push(FailureShape.BAD_CHOICE_SHAPE)
            detail.push(`choice carries non-{text,intent} keys: ${extra.join(', ')}`)
          }
        }
      }
    }
  }

  return { failures, detail }
}

/**
 * Validate an already-extracted value against the draft scene schema + fixture vocabulary. Pure.
 * Returns the typed scene on success, or a de-duplicated list of FailureShapes + a human detail string
 * (which repair.ts quotes back to the model).
 */
export const validateScene = (value: unknown, ctx: P0Context): ValidateResult => {
  const vocab = buildVocabulary(ctx)
  const parsed = SceneSchema.safeParse(value)
  if (!parsed.success) {
    const failures: FailureShape[] = []
    const detail: string[] = []
    for (const issue of parsed.error.issues) {
      const path = issue.path
      if (path.includes('choices')) {
        failures.push(FailureShape.BAD_CHOICE_SHAPE)
      } else if (issue.code === 'too_small') {
        // e.g. beats: [] — a required collection came back empty.
        failures.push(FailureShape.SCHEMA_MISSING_FIELD)
      } else if (resolvePath(value, path) === undefined) {
        failures.push(FailureShape.SCHEMA_MISSING_FIELD)
      } else {
        failures.push(FailureShape.SCHEMA_WRONG_TYPE)
      }
      detail.push(`${path.join('.') || '(root)'}: ${issue.message}`)
    }
    return { ok: false, failures: uniq(failures), detail: detail.join('; ') }
  }

  const cross = vocabCheck(parsed.data, value, vocab)
  if (cross.failures.length) {
    return { ok: false, failures: uniq(cross.failures), detail: cross.detail.join('; ') }
  }
  return { ok: true, scene: parsed.data }
}
