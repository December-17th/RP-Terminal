import { z } from 'zod'
import { buildGenContext } from '../../generation/genContext'
import { matchWorldInfo, assemblePrompt } from '../../generation/assemble'
import { parseResponse, computeMetrics } from '../../generation/parseResponse'
import { foldState } from '../../generation/foldState'
import { persistFloor } from '../../generation/persistFloor'
import { runVnGate, mergeYuzuMvu } from '../../yuzu/vnGate'
import { GenContext } from '../../generation/types'
import { ChatMessage } from '../../promptBuilder'
import { LorebookEntry } from '../../../types/character'
import { PresetParameters } from '../../../types/preset'
import { FloorMetrics } from '../../../../shared/usageTypes'
import { NodeImpl } from '../types'
import { assembledArtifact, resolveSendMessages } from '../promptArtifact'
// `runLlmCall` / `sampleMainCall` moved to `generation/mainSample.ts` (execution-plan M5b); imported for
// the node `run`s below and re-exported so the side-call node files sharing them resolve them unchanged.
import { runLlmCall, sampleMainCall, type LlmCallConfig } from '../../generation/mainSample'
export { runLlmCall, sampleMainCall }

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
    outputs: {
      gen: buildGenContext(ctx.profileId!, ctx.chatId!, ctx.userAction!, ctx.generationType)
    }
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
      outputs: {
        gen: buildGenContext(orig.profileId, orig.chatId, orig.userAction, orig.generationType)
      }
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
    { name: 'params', type: 'Any' },
    // Issue 18b: the SAME assembly, also emitted as the rich `Prompt` artifact (messages +
    // provenance + execution record + params). ADDITIVE — the legacy `sendMessages`/`params` ports
    // stay so every seeded/existing doc wires exactly as before (behavior-neutral). A new workflow
    // wires `prompt` into Sample/Parse/Write instead.
    { name: 'prompt', type: 'Prompt' }
  ],
  run: (_ctx, inputs) => {
    const gen = inputs.gen as GenContext
    const matched = matchWorldInfo(gen)
    const extra = Array.isArray(inputs.entries) ? (inputs.entries as LorebookEntry[]) : []
    const { sendMessages, params, record, authored } = assemblePrompt(
      gen,
      extra.length ? [...matched, ...extra] : matched,
      inputs.block as string
    )
    // Stamp the forensic record onto the shared gen so the terminal write stage can persist it
    // (issue 09). Behavior-neutral: the record travels inside the `prompt` artifact but is not a
    // standalone port, so unwired graphs and the parity gate are unaffected. Guard because
    // assemblePrompt is mocked without a record in unit tests.
    if (record) gen.executionRecord = record
    // `authored` (issue 18c) carries the pre-shape messages + budget policy so the artifact's
    // contributions get `budgetClass`; absent (mocked assemble) → contributions derive from the wire.
    return {
      outputs: {
        sendMessages,
        params,
        prompt: assembledArtifact(sendMessages, params, record, authored)
      }
    }
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
/** `LlmCallConfig` now lives beside its core in `generation/mainSample.ts` (execution-plan M5b);
 *  re-exported here so the side-call nodes keep importing it from this module. */
export type { LlmCallConfig }

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

export const llmSample: NodeImpl = {
  type: 'llm.sample',
  title: 'Sample',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'sendMessages', type: 'Messages' },
    { name: 'params', type: 'Any' },
    // Issue 18b: an alternative to the two legacy ports above — the rich `Prompt` artifact from
    // Assemble/Preset carries BOTH the messages and the params. The legacy ports win when wired
    // (seeded docs are unchanged); `prompt` is the final-adapter fallback when they are not.
    { name: 'prompt', type: 'Prompt' },
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
    const gen = inputs.gen as GenContext
    const r = await sampleMainCall(
      ctx,
      gen,
      { sendMessages: inputs.sendMessages, params: inputs.params },
      inputs.prompt,
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
    // Issue 18b: the `Prompt` artifact as the sendMessages source (final adapter) — for the metrics'
    // sent-token estimate. Legacy `sendMessages` wins when wired (behavior-neutral for seeded docs).
    { name: 'prompt', type: 'Prompt' },
    { name: 'rawUsage', type: 'Any' }
  ],
  outputs: [
    { name: 'parsed', type: 'Any' },
    { name: 'mvu', type: 'Any' },
    { name: 'metrics', type: 'Any' }
  ],
  run: async (ctx, inputs) => {
    const gen = inputs.gen as GenContext
    const raw = inputs.raw as string
    const sendMessages = resolveSendMessages(inputs.sendMessages, inputs.prompt) as ChatMessage[]
    // Project Yuzu WP-S2 (ADR 0009 §1): the mode-gated acceptance-gate seam. In VN mode the raw reply is
    // run through the WP-B ladder BEFORE anything downstream sees it; the validated/fallback scene text
    // (finalRaw) is what parse/apply/write consume, and its `<| effect |>` beat effects fold into canon.
    // The gate result is stashed on the SHARED `gen` for the terminal write stage (same object as
    // executionRecord). Classic turns (vnMode off) skip this entirely and stay byte-identical.
    if (gen.vnMode) {
      const gate = await runVnGate(ctx, gen, raw)
      gen.yuzuGate = { finalRaw: gate.finalRaw, scene: gate.scene, trace: gate.trace }
      // Parse the FINAL scene text for events + any stray `<UpdateVariable>` blocks (ADR 0008 §4), then
      // MERGE those scene-end commands with the effect-derived ones (effects fold first).
      const { parsed, mvu: classicMvu } = parseResponse(gate.finalRaw)
      const mvu = mergeYuzuMvu(gate.mvu, classicMvu)
      const metrics = computeMetrics(gen, sendMessages, gate.finalRaw, inputs.rawUsage)
      return { outputs: { parsed, mvu, metrics } }
    }
    const { parsed, mvu } = parseResponse(raw)
    const metrics = computeMetrics(gen, sendMessages, raw, inputs.rawUsage)
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
    // Issue 18b: the `Prompt` artifact as the sendMessages source (final adapter) — the request array
    // stored on the floor. Legacy `sendMessages` wins when wired (behavior-neutral for seeded docs).
    { name: 'prompt', type: 'Prompt' },
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
    // Project Yuzu WP-S2 (ADR 0009 §1/§3): a VN floor stores the gate's validated/fallback scene text as
    // its response (not the pre-gate raw) and carries the gate trace. Classic floors (no gate stash) pass
    // the raw through and never write `yuzu_trace` — byte-identical, mirroring the `plot_block` precedent.
    const gate = gen.yuzuGate
    const floor = persistFloor(gen, {
      userAction: gen.userAction,
      raw: gate ? gate.finalRaw : (inputs.raw as string),
      sendMessages: resolveSendMessages(inputs.sendMessages, inputs.prompt) as ChatMessage[],
      events: parsed.events,
      variables: inputs.variables as Record<string, unknown>,
      metrics: inputs.metrics as FloorMetrics,
      plot_block: inputs.plot_block as string | undefined,
      yuzu_trace: gate?.trace
    })
    return { outputs: { floor } }
  }
}
