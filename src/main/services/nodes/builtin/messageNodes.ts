import { z } from 'zod'
import { fitToBudget } from '../../promptBudget'
import type { ChatMessage } from '../../promptTypes'
import { providerShape } from '../../generation/providerShape'
import { GenContext } from '../../generation/types'
import { NodeImpl } from '../types'
import { log } from '../../logService'
import {
  wrapMessages,
  isPromptArtifact,
  artifactBudgetClasses,
  withTrimmedMessages
} from '../promptArtifact'

/**
 * Text-authoring built-in nodes (Phase 2b-2 task 5): renders card/workflow-authored templates
 * with the shared macro/EJS engines plus generic upstream-value slots. This file will gain
 * more authoring nodes in a later task; keep additions scoped to text.template for now.
 */

// `interpolate` (+ its private slot helpers) moved to `services/promptInterpolate.ts` (execution-plan
// M5c-1) so the memory maintainer composer shares it without importing the node engine. Re-imported +
// re-exported here so this file's authoring nodes and the other node files keep resolving it from
// `./messageNodes`.
import { interpolate } from '../../promptInterpolate'
export { interpolate }

const slotsOf = (inputs: Record<string, unknown>): Record<string, unknown> => ({
  in1: inputs.in1,
  in2: inputs.in2,
  in3: inputs.in3,
  in4: inputs.in4
})

const templateConfig = z.object({ template: z.string() })

/** Renders an authored text template with context macros/EJS + upstream {{inN}} slots (spec §7). */
export const textTemplate: NodeImpl = {
  type: 'text.template',
  title: 'Template',
  // Agent & memory UX (WP-A; spec §1): `template` is the authored prompt string — routed to the Prompt
  // editor and used for the on-card excerpt, same contract as agent.llm's `messages`.
  promptFields: ['template'],
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'in1', type: 'Any' },
    { name: 'in2', type: 'Any' },
    { name: 'in3', type: 'Any' },
    { name: 'in4', type: 'Any' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [{ name: 'text', type: 'Text' }],
  configSchema: templateConfig,
  run: (_ctx, inputs, node) => {
    const cfg = node.config as z.infer<typeof templateConfig>
    const text = interpolate(cfg.template, slotsOf(inputs), inputs.gen as GenContext | undefined)
    return { outputs: { text } }
  }
}

const messagesConfig = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string()
    })
  )
})

/** Authors an ordered role-tagged message list (spec §8 "Message List"): each row's content is
 *  interpolated (macros/EJS + {{inN}} slots), then the list is provider-shaped when a gen
 *  Context is wired. A trailing assistant row acts as a prefill (orderForProvider keeps it last). */
export const promptMessages: NodeImpl = {
  type: 'prompt.messages',
  title: 'Message List',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'in1', type: 'Any' },
    { name: 'in2', type: 'Any' },
    { name: 'in3', type: 'Any' },
    { name: 'in4', type: 'Any' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'messages', type: 'Messages' },
    // Issue 18b: the SAME authored list, also wrapped as a `Prompt` artifact — each row a SYNTHETIC
    // contribution (this node is a legacy `Messages` producer, so provenance is synthesized). ADDITIVE:
    // the `messages` port stays so existing docs (e.g. the decomposed-default example) wire unchanged.
    { name: 'prompt', type: 'Prompt' }
  ],
  configSchema: messagesConfig,
  run: (_ctx, inputs, node) => {
    const cfg = node.config as z.infer<typeof messagesConfig>
    const gen = inputs.gen as GenContext | undefined
    const rows: ChatMessage[] = cfg.messages.map((m) => ({
      role: m.role,
      content: interpolate(m.content, slotsOf(inputs), gen)
    }))
    // Provider shaping stays gated on a wired `gen` (unchanged); `shaped` records whether it ran so
    // the model-dispatch seam (18e) can avoid shaping twice.
    const messages = gen ? providerShape(gen.settings, rows) : rows
    return {
      outputs: {
        messages,
        prompt: wrapMessages(
          messages,
          { kind: 'pipeline', id: node.id, label: 'prompt.messages' },
          !!gen
        )
      }
    }
  }
}

const trimConfig = z.object({
  /** Token budget the message array must fit under. 0/unset → gen.settings.generation
   *  max_context_tokens (the SAME default assemble.ts:196 uses), falling back to 200000. */
  budget_tokens: z.number().int().min(0).optional()
})

/** Trims a message list to a token budget via the shared fitToBudget (the same trimmer assemble uses).
 *
 *  Two lanes (issue 18c):
 *   · legacy `messages: Messages` — a hand-built array (prompt.messages / merge.messages) with no
 *     budget policy → fitToBudget's legacy fallback: keep the leading system prefix, drop the oldest
 *     from the first non-system message, always keep the last turn. Byte-identical to before.
 *   · Prompt-aware `prompt: Prompt` — trims the artifact's messages under the EXPLICIT budget policy
 *     its contributions declare (`budgetClass` — history dropped oldest-first, pinned kept), and emits
 *     an updated artifact whose execution record carries the budget omission (the issue 07/08 omitted-
 *     by-budget concept). An artifact whose policy is not per-message aligned falls back to the legacy
 *     position-based trim on its wire. The legacy `messages` input wins when both are wired. */
export const messagesTrim: NodeImpl = {
  type: 'messages.trim',
  title: 'Trim Messages',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'messages', type: 'Messages' },
    // Issue 18c: an alternative to the legacy `messages` input — a Prompt artifact whose contributions
    // carry the explicit budget policy. Additive; unwired in every seeded doc (behavior-neutral).
    { name: 'prompt', type: 'Prompt' }
  ],
  outputs: [
    { name: 'messages', type: 'Messages' },
    // The trimmed artifact (record updated with the budget omission) — only when a Prompt was the source.
    { name: 'prompt', type: 'Prompt' }
  ],
  configSchema: trimConfig,
  run: (_ctx, inputs, node) => {
    const cfg = (node?.config ?? {}) as z.infer<typeof trimConfig>
    const gen = inputs.gen as GenContext | undefined
    const artifact = isPromptArtifact(inputs.prompt) ? inputs.prompt : undefined
    // Legacy Messages input wins (pre-18c path); otherwise trim the Prompt artifact's wire.
    const legacy = inputs.messages as ChatMessage[] | undefined
    const messages = legacy ?? artifact?.messages ?? []
    const budget = cfg.budget_tokens || gen?.settings?.generation?.max_context_tokens || 200000
    // Honor the artifact's explicit per-message budget policy (18c) only for the Prompt lane; the
    // legacy lane (and any artifact without an aligned policy) → undefined → legacy fallback.
    const classes = !legacy && artifact ? artifactBudgetClasses(artifact) : undefined
    const { messages: trimmed, dropped } = fitToBudget(messages, budget, classes)
    const note = `budget ${budget} tok — dropped ${dropped} message(s)`
    if (dropped > 0) log('info', `messages.trim: ${note}`)
    return {
      outputs: {
        messages: trimmed,
        // Emit an updated artifact ONLY when a Prompt was the source: record the budget omission when
        // something was dropped, else pass the artifact through unchanged.
        ...(artifact && !legacy
          ? { prompt: dropped > 0 ? withTrimmedMessages(artifact, trimmed, note) : artifact }
          : {})
      }
    }
  }
}

/** Concatenates up to four Messages inputs in port order (a->d, skipping unwired ports — the
 *  fan-in rule requires DISTINCT ports), provider-shaped when gen is wired so the seam between
 *  merged lists stays provider-correct. */
export const mergeMessages: NodeImpl = {
  type: 'merge.messages',
  title: 'Merge Messages',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'a', type: 'Messages' },
    { name: 'b', type: 'Messages' },
    { name: 'c', type: 'Messages' },
    { name: 'd', type: 'Messages' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [{ name: 'messages', type: 'Messages' }],
  run: (_ctx, inputs) => {
    const gen = inputs.gen as GenContext | undefined
    const merged = (['a', 'b', 'c', 'd'] as const).flatMap(
      (p) => (inputs[p] as ChatMessage[] | undefined) ?? []
    )
    return { outputs: { messages: gen ? providerShape(gen.settings, merged) : merged } }
  }
}
