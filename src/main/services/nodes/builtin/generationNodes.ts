import { z } from 'zod'
import { buildGenContext } from '../../generation/genContext'
import { recallMemory } from '../../generation/memoryRecall'
import { matchWorldInfo, assemblePrompt } from '../../generation/assemble'
import { callModel } from '../../generation/callModel'
import { parseResponse, computeMetrics } from '../../generation/parseResponse'
import { foldState } from '../../generation/foldState'
import { persistFloor, compactMemory } from '../../generation/persistFloor'
import { GenContext } from '../../generation/types'
import { ChatMessage } from '../../promptBuilder'
import { PresetParameters } from '../../../types/preset'
import { FloorMetrics } from '../../../../shared/usageTypes'
import { NodeImpl } from '../types'

/**
 * Pre-model built-in nodes (Phase 2b-1b task 2): thin `run()` delegations to the 2b-1a
 * generation stage functions. No generation logic lives here — each node only shapes
 * RunContext/inputs into the stage's call signature and maps its return onto output ports.
 */

/** Assembles the per-turn GenContext bundle from the turn seed (spec node table). */
export const inputContext: NodeImpl = {
  type: 'input.context',
  title: 'Context',
  inputs: [],
  outputs: [{ name: 'gen', type: 'Context' }],
  run: (ctx) => ({
    outputs: { gen: buildGenContext(ctx.profileId!, ctx.chatId!, ctx.userAction!) }
  })
}

/** Recalls relevant episodic memory into a text block for the prompt tail. */
export const memoryRecallNode: NodeImpl = {
  type: 'memory.recall',
  title: 'Recall Memory',
  inputs: [{ name: 'gen', type: 'Context' }],
  outputs: [{ name: 'block', type: 'Text' }],
  run: async (_ctx, inputs) => {
    const r = await recallMemory(inputs.gen as GenContext)
    return { outputs: { block: r.block } }
  }
}

/** Matches world info then assembles the exact message array + sampler params to send. */
export const promptAssemble: NodeImpl = {
  type: 'prompt.assemble',
  title: 'Assemble Prompt',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'block', type: 'Text' }
  ],
  outputs: [
    { name: 'sendMessages', type: 'Messages' },
    { name: 'params', type: 'Any' }
  ],
  run: (_ctx, inputs) => {
    const gen = inputs.gen as GenContext
    const matched = matchWorldInfo(gen)
    const { sendMessages, params } = assemblePrompt(gen, matched, inputs.block as string)
    return { outputs: { sendMessages, params } }
  }
}

/** Calls the provider and streams the reply live via `ctx.streamMain`, aborting on the user's
 *  Stop (`ctx.modelSignal`, not the graph signal). On abort-with-empty (`callModel` returns null)
 *  this calls `ctx.abortGraph()` so the engine's abort path skips the downstream (sync) nodes,
 *  matching `generate()`'s early-return null. On abort-with-text the graph is left running so
 *  parse/apply/write persist the partial floor (Phase 2b-1b abort fix).
 *
 *  `config.stream` (default true) controls whether the reply streams into the CHAT message. A
 *  side-branch LLM (planner / judge / background job — spec §8/§11) sets stream=false so its
 *  output never pollutes the player-facing stream; pair it with `panel.show` to surface the
 *  result in a collapsible chat panel instead (spec D4). */
export const llmSample: NodeImpl = {
  type: 'llm.sample',
  title: 'Sample',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'sendMessages', type: 'Messages' },
    { name: 'params', type: 'Any' },
    // Optional spec §11 gating port: unwired in the default graph, additive-only.
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'raw', type: 'Text' },
    { name: 'rawUsage', type: 'Any' }
  ],
  configSchema: z.object({ stream: z.boolean().optional() }),
  run: async (ctx, inputs, node) => {
    const streamToChat = node?.config?.stream !== false
    const r = await callModel(
      inputs.gen as GenContext,
      inputs.sendMessages as ChatMessage[],
      inputs.params as PresetParameters,
      streamToChat ? ctx.streamMain : () => {},
      ctx.modelSignal ?? ctx.signal
    )
    // Abort-with-empty (callModel returned null): nothing to persist — abort the GRAPH so the engine
    // skips parse/apply/write and generate() returns null. Abort-with-text returns {raw,...} here, so
    // the graph runs on and persists the partial floor (matching the pre-workflow behavior).
    if (r === null) {
      ctx.abortGraph?.()
      return { outputs: {} }
    }
    return { outputs: { raw: r.raw, rawUsage: r.rawUsage } }
  }
}

/** Cleans + parses the raw response into rpt-events/MVU commands, plus computes this turn's
 *  cache metrics. */
export const parseResponseNode: NodeImpl = {
  type: 'parse.response',
  title: 'Parse Response',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'raw', type: 'Text' },
    { name: 'sendMessages', type: 'Messages' },
    { name: 'rawUsage', type: 'Any' }
  ],
  outputs: [
    { name: 'parsed', type: 'Any' },
    { name: 'mvu', type: 'Any' },
    { name: 'metrics', type: 'Any' }
  ],
  run: (_ctx, inputs) => {
    const raw = inputs.raw as string
    const { parsed, mvu } = parseResponse(raw)
    const metrics = computeMetrics(
      inputs.gen as GenContext,
      inputs.sendMessages as ChatMessage[],
      raw,
      inputs.rawUsage
    )
    return { outputs: { parsed, mvu, metrics } }
  }
}

/** Folds this turn's parsed rpt-events + MVU commands onto the running variables. */
export const applyState: NodeImpl = {
  type: 'apply.state',
  title: 'Apply State',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'parsed', type: 'Any' },
    { name: 'mvu', type: 'Any' },
    { name: 'raw', type: 'Text' }
  ],
  outputs: [{ name: 'variables', type: 'Vars' }],
  run: (_ctx, inputs) => {
    const variables = foldState(
      inputs.gen as GenContext,
      inputs.parsed as ReturnType<typeof parseResponse>['parsed'],
      inputs.mvu as ReturnType<typeof parseResponse>['mvu'],
      inputs.raw as string
    )
    return { outputs: { variables } }
  }
}

/** Persists this turn's globals + the finished floor. This is the `isMainOutput` (phase-boundary)
 *  node (spec/plan decision A): the whole synchronous pre-response chain ends here, and the
 *  engine delivers the turn result once this node completes. */
export const outputWriteFloor: NodeImpl = {
  type: 'output.writeFloor',
  title: 'Write Floor',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'raw', type: 'Text' },
    { name: 'sendMessages', type: 'Messages' },
    { name: 'variables', type: 'Vars' },
    { name: 'parsed', type: 'Any' },
    { name: 'metrics', type: 'Any' }
  ],
  outputs: [{ name: 'floor', type: 'Any' }],
  isMainOutputCapable: true,
  run: (_ctx, inputs) => {
    const gen = inputs.gen as GenContext
    const parsed = inputs.parsed as ReturnType<typeof parseResponse>['parsed']
    const floor = persistFloor(gen, {
      userAction: gen.userAction,
      raw: inputs.raw as string,
      sendMessages: inputs.sendMessages as ChatMessage[],
      events: parsed.events,
      variables: inputs.variables as Record<string, unknown>,
      metrics: inputs.metrics as FloorMetrics
    })
    return { outputs: { floor } }
  }
}

/** Folds aged-out turns into episodic memory. Post-response/off the hot path (spec/plan decision
 *  A) — fire-and-forget, same as `generate()`'s `compactMemory(profileId, chatId)` call. */
export const memoryCompact: NodeImpl = {
  type: 'memory.compact',
  title: 'Compact Memory',
  inputs: [{ name: 'gen', type: 'Context' }],
  outputs: [],
  run: (_ctx, inputs) => {
    const gen = inputs.gen as GenContext
    compactMemory(gen.profileId, gen.chatId)
    return { outputs: {} }
  }
}
