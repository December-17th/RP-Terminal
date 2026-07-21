import type { IpcMain } from 'electron'
import type {
  AgentCatalogSummary,
  AgentDefinition,
  AgentFolderSync,
  AgentManualRunResult,
  AgentMutationResult,
  AgentRole,
  AgentUpgradePreview,
  AgentUpgradeResolution
} from '../../shared/agentRuntime'
import { AGENT_CATALOG_CHANNELS, normalizeAgentName } from '../../shared/agentRuntime'
import {
  AgentCatalog,
  AgentCatalogError,
  syncAgentFolder,
  resolveAgentFolder,
  type CatalogAgent
} from '../services/agentRuntime/catalog'
import { invocationRuntime } from '../services/agentRuntime/InvocationRuntimeService'
import {
  MEMORY_MAINTENANCE_AGENT_NAME,
  memoryMaintenanceBridge
} from '../services/agentRuntime/memoryMaintenanceSlot'
import { getAllFloors } from '../services/floorService'
import { resolveProfileId } from '../services/sessionDbService'
import { gate } from './ipcGuards'

/**
 * Agent library management for the app's own Agent Workspace.
 *
 * Every channel here is gated: installing, disabling, deleting, and role-binding Agents decide what
 * model work the app will run, so a card must never reach them even when the user has trusted that
 * card's scripts. Cards invoke Agents through the separate `card-agent-*` transport, which validates
 * an explicit chat scope instead.
 */
const stringArg = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null

const promptSize = (definition: AgentDefinition): { messages: number; chars: number } => ({
  messages: definition.prompt.length,
  chars: definition.prompt.reduce(
    (total, message) =>
      total +
      message.content.reduce(
        (inner, part) => inner + (part.type === 'text' ? part.text.length : 0),
        0
      ),
    0
  )
})

const toSummary = (
  agent: CatalogAgent,
  bindings: Record<AgentRole, string>,
  upgradeAvailable: boolean
): AgentCatalogSummary => {
  const definition = agent.effective
  const size = promptSize(definition)
  const roles = (Object.entries(bindings) as Array<[AgentRole, string]>)
    .filter(([, id]) => id === agent.id || id === agent.name)
    .map(([role]) => role)
  return {
    id: agent.id,
    name: agent.name,
    ...(definition.description ? { description: definition.description } : {}),
    sourceKind: agent.source.kind,
    sourceKey: agent.source.key,
    sourceVersion: agent.source.version,
    sourcePresent: agent.sourcePresent,
    enabled: agent.enabled,
    customized: agent.customized,
    upgradeAvailable,
    blocksNextTurn: definition.defaults.blocksNextTurn,
    resultMode: definition.result.mode,
    ...(definition.result.mode !== 'tools-only' && definition.result.saveAs
      ? { saveAs: definition.result.saveAs }
      : {}),
    promptMessages: size.messages,
    promptChars: size.chars,
    roles,
    ...(definition.modelHint ? { recommendedModel: definition.modelHint } : {}),
    hasApiPreset: Boolean(agent.invocationConfig.apiPresetId),
    updatedAt: agent.updatedAt
  }
}

export const registerAgentCatalogIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.list,
    gate(AGENT_CATALOG_CHANNELS.list, async (_event, rawProfileId: unknown) => {
      const profileId = stringArg(rawProfileId)
      if (!profileId) return []
      const catalog = new AgentCatalog(profileId)
      const bindings = catalog.getRoleBindings()
      return catalog
        .list()
        .map((agent) =>
          toSummary(agent, bindings, catalog.inspectAvailableUpgrade(agent.id) !== null)
        ) satisfies AgentCatalogSummary[]
    })
  )

  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.get,
    gate(AGENT_CATALOG_CHANNELS.get, async (_event, rawProfileId: unknown, rawId: unknown) => {
      const profileId = stringArg(rawProfileId)
      const id = stringArg(rawId)
      if (!profileId || !id) return null
      return new AgentCatalog(profileId).get(id)?.effective ?? null
    })
  )

  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.syncFolder,
    gate(
      AGENT_CATALOG_CHANNELS.syncFolder,
      async (_event, rawProfileId: unknown, rawConflicts: unknown): Promise<AgentFolderSync> => {
        const profileId = stringArg(rawProfileId)
        const dir = resolveAgentFolder()
        if (!profileId) return { dir, items: [] }
        const conflicts =
          rawConflicts === 'keep-customization' || rawConflicts === 'use-source'
            ? (rawConflicts as AgentUpgradeResolution)
            : undefined
        return syncAgentFolder(
          new AgentCatalog(profileId),
          dir,
          conflicts ? { conflicts } : {}
        )
      }
    )
  )

  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.setEnabled,
    gate(
      AGENT_CATALOG_CHANNELS.setEnabled,
      async (_event, rawProfileId: unknown, rawId: unknown, enabled: unknown) => {
        const profileId = stringArg(rawProfileId)
        const id = stringArg(rawId)
        if (!profileId || !id) return { ok: false, error: 'INVALID_REQUEST' }
        try {
          new AgentCatalog(profileId).setEnabled(id, enabled === true)
          return { ok: true }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
    )
  )

  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.remove,
    gate(AGENT_CATALOG_CHANNELS.remove, async (_event, rawProfileId: unknown, rawId: unknown) => {
      const profileId = stringArg(rawProfileId)
      const id = stringArg(rawId)
      if (!profileId || !id) return { ok: false, error: 'INVALID_REQUEST' }
      try {
        new AgentCatalog(profileId).delete(id)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  )

  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.bindRole,
    gate(
      AGENT_CATALOG_CHANNELS.bindRole,
      async (_event, rawProfileId: unknown, rawRole: unknown, rawId: unknown) => {
        const profileId = stringArg(rawProfileId)
        const id = stringArg(rawId)
        const role = rawRole === 'classic.narrator' || rawRole === 'yuzu.sceneDirector' ? rawRole : null
        if (!profileId || !id || !role) return { ok: false, error: 'INVALID_REQUEST' }
        try {
          new AgentCatalog(profileId).bindRole(role, id)
          return { ok: true }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
    )
  )

  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.roleBindings,
    gate(AGENT_CATALOG_CHANNELS.roleBindings, async (_event, rawProfileId: unknown) => {
      const profileId = stringArg(rawProfileId)
      return profileId ? new AgentCatalog(profileId).getRoleBindings() : null
    })
  )

  /** Wrap a catalog mutation so a validation failure becomes a typed result, never a raised invoke. */
  const mutate = (
    profileId: string | null,
    apply: (catalog: AgentCatalog) => CatalogAgent
  ): AgentMutationResult => {
    if (!profileId) return { ok: false, error: 'INVALID_REQUEST', code: 'INVALID_REQUEST' }
    try {
      const catalog = new AgentCatalog(profileId)
      const agent = apply(catalog)
      return {
        ok: true,
        agent: toSummary(
          agent,
          catalog.getRoleBindings(),
          catalog.inspectAvailableUpgrade(agent.id) !== null
        )
      }
    } catch (error) {
      const catalogError = error as { code?: string; details?: unknown; message?: string }
      return {
        ok: false,
        error: catalogError?.message ?? String(error),
        ...(catalogError?.code ? { code: catalogError.code } : {}),
        ...(catalogError?.details !== undefined ? { details: catalogError.details } : {})
      }
    }
  }

  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.create,
    gate(AGENT_CATALOG_CHANNELS.create, async (_event, rawProfileId: unknown, raw: unknown) =>
      mutate(stringArg(rawProfileId), (catalog) => catalog.create(raw))
    )
  )

  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.edit,
    gate(
      AGENT_CATALOG_CHANNELS.edit,
      async (_event, rawProfileId: unknown, rawId: unknown, raw: unknown) => {
        const id = stringArg(rawId)
        return id
          ? mutate(stringArg(rawProfileId), (catalog) => catalog.edit(id, raw))
          : ({ ok: false, error: 'INVALID_REQUEST', code: 'INVALID_REQUEST' } as AgentMutationResult)
      }
    )
  )

  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.restore,
    gate(AGENT_CATALOG_CHANNELS.restore, async (_event, rawProfileId: unknown, rawId: unknown) => {
      const id = stringArg(rawId)
      return id
        ? mutate(stringArg(rawProfileId), (catalog) => catalog.restore(id))
        : ({ ok: false, error: 'INVALID_REQUEST', code: 'INVALID_REQUEST' } as AgentMutationResult)
    })
  )

  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.exportOne,
    gate(AGENT_CATALOG_CHANNELS.exportOne, async (_event, rawProfileId: unknown, rawId: unknown) => {
      const profileId = stringArg(rawProfileId)
      const id = stringArg(rawId)
      if (!profileId || !id) return null
      try {
        return new AgentCatalog(profileId).exportStandalone(id)
      } catch {
        return null
      }
    })
  )

  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.inspectUpgrade,
    gate(
      AGENT_CATALOG_CHANNELS.inspectUpgrade,
      async (_event, rawProfileId: unknown, rawId: unknown): Promise<AgentUpgradePreview | null> => {
        const profileId = stringArg(rawProfileId)
        const id = stringArg(rawId)
        if (!profileId || !id) return null
        const preview = new AgentCatalog(profileId).inspectAvailableUpgrade(id)
        return preview
          ? {
              changedPaths: preview.changedPaths,
              customizedPaths: preview.customizedPaths,
              conflicts: preview.conflicts
            }
          : null
      }
    )
  )

  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.upgrade,
    gate(
      AGENT_CATALOG_CHANNELS.upgrade,
      async (_event, rawProfileId: unknown, rawId: unknown, rawConflicts: unknown) => {
        const id = stringArg(rawId)
        if (!id) return { ok: false, error: 'INVALID_REQUEST' } as AgentMutationResult
        const conflicts =
          rawConflicts === 'keep-customization' || rawConflicts === 'use-source'
            ? (rawConflicts as AgentUpgradeResolution)
            : undefined
        return mutate(stringArg(rawProfileId), (catalog) => {
          const current = catalog.get(id)
          const available = current?.availableSource
          if (!available) {
            throw new AgentCatalogError(
              'UPGRADE_NOT_AVAILABLE',
              'No pending source upgrade for this Agent'
            )
          }
          return catalog.upgrade(
            id,
            available.baseline,
            available.version,
            conflicts ? { conflicts } : {}
          )
        })
      }
    )
  )

  /**
   * Read the Agent's profile-local invocation config (M5b) — currently just the re-homed API preset.
   * Separate from `get` (which returns the portable definition) because this config never belongs to
   * the definition and never exports. Returns `{}` for an unknown profile/agent (fail-soft).
   */
  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.getInvocationConfig,
    gate(
      AGENT_CATALOG_CHANNELS.getInvocationConfig,
      async (_event, rawProfileId: unknown, rawId: unknown) => {
        const profileId = stringArg(rawProfileId)
        const id = stringArg(rawId)
        if (!profileId || !id) return {}
        return new AgentCatalog(profileId).get(id)?.invocationConfig ?? {}
      }
    )
  )

  /** Write the Agent's profile-local invocation config (M5b). Blank apiPresetId clears it (normalized
   *  main-side). Returns the refreshed summary envelope so the UI can reconcile enabled/customized. */
  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.setInvocationConfig,
    gate(
      AGENT_CATALOG_CHANNELS.setInvocationConfig,
      async (_event, rawProfileId: unknown, rawId: unknown, rawConfig: unknown) => {
        const id = stringArg(rawId)
        if (!id) return { ok: false, error: 'INVALID_REQUEST', code: 'INVALID_REQUEST' } as AgentMutationResult
        const config = rawConfig && typeof rawConfig === 'object' ? (rawConfig as { apiPresetId?: unknown }) : {}
        const apiPresetId = typeof config.apiPresetId === 'string' ? config.apiPresetId : undefined
        return mutate(stringArg(rawProfileId), (catalog) =>
          catalog.setInvocationConfig(id, apiPresetId ? { apiPresetId } : {})
        )
      }
    )
  )

  /**
   * Manual Invocation (design §12): explicit JSON input against the LATEST committed floor, with the
   * same identity rule as any other invocation — one Agent per floor, so a repeat click coalesces
   * onto the in-flight run rather than starting a second one. No `toolScope` is passed: a Workspace
   * run is not a mounted card, so it binds no card tools.
   */
  ipcMain.handle(
    AGENT_CATALOG_CHANNELS.run,
    gate(
      AGENT_CATALOG_CHANNELS.run,
      async (
        _event,
        rawProfileId: unknown,
        rawChatId: unknown,
        rawAgent: unknown,
        rawInput: unknown
      ): Promise<AgentManualRunResult> => {
        const profileId = stringArg(rawProfileId)
        const chatId = stringArg(rawChatId)
        const agent = stringArg(rawAgent)
        if (!profileId || !chatId || !agent) {
          return { ok: false, error: 'INVALID_REQUEST', code: 'INVALID_REQUEST' }
        }
        if (resolveProfileId(chatId) !== profileId) {
          return { ok: false, error: 'INVALID_REQUEST', code: 'INVALID_REQUEST' }
        }
        const floor = getAllFloors(profileId, chatId).at(-1)?.floor
        if (floor === undefined) {
          return {
            ok: false,
            error: 'NO_COMMITTED_FLOOR',
            code: 'NO_COMMITTED_FLOOR'
          }
        }
        const catalogAgent = new AgentCatalog(profileId).get(agent)
        const apiPresetId = catalogAgent?.invocationConfig.apiPresetId
        // Final-review Finding 1: a manual "Run now" of Memory Maintenance respects the SAME due-gate
        // the trigger path uses, so nothing-due never bills a pointless provider call. `null` from the
        // bridge means no tables are due — surface a distinct "nothing due" outcome, not a fake success.
        if (normalizeAgentName(agent) === normalizeAgentName(MEMORY_MAINTENANCE_AGENT_NAME)) {
          const bridge = memoryMaintenanceBridge()
          if (bridge && bridge.planDispatch({ profileId, chatId, floor }) === null) {
            return { ok: true, status: 'skipped' }
          }
        }
        try {
          const outcome = await invocationRuntime().run({
            profileId,
            chatId,
            floor,
            agent,
            options: {
              ...(rawInput && typeof rawInput === 'object'
                ? { input: rawInput as Record<string, never> }
                : {}),
              ...(apiPresetId ? { apiPresetId } : {})
            }
          })
          return {
            ok: true,
            invocationId: outcome.invocationId,
            status: outcome.status,
            ...('result' in outcome ? { result: outcome.result } : {})
          }
        } catch (error) {
          const runError = error as { code?: string; message?: string }
          return {
            ok: false,
            error: runError.message ?? String(error),
            ...(runError.code ? { code: runError.code } : {})
          }
        }
      }
    )
  )
}
