import { getSettings, resolveModeConfig } from '../settingsService'
import { getActivePreset } from '../presetService'
import { getCharacter } from '../characterService'
import { getLorebookById } from '../lorebookService'
import { getChat, getChatLorebookIds, getChatMode, isYuzuMode } from '../chatService'
import { getAllFloors, getFloorRequest } from '../floorService'
import { buildScanText } from '../promptBuilder'
import { loadGlobals } from '../templateService'
import { frozenVarsFor } from '../cacheLayers'
import { Lorebook } from '../../types/character'
import { GenContext } from './types'

/**
 * Assemble everything `generate()` needs to run one turn: chat/card/settings/preset,
 * the FSM mode + its tuning, session lorebooks, floor history + seeded working variables,
 * the L1 cache snapshot, and the lore-scan window text. Moved verbatim out of `generate()`
 * (Phase 2b-1a) — same service calls, same error throws, same behavior.
 */
export const buildGenContext = (
  profileId: string,
  chatId: string,
  userAction: string
): GenContext => {
  const chat = getChat(profileId, chatId)
  if (!chat) throw new Error('Chat session not found')

  const card = getCharacter(profileId, chat.character_id)
  if (!card) throw new Error('Character card not found')

  const settings = getSettings(profileId)
  const preset = getActivePreset(profileId)
  // The FSM is on in 'manual' and 'agentic' agent modes (agentic adds auto-routing — TBD,
  // so it behaves like manual for now). It enables per-mode tuning (retrieval breadth,
  // output ceiling, system addendum) + L2 cache-on-transition. 'off' = classic: ST-style,
  // no FSM tuning, lore re-matched every turn (fully dynamic keywords).
  // TODO(agentic): when agent.mode === 'agentic', classify intent here and setChatMode().
  const fsmEnabled = settings.agent?.mode === 'manual' || settings.agent?.mode === 'agentic'
  const mode = getChatMode(profileId, chatId)
  // Project Yuzu (ADR 0008 §7): the VN-mode flag, read once per turn (cheap column read) — orthogonal to
  // the FSM `mode`. Off = classic assembly is byte-identical.
  const vnMode = isYuzuMode(profileId, chatId)
  const modeConfig = resolveModeConfig(settings, mode)
  // A session injects all its selected lorebooks; with none chosen it defaults to
  // the character's own lorebook (id == characterId), preserving prior behavior.
  const lorebookIds = getChatLorebookIds(profileId, chatId) ?? [chat.character_id]
  const lorebooks = lorebookIds
    .map((id) => getLorebookById(profileId, id))
    .filter((lb): lb is Lorebook => lb !== null)
  const floors = getAllFloors(profileId, chatId, chat.floor_count)

  // Seed the working variables from the latest floor; ST-Prompt-Template code in
  // authored content (getvar/setvar/…) reads and mutates these during the build.
  const lastFloor = floors[floors.length - 1]
  // Bulk floor reads are lean (no `request`), but the cache meter (computeMetrics) anchors this
  // turn's proxy against the PREVIOUS floor's stored prompt — fetch just that one on demand.
  if (lastFloor) lastFloor.request = getFloorRequest(profileId, chatId, lastFloor.floor)
  const workingVars: Record<string, any> = JSON.parse(JSON.stringify(lastFloor?.variables ?? {}))
  const globals = loadGlobals(profileId)
  const userName = settings.persona?.name || 'User'

  // Prompt-cache level (L1 Frozen Core when ≥1). The frozen snapshot is derived from the
  // FIRST floor's variables — constant across the session — so the frontier render is
  // byte-stable. 'partition' shows placeholders for state; 'diff' shows the floor-0 values.
  // ⚠️ STASHED (WS-2, 2026-06-26): the cache system is parked — the UI selector is greyed out and pinned
  // to `baseline` (no optimization at all, not even provider caching). Frozen Core is reachable only via
  // the dormant `mode: 'frozen'`. So in production cacheLevel is 0. See the design doc's status note.
  const cacheLevel = settings.cache?.mode === 'frozen' ? (settings.cache?.level ?? 1) : 0
  const l1Mode = settings.cache?.l1_mode ?? 'partition'
  const floor0Vars = floors[0]?.variables ?? {}
  const frozenVars = cacheLevel >= 1 ? frozenVarsFor(l1Mode, floor0Vars) : {}

  const scanDepth = fsmEnabled
    ? (modeConfig.scan_depth ?? settings.lorebook?.scan_depth ?? 3)
    : (settings.lorebook?.scan_depth ?? 3)
  const maxRecursion = settings.lorebook?.max_recursion ?? 0
  const scanText = buildScanText(floors, userAction, scanDepth)

  return {
    profileId,
    chatId,
    userAction,
    chat,
    card,
    settings,
    preset,
    fsmEnabled,
    mode,
    vnMode,
    modeConfig,
    lorebookIds,
    lorebooks,
    floors,
    lastFloor,
    workingVars,
    globals,
    userName,
    cacheLevel,
    l1Mode,
    floor0Vars,
    frozenVars,
    scanDepth,
    maxRecursion,
    scanText
  }
}
