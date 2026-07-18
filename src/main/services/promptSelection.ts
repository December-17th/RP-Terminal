import type { AssemblyJournal, RecordSource } from '../../shared/executionRecord'
import type { PromptBlock } from '../types/preset'

/** Character-card override sources for the main and jailbreak literals. */
export interface CardPromptOverrides {
  system?: string
  postHistory?: string
}

/** A block whose card override may retain the original preset content. */
export type EffectivePromptBlock = PromptBlock & { originalContent?: string }

/** Match ST's generation-type trigger semantics. */
export const shouldTrigger = (
  block: { injection_trigger?: string[] },
  generationType: string
): boolean => {
  const triggers = block.injection_trigger
  return !Array.isArray(triggers) || triggers.length === 0 || triggers.includes(generationType)
}

/**
 * Resolve enabled/triggered prompts and card overrides before assembly.
 * The journal is observational and never changes the resolved collection.
 */
export const resolveEffectivePrompts = (
  prompts: PromptBlock[],
  generationType: string,
  overrides: CardPromptOverrides,
  journal?: AssemblyJournal
): EffectivePromptBlock[] => {
  const normalizedType = String(generationType || 'normal')
    .toLowerCase()
    .trim()
  const blockSource = (block: PromptBlock): RecordSource => ({
    kind: 'preset-block',
    id: block.identifier,
    ...(block.name ? { label: block.name } : {})
  })
  const out: EffectivePromptBlock[] = []

  for (const prompt of prompts) {
    const triggered = prompt.enabled !== false && shouldTrigger(prompt, normalizedType)
    if (triggered) {
      if (prompt.marker === 'none' && prompt.forbid_overrides !== true) {
        if (prompt.identifier === 'main' && overrides.system) {
          out.push({
            ...prompt,
            content: overrides.system,
            originalContent: prompt.content
          })
          continue
        }
        if (prompt.identifier === 'jailbreak' && overrides.postHistory) {
          out.push({
            ...prompt,
            content: overrides.postHistory,
            originalContent: prompt.content
          })
          continue
        }
      } else if (
        prompt.marker === 'none' &&
        prompt.forbid_overrides === true &&
        ((prompt.identifier === 'main' && !!overrides.system) ||
          (prompt.identifier === 'jailbreak' && !!overrides.postHistory))
      ) {
        journal?.exclude(blockSource(prompt), 'override-denied')
      }
      out.push(prompt)
    } else if (prompt.identifier === 'main' && prompt.marker === 'none') {
      out.push({ ...prompt, content: '', enabled: true })
    } else {
      journal?.exclude(
        blockSource(prompt),
        prompt.enabled === false ? 'disabled' : `trigger-filtered:${normalizedType}`
      )
    }
  }
  return out
}
