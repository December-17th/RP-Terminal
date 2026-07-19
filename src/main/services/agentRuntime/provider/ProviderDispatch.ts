import type { Settings } from '../../../types/models'
import type { Preset, PresetParameters } from '../../../types/preset'
import { getActivePreset } from '../../presetService'
import { acquireConcurrencySlot, acquireRpmSlot } from '../../rpmLimiter'
import { getSettings } from '../../settingsService'
import { createAnthropicAdapter } from './anthropicAdapter'
import {
  capabilityProfileFor,
  defaultProviderEndpoint,
  normalizeTools,
  resolveProviderModel
} from './capabilities'
import { ProviderDispatchError } from './errors'
import { createGeminiAdapter } from './geminiAdapter'
import { createOpenAiAdapter } from './openAiAdapter'
import type { ProviderFetch } from './transportUtils'
import type {
  NormalizedProviderRequest,
  ProviderAdapter,
  ProviderAdapterEvent,
  ProviderCacheUsage,
  ProviderCallRequest,
  ProviderCapabilityProfile,
  ProviderConnection,
  ProviderDispatch,
  ProviderEvent,
  ProviderFinishReason,
  ProviderPresetSnapshot,
  ProviderRateLimit,
  ProviderResponseDelivery,
  ProviderResult,
  ProviderSelection,
  ProviderToolCall,
  ProviderTransportFamily,
  ProviderUsage,
  ResolvedProviderDispatch
} from './types'

export const providerEndpointKey = (
  connection: Pick<ProviderConnection, 'provider' | 'endpoint'>
): string =>
  (connection.endpoint || defaultProviderEndpoint(connection.provider)).replace(/\/$/, '')

interface ToolFragment {
  index: number
  id?: string
  name?: string
  argumentsText: string
  input?: unknown
  hasArgumentsDelta: boolean
}

const parseInput = (argumentsText: string, input: unknown): unknown => {
  if (!argumentsText) return input
  try {
    return JSON.parse(argumentsText)
  } catch {
    return undefined
  }
}

const finalizeToolCalls = (fragments: Map<number, ToolFragment>): ProviderToolCall[] =>
  [...fragments.values()]
    .sort((left, right) => left.index - right.index)
    .map((fragment) => {
      const argumentsText = fragment.hasArgumentsDelta
        ? fragment.argumentsText
        : fragment.input === undefined
          ? ''
          : JSON.stringify(fragment.input)
      const input = parseInput(argumentsText, fragment.input)
      return {
        id: fragment.id ?? `tool-call:${fragment.index}`,
        name: fragment.name ?? '',
        argumentsText,
        ...(input === undefined ? {} : { input })
      }
    })

const freezeParameters = (parameters: PresetParameters): Readonly<PresetParameters> =>
  Object.freeze({
    ...parameters,
    ...(parameters.stop ? { stop: Object.freeze([...parameters.stop]) as string[] } : {})
  })

const freezeConnection = (connection: ProviderConnection): Readonly<ProviderConnection> =>
  Object.freeze({ ...connection })

const freezeRequest = (
  request: ProviderCallRequest,
  connection: Readonly<ProviderConnection>,
  parameters: Readonly<PresetParameters>,
  capability: Readonly<ProviderCapabilityProfile>
): NormalizedProviderRequest => {
  const messages = request.messages.map((message) =>
    Object.freeze({
      ...message,
      ...(message.toolCalls
        ? { toolCalls: message.toolCalls.map((call) => Object.freeze({ ...call })) }
        : {})
    })
  )
  const tools = normalizeTools(request.tools ?? [], capability).map((tool) =>
    Object.freeze({
      ...tool,
      inputSchema: Object.freeze(tool.inputSchema)
    })
  )
  return Object.freeze({
    connection,
    capability,
    messages: Object.freeze(messages),
    parameters,
    tools: Object.freeze(tools),
    toolChoice: request.toolChoice ?? 'auto',
    signal: request.signal
  })
}

const createAdapters = (
  options: Pick<CreateProviderDispatchOptions, 'fetch' | 'adapter' | 'adapters'>
): Record<ProviderTransportFamily, ProviderAdapter> => {
  const providerFetch: ProviderFetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  return {
    'openai-compatible': options.adapter ?? createOpenAiAdapter(providerFetch),
    anthropic: options.adapter ?? createAnthropicAdapter(providerFetch),
    gemini: options.adapter ?? createGeminiAdapter(providerFetch),
    ...options.adapters
  }
}

const createResolvedDispatch = (
  connectionInput: ProviderConnection,
  parametersInput: PresetParameters,
  presetInput: Omit<ProviderPresetSnapshot, 'parameters' | 'contextWindowTokens'> & {
    contextWindowTokens?: number
  },
  adapters: Record<ProviderTransportFamily, ProviderAdapter>
): ResolvedProviderDispatch => {
  const connection = freezeConnection({
    ...connectionInput,
    model: resolveProviderModel(connectionInput.provider, connectionInput.model)
  })
  const parameters = freezeParameters(parametersInput)
  const capability = Object.freeze({ ...capabilityProfileFor(connection) })
  const configuredContextWindow = presetInput.contextWindowTokens
  const contextWindowTokens =
    typeof configuredContextWindow === 'number' &&
    Number.isFinite(configuredContextWindow) &&
    configuredContextWindow > 0
      ? Math.floor(configuredContextWindow)
      : capability.defaultContextWindowTokens
  const preset = Object.freeze({
    ...presetInput,
    model: connection.model,
    contextWindowTokens,
    parameters
  })

  return {
    preset,
    capability,
    async dispatch(request): Promise<ProviderResult> {
      const normalized = freezeRequest(request, connection, parameters, capability)
      const endpointKey = providerEndpointKey(connection)
      const rpm = connection.rpmLimit ?? 0
      if (rpm > 0) await acquireRpmSlot(endpointKey, rpm, normalized.signal)
      const release = await acquireConcurrencySlot(
        endpointKey,
        connection.maxConcurrent ?? 0,
        normalized.signal
      )

      let text = ''
      let usage: ProviderUsage | undefined
      let cache: ProviderCacheUsage | undefined
      let rateLimit: ProviderRateLimit | undefined
      let rawUsage: unknown
      let finishReason: ProviderFinishReason = 'stop'
      let delivery: ProviderResponseDelivery = 'stream'
      const fragments = new Map<number, ToolFragment>()
      let completed = false
      let hadStreamOutput = false
      const notify = (event: ProviderEvent): void => request.onEvent?.(event)
      const consume = (event: ProviderAdapterEvent): void => {
        switch (event.type) {
          case 'text-delta':
            if (!event.delta) return
            hadStreamOutput = true
            text += event.delta
            notify({ type: 'text', delta: event.delta })
            return
          case 'reasoning-delta':
            if (event.delta) {
              hadStreamOutput = true
              notify({ type: 'reasoning', delta: event.delta, volatile: true })
            }
            return
          case 'tool-call-delta': {
            hadStreamOutput = true
            const fragment = fragments.get(event.index) ?? {
              index: event.index,
              argumentsText: '',
              hasArgumentsDelta: false
            }
            if (event.id !== undefined) fragment.id = event.id
            if (event.name !== undefined) fragment.name = event.name
            if (event.argumentsDelta !== undefined) {
              fragment.argumentsText += event.argumentsDelta
              fragment.hasArgumentsDelta = true
            }
            if (event.input !== undefined) fragment.input = event.input
            fragments.set(event.index, fragment)
            return
          }
          case 'usage':
            usage = event.usage
            cache = event.cache
            rawUsage = event.raw
            notify({ type: 'usage', usage })
            notify({ type: 'cache', cache })
            return
          case 'rate-limit':
            rateLimit = { ...rateLimit, ...event.rateLimit }
            notify({ type: 'rate-limit', rateLimit })
            return
          case 'finish':
            finishReason = event.reason
            delivery = event.delivery ?? 'stream'
            completed = true
        }
      }

      try {
        await adapters[capability.transport].dispatch(normalized, consume)
      } catch (cause) {
        if (normalized.signal?.aborted && hadStreamOutput) {
          finishReason = 'cancelled'
          completed = true
        } else if (cause instanceof ProviderDispatchError) {
          throw cause
        } else {
          throw new ProviderDispatchError('Provider request failed', {
            retryClass: normalized.signal?.aborted ? 'cancelled' : 'transient',
            diagnostics: {
              category: normalized.signal?.aborted ? 'cancelled' : 'transport'
            }
          })
        }
      } finally {
        release()
      }

      if (!completed) finishReason = normalized.signal?.aborted ? 'cancelled' : finishReason
      const toolCalls = finalizeToolCalls(fragments)
      for (const toolCall of toolCalls) notify({ type: 'tool-call', toolCall })
      notify({ type: 'completion', reason: finishReason, text, toolCalls })
      return {
        capability,
        text,
        toolCalls,
        ...(usage ? { usage } : {}),
        ...(cache ? { cache } : {}),
        ...(rateLimit ? { rateLimit } : {}),
        finishReason,
        delivery,
        ...(rawUsage === undefined ? {} : { rawUsage })
      }
    }
  }
}

export interface CreateProviderDispatchOptions {
  fetch?: ProviderFetch
  /** Test-only or embedding override applied to all transport families. */
  adapter?: ProviderAdapter
  adapters?: Partial<Record<ProviderTransportFamily, ProviderAdapter>>
  getSettings?: (profileId: string) => Settings
  getActivePreset?: (profileId: string) => Preset
}

export const createProviderDispatch = (
  options: CreateProviderDispatchOptions = {}
): ProviderDispatch => {
  const adapters = createAdapters(options)

  return {
    resolve(selection: ProviderSelection): ResolvedProviderDispatch {
      const settings = (options.getSettings ?? getSettings)(selection.profileId)
      const presetId = selection.apiPresetId ?? settings.active_api_preset_id
      const apiPreset = settings.api_presets.find((candidate) => candidate.id === presetId)
      if (!apiPreset) {
        throw new ProviderDispatchError(
          presetId ? `API preset "${presetId}" was not found` : 'No API preset is selected',
          { retryClass: 'non-retryable' }
        )
      }
      const generationPreset = (options.getActivePreset ?? getActivePreset)(selection.profileId)
      // Parameter precedence (ADR 0021 §2), lowest to highest:
      //   resolved generation preset  →  the Agent's bundled preset  →  the invocation's own override.
      // The middle layer is the only thing this ADR added; the outer two are unchanged.
      const parameters = {
        ...generationPreset.parameters,
        ...selection.presetBundleParameters,
        ...selection.generationParameters
      }
      const model = selection.model ?? apiPreset.model
      const cacheMode = settings.cache?.mode ?? 'baseline'
      return createResolvedDispatch(
        {
          provider: apiPreset.provider,
          endpoint: apiPreset.endpoint,
          apiKey: apiPreset.api_key,
          model,
          rpmLimit: apiPreset.rpm_limit,
          maxConcurrent: apiPreset.max_concurrent,
          cacheMode
        },
        parameters,
        {
          id: apiPreset.id,
          name: apiPreset.name,
          provider: apiPreset.provider,
          endpoint: apiPreset.endpoint,
          model,
          rpmLimit: apiPreset.rpm_limit,
          maxConcurrent: apiPreset.max_concurrent,
          cacheMode,
          contextWindowTokens: settings.generation?.max_context_tokens
        },
        adapters
      )
    }
  }
}

/**
 * Temporary adapter for ordinary generation, whose established Interface already supplies a
 * resolved Settings block and generation parameters. New Agent callers use ProviderDispatch.resolve.
 */
export const createCompatibilityProviderDispatch = (
  connection: ProviderConnection,
  parameters: PresetParameters,
  options: Pick<CreateProviderDispatchOptions, 'fetch' | 'adapter' | 'adapters'> = {}
): ResolvedProviderDispatch => {
  const cacheMode = connection.cacheMode ?? 'baseline'
  return createResolvedDispatch(
    connection,
    parameters,
    {
      id: 'legacy-active',
      name: 'Legacy active API preset',
      provider: connection.provider,
      endpoint: connection.endpoint,
      model: connection.model,
      rpmLimit: connection.rpmLimit,
      maxConcurrent: connection.maxConcurrent,
      cacheMode
    },
    createAdapters(options)
  )
}
