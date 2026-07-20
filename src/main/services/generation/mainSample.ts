import type { GenContext } from './types'
import type { ChatMessage } from '../promptBuilder'
import type { PresetParameters } from '../../types/preset'
import type { ProviderDispatchVia } from '../apiService'
import { callModelResilient, ResilienceConfig, withPreset } from './resilientCall'
import { providerShape } from './providerShape'
import { harnessDispatchVia } from './harnessDispatch'
import { NodeRunFailure, type RunContext } from './runContext'
import {
  resolveDispatchMessages,
  resolveParams,
  applyDispatchTransforms,
  appendDispatchEntries,
  isPromptArtifact
} from './promptArtifact'
import { getDispatchHooks } from './dispatchHooks'

/**
 * The main narrator's ONE sampling call + the model-call core it shares, relocated out of the
 * `llm.sample` / `agent.llm` node file (`nodes/builtin/generationNodes.ts`) into a stable generation
 * home (execution-plan M5b) so the direct Classic path (`classicTurn.ts`) keeps them after M5c deletes
 * the node wrappers. Moved VERBATIM: the dispatch shaping / late-transform / Harness plumbing is
 * byte-identical, and `generationNodes.ts` re-exports both so its node runs (and the other side-call
 * nodes that share `runLlmCall`) resolve them unchanged.
 *
 * Transitional imports THIS SLICE: `LlmCallConfig` (type-only, so no runtime cycle), the `promptArtifact`
 * dispatch helpers, and the `dispatchHooks` registry are still read from their current `nodes/` homes —
 * they are pure model/registry modules M5c relocates as part of its collapse (they define no NodeImpl).
 */

/** The shared config surface for a model call: streaming + the chosen api_preset + the resilience
 *  knobs. `llm.sample` and the consolidated `agent.llm` both drive the SAME core (`runLlmCall`) with
 *  this shape. Defined here (with the core) so `generation` owns it and `generationNodes.ts` re-exports
 *  it — the type-only back-edge that would otherwise cycle is thereby removed. */
export type LlmCallConfig = ResilienceConfig & {
  stream?: boolean
  api_preset_id?: string
}

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
  cfg: LlmCallConfig,
  /** Opt-in single-call executor. ONLY the `llm.sample` node passes one — `agent.llm`, memory,
   *  notes, and recall call this directly and keep the plain provider call. Note that `llm.sample`
   *  covers Classic's default graph AND the memory/table templates that embed the same node type. */
  dispatchVia?: ProviderDispatchVia
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
    cfg,
    dispatchVia
  )
  return r === null ? null : { raw: r.raw, rawUsage: r.rawUsage }
}

/**
 * The main narrator's ONE sampling call, from the dispatch seam through the Harness (Classic Narrator
 * plan, Milestone 3). Extracted verbatim from `llm.sample`'s run() so the direct Classic path executes
 * the SAME provider-shaping, late-dispatch-transform, and Harness plumbing rather than a second copy —
 * `llmSample.run` delegates to it. Returns `null` on abort-with-empty (the caller decides
 * whether to abort its turn); throws on give-up exactly as before.
 *
 * `legacy` is the wired `sendMessages`/`params` pair (the seeded doc's wiring, and what the direct path
 * has in hand); `prompt` is the optional rich artifact. With a legacy array present the artifact branch
 * is inert, which is why the direct path passes only the pair.
 */
export const sampleMainCall = async (
  ctx: RunContext,
  gen: GenContext,
  legacy: { sendMessages: unknown; params: unknown },
  prompt: unknown,
  cfg: LlmCallConfig
): Promise<{ raw: string; rawUsage: unknown } | null> => {
  // 18e SEAM 2 — the pre-dispatch transformation seam: resolve the messages to send AND provider-
  // shape them exactly once here (the single dispatch boundary). A legacy `sendMessages` array or an
  // already-shaped artifact passes through unchanged (byte-identical for seeded docs); only an
  // UNSHAPED Prompt artifact is shaped, via providerShape bound to this turn's settings.
  const shapedMessages = resolveDispatchMessages(legacy.sendMessages, prompt, (m) =>
    providerShape(gen.settings, m)
  ) as ChatMessage[]
  // 18e capability-gated PRE-DISPATCH MUTATION seam (Tier-4 TavernHelper, issue 19): apply any
  // registered high-trust late hooks to the FINAL message array and delta-record each real mutation as
  // an `opaque` entry on the Prompt artifact's execution record (script id + hook + before/after hashes —
  // never a raw untracked swap). Zero hooks (the default) ⇒ the array passes through byte-identical.
  const hooks = getDispatchHooks(gen.chatId)
  const { messages: sendMessages, entries: dispatchEntries } = applyDispatchTransforms(
    shapedMessages ?? [],
    hooks
  )
  if (dispatchEntries.length && isPromptArtifact(prompt) && prompt.record) {
    // Forensic: land the late-hook deltas on the LIVE artifact's record — the same object the turn
    // threads to parse.response/writeFloor — so the pre-dispatch mutation is journaled, never a raw
    // untracked swap. `appendDispatchEntries` re-indexes seq; we splice its result back in place.
    const merged = appendDispatchEntries(prompt, dispatchEntries)
    prompt.record.entries.splice(0, prompt.record.entries.length, ...merged.record!.entries)
  }
  return runLlmCall(
    ctx,
    gen,
    sendMessages,
    resolveParams(legacy.params, prompt) as PresetParameters,
    cfg,
    // Milestone 1: this node's ONE sampling call executes through AgentHarness. `sendMessages` is
    // already final here (shaped, then late-transformed above), so the Harness forwards it verbatim.
    // Classic's default graph is the target; the memory/table templates embed this same node type
    // and therefore also route here — accepted, since the seam is byte-identical either way.
    harnessDispatchVia
  )
}
