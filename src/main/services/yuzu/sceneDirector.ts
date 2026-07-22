import type { FloorFile } from '../../types/chat'
import type { GenContext } from '../generation/types'
import type { RunContext } from '../generation/runContext'
import { updateActiveFloorResponse } from '../floorService'
import { log } from '../logService'
import { AgentCatalog } from '../agentRuntime/catalog'
import { invocationRuntime } from '../agentRuntime/InvocationRuntimeService'
import { parseAnnotatedFloor } from '../../../shared/yuzu/annotatedFloor'
import { buildDirectorInput, buildDirectorPrompt } from './directorPrompt'

const relationshipActors = (floor: FloorFile): string[] => {
  const statData = floor.variables?.stat_data
  if (!statData || typeof statData !== 'object' || Array.isArray(statData)) return []
  const relationships = (statData as Record<string, unknown>)['关系列表']
  if (!relationships || typeof relationships !== 'object' || Array.isArray(relationships)) return []
  return Object.keys(relationships as Record<string, unknown>)
}

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
    const portableProcessing =
      agent.effective?.formatVersion === 2 &&
      (!!agent.effective.processing?.preprocess || !!agent.effective.processing?.postprocess)
    if (
      portableProcessing &&
      (agent.effective.result.mode !== 'text' ||
        agent.effective.result.validator !== 'yuzu-annotated-floor')
    ) return floor
    const input = buildDirectorInput(
      gen.profileId,
      gen.lorebookIds,
      floor.response.content,
      relationshipActors(floor)
    )
    const prompt = buildDirectorPrompt(
      gen.profileId,
      gen.lorebookIds,
      floor.response.content,
      relationshipActors(floor)
    )
    const outcome = await invocationRuntime().run({
      profileId: gen.profileId,
      chatId: gen.chatId,
      floor: floor.floor,
      agent: agent.name,
      options: {
        ...(portableProcessing ? { input } : {}),
        required: false,
        maxSteps: 1,
        ...(!portableProcessing ? { maxRetryAttempts: 0 } : {}),
        ...(agent.invocationConfig.apiPresetId
          ? { apiPresetId: agent.invocationConfig.apiPresetId }
          : {})
      },
      ...(!portableProcessing
        ? {
            promptOverride: [{ role: 'system' as const, content: [{ type: 'text' as const, text: prompt }] }],
            acceptRawTextResult: true
          }
        : {
            yssVocabulary: {
              locations: new Set(input.assetVocabulary.locations),
              actors: new Set(Object.keys(input.assetVocabulary.actors)),
              expressions: new Set(Object.values(input.assetVocabulary.actors).flat()),
              cgs: new Set<string>(),
              audio: new Set<string>()
            }
          }),
      restartOnSourceChange: false,
      skipResultIncorporation: true,
      signal: ctx.modelSignal ?? ctx.signal
    })
    if (outcome.status !== 'succeeded' || typeof outcome.result !== 'string') return floor
    if (outcome.processingWarnings?.some((warning) => warning.phase === 'postprocess')) return floor
    const gameText = /<gametxt>([\s\S]*?)<\/gametxt>/.exec(outcome.result)?.[1]
    if (!(gameText ? parseAnnotatedFloor(gameText) : parseAnnotatedFloor(outcome.result))) return floor
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
