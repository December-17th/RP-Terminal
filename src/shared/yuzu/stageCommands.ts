import { NARRATION_SPEAKER, type Scene, type SpriteOp } from './sceneSchema'

/**
 * Project Yuzu WP-D1 — the stage command stream + player-interaction contract (the future skin protocol).
 *
 * This module is the boundary of ADR 0005: the runtime owns state; a stage/skin owns pixels. It defines
 * BOTH halves of that boundary as pure, transport-agnostic types:
 *
 *   - `StageCommand` — the OUTBOUND presentation stream. Everything a stage (native default OR a project
 *     skin) must render to reproduce a beat: backdrop, sprites, CG, audio intents, the displayed line, and
 *     the end-of-scene interaction, plus scene-boundary markers. A well-typed command must never make a
 *     stage throw (see `stageReducer.ts` for the tolerant fold).
 *   - `PlayerInteraction` — the INBOUND event stream. The typed player events a stage emits back: advance,
 *     select a choice, submit a free action. Nothing else crosses the boundary — a skin never touches state
 *     (ADR 0005: "input returns only as typed player interactions").
 *
 * `sceneToCommands` is the deterministic beat → commands derivation (ADR 0008 §2.5 deterministic playback):
 * the same `Scene` always yields the same command groups, so folding them reconstructs the same stage.
 *
 * EFFECTS ARE NOT COMMANDS. `Beat.effects` are opaque MVU command strings (ADR 0008 §4) that mutate
 * *canonical* story state, not presentation. They are deliberately SKIPPED here — the displayed-state view
 * (a separate WP; ADR 0008 §3 / design §2.6) owns applying effects up to the beat cursor. A stage renders
 * pixels; it never sees or applies an effect. This is load-bearing: the command stream is replay-safe
 * precisely because it carries zero canon mutations.
 *
 * This union IS the skin protocol later (PP phase), so every variant is documented and the shape is
 * additive-only: new variants / optional fields may be added, existing ones never repurposed. It is
 * derived strictly from what YSS v0 (`sceneGrammar.ts`) can actually emit — no capability is invented that
 * a beat cannot express — with a little room reserved additively (noted per field).
 */

// ---------------------------------------------------------------------------------------------------
// Small shared vocab
// ---------------------------------------------------------------------------------------------------

/** A sprite stage position. Mirrors `SpriteOp.position` (YSS `left|center|right`). */
export type StageSlot = SpriteOp['position']

/**
 * A backdrop transition hint. YSS v0 has NO transition verb, so derivation always emits `'fade'`; the
 * field exists as additive room for a future `<| transition … |>` and for skins that honor a cut. A stage
 * may ignore it entirely.
 */
export type Transition = 'cut' | 'fade'

/**
 * The kind of a displayed line. YSS v0 emits only `'dialogue'` (a `speaker: text` line for a known actor)
 * and `'narration'` (the `narration` speaker / any bare prose line). `'thought'` is reserved additively —
 * the grammar has no thought syntax yet, so derivation never emits it, but the protocol admits it so a
 * future YSS verb needs no breaking change. A stage must render an unknown-to-it kind as plain text.
 */
export type LineKind = 'dialogue' | 'narration' | 'thought'

/** A player-facing choice: display text + its intent tag. Mirrors the scene `Choice` (no mechanics). */
export interface ChoiceOption {
  text: string
  intent: string
}

// ---------------------------------------------------------------------------------------------------
// StageCommand — the outbound presentation stream
// ---------------------------------------------------------------------------------------------------

/**
 * `scene-begin` — boundary marker opening a scene. Carries the header the skin may use to preload/frame
 * (scene id, declared location, cast present). It does NOT set the backdrop — the backdrop is single-
 * sourced from `set-backdrop` (a scene may have no bg beat, in which case the previous backdrop persists,
 * design §3.7). Emitted once, at the very front of the first beat's command group.
 */
export interface SceneBeginCommand {
  type: 'scene-begin'
  sceneId: string
  location: string
  /** Actor ids the scene header declares present (steering/preload hint; not a render command). */
  present: readonly string[]
}

/** `set-mood` — set the scene mood (free text, e.g. `tense`). From the YSS header `mood`; emitted once if present. */
export interface SetMoodCommand {
  type: 'set-mood'
  mood: string
}

/** `set-backdrop` — change the background to `backdrop` (a location id). `transition` is a hint (see {@link Transition}). */
export interface SetBackdropCommand {
  type: 'set-backdrop'
  backdrop: string
  transition: Transition
}

/**
 * `sprite-enter` — bring `actor` onto the stage at `slot` (default `center` when absent) with `expression`.
 * Upsert semantics in the reducer: entering an already-present actor replaces its slot in place.
 */
export interface SpriteEnterCommand {
  type: 'sprite-enter'
  actor: string
  slot?: StageSlot
  expression?: string
}

/** `sprite-exit` — remove `actor` from the stage. No-op if the actor is not present (tolerant). */
export interface SpriteExitCommand {
  type: 'sprite-exit'
  actor: string
}

/** `sprite-move` — reposition an already-present `actor` to `slot`. No-op if absent (can't move nothing). */
export interface SpriteMoveCommand {
  type: 'sprite-move'
  actor: string
  slot?: StageSlot
}

/**
 * `sprite-update` — change a present actor's expression and/or slot WITHOUT an enter/exit/move (YSS
 * `<| kaede smile center |>` with no action word). Upsert semantics: if the actor is absent it is added
 * (implicit appearance) — the YSS verb's job is "show/animate an actor sprite".
 */
export interface SpriteUpdateCommand {
  type: 'sprite-update'
  actor: string
  expression?: string
  slot?: StageSlot
}

/** `cg-show` — show CG image `cg`, replacing any active CG (last wins). */
export interface CgShowCommand {
  type: 'cg-show'
  cg: string
}

/** `cg-clear` — hide the active CG. No-op if none is active (tolerant). */
export interface CgClearCommand {
  type: 'cg-clear'
}

/** `music-set` — play/replace the music track `track`. Replaces whatever was playing. */
export interface MusicSetCommand {
  type: 'music-set'
  track: string
}

/** `music-stop` — stop music (YSS `<| music stop |>`). Clears the music channel; safe when already silent. */
export interface MusicStopCommand {
  type: 'music-stop'
}

/** `ambience-set` — play/replace the ambience loop `loop`. */
export interface AmbienceSetCommand {
  type: 'ambience-set'
  loop: string
}

/**
 * `sfx-fire` — play a one-shot sound. This is a transient INTENT, not durable channel state: the reducer
 * records the last-fired id for inspection/replay but nothing "holds" it (a stage plays it and forgets).
 */
export interface SfxFireCommand {
  type: 'sfx-fire'
  sfx: string
}

/**
 * `show-line` — display a beat's line. `speaker` is an actor id or `'narration'`; `kind` distinguishes
 * dialogue from narration (see {@link LineKind}). This is the beat's readable content.
 */
export interface ShowLineCommand {
  type: 'show-line'
  speaker: string
  text: string
  kind: LineKind
}

/**
 * `present-interaction` — the end-of-scene player prompt (from `Scene.next`). Either a non-empty choice
 * list (`mode: 'choices'`) OR a free-action prompt (`mode: 'free-input'`) — never both (design §2.8).
 */
export type PresentInteractionCommand =
  | { type: 'present-interaction'; mode: 'choices'; choices: readonly ChoiceOption[] }
  | { type: 'present-interaction'; mode: 'free-input' }

/** `scene-end` — boundary marker: all beats are exhausted (the YSS `<| end |>`). Marks the scene complete. */
export interface SceneEndCommand {
  type: 'scene-end'
}

/**
 * The full outbound presentation protocol. A stage/skin renders these; it never applies effects or mutates
 * canon (ADR 0005 / ADR 0008 §3).
 */
export type StageCommand =
  | SceneBeginCommand
  | SetMoodCommand
  | SetBackdropCommand
  | SpriteEnterCommand
  | SpriteExitCommand
  | SpriteMoveCommand
  | SpriteUpdateCommand
  | CgShowCommand
  | CgClearCommand
  | MusicSetCommand
  | MusicStopCommand
  | AmbienceSetCommand
  | SfxFireCommand
  | ShowLineCommand
  | PresentInteractionCommand
  | SceneEndCommand

/** Discriminant literals of {@link StageCommand}, for exhaustiveness checks in consumers/tests. */
export type StageCommandType = StageCommand['type']

// ---------------------------------------------------------------------------------------------------
// PlayerInteraction — the inbound event stream (the reverse half of the boundary)
// ---------------------------------------------------------------------------------------------------

/** `advance` — reveal the next beat (a click / auto-play tick). Carries no payload. */
export interface AdvanceInteraction {
  type: 'advance'
}

/** `select-choice` — the player picked choice `index`; `intent` echoes that choice's intent tag (design §2.8). */
export interface SelectChoiceInteraction {
  type: 'select-choice'
  index: number
  intent: string
}

/** `submit-free-action` — the player typed a freeform action when the scene ended without choices. */
export interface SubmitFreeActionInteraction {
  type: 'submit-free-action'
  text: string
}

/**
 * The full inbound protocol: the only events a stage may emit back to the runtime. A stage produces these;
 * it never writes state directly (ADR 0005). Additive-only, like {@link StageCommand}.
 */
export type PlayerInteraction =
  | AdvanceInteraction
  | SelectChoiceInteraction
  | SubmitFreeActionInteraction

// ---------------------------------------------------------------------------------------------------
// Derivation: Scene → command groups
// ---------------------------------------------------------------------------------------------------

/**
 * Order of commands WITHIN one beat's group. Fixed and documented so derivation is deterministic and a
 * skin can rely on it: backdrop, then CG, then audio, then sprites, then the line. (Effects are skipped.)
 */
const beatToCommands = (beat: Scene['beats'][number]): StageCommand[] => {
  const out: StageCommand[] = []

  // 1) Backdrop. YSS v0 has no transition verb, so always the default 'fade' hint.
  if (beat.bg !== undefined)
    out.push({ type: 'set-backdrop', backdrop: beat.bg, transition: 'fade' })

  // 2) CG. `null` is an explicit clear; a string is a show. `undefined` means the beat says nothing about CG.
  if (beat.cg === null) out.push({ type: 'cg-clear' })
  else if (beat.cg !== undefined) out.push({ type: 'cg-show', cg: beat.cg })

  // 3) Audio. An EMPTY audio object is the YSS "music stop" marker (sceneValidate foldCommand). Otherwise
  //    each present channel becomes its own intent, in a fixed order.
  if (beat.audio !== undefined) {
    const { music, ambience, sfx } = beat.audio
    if (music === undefined && ambience === undefined && sfx === undefined) {
      out.push({ type: 'music-stop' })
    } else {
      if (music !== undefined) out.push({ type: 'music-set', track: music })
      if (ambience !== undefined) out.push({ type: 'ambience-set', loop: ambience })
      if (sfx !== undefined) out.push({ type: 'sfx-fire', sfx })
    }
  }

  // 4) Sprites. The YSS action word selects the command; no action word ⇒ sprite-update (show/animate).
  for (const sp of beat.sprites ?? []) {
    switch (sp.action) {
      case 'enter':
        out.push({
          type: 'sprite-enter',
          actor: sp.actor,
          slot: sp.position,
          expression: sp.expression
        })
        break
      case 'exit':
        out.push({ type: 'sprite-exit', actor: sp.actor })
        break
      case 'move':
        out.push({ type: 'sprite-move', actor: sp.actor, slot: sp.position })
        break
      default:
        out.push({
          type: 'sprite-update',
          actor: sp.actor,
          expression: sp.expression,
          slot: sp.position
        })
        break
    }
  }

  // 5) Line (dialogue / narration). Effects on this beat are intentionally NOT emitted (canon, not pixels).
  if (beat.line !== undefined) {
    const speaker = beat.speaker ?? NARRATION_SPEAKER
    out.push({
      type: 'show-line',
      speaker,
      text: beat.line,
      kind: speaker === NARRATION_SPEAKER ? 'narration' : 'dialogue'
    })
  }

  return out
}

/**
 * Derive the end-of-scene interaction command from `Scene.next`: a non-empty choice list ⇒ a choices
 * prompt; otherwise a free-action prompt (design §2.8).
 */
const interactionCommand = (next: Scene['next']): PresentInteractionCommand => {
  const choices = next.choices ?? []
  if (choices.length > 0) {
    return {
      type: 'present-interaction',
      mode: 'choices',
      choices: choices.map((c) => ({ text: c.text, intent: c.intent }))
    }
  }
  return { type: 'present-interaction', mode: 'free-input' }
}

/**
 * Deterministic derivation of a `Scene` into per-beat command groups — THE beat → presentation mapping
 * (ADR 0008 §2.5). Return shape: `StageCommand[][]` of length `beats.length + 1`, chosen so the outer
 * index lines up with the beat cursor:
 *
 *   - group `i` for `i < beats.length` = the commands rendering beat `i`. Group 0 is PREFIXED with
 *     `scene-begin` (+ `set-mood` when the header carries a mood), so opening a scene is folded in with its
 *     first beat rather than needing a phantom pre-beat cursor.
 *   - the FINAL group (index `beats.length`) is the post-beats step: `present-interaction` then `scene-end`.
 *
 * With this alignment the load-bearing property holds by construction: **the stage state at beat N is
 * exactly `stageReducer`-folded over the concatenation of groups 0..N** (`initialStageState` seeded).
 * Folding the whole array (through the final group) yields the terminal state (pending interaction + scene
 * complete).
 *
 * Effects are skipped entirely (see the module header): they mutate canon, not the stage, so they never
 * appear in this stream.
 */
export const sceneToCommands = (scene: Scene): StageCommand[][] => {
  const groups: StageCommand[][] = scene.beats.map((beat) => beatToCommands(beat))

  // Prefix the opening boundary onto the first beat's group.
  const opening: StageCommand[] = [
    {
      type: 'scene-begin',
      sceneId: scene.scene_id,
      location: scene.header.location,
      present: [...scene.header.present]
    }
  ]
  if (scene.header.mood !== undefined) opening.push({ type: 'set-mood', mood: scene.header.mood })
  groups[0] = [...opening, ...(groups[0] ?? [])]

  // Trailing group: present the interaction, then mark the scene complete.
  groups.push([interactionCommand(scene.next), { type: 'scene-end' }])

  return groups
}

/** Convenience: the flat command stream (groups concatenated in order). Folding this = the terminal state. */
export const sceneToCommandStream = (scene: Scene): StageCommand[] => sceneToCommands(scene).flat()
