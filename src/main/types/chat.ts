import { FloorMetrics } from '../../shared/usageTypes'
import type { FailureShape } from '../../shared/yuzu/sceneValidate'
import type { Scene } from '../../shared/yuzu/sceneSchema'

/** Manual FSM mode for a session (Phase H). Each mode tunes generation + retrieval. */
export type ChatMode = 'explore' | 'dialogue' | 'combat'
export const CHAT_MODES: ChatMode[] = ['explore', 'dialogue', 'combat']

export interface FloorIndexEntry {
  floor: number
  timestamp: string
  user_preview: string
  response_preview: string
}

export interface ChatSession {
  id: string
  character_id: string
  created_at: string
  updated_at: string
  floor_count: number
  floor_index: FloorIndexEntry[]
  /** Active lorebook ids for this session; null = default to the character's own lorebook. */
  lorebook_ids: string[] | null
}

/** Project Yuzu WP-S2 (ADR 0009 §3) — the outcome of running the WP-B validation ladder on ONE VN-mode
 *  turn: how the acceptance gate resolved the model's reply. `'valid'` = the first attempt parsed clean;
 *  `'repaired'` = one bounded corrective re-ask produced a clean scene; `'fallback'` = both failed and the
 *  raw text was wrapped as a narration-only prose scene (never throws). */
export type YuzuGateOutcome = 'valid' | 'repaired' | 'fallback'

/** One provider round-trip inside the gate (the initial classic sample, or the single repair re-ask),
 *  recorded losslessly for post-hoc inspection (WP-I reads this back). */
export interface YuzuGateAttempt {
  kind: 'initial' | 'repair'
  /** The raw provider text this attempt produced (with any inlined reasoning). */
  rawOut: string
  /** Scene-level failures from the ladder (empty when the attempt validated). */
  failures: FailureShape[]
  /** Non-fatal observations (THINK_WRAPPED / UNKNOWN_ASSET_ID / TRUNCATED …). */
  observations: FailureShape[]
  /** Human-readable failure/observation detail preserved from the ladder. */
  detail: string
  /** Wall-clock ms for this attempt. */
  ms: number
}

/** The full gate trace persisted on a VN floor (ADR 0009 §3) — mirrors the `plot_block` optional-field
 *  precedent: written ONLY for VN floors, absent (and byte-identical) on classic floors. */
export interface YuzuGateTrace {
  outcome: YuzuGateOutcome
  /** The provider's original (pre-repair) raw reply. */
  originalRaw: string
  attempts: YuzuGateAttempt[]
  /** The final scene's non-fatal observations. */
  observations: FailureShape[]
  /** Wall-clock ms for the whole gate (ladder + any repair). */
  totalMs: number
}

/** Turn-scoped stash the acceptance gate leaves on `GenContext.yuzuGate` for the terminal write stage
 *  (ADR 0009 §1): the validated/fallback scene text that becomes the floor's stored response, the parsed
 *  scene, and the trace. Never serialized on its own — it is folded into the floor at `output.writeFloor`. */
export interface YuzuGateStash {
  finalRaw: string
  scene: Scene
  trace: YuzuGateTrace
}

export interface FloorFile {
  floor: number
  chat_id: string
  timestamp: string
  user_message: {
    content: string
    timestamp: string
  }
  response: {
    content: string
    model: string
    provider: string
  }
  /** Alternate responses for this floor (TH swipes). swipes[swipe_id] === response.content;
   * absent/empty ⇒ a single-swipe floor (legacy). */
  swipes?: string[]
  /** Index of the active swipe within `swipes`. */
  swipe_id?: number
  /** State events extracted from this floor's response (rpt-event tags). */
  events: Array<{ type: string; path: string; value: unknown; action: string }>
  /** Cumulative game state after applying this floor's events. */
  variables: Record<string, unknown>
  /** The full provider prompt (message array) that produced this floor — stored losslessly for
   * inspection/replay. Absent on legacy floors saved before this was captured. */
  request?: Array<{ role: string; content: string }>
  /** Cache/token metrics for this floor (this turn's numbers + a cumulative snapshot).
   * Absent on greeting/legacy floors that never went through a metered generation. */
  metrics?: FloorMetrics
  /** Display-only "plot block" produced by `memory.recall` (plot-recall data layer): the planner's
   * directive, formatted for the beautification regex to render. Present only when recall emitted one;
   * it is NOT part of the prompt or the response and never feeds generation. */
  plot_block?: string
  /** Project Yuzu WP-S2 (ADR 0009 §3): the acceptance-gate trace for a VN-mode floor — how the WP-B
   * ladder resolved this turn's scene (raw in/out, repair attempts, observations, timings). Written ONLY
   * for VN floors (mirrors `plot_block`); classic floors never carry it, so they stay byte-identical. */
  yuzu_trace?: YuzuGateTrace
}
