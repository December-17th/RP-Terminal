import type {
  CardAgentRunOptions,
  CardAgentToolBinding,
  CardFloorCommit
} from '../../../shared/agentRuntime'
import type { InvocationPlanPromise, InvocationPromise, InvocationRuntime } from './invocation'
import {
  CARD_TOOL_CALLBACK_CHANNELS,
  type CardToolCallbackResult,
  type CardToolRegistry,
  type CardToolSender
} from './tools/CardToolRegistry'

export interface AgentHostSessionScope {
  profileId: string
  chatId: string
  characterId: string
}

export interface AgentHostSessionRun {
  requestId: string
  name: string
  options?: CardAgentRunOptions
}

export interface AgentHostSessionPlan {
  requestId: string
  plan: unknown
}

export type AgentHostSessionToolAuthority = 'completion-capability' | 'sender'

/** The user's profile-local invocation binding for one Agent (the API preset it must run against). */
export interface AgentInvocationBinding {
  apiPresetId?: string
}

export interface AgentHostSessionDependencies {
  scope: AgentHostSessionScope
  senderId: number
  runtime: Pick<InvocationRuntime, 'run' | 'runPlan' | 'cancelInvocation' | 'cancelPlan'>
  tools: CardToolRegistry
  latestFloor(): number | undefined
  sendTool: CardToolSender
  toolAuthority: AgentHostSessionToolAuthority
  cancelInvocationsOnClose: boolean
  /**
   * Resolve the user's per-Agent invocation binding by Agent name, sourced from the SAME catalog the
   * manual Workspace / trigger paths consult. Card-invoked runs honor this binding (its `apiPresetId`
   * wins), so the same Agent runs against the user's chosen preset regardless of caller. Optional so
   * tests can construct a session without a catalog; production always injects it.
   */
  resolveInvocationConfig?(agentName: string): AgentInvocationBinding | null | undefined
}

type PendingInvocation = { kind: 'run' | 'plan'; id: string }

export class AgentHostSession {
  readonly scope: AgentHostSessionScope
  private readonly pending = new Map<string, PendingInvocation>()
  private readonly toolCapabilities = new Map<string, string>()
  private floorSubscriber: ((event: CardFloorCommit) => void) | null = null
  private closed = false

  constructor(private readonly dependencies: AgentHostSessionDependencies) {
    this.scope = dependencies.scope
  }

  async run(command: AgentHostSessionRun): Promise<Awaited<InvocationPromise>> {
    // Strip `signal` (transport-only) and — per owner policy — any card-supplied `apiPresetId`/`model`:
    // cards may never choose the preset or model. Then let the user's per-Agent binding win.
    const { signal: _signal, apiPresetId: _apiPresetId, model: _model, ...rest } = (command.options ??
      {}) as CardAgentRunOptions & { apiPresetId?: unknown; model?: unknown }
    const options = this.applyBinding(command.name, rest)
    const floor = options.floor ?? this.dependencies.latestFloor()
    if (floor === undefined) throw new Error('No committed Invocation Floor exists')
    const running = this.dependencies.runtime.run({
      ...this.scope,
      floor,
      agent: command.name,
      options,
      toolScope: this.scope
    })
    this.pending.set(command.requestId, { kind: 'run', id: running.invocationId })
    try {
      return await running
    } finally {
      this.pending.delete(command.requestId)
    }
  }

  async runPlan(command: AgentHostSessionPlan): Promise<Awaited<InvocationPlanPromise>> {
    // Sanitize the plan: strip card-supplied `apiPresetId`/`model` from every step call and merge each
    // Agent's user binding (binding wins), mirroring the single-run policy across a declarative plan.
    const plan = this.sanitizePlan(command.plan)
    const planFloor =
      plan && typeof plan === 'object' ? (plan as { floor?: unknown }).floor : undefined
    const floor = typeof planFloor === 'number' ? planFloor : this.dependencies.latestFloor()
    if (floor === undefined) throw new Error('No committed Invocation Floor exists')
    const running = this.dependencies.runtime.runPlan({
      ...this.scope,
      floor,
      plan,
      toolScope: this.scope
    })
    this.pending.set(command.requestId, { kind: 'plan', id: running.planId })
    try {
      return await running
    } finally {
      this.pending.delete(command.requestId)
    }
  }

  /** Merge the user's per-Agent binding onto sanitized run options — its `apiPresetId` wins. */
  private applyBinding(
    agentName: string,
    options: Omit<CardAgentRunOptions, 'signal'>
  ): Omit<CardAgentRunOptions, 'signal'> & { apiPresetId?: string } {
    const apiPresetId = this.dependencies.resolveInvocationConfig?.(agentName)?.apiPresetId
    return apiPresetId ? { ...options, apiPresetId } : options
  }

  /** Return a plan copy with each step call's card-supplied preset/model dropped and the user binding merged. */
  private sanitizePlan(rawPlan: unknown): unknown {
    if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) return rawPlan
    const source = rawPlan as { steps?: unknown }
    if (!Array.isArray(source.steps)) return rawPlan
    const sanitizeCall = (call: unknown): unknown => {
      if (!call || typeof call !== 'object' || Array.isArray(call)) return call
      const { apiPresetId: _apiPresetId, model: _model, ...rest } = call as Record<string, unknown>
      const agentName = typeof rest.agent === 'string' ? rest.agent : undefined
      const apiPresetId = agentName
        ? this.dependencies.resolveInvocationConfig?.(agentName)?.apiPresetId
        : undefined
      return apiPresetId ? { ...rest, apiPresetId } : rest
    }
    const steps = source.steps.map((step) => {
      if (
        step &&
        typeof step === 'object' &&
        !Array.isArray(step) &&
        Array.isArray((step as { parallel?: unknown }).parallel)
      ) {
        const group = step as { parallel: unknown[] }
        return { ...(step as object), parallel: group.parallel.map(sanitizeCall) }
      }
      return sanitizeCall(step)
    })
    return { ...(rawPlan as object), steps }
  }

  cancel(requestId: string): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    return pending.kind === 'run'
      ? this.dependencies.runtime.cancelInvocation(pending.id)
      : this.dependencies.runtime.cancelPlan(pending.id)
  }

  registerTool(binding: CardAgentToolBinding): true | { completionCapability: string } {
    const completionCapability =
      this.dependencies.toolAuthority === 'completion-capability' ? crypto.randomUUID() : undefined
    this.dependencies.tools.register({
      scope: { ...this.scope, senderId: this.dependencies.senderId },
      binding,
      send: this.dependencies.sendTool
    })
    if (!completionCapability) return true
    this.toolCapabilities.set(binding.name, completionCapability)
    return { completionCapability }
  }

  unregisterTool(name: string): boolean {
    this.toolCapabilities.delete(name)
    return this.dependencies.tools.unregister(this.dependencies.senderId, name, this.scope)
  }

  completeTool(
    result: Omit<CardToolCallbackResult, 'senderId' | 'scope'> & {
      completionCapability?: unknown
    }
  ): boolean {
    if (this.dependencies.toolAuthority === 'completion-capability') {
      const capability =
        typeof result.completionCapability === 'string' ? result.completionCapability : null
      if (!capability || ![...this.toolCapabilities.values()].includes(capability)) return false
    }
    return this.dependencies.tools.complete({
      ...result,
      senderId: this.dependencies.senderId,
      scope: this.scope
    })
  }

  subscribeFloors(send: (event: CardFloorCommit) => void): void {
    this.floorSubscriber = send
  }

  unsubscribeFloors(): void {
    this.floorSubscriber = null
  }

  deliverFloor(profileId: string, chatId: string, event: CardFloorCommit): void {
    if (
      this.floorSubscriber &&
      this.scope.profileId === profileId &&
      this.scope.chatId === chatId
    ) {
      this.floorSubscriber(event)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.floorSubscriber = null
    if (this.dependencies.cancelInvocationsOnClose) {
      for (const pending of this.pending.values()) {
        if (pending.kind === 'run') this.dependencies.runtime.cancelInvocation(pending.id)
        else this.dependencies.runtime.cancelPlan(pending.id)
      }
    }
    this.pending.clear()
    this.dependencies.tools.unregisterSender(this.dependencies.senderId)
    this.toolCapabilities.clear()
  }
}

export const agentToolRequestSender = (
  send: (channel: string, payload: unknown) => void,
  decorate: (payload: unknown) => unknown = (payload) => payload
): CardToolSender => {
  return (channel, payload) => {
    if (
      channel !== CARD_TOOL_CALLBACK_CHANNELS.request &&
      channel !== CARD_TOOL_CALLBACK_CHANNELS.abort
    ) {
      return
    }
    send(channel, decorate(payload))
  }
}
