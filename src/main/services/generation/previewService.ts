// Next-prompt injection preview: the trust surface showing exactly what will enter the next prompt,
// attributed per source (ADR 0002 attribution-by-construction, issue 08 — "preview is a reader of the
// execution record").
//
// AS OF execution-plan M5b this runs the SAME pre-LLM stages the direct Classic path (`classicTurn.ts`)
// runs — `buildGenContext → trimProcessedContext → exportTableEntries → matchWorldInfo + assemblePrompt`
// — and stops. There is NO engine, NO wrapped registry, and NO provider call: the assembly is pure and
// stamps the forensic Execution Record on the shared `gen`, which is the sole attribution source. This
// replaced the previous graph-run-with-stubs approach, which (per the M5a hard cutover) previewed a doc
// path the real turn no longer takes AND had a genuine hole — `memory.recall` in an effective doc ran
// for real BEFORE the `llm.sample` stub aborted, making an untracked provider call during a "preview".
// Mirroring the fixed spine removes both problems: only the exact pre-LLM stages the turn runs execute.
//
// TOKEN COUNTS: the app has NO real tokenizer — `estimateTokens` (a CJK-aware char heuristic) is what
// every existing surface counts with. Preview reports the same estimate, flagged `estimated: true`.

import { buildGenContext } from './genContext'
import { trimProcessedContext, exportTableEntries } from './classicStages'
import { matchWorldInfo, assemblePrompt } from './assemble'
import { estimateTokens } from '../promptBudget'
import { log } from '../logService'
import type { AttachmentDecl } from '../../../shared/workflow/attachments'
import type { ExecutionRecord } from '../../../shared/executionRecord'
import type { GenContext } from './types'
import { shapePreview, type PreviewSection, type OmittedItem } from './previewSections'

/** The preview payload the renderer's Preview pane consumes. */
export interface NextPromptPreview {
  sections: PreviewSection[]
  omitted: OmittedItem[]
  /** When the preview could not run (no chat, assembly threw) — a machine reason the renderer localizes.
   *  On the happy path this is absent and `sections` is populated. */
  error?: 'no-chat' | 'failed'
  generatedAt: number
}

export interface PreviewInputs {
  profileId: string
  chatId: string
  /** A pending action to preview against; '' previews the next turn with no typed input yet. */
  userAction?: string
  /** The installed-pack summaries (agentPackService.list). Retained on the input for IPC-contract
   *  stability while the pack system still exists; the direct-assembly preview no longer runs packs
   *  (the fixed Classic spine does not), so this is currently unused and dies with the pack system in
   *  M5c. */
  packSummaries?: {
    id: string
    manifest: { name: string }
    attachments: AttachmentDecl[]
    gateOpen?: boolean
  }[]
}

/**
 * Produce the next-prompt preview for a chat by running the fixed Classic pre-LLM stages and shaping the
 * assembler's Execution Record into attributed sections. NEVER throws — a missing chat resolves to
 * `{ error: 'no-chat' }` and a broken preset (assembly throw) to `{ error: 'failed' }`, both of which the
 * renderer shows as error states. Zero durable writes and zero provider calls by construction.
 */
export const previewNextPrompt = async (inputs: PreviewInputs): Promise<NextPromptPreview> => {
  const { profileId, chatId, userAction = '' } = inputs
  const generatedAt = Date.now()

  // Stage 1: the per-turn Context. A missing chat / card surfaces here as no-chat (buildGenContext throws).
  let gen: GenContext
  try {
    gen = buildGenContext(profileId, chatId, userAction)
  } catch (err) {
    log('info', `previewNextPrompt: cannot build gen context — ${(err as Error)?.message}`)
    return { sections: [], omitted: [], error: 'no-chat', generatedAt }
  }

  try {
    // Stages 2–4, exactly as `classicTurn.ts` runs them (identity trim when no progress pointer; silent
    // empty projection when no table template is bound; the export entries concat onto the world-info
    // matches before assembly). No `block` input — the seeded spine leaves it unwired.
    const trimmed = trimProcessedContext(gen)
    const exported = exportTableEntries(trimmed, {})
    const matched = matchWorldInfo(trimmed)
    const extra = exported.entries
    const result = assemblePrompt(
      trimmed,
      extra.length ? [...matched, ...extra] : matched,
      undefined as unknown as string
    )
    // assemblePrompt always produces the forensic record; a captured assembly without one would be an
    // unsupported path with nothing to attribute.
    const record = (result.record ?? trimmed.executionRecord) as ExecutionRecord | undefined
    if (!record) return { sections: [], omitted: [], error: 'failed', generatedAt }

    // Shape the record alone: the fixed spine has no pack rejoins, so there are no injections and no
    // gate-closed injectors to enumerate — the sections come purely from the record's journaled sources
    // (card / persona / world-info incl. the table export / history / memory tail / action).
    const { sections, omitted } = shapePreview({
      record,
      injections: [],
      gatedInjectors: [],
      estimate: estimateTokens
    })
    return { sections, omitted, generatedAt }
  } catch (err) {
    log('info', `previewNextPrompt: assembly failed — ${(err as Error)?.message}`)
    return { sections: [], omitted: [], error: 'failed', generatedAt }
  }
}
