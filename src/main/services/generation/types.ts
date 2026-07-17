import { ChatSession, FloorFile } from '../../types/chat'
import { RPTerminalCard, Lorebook } from '../../types/character'
import { Settings, ModeConfig } from '../../types/models'
import { Preset } from '../../types/preset'

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
  /** Project Yuzu (ADR 0008 §7): VN play mode on for this session. When true the classic pipeline gains
   *  the YSS scene overlay + a raised output ceiling; when false the assembly is byte-identical to classic. */
  vnMode: boolean
  modeConfig: ModeConfig
  lorebookIds: string[]
  lorebooks: Lorebook[]
  floors: FloorFile[]
  lastFloor: FloorFile | undefined
  workingVars: Record<string, any>
  globals: Record<string, unknown>
  userName: string
  cacheLevel: number
  l1Mode: 'partition' | 'diff'
  floor0Vars: Record<string, unknown>
  frozenVars: Record<string, any>
  scanDepth: number
  maxRecursion: number
  scanText: string
}
