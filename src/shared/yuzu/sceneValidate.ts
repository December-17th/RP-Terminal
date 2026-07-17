import {
  SceneSchema,
  NARRATION_SPEAKER,
  SCENE_SCHEMA_VERSION,
  type Beat,
  type Interaction,
  type Scene,
  type SceneVocabulary
} from './sceneSchema'
import { YSS_GRAMMAR_PROMPT, YSS_VERSION, renderVocabularyBlock } from './sceneGrammar'

/**
 * Project Yuzu WP-B — the validation ladder (ADR 0002 revised + ADR 0007 YSS v0).
 *
 * Three rungs, all pure:
 *   1. `parseScene`   — lenient, line-oriented YSS parse into a candidate `Scene`, with ASYMMETRIC
 *                       leniency (prose never errors; a malformed `<| … |>` line is noted + skipped;
 *                       a missing `<| end |>` is a truncation note). Then it hands the candidate to →
 *   2. `validateScene`— the STRICT canon gate: zod shape parse, then an effect/choice cross check.
 *                       Canon stays strict even though the parse stays lenient. Unknown asset ids are
 *                       NOT fatal (revised ADR 0004) — they surface as an UNKNOWN_ASSET_ID observation
 *                       and resolve fuzzily at play time.
 *   3. `toProseFallbackScene` — the floor: wrap the raw text as a narration-only scene. Never throws,
 *                       never re-enters validation (it IS the escape hatch).
 *
 * `buildRepairMessages` is the one bounded corrective re-ask (it builds messages; it does NOT call any
 * provider — that loop is WP-C).
 */

// ---------------------------------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------------------------------

/**
 * The shape of a single problem. String-valued for easy aggregation/logging. Two disjoint groups:
 *
 * - SCENE-LEVEL FAILURES (fatal — the scene is rejected and the ladder falls to repair/fallback):
 *   SCHEMA_MISSING_FIELD, SCHEMA_WRONG_TYPE, DISALLOWED_EFFECT, BAD_CHOICE_SHAPE, EMPTY_OUTPUT.
 * - OBSERVATIONS (non-fatal — noted for telemetry/traces, the scene survives): THINK_WRAPPED,
 *   UNKNOWN_COMMAND, BAD_SPRITE_TOKEN, TRUNCATED, UNKNOWN_ASSET_ID.
 *
 * UNKNOWN_ASSET_ID is an OBSERVATION (revised ADR 0004): assets resolve at play time through the classic
 * fuzzy `worldAssets` resolver, so a non-exact asset reference (location / actor / speaker / sprite /
 * expression / cg / audio id) is legal — the strict validator records it (with the offending id in the
 * `detail`) but keeps the scene valid, rather than rejecting it into the repair ladder. The
 * `SceneVocabulary` remains the prompt-steering list builder; it just no longer gates canon on membership.
 *
 * The lenient parser only ever emits OBSERVATIONS; the strict validator emits FAILURES plus the one
 * UNKNOWN_ASSET_ID observation. Telemetry can still tell "the model rambled a bit / referenced a fuzzy
 * asset" apart from "the scene is not playable" (ADR 0002 consequences).
 */
export const FailureShape = {
  // Scene-level failures (fatal)
  SCHEMA_MISSING_FIELD: 'SCHEMA_MISSING_FIELD',
  SCHEMA_WRONG_TYPE: 'SCHEMA_WRONG_TYPE',
  DISALLOWED_EFFECT: 'DISALLOWED_EFFECT',
  BAD_CHOICE_SHAPE: 'BAD_CHOICE_SHAPE',
  EMPTY_OUTPUT: 'EMPTY_OUTPUT',
  // Observations (non-fatal)
  THINK_WRAPPED: 'THINK_WRAPPED',
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
  BAD_SPRITE_TOKEN: 'BAD_SPRITE_TOKEN',
  TRUNCATED: 'TRUNCATED',
  UNKNOWN_ASSET_ID: 'UNKNOWN_ASSET_ID'
} as const
export type FailureShape = (typeof FailureShape)[keyof typeof FailureShape]

/**
 * Provider-neutral chat message. Structurally identical to the app's `ChatMessage`
 * (src/main/services/promptBuilder.ts) — mirrored locally rather than imported so this pure
 * `src/shared/**` module never reaches into `src/main` (the module-boundary rule). Because the shape
 * matches exactly, WP-C can hand these straight to the real provider transport.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// ---------------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------------

const uniq = (xs: FailureShape[]): FailureShape[] => [...new Set(xs)]

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Resolve a value along a zod issue path; returns undefined if any step is missing. */
const resolvePath = (value: unknown, path: readonly PropertyKey[]): unknown => {
  let cur: unknown = value
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<PropertyKey, unknown>)[key]
  }
  return cur
}

/** Strip ONE matched surrounding quote pair (ADR 0007 v1 polish: models emit `<| choice "…" :: … |>`). */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'], // “ ”
  ['‘', '’'] // ‘ ’
]
const stripMatchedQuotes = (raw: string): string => {
  const s = raw.trim()
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) return s.slice(1, -1).trim()
  }
  return s
}

// ---------------------------------------------------------------------------------------------------
// Rung 2 — strict validation (the canon gate)
// ---------------------------------------------------------------------------------------------------

export type ValidateResult =
  | { ok: true; scene: Scene; observations: FailureShape[]; detail: string }
  | { ok: false; failures: FailureShape[]; detail: string }

/**
 * Cross-check the resolved scene against the vocabulary + effect allow-list. Two channels:
 * - `failures` (fatal): DISALLOWED_EFFECT, BAD_CHOICE_SHAPE — the scene is genuinely unplayable.
 * - `observations` (non-fatal): UNKNOWN_ASSET_ID — a non-exact asset id (revised ADR 0004). Assets
 *   resolve fuzzily at play time via the classic `worldAssets` resolver, so this is legal; it is noted
 *   with the offending id (`obsDetail`) for traces/inspection but never rejects the scene. Every asset
 *   category shares this one observation path — including speaker/sprite actor ids, which resolve fuzzily
 *   like everything else (there is no distinct speaker failure code to preserve).
 */
const vocabCheck = (
  scene: Scene,
  rawValue: unknown,
  vocab: SceneVocabulary
): {
  failures: FailureShape[]
  failDetail: string[]
  observations: FailureShape[]
  obsDetail: string[]
} => {
  const failures: FailureShape[] = []
  const failDetail: string[] = []
  const observations: FailureShape[] = []
  const obsDetail: string[] = []
  const unknownAsset = (kind: string, id: string): void => {
    observations.push(FailureShape.UNKNOWN_ASSET_ID)
    obsDetail.push(`unknown ${kind} id "${id}"`)
  }

  if (!vocab.locations.has(scene.header.location)) unknownAsset('location', scene.header.location)
  for (const p of scene.header.present) if (!vocab.actors.has(p)) unknownAsset('present-actor', p)

  for (const beat of scene.beats) {
    if (beat.bg !== undefined && !vocab.locations.has(beat.bg)) unknownAsset('bg', beat.bg)
    if (beat.cg != null && !vocab.cgs.has(beat.cg)) unknownAsset('cg', beat.cg)
    if (
      beat.speaker !== undefined &&
      beat.speaker !== NARRATION_SPEAKER &&
      !vocab.actors.has(beat.speaker)
    )
      unknownAsset('speaker', beat.speaker)
    for (const sp of beat.sprites ?? []) {
      if (!vocab.actors.has(sp.actor)) unknownAsset('sprite.actor', sp.actor)
      if (sp.expression !== undefined && !vocab.expressions.has(sp.expression))
        unknownAsset('expression', sp.expression)
    }
    for (const key of ['music', 'ambience', 'sfx'] as const) {
      const id = beat.audio?.[key]
      if (id !== undefined && !vocab.audio.has(id)) unknownAsset(`audio.${key}`, id)
    }
    for (const eff of beat.effects ?? []) {
      if (!vocab.effects.has(eff.type)) {
        failures.push(FailureShape.DISALLOWED_EFFECT)
        failDetail.push(`disallowed effect type "${eff.type}"`)
      }
    }
  }

  // Choices must be {text,intent} ONLY. zod strips extra keys, so inspect the RAW value for mechanics.
  if (isRecord(rawValue)) {
    const rawNext = rawValue.next
    const rawChoices = isRecord(rawNext) ? rawNext.choices : undefined
    if (Array.isArray(rawChoices)) {
      for (const c of rawChoices) {
        if (isRecord(c)) {
          const extra = Object.keys(c).filter((k) => k !== 'text' && k !== 'intent')
          if (extra.length) {
            failures.push(FailureShape.BAD_CHOICE_SHAPE)
            failDetail.push(`choice carries non-{text,intent} keys: ${extra.join(', ')}`)
          }
        }
      }
    }
  }

  return { failures, failDetail, observations, obsDetail }
}

/**
 * Validate a candidate value against the scene schema + vocabulary. Pure. Returns the typed scene on
 * success (alongside any non-fatal `observations` + their `detail`), or a de-duplicated list of
 * FailureShapes + a human `detail` string (which the repair builder quotes back to the model). This is
 * the load-bearing correctness gate — it is strict regardless of how the candidate was produced, so any
 * non-parser producer (WP-C, hand-authored scenes) is held to the same canon rules. Unknown asset ids do
 * NOT fail the scene (revised ADR 0004): they surface as an UNKNOWN_ASSET_ID observation, since assets
 * resolve fuzzily at play time.
 */
export const validateScene = (value: unknown, vocab: SceneVocabulary): ValidateResult => {
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
    return { ok: false, failures: uniq(cross.failures), detail: cross.failDetail.join('; ') }
  }
  return {
    ok: true,
    scene: parsed.data,
    observations: uniq(cross.observations),
    detail: cross.obsDetail.join('; ')
  }
}

// ---------------------------------------------------------------------------------------------------
// Rung 1 — lenient YSS parse
// ---------------------------------------------------------------------------------------------------

const THINK_RE = /<think\b[^>]*>[\s\S]*?<\/think>/gi
const POSITIONS = new Set(['left', 'center', 'right'])
const ACTIONS = new Set(['enter', 'exit', 'move'])

export type ParseResult =
  | { ok: true; scene: Scene; observations: FailureShape[] }
  | { ok: false; failures: FailureShape[]; detail: string; observations: FailureShape[] }

/** Mutable accumulator folded across the YSS lines, then frozen into a Scene candidate. */
interface Accum {
  location?: string
  mood?: string
  present: Set<string>
  beats: Beat[]
  choices: { text: string; intent: string }[]
}

/** Parse the tokens after `<| <actor>` into a sprite op, classifying each token by vocabulary. */
const foldSpriteOp = (
  actor: string,
  tokens: string[],
  vocab: SceneVocabulary,
  acc: Accum,
  obs: FailureShape[]
): void => {
  const sprite: SpriteOpLike = { actor }
  for (const tok of tokens) {
    if (vocab.expressions.has(tok)) sprite.expression = tok
    else if (POSITIONS.has(tok)) sprite.position = tok as 'left' | 'center' | 'right'
    else if (ACTIONS.has(tok)) sprite.action = tok as 'enter' | 'exit' | 'move'
    else obs.push(FailureShape.BAD_SPRITE_TOKEN) // classifies to none — note it, keep the sprite
  }
  if (sprite.action === 'enter') acc.present.add(actor)
  acc.beats.push({ sprites: [sprite] })
}
type SpriteOpLike = NonNullable<Beat['sprites']>[number]

/**
 * Handle one `<| … |>` command line. Returns 'end' to stop the fold early. Every unrecognized or
 * un-validatable command (unknown verb, empty/unknown arg, unknown asset id, non-allow-listed effect)
 * is recorded as an UNKNOWN_COMMAND observation and SKIPPED — canon leniency lives here; the strict
 * canon gate is `validateScene`.
 */
const foldCommand = (
  inner: string,
  vocab: SceneVocabulary,
  acc: Accum,
  obs: FailureShape[]
): 'continue' | 'end' => {
  const tokens = inner.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    obs.push(FailureShape.UNKNOWN_COMMAND)
    return 'continue'
  }
  const verb = tokens[0]
  const args = tokens.slice(1)
  const rest = inner.slice(verb.length).trim()

  switch (verb) {
    case 'bg': {
      const id = args[0]
      if (!id || !vocab.locations.has(id)) {
        obs.push(FailureShape.UNKNOWN_COMMAND)
        return 'continue'
      }
      if (acc.location === undefined) acc.location = id
      acc.beats.push({ bg: id })
      return 'continue'
    }
    case 'mood': {
      if (rest)
        acc.mood = rest // last one wins; free text, not vocab-checked
      else obs.push(FailureShape.UNKNOWN_COMMAND)
      return 'continue'
    }
    case 'music':
    case 'ambience':
    case 'sfx': {
      const id = args[0]
      if (verb === 'music' && id === 'stop') {
        acc.beats.push({ audio: {} }) // "music stop" — a marker beat with no audio id
        return 'continue'
      }
      if (!id || !vocab.audio.has(id)) {
        obs.push(FailureShape.UNKNOWN_COMMAND)
        return 'continue'
      }
      acc.beats.push({ audio: { [verb]: id } })
      return 'continue'
    }
    case 'cg': {
      const id = args[0]
      if (id === 'clear') {
        acc.beats.push({ cg: null })
        return 'continue'
      }
      if (!id || !vocab.cgs.has(id)) {
        obs.push(FailureShape.UNKNOWN_COMMAND)
        return 'continue'
      }
      acc.beats.push({ cg: id })
      return 'continue'
    }
    case 'effect': {
      const type = args[0]
      if (!type || !vocab.effects.has(type)) {
        obs.push(FailureShape.UNKNOWN_COMMAND)
        return 'continue'
      }
      const effectArgs = args.slice(1)
      const effect =
        effectArgs.length > 0 ? { type, args: { raw: effectArgs.join(' ') } } : { type }
      const last = acc.beats[acc.beats.length - 1]
      if (last) last.effects = [...(last.effects ?? []), effect]
      else acc.beats.push({ effects: [effect] })
      return 'continue'
    }
    case 'choice': {
      const sep = rest.indexOf(' :: ')
      const text = stripMatchedQuotes(sep >= 0 ? rest.slice(0, sep) : rest)
      const intent = sep >= 0 ? rest.slice(sep + 4).trim() || text : text
      if (!text) {
        obs.push(FailureShape.UNKNOWN_COMMAND)
        return 'continue'
      }
      acc.choices.push({ text, intent })
      return 'continue'
    }
    case 'end':
      return 'end'
    default: {
      // Not a known command verb — is it an actor sprite-op?
      if (vocab.actors.has(verb)) {
        foldSpriteOp(verb, args, vocab, acc, obs)
        return 'continue'
      }
      obs.push(FailureShape.UNKNOWN_COMMAND)
      return 'continue'
    }
  }
}

/**
 * Rung 1: parse a YSS reply into a candidate `Scene` and validate it with `validateScene`. Pure, never
 * throws. `observations` (THINK_WRAPPED + any noted-and-skipped malformed lines + TRUNCATED) are
 * returned on BOTH the ok and the failure paths, so telemetry sees them regardless of the outcome. The
 * raw error context is preserved in `detail` on every failure path.
 */
export const parseScene = (raw: string, vocab: SceneVocabulary): ParseResult => {
  const observations: FailureShape[] = []

  let text = raw ?? ''
  if (THINK_RE.test(text)) {
    text = text.replace(THINK_RE, '')
    observations.push(FailureShape.THINK_WRAPPED)
  }

  // EMPTY_OUTPUT: the model returned nothing usable (empty, whitespace, or only a reasoning block).
  const lines = text.split(/\r?\n/)
  if (!lines.some((l) => l.trim().length > 0)) {
    return {
      ok: false,
      failures: [FailureShape.EMPTY_OUTPUT],
      detail: 'no scene content in model output (empty after stripping reasoning)',
      observations: uniq(observations)
    }
  }

  const acc: Accum = { present: new Set(), beats: [], choices: [] }
  let sawEnd = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue // blank lines are ignored, never narration

    // 1) Command
    if (line.startsWith('<|') && line.endsWith('|>')) {
      const innerCmd = line.slice(2, line.length - 2).trim()
      if (foldCommand(innerCmd, vocab, acc, observations) === 'end') {
        sawEnd = true
        break
      }
      continue
    }

    // 2) Dialogue — "<known speaker>: text" (a colon FOLLOWED BY a space)
    const ci = line.indexOf(': ')
    if (ci > 0) {
      const speaker = line.slice(0, ci)
      if (speaker === NARRATION_SPEAKER || vocab.actors.has(speaker)) {
        const spoken = line.slice(ci + 2)
        acc.beats.push({ speaker, line: spoken })
        if (speaker !== NARRATION_SPEAKER) acc.present.add(speaker)
        continue
      }
    }

    // 3) Narration — anything else
    acc.beats.push({ speaker: NARRATION_SPEAKER, line })
  }

  // The scene must terminate with a <| end |> marker; its absence flags a possibly cut-off generation.
  // This is an OBSERVATION only — it never fails the scene by itself.
  if (!sawEnd) observations.push(FailureShape.TRUNCATED)

  // Interaction is inferred purely from choices: any choices ⇒ present them; none ⇒ free player input.
  const next: Interaction = { choices: acc.choices }

  // Build a candidate (location may be undefined ⇒ SCHEMA_MISSING_FIELD, a fair failure) and let the
  // strict validator judge it. We never fabricate a location — leniency covers only extra/unknown lines,
  // never a missing required field. `scene_id` is a placeholder; the store (WP-E) assigns the stable id.
  const candidate = {
    schemaVersion: SCENE_SCHEMA_VERSION,
    scene_id: 'scene',
    header: { location: acc.location, present: [...acc.present], mood: acc.mood },
    beats: acc.beats,
    next
  }

  const v = validateScene(candidate, vocab)
  if (v.ok)
    return { ok: true, scene: v.scene, observations: uniq([...observations, ...v.observations]) }
  return {
    ok: false,
    failures: v.failures,
    detail: v.detail,
    observations: uniq(observations)
  }
}

// ---------------------------------------------------------------------------------------------------
// Rung 3 — prose fallback (the floor)
// ---------------------------------------------------------------------------------------------------

/**
 * Total-failure degrade path. When both the first attempt and the single repair fail to produce a valid
 * scene, we don't drop the turn: we wrap whatever text the model DID return as a single narration-only
 * beat, so the story keeps moving. The result is schema-valid by construction — it NEVER throws and
 * NEVER re-enters validation (it IS the escape hatch). The fallback location comes from the vocabulary,
 * or 'unknown' when the vocabulary declares none.
 */
export const toProseFallbackScene = (rawText: string, vocab: SceneVocabulary): Scene => ({
  schemaVersion: SCENE_SCHEMA_VERSION,
  scene_id: 'fallback',
  header: {
    location: [...vocab.locations][0] ?? 'unknown',
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

// ---------------------------------------------------------------------------------------------------
// Bounded repair-prompt builder (messages only — the provider loop is WP-C)
// ---------------------------------------------------------------------------------------------------

export interface RepairInput {
  /** The rejected reply, echoed back as the assistant turn. */
  priorRaw: string
  /** The scene-level failures from `validateScene`/`parseScene`. */
  failures: FailureShape[]
  /** The human-readable detail string preserved from the failure. */
  detail: string
  /** The vocabulary, so the corrective can remind the model of the legal ids. */
  vocab: SceneVocabulary
}

/**
 * The single bounded corrective re-ask. Builds a LEAN, self-contained message array: a system turn with
 * the shared YSS grammar + the legal vocabulary, the rejected reply as the assistant turn, then a terse
 * user turn quoting what was wrong. It deliberately does NOT reproduce WP-C's full context-packing
 * generation prompt (premise/story-state/last-N scenes) — that is WP-C's concern. It NEVER calls a
 * provider; it only returns messages (the repair loop that sends them is WP-C).
 */
export const buildRepairMessages = (input: RepairInput): ChatMessage[] => {
  const { priorRaw, failures, detail, vocab } = input

  const system = [
    `You are the scene director for a visual-novel engine (YSS ${YSS_VERSION}). You emit ONE scene at a time as a line script.`,
    '',
    YSS_GRAMMAR_PROMPT,
    '',
    renderVocabularyBlock(vocab)
  ].join('\n')

  const shapes = failures.length ? failures.join(', ') : 'unspecified'
  const corrective = [
    `Your previous reply was rejected. Problem type(s): ${shapes}.`,
    detail ? `Details: ${detail}.` : '',
    'Reply again as YSS lines only — no JSON, no markdown fence, no <think> block — fixing the above and using only the allowed asset ids. Emit a <| bg <location> |> line and finish with <| end |>.'
  ]
    .filter(Boolean)
    .join('\n')

  return [
    { role: 'system', content: system },
    { role: 'assistant', content: priorRaw },
    { role: 'user', content: corrective }
  ]
}

// Re-export the shared grammar constants so consumers can pull the whole ladder + grammar from one module.
export { YSS_GRAMMAR_PROMPT, YSS_VERSION, renderVocabularyBlock } from './sceneGrammar'
