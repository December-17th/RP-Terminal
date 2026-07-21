import {
  resolveInvocationOptions,
  type EffectiveInvocationOptions,
  type InvocationOptions
} from '../../../../shared/agentRuntime'
import type {
  ProviderDispatch,
  ProviderMessage,
  ResolvedProviderDispatch
} from '../provider'
import { buildAttemptLog, providerMessagesOf } from './attemptLog'
import { compileJsonSchema } from './schemaValidation'
import type {
  AttributedProviderMessage,
  HarnessExecuteRequest,
  HarnessFailure
} from './types'

export interface PreparedHarnessExecution {
  options: EffectiveInvocationOptions
  provider: ResolvedProviderDispatch
  immutablePrefix: ProviderMessage[]
  attemptLog: ProviderMessage[]
  renderedPrompt: AttributedProviderMessage[]
  prefixCount: number
}

export type PrepareHarnessExecutionResult =
  | { ok: true; value: PreparedHarnessExecution }
  | { ok: false; failure: HarnessFailure; provider?: ResolvedProviderDispatch }

export const harnessInvocationOptions = (
  options: InvocationOptions | undefined
): Omit<InvocationOptions, 'floor' | 'input' | 'inputBindings'> | undefined => {
  if (!options) return undefined
  const { floor: _floor, input: _input, inputBindings: _bindings, ...rest } = options
  return rest
}

/**
 * Resolve and validate the immutable step-zero execution snapshot shared by real runs and previews.
 * Provider dispatch, retries, tools, and persistence remain outside this pure preparation module.
 */
export const prepareHarnessExecution = ({
  request,
  providerDispatch,
  harnessPolicy
}: {
  request: HarnessExecuteRequest
  providerDispatch: ProviderDispatch
  harnessPolicy: string
}): PrepareHarnessExecutionResult => {
  const resolved = resolveInvocationOptions(request.definition, request.options)
  if (!resolved.ok) {
    return {
      ok: false,
      failure: {
        code: 'INVALID_INVOCATION',
        message: resolved.errors.map((error) => error.message).join('; '),
        retryable: false
      }
    }
  }

  let provider: ResolvedProviderDispatch
  try {
    provider = providerDispatch.resolve({
      profileId: request.profileId,
      ...(resolved.value.apiPresetId ? { apiPresetId: resolved.value.apiPresetId } : {}),
      ...(resolved.value.model ? { model: resolved.value.model } : {}),
      ...(request.definition.preset?.generationParameters
        ? { presetBundleParameters: request.definition.preset.generationParameters }
        : {}),
      ...(resolved.value.generationParameters
        ? { generationParameters: resolved.value.generationParameters }
        : {})
    })
  } catch (cause) {
    return {
      ok: false,
      failure: {
        code: 'PROVIDER_SELECTION',
        message: cause instanceof Error ? cause.message : 'Provider preset resolution failed',
        retryable: false
      }
    }
  }

  const inputSchema = compileJsonSchema(request.definition.inputSchema)
  if (!inputSchema.ok) {
    return {
      ok: false,
      failure: { code: 'INVALID_INPUT_SCHEMA', message: inputSchema.message, retryable: false },
      provider
    }
  }
  const input = inputSchema.validate.safeParse(request.input)
  if (!input.success) {
    return {
      ok: false,
      failure: { code: 'INVALID_INPUT', message: input.error.message, retryable: false },
      provider
    }
  }
  if (request.definition.result.mode === 'json') {
    const resultSchema = compileJsonSchema(request.definition.result.schema)
    if (!resultSchema.ok) {
      return {
        ok: false,
        failure: { code: 'INVALID_RESULT_SCHEMA', message: resultSchema.message, retryable: false },
        provider
      }
    }
  }

  const context = buildAttemptLog(request.definition, request, resolved.value, harnessPolicy)
  if (!context.ok) return { ...context, provider }

  return {
    ok: true,
    value: {
      options: resolved.value,
      provider,
      immutablePrefix: providerMessagesOf(context.immutablePrefix),
      attemptLog: providerMessagesOf(context.attemptLog),
      renderedPrompt: [...context.immutablePrefix, ...context.attemptLog],
      prefixCount: context.immutablePrefix.length
    }
  }
}
