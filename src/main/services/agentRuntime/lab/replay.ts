import {
  type AgentLabCase,
  type AgentLabRunResult,
  type AgentRunMessage,
  type AgentRunRecord,
  type AgentToolDefinition,
  type JsonValue,
  type PromptMessage
} from '../../../../shared/agentRuntime'
import { type CatalogAgent } from '../catalog'
import {
  createInvocationRuntime,
  type InvocationFloorPort,
  type InvocationPromptResult
} from '../invocation'
import {
  createProviderDispatch,
  createScriptedProviderAdapter,
  type ProviderAdapter,
  type ProviderAdapterEvent,
  type ProviderDispatch,
  type ProviderToolCall
} from '../provider'
import { createToolRegistry, type ToolBinding } from '../harness'
import { agentRunStore, createHarnessRunAdapter, type AgentRunStore } from '../runs'
import { createProfileCatalogCache } from './profileCatalogs'

/**
 * Agent Lab REPLAY (plan §Replay semantics, pinned mode).
 *
 * Re-runs a captured case against the CURRENT Agent definition WITHOUT calling any provider or
 * executing any real tool. Composition mirrors the recipe proven in
 * `test/agentRuntime/promptPreview.test.ts` `runAndCapture`: a real `InvocationRuntime` driven
 * through its public `run`, with three seams pinned from the case's `sourceRecord`:
 *
 *  1. PROMPT — a planner that substitutes the recorded `renderedPrompt` (origins stripped) so the
 *     wire prompt is byte-identical to the capture.
 *  2. PROVIDER — a scripted adapter whose steps are reconstructed from the recorded assistant turns
 *     (one provider step per recorded assistant message, with its tool calls and usage).
 *  3. TOOLS — stub bindings that replay recorded tool results in order, by tool name. A requested
 *     call with no recorded result fails the run with `LAB_TOOL_DIVERGENCE` and executes nothing.
 *
 * What replay therefore exercises is everything DOWNSTREAM of the provider on the current definition:
 * result-contract validation, the repair loop, tool-loop handling, and retry classification. The
 * produced `AgentRunRecord` lands in the real per-chat store (same as a manual run).
 */

export interface AgentLabReplayRequest {
  profileId: string
  chatId: string
  floor: number
  case: AgentLabCase
}

export interface AgentLabReplayDeps {
  catalog: { get(profileId: string, name: string): CatalogAgent | null }
  runStore?: AgentRunStore
  /** Wraps the scripted adapter into a dispatch. Default resolves the real preset (no network — the
   *  scripted adapter never reaches transport). Tests inject settings/preset here. */
  providerDispatchFactory?: (adapter: ProviderAdapter) => ProviderDispatch
  createId?: () => string
}

const ORIGINS_TO_STRIP = new Set(['harness-policy', 'input', 'addendum'])

/** Rebuild the pinned prompt substitution + addendum from the recorded renderedPrompt. */
const pinnedPrompt = (
  renderedPrompt: AgentRunMessage[]
): { prompt: PromptMessage[]; addendum?: string } => {
  const prompt: PromptMessage[] = []
  let addendum: string | undefined
  for (const message of renderedPrompt) {
    if (message.origin === 'addendum') {
      addendum = message.content
      continue
    }
    if (message.origin && ORIGINS_TO_STRIP.has(message.origin)) continue
    prompt.push({
      role: message.role === 'tool' ? 'user' : message.role,
      content: [{ type: 'text', text: message.content }]
    })
  }
  return { prompt, ...(addendum !== undefined ? { addendum } : {}) }
}

/**
 * Reconstruct the scripted provider steps (one per recorded assistant turn, in attempt order) and the
 * per-tool-name ordered result queues from a captured run record.
 */
const reconstruct = (
  record: AgentRunRecord
): {
  steps: Array<{ events: ProviderAdapterEvent[] }>
  toolResults: Map<string, JsonValue[]>
} => {
  const steps: Array<{ events: ProviderAdapterEvent[] }> = []
  const toolResults = new Map<string, JsonValue[]>()
  for (const attempt of record.attempts) {
    const usages = attempt.usage ?? []
    let usageIndex = 0
    for (const message of attempt.appendOnlyLog ?? []) {
      if (message.role !== 'assistant') continue
      const events: ProviderAdapterEvent[] = []
      if (message.content) events.push({ type: 'text-delta', delta: message.content })
      const toolCalls = (message.toolCalls ?? []) as unknown as ProviderToolCall[]
      toolCalls.forEach((call, index) => {
        events.push({
          type: 'tool-call-delta',
          index,
          ...(call.id !== undefined ? { id: call.id } : {}),
          ...(call.name !== undefined ? { name: call.name } : {}),
          ...(call.argumentsText
            ? { argumentsDelta: call.argumentsText }
            : call.input !== undefined
              ? { input: call.input }
              : {})
        })
      })
      const usage = usages[usageIndex++]
      if (usage) {
        events.push({
          type: 'usage',
          usage,
          cache: { readTokens: 0, writeTokens: 0 },
          raw: null
        })
      }
      events.push({ type: 'finish', reason: toolCalls.length ? 'tool-calls' : 'stop' })
      steps.push({ events })
    }
    for (const raw of attempt.tools ?? []) {
      const evidence = raw as {
        call?: { name?: string }
        result?: JsonValue
        status?: string
      } | null
      if (!evidence || evidence.status === 'failure' || !('result' in evidence)) continue
      const name = evidence.call?.name
      if (typeof name !== 'string') continue
      const queue = toolResults.get(name) ?? []
      queue.push(evidence.result as JsonValue)
      toolResults.set(name, queue)
    }
  }
  return { steps, toolResults }
}

export const createAgentLabReplay = (
  deps: AgentLabReplayDeps
): ((request: AgentLabReplayRequest) => Promise<AgentLabRunResult>) => {
  const runStore = deps.runStore ?? agentRunStore
  const dispatchFactory =
    deps.providerDispatchFactory ?? ((adapter) => createProviderDispatch({ adapter }))
  return async (request) => {
    const source = request.case.sourceRecord
    if (!source) return { ok: false, code: 'LAB_NO_SOURCE' }

    const agent = deps.catalog.get(request.profileId, request.case.agentId ?? request.case.agentName)
    if (!agent) return { ok: false, code: 'AGENT_NOT_FOUND' }
    if (!agent.enabled) return { ok: false, code: 'AGENT_DISABLED' }

    const definition = agent.effective
    const { steps, toolResults } = reconstruct(source)

    // Early drift detection: a tool the capture recorded results for but that the CURRENT definition no
    // longer exposes (removed or renamed) is a terminal divergence. Detect it BEFORE building the
    // runtime so no run record is persisted for a case whose tool surface has already drifted.
    const currentToolNames = new Set(definition.tools.map((tool) => tool.name))
    for (const recordedToolName of toolResults.keys()) {
      if (!currentToolNames.has(recordedToolName)) {
        return { ok: false, code: 'LAB_TOOL_DIVERGENCE' }
      }
    }

    // Divergence is detected inside a stub tool binding (the harness drives the tool loop). It is a
    // terminal Lab condition regardless of how the underlying run resolves, so it is surfaced from the
    // closure after the run settles. The stub NEVER calls anything real.
    let divergence: string | null = null
    const bindingFor = (tool: AgentToolDefinition): ToolBinding => ({
      name: tool.name,
      inputSchema: tool.inputSchema,
      transactionMode: tool.transactionMode,
      parallelSafe: tool.parallelSafe,
      execute() {
        const queue = toolResults.get(tool.name)
        if (!queue || queue.length === 0) {
          divergence = tool.name
          throw new Error(`Agent Lab replay diverged: no recorded result for tool "${tool.name}"`)
        }
        return queue.shift() as JsonValue
      }
    })
    const toolRegistry = createToolRegistry(definition.tools.map(bindingFor))

    const adapter = createScriptedProviderAdapter(steps)
    const harness = createHarnessRunAdapter({
      runStore,
      providerDispatch: dispatchFactory(adapter),
      toolRegistry
    })

    const pinned = pinnedPrompt(source.renderedPrompt)
    const floor: InvocationFloorPort = {
      async resolveSource() {
        return {
          token: `lab-replay:${source.invocationId}`,
          input: source.input,
          promptValues: {},
          history: source.history
        }
      },
      isSourceCurrent: () => true,
      async incorporate({ commitRun }) {
        commitRun()
        return { status: 'committed' }
      }
    }

    const promptResult: InvocationPromptResult = { prompt: pinned.prompt }
    const runtime = createInvocationRuntime({
      catalog: { get: () => agent },
      harness,
      floor,
      promptRenderer: () => promptResult,
      ...(deps.createId ? { createId: deps.createId } : {})
    })

    const outcome = await runtime.run({
      profileId: request.profileId,
      chatId: request.chatId,
      floor: request.floor,
      agent: definition.name,
      options: {
        input: source.input,
        // Replay timing is irrelevant; zero the delay so retry classification runs instantly.
        retryDelayMs: 0,
        ...(agent.invocationConfig.apiPresetId
          ? { apiPresetId: agent.invocationConfig.apiPresetId }
          : {}),
        ...(pinned.addendum !== undefined ? { addendum: pinned.addendum } : {})
      }
    })

    if (divergence)
      return { ok: false, code: 'LAB_TOOL_DIVERGENCE', invocationId: outcome.invocationId }
    return { ok: true, invocationId: outcome.invocationId, status: outcome.status }
  }
}

let production: ((request: AgentLabReplayRequest) => Promise<AgentLabRunResult>) | null = null

/** Production replay composition: the CURRENT definition comes from the real per-profile catalog, the
 *  record lands in the real per-chat run store, and the preset resolves through the real settings. */
export const agentLabReplay = (): ((request: AgentLabReplayRequest) => Promise<AgentLabRunResult>) => {
  if (!production) {
    const catalogFor = createProfileCatalogCache()
    production = createAgentLabReplay({
      catalog: {
        get(profileId, name) {
          return catalogFor(profileId).get(name)
        }
      }
    })
  }
  return production
}
