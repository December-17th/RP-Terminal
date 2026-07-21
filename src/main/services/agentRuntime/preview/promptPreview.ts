import {
  resolveInvocationOptions,
  type AgentPromptPreview,
  type AgentPromptPreviewMessage,
  type InvocationOptions,
  type JsonObject
} from '../../../../shared/agentRuntime'
import type { CatalogAgent } from '../catalog'
import {
  buildAttemptLog,
  contextAttribution,
  defaultEstimateTokens,
  DEFAULT_HARNESS_POLICY,
  type HarnessExecuteRequest
} from '../harness'
import type { InvocationFloorPort } from '../invocation'
import { createAgentPromptPlanner, type InvocationPromptPort } from '../prompt'
import { createProviderDispatch, type ProviderDispatch } from '../provider'
import { createSessionInvocationFloorPort } from '../InvocationRuntimeService'

/**
 * Pre-run Prompt Preview (Microscope-lite D4).
 *
 * Builds the EXACT prompt an Agent run would dispatch against the latest committed floor — the same
 * messages, in the same order, byte for byte — with ZERO provider calls and ZERO side effects. It
 * reuses the very functions the Invocation Runtime uses per attempt (floor source resolution, the
 * prompt planner, `buildAttemptLog`, `contextAttribution`, provider resolution), so a preview cannot
 * drift from a real run. Nothing here writes: `resolveSource` is a pure SELECT, the assembler clones
 * its vars, and `providerDispatch.resolve` only reads settings/preset.
 *
 * The preview reflects the floor/vars as they stand NOW; a later run re-renders against live state and
 * may differ. A Workspace preview binds NO tools (it is not a mounted card), so tool-schema token
 * regions are absent — the same shape a Workspace "Run now" produces.
 */
export interface AgentPromptPreviewRequest {
  profileId: string
  chatId: string
  floor: number
  agent: CatalogAgent
  input: JsonObject
  apiPresetId?: string
}

export interface AgentPromptPreviewDeps {
  floor: Pick<InvocationFloorPort, 'resolveSource'>
  planner: InvocationPromptPort
  providerDispatch: ProviderDispatch
  harnessPolicy?: string
  estimateTokens?: (content: string) => number
}

/** Strip the source-selection fields the Harness never re-reads, mirroring the Invocation Runtime's
 *  `invocationOptions` so `resolveInvocationOptions` sees the same shape a real run resolves. */
const harnessOptionsOf = (
  options: InvocationOptions
): Omit<InvocationOptions, 'floor' | 'input' | 'inputBindings'> => {
  const { floor: _floor, input: _input, inputBindings: _bindings, ...rest } = options
  return rest
}

export const createAgentPromptPreview = (
  deps: AgentPromptPreviewDeps
): ((request: AgentPromptPreviewRequest) => Promise<AgentPromptPreview>) => {
  const harnessPolicy = deps.harnessPolicy ?? DEFAULT_HARNESS_POLICY
  const estimateTokens = deps.estimateTokens ?? defaultEstimateTokens
  return async (request) => {
    const { profileId, chatId, floor, agent } = request
    const definition = agent.effective
    const options: InvocationOptions = {
      ...(request.input && Object.keys(request.input).length ? { input: request.input } : {}),
      ...(request.apiPresetId ? { apiPresetId: request.apiPresetId } : {})
    }
    try {
      const source = await deps.floor.resolveSource({ profileId, chatId, floor, agent, options })

      // Per attempt the Invocation Runtime asks the planner whether this Agent renders its own messages
      // or gets an assembled substitute prompt; preview asks the identical port with the full options.
      const prompt = deps.planner({
        profileId,
        chatId,
        floor,
        agent: definition,
        options
      })

      const resolved = resolveInvocationOptions(definition, harnessOptionsOf(options))
      if (!resolved.ok) {
        return {
          ok: false,
          code: 'INVALID_REQUEST',
          message: resolved.errors.map((error) => error.message).join('; ')
        }
      }

      let provider
      try {
        provider = deps.providerDispatch.resolve({
          profileId,
          ...(resolved.value.apiPresetId ? { apiPresetId: resolved.value.apiPresetId } : {}),
          ...(resolved.value.model ? { model: resolved.value.model } : {}),
          ...(definition.preset?.generationParameters
            ? { presetBundleParameters: definition.preset.generationParameters }
            : {}),
          ...(resolved.value.generationParameters
            ? { generationParameters: resolved.value.generationParameters }
            : {})
        })
      } catch (cause) {
        return {
          ok: false,
          code: 'PROVIDER_SELECTION',
          message: cause instanceof Error ? cause.message : 'Provider preset resolution failed'
        }
      }

      const harnessRequest = {
        definition,
        input: source.input,
        profileId,
        ...(source.promptValues ? { promptValues: source.promptValues } : {}),
        ...(source.history !== undefined ? { history: source.history } : {}),
        ...(prompt?.render ? { render: prompt.render } : {}),
        ...(prompt?.prompt ? { prompt: prompt.prompt } : {})
      } satisfies HarnessExecuteRequest

      const built = buildAttemptLog(definition, harnessRequest, resolved.value, harnessPolicy)
      if (!built.ok) {
        return {
          ok: false,
          code:
            built.failure.code === 'PROMPT_BINDING_MISSING'
              ? 'PROMPT_BINDING_MISSING'
              : 'PREVIEW_FAILED',
          message: built.failure.message
        }
      }

      const combined = [...built.immutablePrefix, ...built.attemptLog]
      const messages: AgentPromptPreviewMessage[] = combined.map((message, index) => ({
        role: message.role,
        content: message.content,
        ...(built.origins[index] ? { origin: built.origins[index] } : {})
      }))

      // A Workspace preview binds no tools, so tool-schema regions are empty by construction (the same
      // shape a Workspace "Run now" produces); the message list is byte-identical either way.
      const attribution = contextAttribution(
        harnessRequest,
        built.immutablePrefix,
        built.attemptLog,
        [],
        estimateTokens,
        provider.preset.parameters.max_tokens ?? 0,
        provider.preset.contextWindowTokens
      )

      return {
        ok: true,
        messages,
        prefixCount: built.immutablePrefix.length,
        attribution,
        provider: {
          presetId: provider.preset.id,
          presetName: provider.preset.name,
          provider: provider.preset.provider,
          model: provider.preset.model,
          contextWindow: provider.preset.contextWindowTokens,
          cacheMode: provider.preset.cacheMode
        },
        warnings: prompt?.warnings ?? []
      }
    } catch (cause) {
      return {
        ok: false,
        code: 'PREVIEW_FAILED',
        message: cause instanceof Error ? cause.message : 'Prompt preview failed'
      }
    }
  }
}

let production: ((request: AgentPromptPreviewRequest) => Promise<AgentPromptPreview>) | null = null

/** The production preview composition, lazily wired to the same floor/planner/provider seams the
 *  Invocation Runtime uses. */
export const agentPromptPreview = (): ((
  request: AgentPromptPreviewRequest
) => Promise<AgentPromptPreview>) => {
  if (!production) {
    production = createAgentPromptPreview({
      floor: createSessionInvocationFloorPort(),
      planner: createAgentPromptPlanner(),
      providerDispatch: createProviderDispatch()
    })
  }
  return production
}
