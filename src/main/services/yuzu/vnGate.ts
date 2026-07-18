import { streamProvider } from '../apiService'
import { resolveYuzuMaxTokens } from '../settingsService'
import { log } from '../logService'
import { parseMvuCommands, type ParsedMvu } from '../../parsers/mvuParser'
import type { ChatMessage as MainChatMessage } from '../promptBuilder'
import type { PresetParameters } from '../../types/preset'
import type { GenContext } from '../generation/types'
import type { RunContext } from '../nodes/types'
import type { YuzuGateOutcome, YuzuGateAttempt, YuzuGateTrace } from '../../types/chat'
import {
  parseScene,
  buildRepairMessages,
  toProseFallbackScene,
  FailureShape
} from '../../../shared/yuzu/sceneValidate'
import type { Scene, SceneVocabulary } from '../../../shared/yuzu/sceneSchema'
import { buildVnVocabulary } from './vnPrompt'

/**
 * Project Yuzu WP-S2 (ADR 0009) — the VN-mode acceptance gate: a mode-gated SEAM in the classic turn
 * pipeline. When a turn is in VN mode, the model's raw reply is run through the WP-B validation ladder
 * (parseScene → one bounded repair on STRUCTURAL failure → prose fallback) BEFORE the floor commits, so a
 * VN floor stores a validated Yuzu Scene Script (or a narration-only fallback), never a malformed one.
 * The gate also bridges the scene's `<| effect |>` beat effects into the classic MVU command grammar so
 * the floor's canonical `stat_data` folds them at generation (ADR 0008 §3).
 *
 * Boundaries: this is the ONLY place the ladder is composed on the response path. It never touches the
 * classic `resilientCall.ts` / `llm.sample` — the repair re-ask is a discrete, swappable strategy fn
 * ({@link YssRepairFn}) so a future agentic workflow can own YSS weaving without rewriting the gate. The
 * v1 impl ({@link streamProviderRepair}) does a single silent `streamProvider` re-ask. Never throws: an
 * abort during repair degrades to the prose fallback.
 */

// ---------------------------------------------------------------------------------------------------
// The repair seam (swappable strategy)
// ---------------------------------------------------------------------------------------------------

/** What the repair strategy is handed: the rejected reply + the ladder's structural verdict + the vocab. */
export interface YssRepairInput {
  /** The rejected raw reply, echoed back as the assistant turn. */
  priorRaw: string
  /** The scene-level (structural) failures that TRIGGERED repair. */
  failures: FailureShape[]
  /** The human-readable failure detail, quoted back to the model. */
  detail: string
  /** The legal-asset vocabulary, so the corrective can remind the model of valid ids. */
  vocab: SceneVocabulary
}

/** The per-turn context a repair strategy needs (the connection + budget + the abort signal). */
export interface YssRepairCtx {
  gen: GenContext
  signal: AbortSignal
}

/**
 * The acceptance gate's ONE swappable seam (ADR 0009 §2): "repair this YSS". Given the rejected reply and
 * the scene context, produce a repaired raw reply — or `null` to give up (the gate then falls to the prose
 * fallback). v1 is a direct `streamProvider` re-ask; a future agentic workflow implements the same contract.
 */
export type YssRepairFn = (input: YssRepairInput, ctx: YssRepairCtx) => Promise<{ raw: string } | null>

/**
 * v1 repair strategy: ONE bounded, silent `streamProvider` re-ask built from {@link buildRepairMessages},
 * budgeted by the VN max_tokens setting and honoring the turn's abort signal. Streams to NOTHING (the
 * player already saw the first reply stream; the repair is a corrective side call). Returns `null` on any
 * thrown error (incl. abort), so the gate degrades to the prose fallback rather than propagating.
 */
export const streamProviderRepair: YssRepairFn = async (input, { gen, signal }) => {
  const messages = buildRepairMessages(input)
  const params: PresetParameters = {
    ...gen.preset.parameters,
    max_tokens: resolveYuzuMaxTokens(gen.settings)
  }
  try {
    const raw = await streamProvider(
      gen.settings,
      messages as unknown as MainChatMessage[],
      params,
      () => {}, // silent: the repair delta never re-streams into the player-facing chat
      signal
    )
    return { raw }
  } catch {
    return null // thrown provider error / abort → give up, the gate falls to prose fallback
  }
}

// ---------------------------------------------------------------------------------------------------
// The structural / soft split (ADR 0008 §5 — only STRUCTURAL failures trigger repair)
// ---------------------------------------------------------------------------------------------------

/** The scene-level failures that TRIGGER a repair re-ask; every other FailureShape is a soft observation
 *  that never repairs (ADR 0008 §5). Kept explicit so the split is auditable at a glance. */
const STRUCTURAL_FAILURES: ReadonlySet<FailureShape> = new Set([
  FailureShape.SCHEMA_MISSING_FIELD,
  FailureShape.SCHEMA_WRONG_TYPE,
  FailureShape.BAD_CHOICE_SHAPE,
  FailureShape.EMPTY_OUTPUT
])

const isStructural = (failures: FailureShape[]): boolean =>
  failures.some((f) => STRUCTURAL_FAILURES.has(f))

// ---------------------------------------------------------------------------------------------------
// The effect → MVU-command bridge (main-side; shared stays main-free)
// ---------------------------------------------------------------------------------------------------

const EMPTY_MVU: ParsedMvu = { text: '', commands: [], patches: [] }

/**
 * Bridge a validated scene's `<| effect |>` beat effects into classic MVU commands (ADR 0009 §4). Effects
 * are raw MVU command strings collected in BEAT ORDER and joined newline-separated; `parseMvuCommands`
 * only extracts calls from inside an `<UpdateVariable>` block, so they are wrapped in one before parsing.
 * A scene with no effects yields an empty `ParsedMvu` (no allocation of a wrapper block).
 */
export const effectsToMvu = (scene: Scene): ParsedMvu => {
  const effects: string[] = []
  for (const beat of scene.beats) for (const e of beat.effects ?? []) effects.push(e)
  if (!effects.length) return EMPTY_MVU
  return parseMvuCommands(`<UpdateVariable>\n${effects.join('\n')}\n</UpdateVariable>`)
}

/**
 * Merge the scene's effect-derived commands with any stray classic `<UpdateVariable>` commands the model
 * left in the scene text (ADR 0008 §4 keeps these legal, attributing them to scene END). Effects fold
 * FIRST (they run inline through the scene), then the scene-end `<UpdateVariable>` block — the same order
 * `foldState` will apply them. The merged `text` comes from the classic parse (the effect wrapper is
 * synthetic and carries no narrative).
 */
export const mergeYuzuMvu = (effectsMvu: ParsedMvu, classicMvu: ParsedMvu): ParsedMvu => ({
  text: classicMvu.text,
  commands: [...effectsMvu.commands, ...classicMvu.commands],
  patches: [...effectsMvu.patches, ...classicMvu.patches]
})

// ---------------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------------

/** The gate's result: the validated/fallback scene text (what the floor stores), the parsed scene, the
 *  effect-derived MVU commands, and the full trace. */
export interface YuzuGateResult {
  /** The scene text the floor stores as its response — the validated/repaired reply, or the original raw
   *  on fallback (the prose-fallback scene wraps THIS text verbatim as narration). */
  finalRaw: string
  scene: Scene
  /** The effect-derived MVU commands (NOT yet merged with stray `<UpdateVariable>` — the node merges). */
  mvu: ParsedMvu
  trace: YuzuGateTrace
}

const attempt = (
  kind: 'initial' | 'repair',
  rawOut: string,
  parse: ReturnType<typeof parseScene>,
  ms: number
): YuzuGateAttempt => ({
  kind,
  rawOut,
  failures: parse.ok ? [] : parse.failures,
  observations: parse.observations,
  detail: parse.ok ? '' : parse.detail,
  ms
})

/**
 * Run the WP-B acceptance ladder over one VN-mode reply (ADR 0009 §1). Composition:
 *   1. Build the vocab from the session's lorebook ids (the SAME derivation the S1 overlay steers with).
 *   2. `parseScene(raw)` — lenient text→Scene. Clean ⇒ outcome `valid`.
 *   3. On a STRUCTURAL failure only (ADR 0008 §5), ONE repair via the injectable {@link YssRepairFn};
 *      re-parse. Clean ⇒ outcome `repaired`. (Soft observations never repair.)
 *   4. Still failing (or repair gave up / aborted) ⇒ `toProseFallbackScene(raw)`, outcome `fallback`.
 * Never throws. `finalRaw` is the successful/repaired scene text, or the original raw on fallback.
 */
export const runVnGate = async (
  ctx: RunContext,
  gen: GenContext,
  rawModelOutput: string,
  repair: YssRepairFn = streamProviderRepair
): Promise<YuzuGateResult> => {
  const started = Date.now()
  const vocab = buildVnVocabulary(gen.profileId, gen.lorebookIds)
  const signal = ctx.modelSignal ?? ctx.signal
  const attempts: YuzuGateAttempt[] = []

  const finish = (
    outcome: YuzuGateOutcome,
    scene: Scene,
    finalRaw: string,
    observations: FailureShape[]
  ): YuzuGateResult => {
    log('info', `[yuzu] acceptance gate → ${outcome} (${attempts.length} attempt(s))`)
    return {
      finalRaw,
      scene,
      mvu: effectsToMvu(scene),
      trace: {
        outcome,
        originalRaw: rawModelOutput,
        attempts,
        observations,
        totalMs: Date.now() - started
      }
    }
  }

  // --- Attempt 1 (the classic sample's reply) ---------------------------------------------------
  const a1Start = Date.now()
  const parse1 = parseScene(rawModelOutput, vocab)
  attempts.push(attempt('initial', rawModelOutput, parse1, Date.now() - a1Start))
  if (parse1.ok) return finish('valid', parse1.scene, rawModelOutput, parse1.observations)

  // --- Attempt 2 (one bounded repair — STRUCTURAL failures only) ---------------------------------
  if (isStructural(parse1.failures)) {
    const a2Start = Date.now()
    const repaired = await repair(
      { priorRaw: rawModelOutput, failures: parse1.failures, detail: parse1.detail, vocab },
      { gen, signal }
    )
    if (repaired) {
      const parse2 = parseScene(repaired.raw, vocab)
      attempts.push(attempt('repair', repaired.raw, parse2, Date.now() - a2Start))
      if (parse2.ok) return finish('repaired', parse2.scene, repaired.raw, parse2.observations)
    }
  }

  // --- Prose fallback (the floor) ---------------------------------------------------------------
  const scene = toProseFallbackScene(rawModelOutput, vocab)
  return finish('fallback', scene, rawModelOutput, parse1.observations)
}
