import type { FloorFile } from '../../types/chat'
import type { GenContext } from '../generation/types'
import type { RunContext } from '../generation/runContext'
import { updateActiveFloorResponse } from '../floorService'
import { log } from '../logService'
import { AgentCatalog } from '../agentRuntime/catalog'
import { invocationRuntime } from '../agentRuntime/InvocationRuntimeService'
import { parseAnnotatedFloor } from '../../../shared/yuzu/annotatedFloor'
import { buildDirectorPrompt } from './directorPrompt'

/** Run the bound scene director once after the raw narrator floor has committed. Every failure is fail-open. */
export const runYuzuSceneDirector = async (
  ctx: RunContext,
  gen: GenContext,
  floor: FloorFile
): Promise<FloorFile> => {
  try {
    const catalog = new AgentCatalog(gen.profileId)
    const binding = catalog.getRoleBindings()['yuzu.sceneDirector']
    if (!binding) return floor
    const agent = catalog.get(binding)
    if (!agent?.enabled) return floor
    const prompt = buildDirectorPrompt(gen.profileId, gen.lorebookIds, floor.response.content)
    const outcome = await invocationRuntime().run({
      profileId: gen.profileId,
      chatId: gen.chatId,
      floor: floor.floor,
      agent: agent.name,
      options: {
        required: false,
        maxSteps: 1,
        maxRetryAttempts: 0,
        ...(agent.invocationConfig.apiPresetId
          ? { apiPresetId: agent.invocationConfig.apiPresetId }
          : {})
      },
      promptOverride: [{ role: 'system', content: [{ type: 'text', text: prompt }] }],
      acceptRawTextResult: true,
      restartOnSourceChange: false,
      skipResultIncorporation: true,
      signal: ctx.modelSignal ?? ctx.signal
    })
    if (outcome.status !== 'succeeded' || typeof outcome.result !== 'string') return floor
    if (!parseAnnotatedFloor(outcome.result)) return floor
    return (
      updateActiveFloorResponse(gen.profileId, gen.chatId, floor.floor, outcome.result) ?? floor
    )
  } catch (error) {
    log(
      'error',
      `Yuzu scene director failed open for chat ${gen.chatId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return floor
  }
}
