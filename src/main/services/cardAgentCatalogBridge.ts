import { AgentCatalog } from './agentRuntime/catalog'
import { setCardAgentHooks } from './characterService'
import { chatIdsForProfile } from './chatDeleteService'
import { getSessionDb } from './sessionDbService'
import { deleteByAgentNameInDb } from './agentRuntime/runs/AgentRunStore'
import { log } from './logService'

/**
 * Purge the run history of Agents that a card import REPLACED. Chat history (floors/messages) is never
 * touched — only `agent_runs` rows for the replaced Agent names, across every chat's session DB. Wrapped
 * per-chat so one unopenable/corrupt session store cannot fail the whole import.
 */
const purgeReplacedAgentRuns = (profileId: string, replacedNames: string[]): void => {
  if (replacedNames.length === 0) return
  for (const chatId of chatIdsForProfile(profileId)) {
    try {
      const db = getSessionDb(profileId, chatId)
      for (const name of replacedNames) deleteByAgentNameInDb(db, name)
    } catch (error) {
      log('error', `Failed to purge replaced Agent runs for chat ${chatId}:`, error)
    }
  }
}

setCardAgentHooks({
  inspectAgents(
    profileId,
    characterId,
    sourceVersion,
    agents,
    roleRecommendations,
    resolutions
  ) {
    return new AgentCatalog(profileId)
      .validateCardSource(
        characterId,
        sourceVersion,
        agents,
        resolutions,
        roleRecommendations
      )
      .collisions.map(({ incomingName, existing }) => ({
        incomingName,
        existing: {
          id: existing.id,
          name: existing.name,
          builtin: existing.source.kind === 'builtin'
        }
      }))
  },
  installAgents(
    profileId,
    characterId,
    sourceVersion,
    agents,
    roleRecommendations,
    resolutions
  ) {
    const result = new AgentCatalog(profileId).reconcileCardSource(
      characterId,
      sourceVersion,
      agents,
      resolutions,
      roleRecommendations
    )
    purgeReplacedAgentRuns(profileId, result.replaced)
  },
  replaceAgents(
    profileId,
    previousCharacterId,
    characterId,
    sourceVersion,
    agents,
    roleRecommendations,
    resolutions
  ) {
    const result = new AgentCatalog(profileId).replaceCardSource(
      previousCharacterId,
      characterId,
      sourceVersion,
      agents,
      resolutions,
      roleRecommendations
    )
    purgeReplacedAgentRuns(profileId, result.replaced)
  },
  removeAgents(profileId, characterId, purge) {
    new AgentCatalog(profileId).removeCardSource(characterId, purge)
  }
})
