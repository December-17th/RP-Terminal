// Next-prompt injection preview (agent-packs plan WP3.4): the trust surface showing exactly what will
// enter the next prompt, attributed per source (ADR 0002 attribution-by-construction). This service
// runs the effective doc's PRE-ASSEMBLE closure through the REAL engine with a WRAPPED registry — every
// side-effecting node's run() replaced by a safe stub — so producing the preview costs ZERO state writes
// and ZERO LLM calls, while the assembly (prompt.assemble) + the pack rejoins (table.export etc.) run for
// real and yield the exact bytes the next turn would send.
//
// THE MECHANISM (controller's preferred approach — no engine change):
//   1. resolveEffectiveDoc → narrator + every enabled pack fragment composed (WP1.3).
//   2. Wrap builtinRegistry: llm.sample → a stub that captures nothing and calls ctx.abortGraph() so the
//      engine skips every node AFTER assemble (parse/apply/write and any post-phase side jobs never run);
//      table.apply / table.gate / vars.save / mvu.set / apply.state / output.writeFloor / tool.* →
//      no-op passthrough stubs (defense-in-depth: even a custom narrator that writes state UPSTREAM of
//      assemble is neutralised). prompt.assemble runs the REAL impl; we tee its `sendMessages` output.
//   3. runWorkflow(effectiveDoc, wrappedRegistry, ctx). The engine runs ctx→(trim)→(pack export)→assemble
//      for real, then hits the llm stub → abortGraph → the run settles having touched no persistent state.
//   4. Shape the captured prompt + composition meta + engine outputs into attributed sections
//      (previewSections.shapePreview).
//
// TOKEN COUNTS: the app has NO real tokenizer — `estimateTokens` (promptBuilder.ts, a CJK-aware char
// heuristic) is what every existing surface counts with. Preview reports the same estimate, flagged
// `estimated: true` honestly.
//
// registry-injectability check (controller's stop-and-report gate): runWorkflow(doc, REGISTRY, ctx) takes
// the registry as a parameter (workflowEngine.ts:241) — the wrapped-registry approach needs no engine
// change. Confirmed before building.

import { runWorkflow } from '../workflowEngine'
import { builtinRegistry } from '../nodes/builtin'
import { createRegistry } from '../nodes/registry'
import { NodeImpl, RunContext } from '../nodes/types'
import { resolveEffectiveDoc } from '../workflowService'
import { estimateTokens } from '../promptBudget'
import type { ChatMessage } from '../promptTypes'
import { log } from '../logService'
import type { CompositionMeta } from '../../../shared/workflow/compose'
import type { AttachmentDecl } from '../../../shared/workflow/attachments'
import type { ExecutionRecord } from '../../../shared/executionRecord'
import type { GenContext } from './types'
import {
  packInjections,
  shapePreview,
  type GatedInjector,
  type PreviewSection,
  type OmittedItem
} from './previewSections'

/** The preview payload the renderer's Preview pane consumes. */
export interface NextPromptPreview {
  sections: PreviewSection[]
  omitted: OmittedItem[]
  /** When the preview could not run (no chat, assembly threw) — a machine reason the renderer localizes.
   *  On the happy path this is absent and `sections` is populated. */
  error?: 'no-chat' | 'failed'
  generatedAt: number
}

/** Node types whose run() has a SIDE EFFECT (state write / provider call) — replaced by safe stubs in
 *  the preview registry. Grounded against the builtin node bodies:
 *   · llm.sample        — the provider call (generationNodes.ts). Stubbed to abort the graph.
 *   · output.writeFloor — persists the floor + globals (generationNodes.ts / persistFloor).
 *   · apply.state       — folds vars in-memory (generationNodes.ts / foldState); harmless but downstream
 *                         of llm anyway — stubbed for completeness.
 *   · table.apply       — SQL table write (tableNodes.ts).
 *   · table.gate        — advances the committed progress pointer (tableNodes.ts).
 *   · vars.save / mvu.set — floor-variable / stat_data writes (varsNodes.ts / mvuNodes.ts).
 *   · tool.startCombat / tool.startDuel — start an encounter (toolNodes.ts). */
const SIDE_EFFECT_TYPES = [
  'output.writeFloor',
  'apply.state',
  'table.apply',
  'table.gate',
  'vars.save',
  'mvu.set',
  'tool.startCombat',
  'tool.startDuel'
] as const

/** Build a preview registry: the real builtins, but with run() swapped where it matters.
 *   · every side-effecting node → a stub returning empty outputs (no write, no provider call);
 *   · llm.sample → additionally aborts the graph (the engine then marks every downstream node
 *     parse/apply/write skipped and runs no post phase — workflowEngine.ts abort path);
 *   · prompt.assemble → the REAL impl (assembly is pure) plus a tee that captures its sendMessages
 *     AND the forensic Execution Record it stamped on the shared `gen` (issue 08 preview reader).
 *  Descriptors (ports/config schema) are reused verbatim so validateWorkflow + input wiring are
 *  unchanged; only run() is swapped. A fresh registry per call so the captures are call-scoped. */
const buildPreviewRegistry = (
  onCaptureAssembled: (msgs: ChatMessage[]) => void,
  onCaptureRecord: (record: ExecutionRecord) => void
): ReturnType<typeof createRegistry> => {
  const impls: NodeImpl[] = []
  for (const type of builtinRegistry.descriptors().keys()) {
    const real = builtinRegistry.get(type)!
    if (type === 'llm.sample') {
      impls.push({
        ...real,
        run: (ctx: RunContext) => {
          ctx.abortGraph?.()
          return { outputs: {} }
        }
      })
    } else if (type === 'prompt.assemble') {
      impls.push({
        ...real,
        run: async (ctx, inputs, node) => {
          const result = await real.run(ctx, inputs, node)
          const msgs = result.outputs?.sendMessages
          if (Array.isArray(msgs)) onCaptureAssembled(msgs as ChatMessage[])
          // The node stamps the just-built record onto its `gen` input (generationNodes.ts) — read it
          // off the same object the real run mutated. The record IS the attribution source (issue 08).
          const record = (inputs.gen as GenContext | undefined)?.executionRecord
          if (record) onCaptureRecord(record)
          return result
        }
      })
    } else if ((SIDE_EFFECT_TYPES as readonly string[]).includes(type)) {
      // No-op passthrough: empty outputs (dead downstream edges — matches an unwired producer). Defense-
      // in-depth; llm.sample's abort already prevents these from running in the default spine.
      impls.push({ ...real, run: () => ({ outputs: {} }) })
    } else {
      impls.push(real)
    }
  }
  return createRegistry(impls)
}

/** Does this fragment declare a rejoin at the prompt-assembly checkpoint (i.e. it WOULD inject into the
 *  next prompt)? Used to enumerate gate-CLOSED injectors for the omitted-by-gate list. */
const hasPromptAssemblyRejoin = (attachments: AttachmentDecl[] | undefined): boolean =>
  (attachments ?? []).some((a) => a.kind === 'rejoin' && a.checkpoint === 'prompt-assembly')

/** The gate-closed packs that WOULD inject at prompt-assembly (omitted-by-gate). Derived from the
 *  installed-pack summaries: a pack whose gate is closed for this (world, chat) AND whose fragment
 *  declares a prompt-assembly rejoin. Passed in by the caller (agentPackService.list result) so this
 *  service does not import the pack store directly (keeps the dependency shallow + testable). */
export const gatedInjectorsFrom = (
  summaries: {
    id: string
    manifest: { name: string }
    attachments: AttachmentDecl[]
    gateOpen?: boolean
  }[]
): GatedInjector[] =>
  summaries
    .filter((s) => s.gateOpen === false && hasPromptAssemblyRejoin(s.attachments))
    .map((s) => ({ packId: s.id, name: s.manifest.name }))

/** Resolve packId → display name for attribution. The caller passes the installed summaries so we do
 *  not re-read the pack store here. */
const packNamesFrom = (
  summaries: { id: string; manifest: { name: string } }[]
): Record<string, string> => {
  const m: Record<string, string> = {}
  for (const s of summaries) m[s.id] = s.manifest.name
  return m
}

export interface PreviewInputs {
  profileId: string
  chatId: string
  /** A pending action to preview against; '' previews the next turn with no typed input yet. */
  userAction?: string
  /** The installed-pack summaries (agentPackService.list) — for pack names + gated-injector derivation.
   *  Passed in so this service stays independent of the pack store (unit-testable in isolation). */
  packSummaries: {
    id: string
    manifest: { name: string }
    attachments: AttachmentDecl[]
    gateOpen?: boolean
  }[]
}

/**
 * Produce the next-prompt preview for a chat: run the effective doc's pre-assemble closure with the
 * wrapped registry (zero writes, zero LLM), capture the assembled prompt, and shape it into attributed
 * sections. NEVER throws — a failure (e.g. a broken preset that makes assembly throw) resolves to a
 * `{ error: 'failed' }` payload the renderer shows as an error state.
 */
export const previewNextPrompt = async (inputs: PreviewInputs): Promise<NextPromptPreview> => {
  const { profileId, chatId, userAction = '', packSummaries } = inputs
  const generatedAt = Date.now()

  let doc
  try {
    doc = resolveEffectiveDoc(profileId, chatId).doc
  } catch (err) {
    // No chat / no card — buildGenContext-adjacent throws surface here as no-chat.
    log('info', `previewNextPrompt: cannot resolve effective doc — ${(err as Error)?.message}`)
    return { sections: [], omitted: [], error: 'no-chat', generatedAt }
  }

  // Capture prompt.assemble's output + its forensic Execution Record by teeing its REAL run() (the
  // assembly is pure — no writes). The record is the attribution SOURCE (issue 08): sections are
  // decomposed from its journaled entries, not guessed from the flat message content.
  let assembled: ChatMessage[] | null = null
  let record: ExecutionRecord | null = null
  const registry = buildPreviewRegistry(
    (msgs) => {
      assembled = msgs
    },
    (rec) => {
      record = rec
    }
  )

  const mainId = doc.nodes.find((n) => n.isMainOutput)?.id
  if (!mainId) return { sections: [], omitted: [], error: 'failed', generatedAt }

  const ctx = makePreviewContext(profileId, chatId, userAction)
  // The engine's node outputs — read AFTER the run to attribute pack rejoins. runWorkflow returns the
  // outputs map on EVERY path (ok / aborted / fatal — workflowEngine.ts), so we read the pack export
  // values off the settled result rather than onResponseReady (which the llm-stub's abort skips).
  let outputsMap = new Map<string, Record<string, unknown>>()
  try {
    const result = await runWorkflow(doc, registry, ctx)
    outputsMap = result.outputs
    // A pre-phase failure BEFORE assemble (e.g. a preset throw in prompt.assemble) surfaces as a fatal
    // result with no captured record. assemblePrompt always produces a record, so a captured prompt
    // without one would mean an unsupported assemble path — either way there is nothing to attribute.
    if (!assembled || !record) {
      if (result.error) log('info', `previewNextPrompt: assembly failed — ${result.error.message}`)
      return { sections: [], omitted: [], error: 'failed', generatedAt }
    }
  } catch (err) {
    log('info', `previewNextPrompt: run threw — ${(err as Error)?.message}`)
    return { sections: [], omitted: [], error: 'failed', generatedAt }
  }

  const composition = (doc.meta as { composition?: CompositionMeta } | undefined)?.composition
  const packNames = packNamesFrom(packSummaries)
  const injections = packInjections(composition, outputsMap, packNames)
  const gatedInjectors = gatedInjectorsFrom(packSummaries)

  const { sections, omitted } = shapePreview({
    // Narrowed non-null by the guard above; the cast satisfies TS across the closure-captured `let`.
    record: record as ExecutionRecord,
    injections,
    gatedInjectors,
    estimate: estimateTokens
  })
  return { sections, omitted, generatedAt }
}

// ── internal: the preview RunContext + the assemble tap ──────────────────────────────────────────────

/** A RunContext with the preview affordances: a real abortGraph (so the llm stub can skip everything
 *  downstream of assemble), and no-op streaming / panels / node-state (a preview never writes node state
 *  either). The pack-rejoin outputs are read off runWorkflow's RETURN value, not this ctx. */
const makePreviewContext = (profileId: string, chatId: string, userAction: string): RunContext => {
  const graph = new AbortController()
  return {
    signal: graph.signal,
    modelSignal: graph.signal,
    abortGraph: () => graph.abort(),
    streamMain: () => {},
    emitPanel: () => {},
    getNodeState: () => undefined,
    setNodeState: () => {},
    profileId,
    chatId,
    userAction
  }
}
