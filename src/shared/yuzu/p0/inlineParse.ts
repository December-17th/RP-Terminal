import type { Beat, Interaction, Scene } from './sceneDraftSchema'
import { buildVocabulary, NARRATION_SPEAKER, type P0Context } from './fixtureContext'
import { FailureShape, validateScene } from './validate'

/**
 * Project Yuzu WP-P0 — the SECOND wire format: "Yuzu Scene Script" (YSS v0), a line-oriented command
 * stream. This parser folds the model's lines into the SAME draft `Scene` shape the JSON path produces,
 * then hands it to the SHARED `validateScene` so the A/B is judged by one identical validator.
 *
 * Asymmetric leniency is the whole point: a line that is neither a `<| … |>` command nor a
 * `knownActor: …` dialogue is narration (never an error); a `<| … |>` whose verb/id/effect is unknown
 * is NOTED as an observation and SKIPPED (never thrown, never discards the rest of the scene). Those
 * observations are reported like THINK_WRAPPED — they don't by themselves make a run fail; the run is
 * judged solely by whether the reconstructed Scene passes `validateScene`.
 */

const THINK_RE = /<think\b[^>]*>[\s\S]*?<\/think>/gi

const POSITIONS = new Set(['left', 'center', 'right'])
const ACTIONS = new Set(['enter', 'exit', 'move'])

export type InlineParseResult =
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

const uniq = (xs: FailureShape[]): FailureShape[] => [...new Set(xs)]

/** Parse the tokens after `<| <actor>` into a sprite op, classifying each token by vocabulary. */
const foldSpriteOp = (
  actor: string,
  tokens: string[],
  ctx: ReturnType<typeof buildVocabulary>,
  acc: Accum,
  obs: FailureShape[]
): void => {
  const sprite: NonNullable<Beat['sprites']>[number] = { actor }
  for (const tok of tokens) {
    if (ctx.expressions.has(tok)) sprite.expression = tok
    else if (POSITIONS.has(tok)) sprite.position = tok as 'left' | 'center' | 'right'
    else if (ACTIONS.has(tok)) sprite.action = tok as 'enter' | 'exit' | 'move'
    else obs.push(FailureShape.BAD_SPRITE_TOKEN) // classifies to none — note it, keep the sprite
  }
  if (sprite.action === 'enter') acc.present.add(actor)
  acc.beats.push({ sprites: [sprite] })
}

/** Handle one `<| … |>` command line. Returns 'end' to stop the fold early. */
const foldCommand = (
  inner: string,
  vocab: ReturnType<typeof buildVocabulary>,
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
        obs.push(id ? FailureShape.UNKNOWN_ASSET_ID : FailureShape.UNKNOWN_COMMAND)
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
        obs.push(id ? FailureShape.UNKNOWN_ASSET_ID : FailureShape.UNKNOWN_COMMAND)
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
        obs.push(id ? FailureShape.UNKNOWN_ASSET_ID : FailureShape.UNKNOWN_COMMAND)
        return 'continue'
      }
      acc.beats.push({ cg: id })
      return 'continue'
    }
    case 'effect': {
      const type = args[0]
      if (!type || !vocab.effects.has(type)) {
        obs.push(type ? FailureShape.DISALLOWED_EFFECT : FailureShape.UNKNOWN_COMMAND)
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
      const text = (sep >= 0 ? rest.slice(0, sep) : rest).trim()
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
 * Parse a YSS reply into a draft Scene and validate it with the SHARED `validateScene`. Pure, never
 * throws. `observations` (THINK_WRAPPED + any noted-and-skipped malformed lines) are returned on both
 * the ok and the failure paths, so the histogram sees them regardless of the final outcome.
 */
export const parseInlineScene = (raw: string, ctx: P0Context): InlineParseResult => {
  const vocab = buildVocabulary(ctx)
  const observations: FailureShape[] = []

  let text = raw ?? ''
  if (THINK_RE.test(text)) {
    text = text.replace(THINK_RE, '')
    observations.push(FailureShape.THINK_WRAPPED)
  }

  const acc: Accum = { present: new Set(), beats: [], choices: [] }
  let sawEnd = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue // blank lines are ignored, never narration

    // 1) Command
    if (line.startsWith('<|') && line.endsWith('|>')) {
      const inner = line.slice(2, line.length - 2).trim()
      if (foldCommand(inner, vocab, acc, observations) === 'end') {
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

  // Build a LOOSE candidate (location may be undefined ⇒ SCHEMA_MISSING_FIELD, a fair failure) and let
  // the shared validator judge it. We never fabricate a location — leniency covers only extra/unknown
  // lines, never a missing required field.
  const candidate = {
    scene_id: 'inline',
    header: { location: acc.location, present: [...acc.present], mood: acc.mood },
    beats: acc.beats,
    next
  }

  const v = validateScene(candidate, ctx)
  if (v.ok) return { ok: true, scene: v.scene, observations: uniq(observations) }
  return {
    ok: false,
    failures: v.failures,
    detail: v.detail,
    observations: uniq(observations)
  }
}
