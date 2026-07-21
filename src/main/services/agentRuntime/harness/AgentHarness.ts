import {
  type AgentDefinition,
  type EffectiveInvocationOptions,
  type JsonObject,
  type JsonValue
} from '../../../../shared/agentRuntime'
import {
  providerFailureMessage,
  ProviderDispatchError,
  type ProviderCacheUsage,
  type ProviderMessage,
  type ProviderRateLimit,
  type ProviderResult,
  type ProviderToolCall,
  type ProviderToolDefinition,
  type ProviderUsage,
  type ResolvedProviderDispatch
} from '../provider'
import {
  AttemptTransaction,
  executionContextFor,
  type AttemptTransactionSnapshot,
  type ToolBinding,
  type ToolExecutionScope,
  type ToolRegistry
} from '../tools'
import { normalizeJsonValue } from '../internal/json'
import { contextAttribution, defaultEstimateTokens } from './budget'
import { projectToolResult } from './projection'
import { callsFromWrongChannel, canonicalJson, closeTruncatedJson } from './repair'
import { validateHarnessResult } from './resultValidation'
import { cancelledFailure, correctiveMessage, sleepWithSignal } from './retry'
import { prepareHarnessExecution } from './prepare'
import { compileJsonSchema } from './schemaValidation'
import type {
  AgentHarness,
  ContextBudgetAttribution,
  CreateAgentHarnessOptions,
  HarnessAttemptEvidence,
  HarnessEvidence,
  HarnessExecuteRequest,
  HarnessExecutionResult,
  HarnessFailure,
  HarnessPreparedRequest,
  IrreversibleBoundaryEvidence,
  ToolEvidence
} from './types'

export const DEFAULT_HARNESS_POLICY =
  'RP Terminal Agent Harness: follow the Agent prompt and return only its declared result.'

type AttemptResult =
  | {
      ok: true
      value: JsonValue | undefined
      transaction: AttemptTransaction
      evidence: HarnessAttemptEvidence
    }
  | {
      ok: false
      failure: HarnessFailure
      transaction: AttemptTransaction
      evidence: HarnessAttemptEvidence
      correction?: string
      retryAfterMs?: number
      transportFailure: boolean
      transportRetry?: TransportRetry
    }

interface CompletedToolExecution {
  input: JsonObject
  evidence: ToolEvidence
}

interface TransportRetry {
  attemptLog: ProviderMessage[]
  tools: CompletedToolExecution[]
  transaction: AttemptTransactionSnapshot
}

const preflightTools = (
  definition: AgentDefinition,
  registry: ToolRegistry,
  supportsTools: boolean,
  toolScope?: ToolExecutionScope
):
  | {
      ok: true
      bindings: Map<string, ToolBinding>
      providerTools: ProviderToolDefinition[]
    }
  | { ok: false; failure: HarnessFailure } => {
  if (definition.tools.length && !supportsTools) {
    return {
      ok: false,
      failure: {
        code: 'TOOLS_UNSUPPORTED',
        message: 'The frozen provider preset does not support tools',
        retryable: false
      }
    }
  }
  const bindings = new Map<string, ToolBinding>()
  const providerTools: ProviderToolDefinition[] = []
  for (const tool of definition.tools) {
    const schema = compileJsonSchema(tool.inputSchema)
    if (!schema.ok) {
      return {
        ok: false,
        failure: {
          code: 'INVALID_TOOL_SCHEMA',
          message: `Tool "${tool.name}" schema is invalid: ${schema.message}`,
          retryable: false
        }
      }
    }
    const binding = registry.resolve(tool, toolScope)
    if (!binding) {
      if (!tool.required) continue
      return {
        ok: false,
        failure: {
          code: 'TOOL_UNAVAILABLE',
          message: `Required tool "${tool.name}" is unavailable or incompatible`,
          retryable: false
        }
      }
    }
    bindings.set(tool.name, binding)
    providerTools.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    })
  }
  return { ok: true, bindings, providerTools }
}

const runAttempt = async ({
  attempt,
  request,
  options,
  provider,
  immutablePrefix,
  baseAttemptLog,
  correction,
  bindings,
  providerTools,
  estimateTokens,
  transportRetry,
  contextWindowTokens
}: {
  attempt: number
  request: HarnessExecuteRequest
  options: EffectiveInvocationOptions
  provider: ResolvedProviderDispatch
  immutablePrefix: ProviderMessage[]
  baseAttemptLog: ProviderMessage[]
  correction?: string
  bindings: Map<string, ToolBinding>
  providerTools: ProviderToolDefinition[]
  estimateTokens: (content: string) => number
  transportRetry?: TransportRetry
  contextWindowTokens: number
}): Promise<AttemptResult> => {
  const transaction = transportRetry
    ? AttemptTransaction.fromSnapshot(transportRetry.transaction)
    : new AttemptTransaction()
  const attemptPrefix = immutablePrefix.map((message) => structuredClone(message))
  const attemptLog = (transportRetry?.attemptLog ?? baseAttemptLog).map((message) =>
    structuredClone(message)
  )
  if (!transportRetry && correction) attemptLog.push({ role: 'user', content: correction })
  const tools: ToolEvidence[] = []
  const usage: ProviderUsage[] = []
  const cache: ProviderCacheUsage[] = []
  const latencyMs: number[] = []
  const rateLimits: ProviderRateLimit[] = []
  const repairs: NonNullable<HarnessAttemptEvidence['repairs']> = []
  const irreversibleBoundaries: IrreversibleBoundaryEvidence[] = []
  const fingerprints = new Set<string>()
  const completedToolExecutions: CompletedToolExecution[] = []
  let providerCalls = 0
  let finalText: string | undefined
  let finalFinishReason: ProviderResult['finishReason'] | undefined
  let currentStep = 0
  let lastDispatchedAttemptLog: ProviderMessage[] | undefined
  // Step-0 token attribution, captured once the first provider step computes it (D2). Surfaced on this
  // attempt's evidence regardless of outcome, so every finished run carries a budget — not only the
  // CONTEXT_BUDGET failures that historically copied it onto the failure shape.
  let stepZeroBudget: ContextBudgetAttribution | undefined
  const orderedIrreversibleBoundaries = (): IrreversibleBoundaryEvidence[] =>
    structuredClone(
      [...irreversibleBoundaries].sort(
        (left, right) => left.step - right.step || left.toolCall.index - right.toolCall.index
      )
    )

  const fail = (
    failure: HarnessFailure,
    rejectedOutput = '',
    transportFailure = false,
    retryAfterMs?: number
  ): AttemptResult => {
    const effectiveFailure = transaction.externalEffectBegan
      ? { ...failure, retryable: false }
      : failure
    return {
      ok: false,
      failure: effectiveFailure,
      transaction,
      correction: correctiveMessage(rejectedOutput, failure),
      retryAfterMs,
      transportFailure,
      ...(transportFailure && effectiveFailure.retryable && lastDispatchedAttemptLog
        ? {
            transportRetry: {
              attemptLog: lastDispatchedAttemptLog,
              tools: completedToolExecutions,
              transaction: transaction.snapshot()
            }
          }
        : {}),
      evidence: {
        attempt,
        outcome: request.signal?.aborted ? 'cancelled' : 'failure',
        providerCalls,
        immutablePrefix: attemptPrefix,
        toolSchemas: providerTools,
        appendOnlyLog: structuredClone(attemptLog),
        tools: structuredClone(tools),
        usage: structuredClone(usage),
        cache: structuredClone(cache),
        latencyMs: [...latencyMs],
        rateLimits: structuredClone(rateLimits),
        ...(repairs?.length ? { repairs } : {}),
        rejectedOutput,
        irreversibleBoundary: transaction.externalEffectBegan,
        ...(irreversibleBoundaries.length
          ? { irreversibleBoundaries: orderedIrreversibleBoundaries() }
          : {}),
        ...(stepZeroBudget ? { contextBudget: stepZeroBudget } : {}),
        error: effectiveFailure
      }
    }
  }

  if (transportRetry) {
    for (const replay of transportRetry.tools) {
      completedToolExecutions.push(replay)
      tools.push(structuredClone(replay.evidence))
      fingerprints.add(`${replay.evidence.call.name}:${canonicalJson(replay.input)}`)
    }
  }

  for (; currentStep < options.maxSteps; currentStep++) {
    if (request.signal?.aborted) return fail(cancelledFailure())
    const budget = contextAttribution(
      request,
      immutablePrefix,
      attemptLog,
      providerTools,
      estimateTokens,
      provider.preset.parameters.max_tokens ?? 0,
      contextWindowTokens
    )
    if (currentStep === 0) stepZeroBudget = budget
    if (budget.total > budget.limit) {
      return fail({
        code: 'CONTEXT_BUDGET',
        message: `Request uses ${budget.total} tokens but the preset limit is ${budget.limit}`,
        retryable: false,
        contextBudget: budget
      })
    }

    let providerResult: ProviderResult
    let volatileReasoning = ''
    lastDispatchedAttemptLog = attemptLog.map((message) => structuredClone(message))
    providerCalls++
    const startedAt = performance.now()
    try {
      providerResult = await provider.dispatch({
        messages: [...attemptPrefix, ...attemptLog],
        tools: providerTools,
        toolChoice: providerTools.length ? 'auto' : 'none',
        signal: request.signal,
        onEvent(event) {
          if (event.type === 'reasoning') volatileReasoning += event.delta
        }
      })
    } catch (cause) {
      latencyMs.push(Math.max(0, performance.now() - startedAt))
      if (request.signal?.aborted) return fail(cancelledFailure())
      if (cause instanceof ProviderDispatchError) {
        const retryable = cause.retryClass === 'transient' || cause.retryClass === 'rate-limit'
        return fail(
          {
            code: `PROVIDER_${cause.retryClass.toUpperCase().replace('-', '_')}`,
            message: providerFailureMessage(cause),
            retryable
          },
          '',
          true,
          cause.retryAfterMs
        )
      }
      return fail(
        {
          code: 'PROVIDER_TRANSIENT',
          message: cause instanceof Error ? cause.message : 'Provider request failed',
          retryable: true
        },
        '',
        true
      )
    }
    latencyMs.push(Math.max(0, performance.now() - startedAt))
    if (providerResult.usage) usage.push(providerResult.usage)
    if (providerResult.cache) cache.push(providerResult.cache)
    if (providerResult.rateLimit) rateLimits.push(providerResult.rateLimit)
    if (providerResult.finishReason === 'cancelled' || request.signal?.aborted) {
      return fail(cancelledFailure())
    }

    let calls = providerResult.toolCalls
    let wrongChannel = false
    if (!calls.length) {
      if (request.definition.result.mode === 'json') {
        const finalValidation = validateHarnessResult(
          request,
          providerResult.text,
          tools.length,
          provider.capability.supportsTruncatedJsonRepair
        )
        if (finalValidation.ok) {
          attemptLog.push({ role: 'assistant', content: providerResult.text })
          finalText = providerResult.text
          finalFinishReason = providerResult.finishReason
          break
        }
      }
      if (provider.capability.supportsWrongChannelToolRepair) {
        calls = callsFromWrongChannel(providerResult, bindings, 'visible-result')
        if (!calls.length && volatileReasoning) {
          calls = callsFromWrongChannel(
            { ...providerResult, text: volatileReasoning },
            bindings,
            'reasoning'
          )
        }
      }
      wrongChannel = calls.length > 0
      if (wrongChannel) repairs?.push('wrong-channel-tool-call')
    }
    if (!calls.length) {
      attemptLog.push({ role: 'assistant', content: providerResult.text })
      finalText = providerResult.text
      finalFinishReason = providerResult.finishReason
      break
    }

    const prepared: Array<{
      call: ProviderToolCall
      binding: ToolBinding
      input: JsonObject
      definition: AgentDefinition['tools'][number]
      repaired?: 'wrong-channel' | 'truncated-json'
    }> = []
    for (const originalCall of calls) {
      const binding = bindings.get(originalCall.name)
      const definition = request.definition.tools.find((tool) => tool.name === originalCall.name)
      if (!binding || !definition) {
        return fail(
          {
            code: 'TOOL_UNAVAILABLE',
            message: `Tool "${originalCall.name}" is not bound`,
            retryable: false
          },
          originalCall.argumentsText
        )
      }
      const parsedArguments =
        originalCall.input !== undefined
          ? {
              ok: true as const,
              value: originalCall.input,
              text: originalCall.argumentsText || JSON.stringify(originalCall.input),
              repaired: false
            }
          : provider.capability.supportsTruncatedJsonRepair
            ? closeTruncatedJson(originalCall.argumentsText)
            : (() => {
                try {
                  return {
                    ok: true as const,
                    value: JSON.parse(originalCall.argumentsText),
                    text: originalCall.argumentsText,
                    repaired: false
                  }
                } catch {
                  return { ok: false as const }
                }
              })()
      if (!parsedArguments.ok) {
        return fail(
          {
            code: 'INVALID_TOOL_ARGUMENTS',
            message: `Malformed arguments for tool "${originalCall.name}"`,
            retryable: true
          },
          originalCall.argumentsText
        )
      }
      const schema = compileJsonSchema(definition.inputSchema)
      const validated = schema.ok ? schema.validate.safeParse(parsedArguments.value) : undefined
      if (
        !schema.ok ||
        !validated?.success ||
        typeof validated.data !== 'object' ||
        !validated.data
      ) {
        return fail(
          {
            code: 'INVALID_TOOL_ARGUMENTS',
            message: `Invalid arguments for tool "${originalCall.name}"`,
            retryable: true
          },
          parsedArguments.text
        )
      }
      const call = {
        ...originalCall,
        argumentsText: parsedArguments.text,
        input: validated.data
      }
      const fingerprint = `${call.name}:${canonicalJson(validated.data)}`
      if (fingerprints.has(fingerprint)) {
        tools.push({ call, suppressed: true })
        return fail(
          {
            code: 'REPEATED_TOOL_CALL',
            message: `Repeated tool call "${call.name}" was suppressed`,
            retryable: true
          },
          call.argumentsText
        )
      }
      fingerprints.add(fingerprint)
      if (parsedArguments.repaired) repairs?.push('truncated-json')
      prepared.push({
        call,
        binding,
        input: validated.data as JsonObject,
        definition,
        repaired: wrongChannel
          ? 'wrong-channel'
          : parsedArguments.repaired
            ? 'truncated-json'
            : undefined
      })
    }

    attemptLog.push({
      role: 'assistant',
      content: providerResult.text,
      toolCalls: prepared.map(({ call }) => call)
    })
    const failedExecutions: Array<
      | {
          durationMs: number
          irreversibleBoundaryCrossed: boolean
        }
      | undefined
    > = []
    const execute = async (
      entry: (typeof prepared)[number],
      index: number,
      signal = request.signal
    ): Promise<JsonValue> => {
      const startedAt = performance.now()
      let irreversibleBoundaryCrossed = false
      try {
        return await entry.binding.execute(
          entry.input,
          executionContextFor(transaction, entry.binding.transactionMode, signal, () => {
            irreversibleBoundaryCrossed = true
            irreversibleBoundaries.push({
              step: currentStep + 1,
              toolCall: {
                id: entry.call.id,
                name: entry.call.name,
                index
              }
            })
          })
        )
      } catch (cause) {
        failedExecutions[index] = {
          durationMs: Math.max(0, performance.now() - startedAt),
          irreversibleBoundaryCrossed
        }
        throw cause
      }
    }
    const settled: Array<PromiseSettledResult<JsonValue>> = []
    if (prepared.every(({ binding }) => binding.parallelSafe)) {
      const siblingController = new AbortController()
      const abortSiblings = (): void => siblingController.abort(request.signal?.reason)
      if (request.signal?.aborted) abortSiblings()
      else request.signal?.addEventListener('abort', abortSiblings, { once: true })
      const executions = prepared.map((entry, index) =>
        execute(entry, index, siblingController.signal).catch((cause) => {
          if (!siblingController.signal.aborted) siblingController.abort(cause)
          throw cause
        })
      )
      settled.push(...(await Promise.allSettled(executions)))
      request.signal?.removeEventListener('abort', abortSiblings)
    } else {
      for (const [index, entry] of prepared.entries()) {
        try {
          settled.push({ status: 'fulfilled', value: await execute(entry, index) })
        } catch (reason) {
          settled.push({ status: 'rejected', reason })
          break
        }
      }
    }
    const executionFailure: HarnessFailure = {
      code: request.signal?.aborted ? 'CANCELLED' : 'TOOL_EXECUTION_FAILED',
      message: request.signal?.aborted
        ? 'Agent Invocation was cancelled'
        : 'Tool execution failed',
      retryable: !request.signal?.aborted
    }
    let batchFailure: HarnessFailure | undefined
    for (const [index, outcome] of settled.entries()) {
      const entry = prepared[index]
      if (outcome.status === 'rejected') {
        const failure = failedExecutions[index]
        const error = {
          code: executionFailure.code,
          message: executionFailure.message
        }
        tools.push({
          step: currentStep + 1,
          call: structuredClone(entry.call),
          index,
          arguments: structuredClone(entry.input),
          status: 'failure',
          error,
          durationMs: failure?.durationMs ?? 0,
          transactionMode: entry.binding.transactionMode,
          irreversibleBoundaryCrossed: failure?.irreversibleBoundaryCrossed ?? false,
          ...(entry.repaired ? { repaired: entry.repaired } : {})
        })
        attemptLog.push({
          role: 'tool',
          content: JSON.stringify({ error }),
          toolCallId: entry.call.id,
          name: entry.call.name
        })
        batchFailure = executionFailure
        continue
      }
      const normalized = normalizeJsonValue(outcome.value)
      if (!normalized.ok) {
        const invalidResultFailure: HarnessFailure = {
          code: 'INVALID_TOOL_RESULT',
          message: `Tool "${entry.call.name}" returned a non-JSON result: ${normalized.message}`,
          retryable: true
        }
        const error = {
          code: invalidResultFailure.code,
          message: invalidResultFailure.message
        }
        tools.push({
          step: currentStep + 1,
          call: structuredClone(entry.call),
          index,
          arguments: structuredClone(entry.input),
          status: 'failure',
          error,
          durationMs: 0,
          transactionMode: entry.binding.transactionMode,
          irreversibleBoundaryCrossed: false,
          ...(entry.repaired ? { repaired: entry.repaired } : {})
        })
        attemptLog.push({
          role: 'tool',
          content: JSON.stringify({ error }),
          toolCallId: entry.call.id,
          name: entry.call.name
        })
        batchFailure ??= invalidResultFailure
        continue
      }
      const result = normalized.value
      const projectionLimit =
        entry.definition.resultMaxTokens ?? options.toolResultMaxTokens ?? 10000
      const projection = projectToolResult(result, projectionLimit, estimateTokens)
      tools.push({
        call: entry.call,
        result: structuredClone(result),
        projectedContent: projection.content,
        projectedTokens: projection.tokens,
        projectionLimit,
        truncated: projection.truncated,
        ...(entry.repaired ? { repaired: entry.repaired } : {})
      })
      completedToolExecutions.push({
        input: structuredClone(entry.input),
        evidence: structuredClone(tools.at(-1)!)
      })
      attemptLog.push({
        role: 'tool',
        content: projection.content,
        toolCallId: entry.call.id,
        name: entry.call.name
      })
    }
    if (batchFailure) {
      return fail(
        batchFailure,
        prepared.map(({ call }) => call.argumentsText).join('\n')
      )
    }
  }

  if (finalText === undefined) {
    return fail(
      {
        code: 'MAX_STEPS',
        message: `Agent exceeded maxSteps ${options.maxSteps}`,
        retryable: false
      },
      ''
    )
  }
  if (
    finalFinishReason === 'length' &&
    (request.definition.result.mode === 'tools-only' ||
      (request.definition.result.mode === 'text' &&
        (request.definition.result.validator !== 'yss' || !/<\|\s*end\s*\|>/.test(finalText))))
  ) {
    return fail(
      {
        code: 'TRUNCATED_RESULT',
        message:
          'Provider output ended at its token limit and could not be repaired deterministically',
        retryable: true
      },
      finalText
    )
  }
  const validation = validateHarnessResult(
    request,
    finalText,
    tools.length,
    provider.capability.supportsTruncatedJsonRepair
  )
  if (!validation.ok) return fail(validation.failure, finalText)
  if (validation.repaired) repairs?.push('truncated-json')
  return {
    ok: true,
    value: validation.value,
    transaction,
    evidence: {
      attempt,
      outcome: 'success',
      providerCalls,
      immutablePrefix: attemptPrefix,
      toolSchemas: providerTools,
      appendOnlyLog: attemptLog,
      tools,
      usage,
      cache,
      latencyMs,
      rateLimits,
      irreversibleBoundary: transaction.externalEffectBegan,
      ...(irreversibleBoundaries.length
        ? { irreversibleBoundaries: orderedIrreversibleBoundaries() }
        : {}),
      ...(stepZeroBudget ? { contextBudget: stepZeroBudget } : {}),
      ...(repairs?.length ? { repairs } : {})
    }
  }
}

export const createAgentHarness = ({
  providerDispatch,
  toolRegistry,
  harnessPolicy = DEFAULT_HARNESS_POLICY,
  estimateTokens = defaultEstimateTokens,
  sleep = sleepWithSignal,
  contextWindowTokensForTest
}: CreateAgentHarnessOptions): AgentHarness => ({
  /**
   * One text step from an already-final request. Deliberately NOT `execute`: nothing here renders a
   * prompt, prepends the harness policy, appends the serialized input, binds tools, or retries. The
   * message array reaches `provider.dispatch` in the caller's exact order, byte for byte. Provider
   * errors and cancellation propagate unchanged so the caller keeps its own classification.
   */
  async executePrepared(request: HarnessPreparedRequest): Promise<ProviderResult> {
    return request.provider.dispatch({
      messages: request.messages,
      tools: [],
      // Zero tools: every shaper omits tool_choice entirely, so this cannot reach the wire.
      toolChoice: 'none',
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onEvent ? { onEvent: request.onEvent } : {})
    })
  },
  async execute(request: HarnessExecuteRequest): Promise<HarnessExecutionResult> {
    const evidence: HarnessEvidence = { attempts: [] }
    const prepared = prepareHarnessExecution({ request, providerDispatch, harnessPolicy })
    if (!prepared.ok) {
      if (prepared.provider) evidence.preset = prepared.provider.preset
      return { ok: false, failure: prepared.failure, stagedOperations: [], evidence }
    }
    const { provider, options, immutablePrefix, attemptLog, renderedPrompt } = prepared.value
    evidence.preset = provider.preset
    // Publish THESE bytes — the ones every attempt below is built from — to whoever records the run.
    // Rendering happens exactly once per execution; nobody downstream re-renders (see `onPromptBuilt`).
    request.onPromptBuilt?.(renderedPrompt)
    const tools = preflightTools(
      request.definition,
      toolRegistry,
      provider.capability.supportsTools,
      request.toolScope
    )
    if (!tools.ok) {
      return { ok: false, failure: tools.failure, stagedOperations: [], evidence }
    }

    let correction = request.corrective
      ? correctiveMessage(request.corrective.rejectedOutput, request.corrective.failure)
      : undefined
    let transportRetry: TransportRetry | undefined
    const maximumAttempts = 1 + options.maxRetryAttempts
    for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
      const outcome = await runAttempt({
        attempt,
        request,
        options,
        provider,
        immutablePrefix,
        baseAttemptLog: attemptLog,
        correction,
        bindings: tools.bindings,
        providerTools: tools.providerTools,
        estimateTokens,
        transportRetry,
        contextWindowTokens: contextWindowTokensForTest ?? provider.preset.contextWindowTokens
      })
      if (outcome.ok) {
        evidence.attempts.push(outcome.evidence)
        // Record-level budget reflects the LATEST attempt (D2), populated on every finished run.
        if (outcome.evidence.contextBudget) evidence.contextBudget = outcome.evidence.contextBudget
        return {
          ok: true,
          result: outcome.value,
          stagedOperations: outcome.transaction.stagedOperations(),
          evidence
        }
      }
      const canRetry =
        outcome.failure.retryable && attempt < maximumAttempts && !request.signal?.aborted
      outcome.evidence.outcome = request.signal?.aborted
        ? 'cancelled'
        : canRetry
          ? 'retry'
          : 'failure'
      evidence.attempts.push(outcome.evidence)
      // Record-level budget reflects the LATEST attempt (D2), populated on every finished run; the
      // failure-shape copy below stays as the fallback for a CONTEXT_BUDGET failure.
      if (outcome.evidence.contextBudget) evidence.contextBudget = outcome.evidence.contextBudget
      if (!canRetry) {
        outcome.evidence.discardedOperations = outcome.transaction.stagedOperations().length
        outcome.transaction.discard()
        if (outcome.failure.contextBudget) evidence.contextBudget = outcome.failure.contextBudget
        return { ok: false, failure: outcome.failure, stagedOperations: [], evidence }
      }
      outcome.evidence.discardedOperations = outcome.transaction.stagedOperations().length
      outcome.transaction.discard()
      if (outcome.transportFailure && outcome.transportRetry) {
        transportRetry = outcome.transportRetry
        correction = undefined
      } else {
        transportRetry = undefined
        correction = outcome.correction
      }
      const delay = Math.max(options.retryDelayMs, outcome.retryAfterMs ?? 0)
      try {
        await sleep(delay, request.signal)
      } catch {
        const failure = cancelledFailure()
        return { ok: false, failure, stagedOperations: [], evidence }
      }
    }
    const failure: HarnessFailure = {
      code: 'ATTEMPTS_EXHAUSTED',
      message: 'Agent attempts exhausted',
      retryable: false
    }
    return { ok: false, failure, stagedOperations: [], evidence }
  }
})
