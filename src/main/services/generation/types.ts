import { ChatSession, FloorFile, YuzuGateStash } from '../../types/chat'
import { RPTerminalCard, Lorebook } from '../../types/character'
import { Settings, ModeConfig } from '../../types/models'
import { Preset } from '../../types/preset'
import { ExecutionRecord } from '../../../shared/executionRecord'

/**
 * Everything `generate()` needs to run one turn, assembled up front by `buildGenContext`.
 * Carved out of the `generate()` monolith (Phase 2b-1a) so the setup block is testable
 * and reusable on its own; the rest of `generate()` reads from this instead of re-deriving it.
 */
export interface GenContext {
  profileId: string
  chatId: string
  userAction: string
  chat: ChatSession
  card: RPTerminalCard
  settings: Settings
  preset: Preset
  fsmEnabled: boolean
  mode: string
  /** ST generation type (`normal` | `regenerate` | `swipe` | `continue` | `impersonate` | `quiet`),
   *  lowercased, driving preset `injection_trigger` filtering (promptBuilder.resolveEffectivePrompts).
   *  Seeded per turn from the entry point; 'normal' for a plain player send / a background read. */
  generationType: string
  /** VN presentation mode for this session. Narration still uses the unchanged Classic prompt/preset. */
  vnMode: boolean
  modeConfig: ModeConfig
  lorebookIds: string[]
  lorebooks: Lorebook[]
  floors: FloorFile[]
  lastFloor: FloorFile | undefined
  workingVars: Record<string, any>
  /** Snapshot immediately before this floor's model fold; persisted once for exact floor-0 replay. */
  floorStateBaseline?: Record<string, unknown>
  globals: Record<string, unknown>
  userName: string
  cacheLevel: number
  l1Mode: 'partition' | 'diff'
  floor0Vars: Record<string, unknown>
  frozenVars: Record<string, any>
  scanDepth: number
  maxRecursion: number
  scanText: string
  /**
   * ADR 0023 (Assembly Epoch): the chat's epoch READ AT CONTEXT-BUILD TIME — i.e. before this turn's
   * assembly reads any lorebook / preset / regex / variable input. `persistFloor` stamps THIS value on
   * the floor, never a fresh read: a re-read at persist time sits on the far side of the model call, so
   * an edit landing mid-stream would be folded into the stamp and a prompt assembled under the OLD
   * epoch would look current to Resample. Stamping the build-time epoch keeps the failure direction
   * safe — a mid-turn edit leaves the floor stamped stale and forces a full reassembly.
   */
  assemblyEpoch: number
  /**
   * Turn-scoped carrier for the forensic Execution Record (issue 09). `buildGenContext` never sets
   * this; the assemble STAGE (`prompt.assemble` / `prompt.preset`) stamps the just-built record here so
   * the terminal write stage (`persistFloor`) can persist it WITHOUT a dedicated graph edge — both
   * stages read the same `gen` object from their common upstream, so the write side sees what assemble
   * stamped. Absent (undefined) on any graph whose assemble→write path doesn't share `gen`
   * (e.g. a `context.refresh` between them) — persistence then simply skips, best-effort. Never
   * serialized: `gen` is turn-scoped and dropped after the turn.
   */
  executionRecord?: ExecutionRecord
  /**
   * Project Yuzu WP-S2 (ADR 0009 §1): the acceptance gate's turn-scoped stash. In VN mode `parse.response`
   * runs the WP-B ladder and leaves the validated/fallback scene text + parsed scene + trace here; the
   * terminal write stage (`output.writeFloor`) reads it to store `finalRaw` as the floor response and to
   * persist `yuzu_trace`. Absent on classic turns and on any graph whose parse→write path doesn't share
   * `gen` — the write side then simply persists a classic floor. Never serialized (turn-scoped).
   */
  yuzuGate?: YuzuGateStash
}
