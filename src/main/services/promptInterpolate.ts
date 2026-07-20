import { expandMacros } from '../../shared/macros'
import { evalTemplate, buildTemplateContext } from './templateService'
import { GenContext } from './generation/types'

/**
 * Authored-template interpolation, relocated OUT of the `text.template` node file
 * (`nodes/builtin/messageNodes.ts`) into a neutral service home (execution-plan M5c-1) so the memory
 * maintainer composer (`memory/maintainerCompose.ts`) shares it without importing the node engine.
 * Moved VERBATIM. `messageNodes.ts` re-imports `interpolate` from here, so its authoring nodes and the
 * other node files that share it resolve it unchanged.
 */

/** Stringify a slot value for {{inN}} substitution: strings pass through, objects JSON-encode. */
const slotText = (v: unknown): string =>
  v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)

/** The four generic upstream-value ports shared by the authoring nodes. */
const SLOT_NAMES = ['in1', 'in2', 'in3', 'in4'] as const

/**
 * Interpolate an authored template (spec §8): context macros + EJS run FIRST (only when a `gen` Context
 * is wired — they need vars/globals), then the `{{in1}}`-`{{in4}}` upstream-slot placeholders (plus
 * `{{input}}` when the caller supplies an `input` slot) are substituted LAST, so upstream text is always
 * data, never executable template code. `{{inN}}`/`{{input}}` are not known macros, so expandMacros
 * leaves the placeholders untouched.
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
  // agent.llm's dedicated `{{input}}` placeholder: the generic `input` port payload, substituted here as
  // DATA — last, same invariant as `{{inN}}` — so an upstream table block or an LLM output can never
  // inject executable template code. Only substituted when the caller wired an `input` slot.
  if ('input' in slots) out = out.split('{{input}}').join(slotText(slots.input))
  return out
}
