import { z } from 'zod'
import { expandMacros } from '../../../../shared/macros'
import { evalTemplate, buildTemplateContext } from '../../templateService'
import { ChatMessage } from '../../promptBuilder'
import { providerShape } from '../../generation/providerShape'
import { GenContext } from '../../generation/types'
import { NodeImpl } from '../types'

/**
 * Text-authoring built-in nodes (Phase 2b-2 task 5): renders card/workflow-authored templates
 * with the shared macro/EJS engines plus generic upstream-value slots. This file will gain
 * more authoring nodes in a later task; keep additions scoped to text.template for now.
 */

/** Stringify a slot value for {{inN}} substitution: strings pass through, objects JSON-encode. */
const slotText = (v: unknown): string =>
  v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)

/** The four generic upstream-value ports shared by the authoring nodes (plan decision 5). */
const SLOT_NAMES = ['in1', 'in2', 'in3', 'in4'] as const

const slotsOf = (inputs: Record<string, unknown>): Record<string, unknown> => ({
  in1: inputs.in1,
  in2: inputs.in2,
  in3: inputs.in3,
  in4: inputs.in4
})

/**
 * Interpolate an authored template (spec §8): context macros + EJS run FIRST (only when a
 * `gen` Context is wired — they need vars/globals), then the `{{in1}}`-`{{in4}}` upstream-slot
 * placeholders are substituted LAST, so upstream text is always data, never executable
 * template code (an LLM output containing `{{…}}`/`<%…%>` must not run). `{{inN}}` is not a
 * known macro, so expandMacros leaves the placeholders untouched.
 */
export const interpolate = (
  text: string,
  slots: Record<string, unknown>,
  gen?: GenContext
): string => {
  let out = text
  if (gen) {
    const charName = gen.card.data.name || 'Character'
    out = expandMacros(out, {
      user: gen.userName,
      char: charName,
      vars: gen.workingVars,
      globals: gen.globals
    })
    out = evalTemplate(
      out,
      buildTemplateContext(gen.workingVars, {
        globals: gen.globals as Record<string, any>,
        enabled: gen.settings.templates?.enabled !== false,
        constants: { userName: gen.userName, charName, assistantName: charName }
      })
    )
  }
  for (const name of SLOT_NAMES) {
    out = out.split(`{{${name}}}`).join(slotText(slots[name]))
  }
  return out
}

const templateConfig = z.object({ template: z.string() })

/** Renders an authored text template with context macros/EJS + upstream {{inN}} slots (spec §7). */
export const textTemplate: NodeImpl = {
  type: 'text.template',
  title: 'Template',
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
  outputs: [{ name: 'messages', type: 'Messages' }],
  configSchema: messagesConfig,
  run: (_ctx, inputs, node) => {
    const cfg = node.config as z.infer<typeof messagesConfig>
    const gen = inputs.gen as GenContext | undefined
    const rows: ChatMessage[] = cfg.messages.map((m) => ({
      role: m.role,
      content: interpolate(m.content, slotsOf(inputs), gen)
    }))
    return { outputs: { messages: gen ? providerShape(gen.settings, rows) : rows } }
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
