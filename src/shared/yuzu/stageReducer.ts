import type { LineKind, PresentInteractionCommand, StageCommand, StageSlot } from './stageCommands'

/**
 * Project Yuzu WP-D1 — the pure stage reducer: the deterministic fold of a {@link StageCommand} stream
 * into renderable {@link StageState}.
 *
 * This is the load-bearing half of deterministic playback (ADR 0008 §2.5 / design §2.5): **the stage at
 * beat N is EXACTLY `initialStageState()` folded over every command through beat N** — there is no other
 * source of stage truth. Because the fold is pure and total, reconstruction after reload/rollback is just
 * "replay the commands to the saved cursor", and replaying the same commands always yields the same state.
 *
 * Two invariants keep that promise:
 *   1. **No time in state.** The reducer holds zero clocks/timers — pacing, auto-play, and reveal timing
 *      are the player/stage's job (design §2.5 "the runtime owns animation timing" lives in the STAGE, not
 *      here). Feeding the same commands out of any real-time context reproduces the same states.
 *   2. **Total & tolerant.** Every well-typed command is accepted; none throws. Edge cases (move/exit of an
 *      absent actor, clear with no CG, stop with no music) resolve to documented, benign outcomes so a
 *      buggy scene degrades gracefully instead of crashing the stage (design §3.7 fallbacks).
 *
 * Effects never reach here — they are not commands (see `stageCommands.ts`); canon/displayed-state folding
 * is a separate concern.
 */

/** One occupied sprite slot on the stage. `position` always resolves to a concrete slot (default center). */
export interface SpriteSlot {
  actor: string
  position: StageSlot
  expression?: string
}

/** The current displayed line, or null before any line has shown in the scene. */
export interface DisplayedLine {
  speaker: string
  text: string
  kind: LineKind
}

/** Scene-boundary bookkeeping: which scene is playing and whether its beats are exhausted. */
export interface SceneBoundary {
  sceneId: string
  location: string
  present: readonly string[]
  /** True once `scene-end` has folded in — every beat has been revealed. */
  complete: boolean
}

/**
 * The complete renderable stage. A pure function of the commands folded so far — everything a stage needs
 * to paint the current frame, and nothing a stage should not own (no canon, no effects, no time).
 */
export interface StageState {
  /** Scene boundary, or null before any `scene-begin` has folded in. */
  scene: SceneBoundary | null
  /** Free-text scene mood, or null when unset. */
  mood: string | null
  /** Current background/location id, or null when no backdrop has been set yet. */
  backdrop: string | null
  /** Ordered sprite slots (insertion order preserved), keyed by actor within. */
  sprites: readonly SpriteSlot[]
  /** Active CG image id, or null when none is shown. */
  cg: string | null
  /** Current music track id, or null when silent. */
  music: string | null
  /** Current ambience loop id, or null when none. */
  ambience: string | null
  /** Last one-shot sfx id fired (transient intent; recorded for inspection/replay), or null. */
  lastSfx: string | null
  /** The current displayed line, or null before the first line of the scene. */
  line: DisplayedLine | null
  /** Pending end-of-scene interaction, or null while beats are still playing. */
  interaction: PresentInteractionCommand | null
}

/** The empty stage: the seed for every fold. A fresh object each call (never share mutable state). */
export const initialStageState = (): StageState => ({
  scene: null,
  mood: null,
  backdrop: null,
  sprites: [],
  cg: null,
  music: null,
  ambience: null,
  lastSfx: null,
  line: null,
  interaction: null
})

// ---------------------------------------------------------------------------------------------------
// Sprite-list helpers (pure; return new arrays)
// ---------------------------------------------------------------------------------------------------

/**
 * Upsert a sprite: replace the actor's slot in place if present (preserving order), else append. Missing
 * command fields fall back to the actor's existing value, then to a `center` default position. Shared by
 * `sprite-enter` (may animate in) and `sprite-update` (in-place change) — identical STATE effect; the two
 * commands differ only as a rendering hint for the stage.
 */
const upsertSprite = (
  sprites: readonly SpriteSlot[],
  actor: string,
  slot: StageSlot | undefined,
  expression: string | undefined
): readonly SpriteSlot[] => {
  const idx = sprites.findIndex((s) => s.actor === actor)
  const prev = idx >= 0 ? sprites[idx] : undefined
  const next: SpriteSlot = {
    actor,
    position: slot ?? prev?.position ?? 'center',
    expression: expression ?? prev?.expression
  }
  if (idx < 0) return [...sprites, next]
  const copy = sprites.slice()
  copy[idx] = next
  return copy
}

/** Reposition a present actor; a no-op (returns the same array) when the actor is absent. */
const moveSprite = (
  sprites: readonly SpriteSlot[],
  actor: string,
  slot: StageSlot | undefined
): readonly SpriteSlot[] => {
  const idx = sprites.findIndex((s) => s.actor === actor)
  if (idx < 0) return sprites
  const copy = sprites.slice()
  copy[idx] = { ...copy[idx], position: slot ?? copy[idx].position }
  return copy
}

/** Remove an actor; a no-op (returns the same array) when the actor is absent. */
const removeSprite = (sprites: readonly SpriteSlot[], actor: string): readonly SpriteSlot[] => {
  const idx = sprites.findIndex((s) => s.actor === actor)
  if (idx < 0) return sprites
  return [...sprites.slice(0, idx), ...sprites.slice(idx + 1)]
}

// ---------------------------------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------------------------------

/**
 * Fold ONE command into the stage. Pure, total, and never throws on a well-typed command. Returns a new
 * `StageState` (the input is never mutated), so folding an array with `Array.prototype.reduce` from
 * `initialStageState()` reconstructs the stage at any cursor.
 *
 * Tolerant-semantics summary (each documented at its case):
 *   - `sprite-move` / `sprite-exit` of an absent actor → no-op.
 *   - `cg-clear` with no active CG, `music-stop` with no music → clear-to-null (idempotent).
 *   - `cg-show` over an active CG, `music-set` over a playing track → replace (last wins).
 *   - `sprite-enter` / `sprite-update` → upsert (add if absent, replace-in-place if present).
 */
export const stageReducer = (state: StageState, command: StageCommand): StageState => {
  switch (command.type) {
    case 'scene-begin':
      // Open a scene: set the boundary and clear scene-scoped bookkeeping (pending interaction, complete
      // flag). It deliberately does NOT reset presentation channels (backdrop/sprites/audio) — carrying or
      // resetting the stage across scenes is a higher-WP/player decision; folding a single scene from
      // `initialStageState()` is unaffected either way.
      return {
        ...state,
        scene: {
          sceneId: command.sceneId,
          location: command.location,
          present: command.present,
          complete: false
        },
        interaction: null
      }

    case 'set-mood':
      return { ...state, mood: command.mood }

    case 'set-backdrop':
      // `transition` is a stage-only hint; it changes no state beyond the backdrop id.
      return { ...state, backdrop: command.backdrop }

    case 'sprite-enter':
      return {
        ...state,
        sprites: upsertSprite(state.sprites, command.actor, command.slot, command.expression)
      }

    case 'sprite-update':
      return {
        ...state,
        sprites: upsertSprite(state.sprites, command.actor, command.slot, command.expression)
      }

    case 'sprite-move':
      return { ...state, sprites: moveSprite(state.sprites, command.actor, command.slot) }

    case 'sprite-exit':
      return { ...state, sprites: removeSprite(state.sprites, command.actor) }

    case 'cg-show':
      return { ...state, cg: command.cg }

    case 'cg-clear':
      return { ...state, cg: null }

    case 'music-set':
      return { ...state, music: command.track }

    case 'music-stop':
      return { ...state, music: null }

    case 'ambience-set':
      return { ...state, ambience: command.loop }

    case 'sfx-fire':
      // A transient intent: record the last id so replay is faithful and the inspector can see it.
      return { ...state, lastSfx: command.sfx }

    case 'show-line':
      return {
        ...state,
        line: { speaker: command.speaker, text: command.text, kind: command.kind }
      }

    case 'present-interaction':
      return { ...state, interaction: command }

    case 'scene-end':
      return { ...state, scene: state.scene ? { ...state.scene, complete: true } : null }

    default: {
      // Exhaustiveness guard: if a new StageCommand variant is added, this fails to compile until handled.
      // At runtime, an unknown-but-typed command is tolerated (returns state unchanged — never throws).
      const _exhaustive: never = command
      void _exhaustive
      return state
    }
  }
}

/** Fold a whole command stream from the empty stage — the terminal (or cursor-N) reconstruction helper. */
export const foldCommands = (commands: readonly StageCommand[]): StageState =>
  commands.reduce(stageReducer, initialStageState())
