import {
  normalizeAgentName,
  type AgentDefinition,
  type HistoryPolicy,
  type InvocationOptions,
  type PromptMessage
} from '../../../../shared/agentRuntime'
import { log } from '../../logService'
import {
  MEMORY_MAINTENANCE_AGENT_NAME,
  memoryMaintenanceBridge
} from '../memoryMaintenanceSlot'
import {
  createAgentPromptRenderer,
  isDynamicAgentPromptText,
  type AgentPromptRendererPort
} from './agentPromptRenderer'

/**
 * Preset-driven Agent prompt assembly (ADR 0021, slices 3 + 4).
 *
 * An Agent that bundles a preset (`definition.preset`) does not send its `prompt` messages as the
 * whole prompt. Its prompt is ASSEMBLED — character card, persona, world info, opt-in history — by
 * the same `assemblePrompt` Classic uses, with the Agent's own `prompt` appended as the task
 * instruction. Assembly happens strictly BEFORE the Harness; the Harness receives the finished
 * messages and never learns a preset was involved.
 *
 * IMPORT DIRECTION. `generation/` already imports `agentRuntime/` (harnessDispatch.ts), so the
 * reverse import would close a cycle. This module is therefore a REGISTRATION SLOT, the same shape
 * `cardAgentCatalogBridge.ts` uses for the card catalog: `agentRuntime` owns the setter and the
 * interface, and a tiny bridge on the generation side (`agentPresetAssemblyBridge.ts`, imported once
 * from `main/index.ts`) installs the real assembler at startup. Nothing here imports `generation/`.
 *
 * FAIL-OPEN. Every failure — no assembler registered, an unreadable envelope, a throwing assembler —
 * falls back to the messages-Agent behaviour (the definition's own `prompt`, rendered). A degraded
 * prompt is recoverable; a crashed invocation is not.
 */

export interface AgentPresetAssemblyRequest {
  profileId: string
  chatId: string
  /** The Agent's OWNING floor. Assembly reads the chat as it stood at this floor, never later. */
  floor: number
  /** Carries the bundle (`definition.preset`) and the Agent's own task-instruction `prompt`. */
  definition: AgentDefinition
  /**
   * The EFFECTIVE History Policy (invocation option, else the Agent's default). Undefined means the
   * Agent declared none, which per ADR 0021 §3 means NO history at all — not "the usual history".
   */
  history?: HistoryPolicy
  /** The same text renderer a messages Agent gets, so the appended task instruction still templates. */
  render?: (text: string) => string
}

/** Produces the FULL ordered prompt for a preset Agent, or undefined to fall back to `prompt`. */
export type AgentPresetAssembler = (
  request: AgentPresetAssemblyRequest
) => PromptMessage[] | undefined

let registered: AgentPresetAssembler | undefined

/** Install the production assembler. Called once, from the generation-side bridge at startup. */
export const setAgentPresetAssembler = (assembler: AgentPresetAssembler | undefined): void => {
  registered = assembler
}

/** The installed assembler, or undefined when nothing registered (tests, lightweight compositions). */
export const agentPresetAssembler = (): AgentPresetAssembler | undefined => registered

/**
 * What the Invocation Runtime hands to the Harness for one attempt: either a text renderer (messages
 * Agent) or a complete substitute prompt (preset Agent). Never both — assembled messages arrive
 * already rendered, and re-running the engine over them could expand a `{{...}}` that is card DATA.
 */
export interface InvocationPrompt {
  render?: (text: string) => string
  volatilePromptIndices?: number[]
  prompt?: PromptMessage[]
  /**
   * Degradation notices for the Run Record. Fail-open keeps the invocation alive, but a preset Agent
   * that fell back to its bare `prompt` lost the card, persona, world info and history it was written
   * against — and still bills a real provider call. Without this the resulting run is
   * indistinguishable from a healthy one in the UI, which is the whole failure mode.
   */
  warnings?: string[]
}

export interface AgentPromptPlannerDeps {
  renderer: AgentPromptRendererPort
  assembler(): AgentPresetAssembler | undefined
  warn(message: string, detail?: unknown): void
}

export const defaultAgentPromptPlannerDeps: AgentPromptPlannerDeps = {
  renderer: createAgentPromptRenderer(),
  assembler: agentPresetAssembler,
  // LogLevel has no 'warn' tier; a preset Agent silently degrading to its bare prompt is something
  // the developer must see, so it is logged at 'error' while the invocation itself continues.
  warn: (message, detail) => log('error', message, detail)
}

export type InvocationPromptPort = (scope: {
  profileId: string
  chatId: string
  floor: number
  agent: AgentDefinition
  options?: InvocationOptions
}) => InvocationPrompt | undefined

/**
 * The composition the Invocation Runtime injects: decides, per attempt, whether this Agent renders
 * its own messages or gets an assembled prompt.
 */
export const createAgentPromptPlanner = (
  deps: AgentPromptPlannerDeps = defaultAgentPromptPlannerDeps
): InvocationPromptPort => {
  return (scope) => {
    // Built-in Memory Maintenance Agent (M4): its prompt is the shared `composeMaintainerMessages`
    // output, produced by the main-side bridge and SUBSTITUTED via `prompt` — the same seam a preset
    // Agent uses. Nothing here imports the composer; the bridge owns it (memoryMaintenanceSlot.ts).
    const memory = memoryMaintenanceBridge()
    if (
      memory &&
      normalizeAgentName(scope.agent.name) === normalizeAgentName(MEMORY_MAINTENANCE_AGENT_NAME)
    ) {
      const prompt = memory.composePrompt({
        profileId: scope.profileId,
        chatId: scope.chatId,
        floor: scope.floor
      })
      if (prompt?.length) return { prompt }
      // Compose fell open (state changed since the due-gate) — fall through to the render/degrade path
      // so the definition's placeholder prompt is sent rather than nothing.
    }
    const render = deps.renderer({
      profileId: scope.profileId,
      chatId: scope.chatId,
      floor: scope.floor
    })
    const volatilePromptIndices = render
      ? scope.agent.prompt.flatMap((message, index) =>
          message.content.some(
            (segment) => segment.type === 'text' && isDynamicAgentPromptText(segment.text)
          )
            ? [index]
            : []
        )
      : []
    const renderedPrompt = render
      ? {
          render,
          ...(volatilePromptIndices.length ? { volatilePromptIndices } : {})
        }
      : {}
    const bundle = scope.agent.preset
    const assemble = bundle ? deps.assembler() : undefined
    // Every path below that reaches the fallback records WHY, so the run is marked degraded rather
    // than merely logged. The suffix is shared because the consequence is identical in every case.
    const lost = `its bundled preset did not run, so the character card, persona, world info and history are missing from this prompt`
    let degraded: string | undefined
    if (bundle && assemble) {
      // Resolved the same way `resolveInvocationOptions` resolves it, so the Policy an operator set on
      // the invocation wins over the Agent's declared default.
      const history = scope.options?.history ?? scope.agent.defaults.history
      try {
        const prompt = assemble({
          profileId: scope.profileId,
          chatId: scope.chatId,
          floor: scope.floor,
          definition: scope.agent,
          ...(history ? { history } : {}),
          ...(render ? { render } : {})
        })
        if (prompt?.length) return { prompt }
        degraded = `Preset assembly produced no messages — ${lost}`
      } catch (cause) {
        degraded = `Preset assembly failed (${
          cause instanceof Error ? cause.message : String(cause)
        }) — ${lost}`
      }
    } else if (bundle) {
      degraded = `No preset assembler is registered — ${lost}`
    }
    if (degraded) {
      deps.warn(`Agent "${scope.agent.name}": ${degraded}`)
      return { ...renderedPrompt, warnings: [degraded] }
    }
    return render ? renderedPrompt : undefined
  }
}
