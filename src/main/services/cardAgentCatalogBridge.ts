import { AgentCatalog } from './agentRuntime/catalog'
import { setCardAgentHooks } from './characterService'

setCardAgentHooks({
  inspectAgents(
    profileId,
    characterId,
    sourceVersion,
    agents,
    roleRecommendations,
    incomingRenames
  ) {
    return new AgentCatalog(profileId)
      .validateCardSource(
        characterId,
        sourceVersion,
        agents,
        incomingRenames,
        roleRecommendations
      )
      .collisions.map(({ incomingName, existing }) => ({
        incomingName,
        existing: { id: existing.id, name: existing.name }
      }))
  },
  installAgents(
    profileId,
    characterId,
    sourceVersion,
    agents,
    roleRecommendations,
    incomingRenames
  ) {
    const catalog = new AgentCatalog(profileId)
    catalog.reconcileCardSource(
      characterId,
      sourceVersion,
      agents,
      incomingRenames,
      roleRecommendations
    )
  },
  replaceAgents(
    profileId,
    previousCharacterId,
    characterId,
    sourceVersion,
    agents,
    roleRecommendations,
    incomingRenames
  ) {
    new AgentCatalog(profileId).replaceCardSource(
      previousCharacterId,
      characterId,
      sourceVersion,
      agents,
      incomingRenames,
      roleRecommendations
    )
  },
  removeAgents(profileId, characterId, purge) {
    new AgentCatalog(profileId).removeCardSource(characterId, purge)
  }
})
