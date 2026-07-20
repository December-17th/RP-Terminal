import type {
  CardAgentPlanOutcome,
  CardAgentRunOptions,
  CardAgentRunOutcome,
  CardAgentToolBinding,
  CardAgentToolExecution,
  CardAgentToolHandler,
  CardFloorCommit,
  InvocationPlan,
  JsonObject
} from '../agentRuntime'
import type { AgentHost } from './hostFacets'

export type { CardAgentToolBinding, CardFloorCommit } from '../agentRuntime'

export interface AgentRunCommand {
  kind: 'run'
  requestId: string
  name: string
  options: Omit<CardAgentRunOptions, 'signal'>
}

export interface AgentPlanCommand {
  kind: 'runPlan'
  requestId: string
  plan: InvocationPlan
}

export type AgentInvocationCommand = AgentRunCommand | AgentPlanCommand

export interface AgentInvocationPort {
  run(command: AgentRunCommand): Promise<CardAgentRunOutcome>
  runPlan(command: AgentPlanCommand): Promise<CardAgentPlanOutcome>
  cancel(requestId: string): void | Promise<unknown>
}

export interface AgentToolRequest {
  requestId: string
  name: string
  input: JsonObject
}

export interface AgentToolCompletion extends Partial<CardAgentToolExecution> {
  requestId: string
  result: CardAgentToolExecution['result']
  error?: string
}

export interface AgentToolPort<Lease = unknown> {
  register(binding: CardAgentToolBinding): Promise<Lease>
  unregister(name: string, lease: Lease | undefined): void | Promise<unknown>
  complete(lease: Lease, completion: AgentToolCompletion): void
  onRequest(handler: (request: AgentToolRequest) => void): () => void
  onAbort(handler: (requestId: string) => void): () => void
}

export interface AgentFloorPort {
  subscribe(handler: (event: CardFloorCommit) => void): () => void
}

export interface AgentHostPorts<Lease = unknown> {
  invocation: AgentInvocationPort
  tools: AgentToolPort<Lease>
  floors: AgentFloorPort
}

const aborted = (): DOMException => new DOMException('Agent invocation was aborted', 'AbortError')

export const createAgentHostFacet = <Lease>({
  invocation,
  tools,
  floors
}: AgentHostPorts<Lease>): AgentHost => {
  const toolHandlers = new Map<string, CardAgentToolHandler>()
  const toolLeases = new Map<string, Lease>()
  const toolReadiness = new Map<string, Promise<void>>()
  const toolRegistrationErrors = new Map<string, unknown>()
  const pendingTools = new Map<string, { name: string; controller: AbortController }>()
  let stopToolRequests: (() => void) | null = null
  let stopToolAborts: (() => void) | null = null

  const awaitToolReadiness = async (): Promise<void> => {
    await Promise.all(toolReadiness.values())
    const error = toolRegistrationErrors.values().next().value
    if (error !== undefined) throw error
  }

  const invoke = async <T>(
    command: AgentInvocationCommand,
    signal: AbortSignal | undefined,
    send: () => Promise<T>
  ): Promise<T> => {
    if (toolReadiness.size > 0) await awaitToolReadiness()
    if (signal?.aborted) throw aborted()
    const abort = (): void => {
      void invocation.cancel(command.requestId)
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await send()
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  const ensureToolListeners = (): void => {
    if (stopToolRequests) return
    stopToolRequests = tools.onRequest((request) => {
      void (async () => {
        await toolReadiness.get(request.name)
        const handler = toolHandlers.get(request.name)
        if (!handler || !toolLeases.has(request.name) || typeof request.requestId !== 'string')
          return
        const lease = toolLeases.get(request.name) as Lease
        const controller = new AbortController()
        pendingTools.set(request.requestId, { name: request.name, controller })
        await Promise.resolve(handler(request.input ?? {}, { signal: controller.signal }))
          .then((execution) => {
            if (!controller.signal.aborted) {
              tools.complete(lease, { requestId: request.requestId, ...execution })
            }
          })
          .catch((cause) => {
            if (controller.signal.aborted) return
            tools.complete(lease, {
              requestId: request.requestId,
              result: null,
              error: cause instanceof Error ? cause.message : String(cause)
            })
          })
          .finally(() => pendingTools.delete(request.requestId))
      })()
    })
    stopToolAborts = tools.onAbort((requestId) => {
      pendingTools.get(requestId)?.controller.abort()
    })
  }

  const floorHandlers = new Set<(event: CardFloorCommit) => void>()
  let stopFloorEvents: (() => void) | null = null

  return {
    runAgent(name, options: CardAgentRunOptions = {}) {
      const { signal, ...transportOptions } = options
      const command: AgentRunCommand = {
        kind: 'run',
        requestId: crypto.randomUUID(),
        name,
        options: transportOptions
      }
      return invoke(command, signal, () => invocation.run(command))
    },

    runAgentPlan(plan, signal) {
      const command: AgentPlanCommand = {
        kind: 'runPlan',
        requestId: crypto.randomUUID(),
        plan
      }
      return invoke(command, signal, () => invocation.runPlan(command))
    },

    registerAgentTool(binding, handler) {
      if (toolHandlers.has(binding.name)) {
        throw Object.assign(new Error('Card tool is already registered: ' + binding.name), {
          code: 'CARD_TOOL_DUPLICATE'
        })
      }
      ensureToolListeners()
      toolHandlers.set(binding.name, handler)
      toolRegistrationErrors.delete(binding.name)
      const ready = tools.register(binding).then(
        (lease) => {
          toolLeases.set(binding.name, lease)
        },
        (cause) => {
          toolHandlers.delete(binding.name)
          toolRegistrationErrors.set(binding.name, cause)
          toolLeases.delete(binding.name)
        }
      )
      toolReadiness.set(binding.name, ready)
      return () => {
        if (!toolHandlers.delete(binding.name)) return
        toolRegistrationErrors.delete(binding.name)
        const lease = toolLeases.get(binding.name)
        toolLeases.delete(binding.name)
        for (const pending of pendingTools.values()) {
          if (pending.name === binding.name) pending.controller.abort()
        }
        void ready.then(() => tools.unregister(binding.name, lease))
        toolReadiness.delete(binding.name)
        if (toolHandlers.size === 0) {
          stopToolRequests?.()
          stopToolAborts?.()
          stopToolRequests = null
          stopToolAborts = null
        }
      }
    },

    onFloorCommitted(handler) {
      if (floorHandlers.size === 0) {
        stopFloorEvents = floors.subscribe((event) => {
          for (const current of floorHandlers) current(event)
        })
      }
      floorHandlers.add(handler)
      return () => {
        if (!floorHandlers.delete(handler) || floorHandlers.size > 0) return
        stopFloorEvents?.()
        stopFloorEvents = null
      }
    }
  }
}
