import type { ProviderDispatchVia } from '../apiService'
import { createAgentHarness, createToolRegistry, type AgentHarness } from '../agentRuntime/harness'
import { createProviderDispatch } from '../agentRuntime/provider'

/**
 * The `llm.sample` production AgentHarness seam (execution plan Milestone 1).
 *
 * The caller already owns prompt assembly, provider shaping, and the late dispatch transforms, and it
 * already resolved its own connection/preset before the call. So it enters the Harness through the
 * prepared-request Interface, which sends that exact message array and adds nothing to it.
 *
 * BLAST RADIUS: every `llm.sample` node, not Classic Narrator alone. Classic's default graph is the
 * milestone's target, but the memory group template (`defaultMemoryTemplate.ts`), the async memory
 * pack, and the table memory pack all instantiate `llm.sample` too, so their background sampling
 * routes here as well. That is accepted rather than gated: the seam is provider-invisible and
 * byte-identical, so discriminating Classic's node from memory's would add runtime machinery for no
 * observable difference. `agent.llm`, memory, notes, and recall nodes call `runLlmCall` directly and
 * are NOT affected.
 *
 * `providerDispatch` is present only because `createAgentHarness` requires the full options block;
 * the prepared path never calls `resolve`, so the connection is always the caller's, never one
 * re-derived from settings. `toolRegistry` is empty because this path binds no tools.
 */
let harness: AgentHarness | undefined

const classicHarness = (): AgentHarness =>
  (harness ??= createAgentHarness({
    providerDispatch: createProviderDispatch(),
    toolRegistry: createToolRegistry()
  }))

/**
 * Routes ONE provider call through `AgentHarness.executePrepared`. The Harness performs no retry
 * here (`callModelResilient` still owns that), adds no message, and binds no tool, so the
 * provider-visible request is byte-identical to the direct dispatch it replaces.
 */
export const harnessDispatchVia: ProviderDispatchVia = (provider, request) =>
  classicHarness().executePrepared({
    provider,
    messages: request.messages,
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.onEvent ? { onEvent: request.onEvent } : {})
  })
