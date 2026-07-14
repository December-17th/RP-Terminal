import { z } from 'zod'
import { buildGenContext } from '../../generation/genContext'
import { matchWorldInfo, assemblePrompt } from '../../generation/assemble'
import { callModelResilient, ResilienceConfig, withPreset } from '../../generation/resilientCall'
import { parseResponse, computeMetrics } from '../../generation/parseResponse'
import { foldState } from '../../generation/foldState'
import { persistFloor } from '../../generation/persistFloor'
import { GenContext } from '../../generation/types'
import { ChatMessage } from '../../promptBuilder'
import { LorebookEntry } from '../../../types/character'
import { PresetParameters } from '../../../types/preset'
import { FloorMetrics } from '../../../../shared/usageTypes'
import { NodeImpl, NodeRunFailure, RunContext } from '../types'

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

/** Re-acquires the per-turn GenContext bundle MID-GRAPH (context epochs). `input.context` snapshots
 *  floors + variables ONCE at the top; a branch that writes floor variables mid-turn (vars.save /
 *  mvu.set) is invisible to every later node reading the original bundle. Wiring context.refresh
 *  AFTER such a write yields a FRESH `buildGenContext` that reflects it — the main prompt (or a
 *  side call) then reads the branch's writes instead of the stale snapshot.
 *
 *  Ports:
 *   - `gen: Context` — the ORIGINAL bundle: provides profileId/chatId/userAction to re-acquire from
 *     (its value is otherwise ignored; the output is a wholly fresh read).
 *   - `after: Any` — an ORDERING-ONLY edge from the write branch (value ignored; same pattern as
 *     output.writeFloor's `floor` output used as a sequencing dependency). It MUST be `Any`, NOT
 *     `Signal`: portCompatible forbids a
 *     non-Signal→Signal wire, but more importantly the engine's prune rule marks a node dead only
 *     when EVERY incoming edge is dead. A `Signal` `after` gated off this turn would SKIP the
 *     refresh; with `Any`, a dead `after` edge still leaves the live `gen` edge feeding the node, so
 *     the refresh runs and downstream always receives a current bundle. The `after` value carries no
 *     data — it exists purely to sequence the fresh read after the write completes. */
export const contextRefresh: NodeImpl = {
  type: 'context.refresh',
  title: 'Refresh Context',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'after', type: 'Any' }
  ],
  outputs: [{ name: 'gen', type: 'Context' }],
  run: (_ctx, inputs) => {
    const orig = inputs.gen as GenContext
    return {
      outputs: { gen: buildGenContext(orig.profileId, orig.chatId, orig.userAction) }
    }
  }
}

/** Matches world info then assembles the exact message array + sampler params to send.
 *
 *  Optional `entries` port (issue 04): pre-qualified LorebookEntry[] (typically from `table.export`)
 *  CONCATENATED onto the scanned matches before assembly — so table projection rides the exact same
 *  placement/render machinery as lorebook world info. UNWIRED = empty concat = byte-identical to before
 *  (the parity gate: `matched` and `[...matched]` produce the same assembled prompt). */
export const promptAssemble: NodeImpl = {
  type: 'prompt.assemble',
  title: 'Assemble Prompt',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'block', type: 'Text' },
    { name: 'entries', type: 'Any' }
  ],
  outputs: [
    { name: 'sendMessages', type: 'Messages' },
    { name: 'params', type: 'Any' }
  ],
  run: (_ctx, inputs) => {
    const gen = inputs.gen as GenContext
    const matched = matchWorldInfo(gen)
    const extra = Array.isArray(inputs.entries) ? (inputs.entries as LorebookEntry[]) : []
    const { sendMessages, params } = assemblePrompt(
      gen,
      extra.length ? [...matched, ...extra] : matched,
      inputs.block as string
    )
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
 *  result in a collapsible chat panel instead (spec D4).
 *
 *  Failure handling (spec §10): the remaining config drives callModelResilient — auto-retry on
 *  API errors (`retries` times, `retry_delay_s` seconds apart), a fallback preset connection,
 *  and a validator with corrective retry. Give-up
 *  throws a NodeRunFailure the engine routes on the `error` output port when wired; unwired (the
 *  default graph) it surfaces as the turn's failure, exactly like before. Empty config = one
 *  plain call — parity preserved.
 *
 *  `config.api_preset_id` (spec §11 / plan §4): when set, the model call runs against THAT saved
 *  api_preset's connection instead of the turn's — a side-call feature (世界推进/剧情推进) points its
 *  own LLM at its own provider/model/budget. Implemented by reusing resilientCall's `withPreset`
 *  (rpm_limit/max_concurrent ride the substituted connection), so `fallback_preset_id` still applies
 *  ON TOP of the substituted primary. Unknown id → class-B NodeRunFailure code `bad-preset`. */
/** The shared config surface for a model call: streaming + the chosen api_preset + the resilience
 *  knobs. `llm.sample` and the consolidated `agent.llm` (agentNodes.ts) both drive the SAME core
 *  (runLlmCall) with this shape, so streaming/abort/preset-swap/retry behavior stays ONE
 *  implementation across the fine-grained and consolidated nodes (WP6.2 — never duplicate the
 *  provider call). */
export type LlmCallConfig = ResilienceConfig & {
  stream?: boolean
  api_preset_id?: string
}

/** The zod schema for LlmCallConfig — llm.sample uses it directly; agent.llm extends it. */
export const llmCallConfigSchema = z.object({
  stream: z.boolean().optional(),
  api_preset_id: z.string().optional(),
  retries: z.number().int().min(0).max(5).optional(),
  retry_delay_s: z.number().min(0).max(300).optional(),
  fallback_preset_id: z.string().optional(),
  validator: z.enum(['none', 'non_empty', 'regex', 'json']).optional(),
  validator_pattern: z.string().optional(),
  validator_retries: z.number().int().min(0).max(3).optional(),
  corrective_nudge: z.string().optional()
})

/** Assemble the `LlmCallConfig` from a parsed config carrying the `llmCallConfigSchema` fields — the
 *  conditional-spread the side-call nodes share. `agent.llm` and `memory.maintain` are side calls, so
 *  `stream` defaults to false here (a maintenance/agent reply must not pollute the player stream); pass
 *  a config whose `stream` is `true` to opt into streaming. Factored so the provider-call plumbing is
 *  built ONE way (both nodes already share `runLlmCall`). */
export const buildLlmCallConfig = (cfg: z.infer<typeof llmCallConfigSchema>): LlmCallConfig => ({
  stream: cfg.stream === true,
  ...(cfg.api_preset_id ? { api_preset_id: cfg.api_preset_id } : {}),
  ...(cfg.retries != null ? { retries: cfg.retries } : {}),
  ...(cfg.retry_delay_s != null ? { retry_delay_s: cfg.retry_delay_s } : {}),
  ...(cfg.fallback_preset_id ? { fallback_preset_id: cfg.fallback_preset_id } : {}),
  ...(cfg.validator ? { validator: cfg.validator } : {}),
  ...(cfg.validator_pattern ? { validator_pattern: cfg.validator_pattern } : {}),
  ...(cfg.validator_retries != null ? { validator_retries: cfg.validator_retries } : {}),
  ...(cfg.corrective_nudge ? { corrective_nudge: cfg.corrective_nudge } : {})
})

/** The preset's sampler params with an optional per-call temperature override — the shared params shape
 *  a side call builds (`agent.llm` / `memory.maintain`). No FSM cap: a side call is budgeted by its own
 *  preset. */
export const presetParamsWithTemperature = (
  gen: GenContext,
  temperature?: number
): PresetParameters => ({
  ...gen.preset.parameters,
  ...(temperature != null ? { temperature } : {})
})

/**
 * THE one model-call core, factored out of `llm.sample`'s run() so `agent.llm` (agentNodes.ts) shares
 * it verbatim rather than reimplementing streaming/abort/preset-swap. Given a Context, the messages to
 * send, the sampler params, and an LlmCallConfig, it:
 *   · swaps the connection to `api_preset_id` when set (the same withPreset substitution resilientCall's
 *     fallback path uses; unknown id → class-B `bad-preset`),
 *   · runs callModelResilient (auto-retry / fallback / validator per the config),
 *   · streams to the chat ONLY when `stream !== false` (a side/agent call sets stream:false so its
 *     output never pollutes the player stream),
 *   · returns `{ raw, rawUsage }`, or `null` on abort-with-empty (the caller decides whether to abort
 *     the graph — llm.sample does; a headless agent call has no turn to abort).
 */
export const runLlmCall = async (
  ctx: RunContext,
  gen: GenContext,
  sendMessages: ChatMessage[],
  params: PresetParameters,
  cfg: LlmCallConfig
): Promise<{ raw: string; rawUsage: unknown } | null> => {
  const streamToChat = cfg.stream !== false
  let g = gen
  if (cfg.api_preset_id) {
    const swapped = withPreset(g, cfg.api_preset_id)
    if (!swapped)
      throw new NodeRunFailure('B', `api preset '${cfg.api_preset_id}' not found`, 1, 'bad-preset')
    g = swapped
  }
  const r = await callModelResilient(
    g,
    sendMessages,
    params,
    streamToChat ? ctx.streamMain : () => {},
    ctx.modelSignal ?? ctx.signal,
    cfg
  )
  return r === null ? null : { raw: r.raw, rawUsage: r.rawUsage }
}

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
    { name: 'rawUsage', type: 'Any' },
    // Spec §10: the give-up value ({kind, message, attempts, …}) for author-wired error branches.
    { name: 'error', type: 'Error' }
  ],
  configSchema: llmCallConfigSchema,
  run: async (ctx, inputs, node) => {
    const cfg = (node?.config ?? {}) as LlmCallConfig
    const r = await runLlmCall(
      ctx,
      inputs.gen as GenContext,
      inputs.sendMessages as ChatMessage[],
      inputs.params as PresetParameters,
      cfg
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
    { name: 'metrics', type: 'Any' },
    // Optional display-only plot block (plot-recall data layer). When wired from memory.recall it is
    // persisted losslessly onto the FloorFile for a later renderer; absent → the field is not written.
    { name: 'plot_block', type: 'Text' }
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
      metrics: inputs.metrics as FloorMetrics,
      plot_block: inputs.plot_block as string | undefined
    })
    return { outputs: { floor } }
  }
}
