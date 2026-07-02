import { z } from 'zod'
import { getPresetById } from '../../presetService'
import { matchWorldInfo, assemblePrompt, AssembleOverrides } from '../../generation/assemble'
import { GenContext } from '../../generation/types'
import { ChatMessage } from '../../promptBuilder'
import { NodeImpl, NodeRunFailure } from '../types'

/**
 * prompt.preset composer (context-epochs plan §3): `prompt.assemble` with its ingredients exposed
 * as wireable ports. It runs the SAME `assemblePrompt` the default graph uses, but each wired port
 * overrides one ingredient — the preset skeleton (config `preset_id`), the history, the World Info
 * block, the memory tail, and the pending action. This is what lets a side-call feature (世界推进,
 * 剧情推进) build its own main prompt against its own preset + its own lorebook subset.
 *
 * With NOTHING wired (and no preset_id), its output is byte-identical to prompt.assemble's on the
 * same gen — parity is structural (an unwired port = today's default computation).
 */

const presetConfig = z.object({
  /** Saved preset id to compose against (getPresetById). Missing id → class-B `bad-preset`
   *  (fail loud, not a silent fallback to the active preset). */
  preset_id: z.string().optional()
})

export const promptPreset: NodeImpl = {
  type: 'prompt.preset',
  title: 'Preset Prompt',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'history', type: 'Messages' },
    { name: 'worldInfo', type: 'Text' },
    { name: 'memory', type: 'Text' },
    { name: 'action', type: 'Text' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'sendMessages', type: 'Messages' },
    { name: 'params', type: 'Any' }
  ],
  configSchema: presetConfig,
  run: (_ctx, inputs, node) => {
    const gen = inputs.gen as GenContext
    const cfg = (node?.config ?? {}) as z.infer<typeof presetConfig>

    const overrides: AssembleOverrides = {}
    if (cfg.preset_id) {
      const preset = getPresetById(gen.profileId, cfg.preset_id)
      if (!preset)
        throw new NodeRunFailure('B', `preset '${cfg.preset_id}' not found`, 1, 'bad-preset')
      overrides.preset = preset
    }
    const history = inputs.history as ChatMessage[] | undefined
    if (history) overrides.history = history
    const worldInfo = inputs.worldInfo as string | undefined
    if (worldInfo !== undefined) overrides.worldInfo = worldInfo
    const action = inputs.action as string | undefined
    if (action !== undefined) overrides.action = action

    // World Info: a wired override replaces the block AND skips the keyword scan; otherwise
    // matchWorldInfo runs exactly as prompt.assemble does.
    const matched = overrides.worldInfo !== undefined ? [] : matchWorldInfo(gen)
    // Unwired memory = '' (assemble's behavior for an empty memory block — NOT the default graph's
    // recall, which it wires explicitly).
    const memory = (inputs.memory as string | undefined) ?? ''
    const { sendMessages, params } = assemblePrompt(gen, matched, memory, overrides)
    return { outputs: { sendMessages, params } }
  }
}
