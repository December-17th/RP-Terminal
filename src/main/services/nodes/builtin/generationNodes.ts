import { buildGenContext } from '../../generation/genContext'
import { recallMemory } from '../../generation/memoryRecall'
import { matchWorldInfo, assemblePrompt } from '../../generation/assemble'
import { GenContext } from '../../generation/types'
import { NodeImpl } from '../types'

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

/** Recalls relevant episodic memory into a text block for the prompt tail. */
export const memoryRecallNode: NodeImpl = {
  type: 'memory.recall',
  title: 'Recall Memory',
  inputs: [{ name: 'gen', type: 'Context' }],
  outputs: [{ name: 'block', type: 'Text' }],
  run: async (_ctx, inputs) => {
    const r = await recallMemory(inputs.gen as GenContext)
    return { outputs: { block: r.block } }
  }
}

/** Matches world info then assembles the exact message array + sampler params to send. */
export const promptAssemble: NodeImpl = {
  type: 'prompt.assemble',
  title: 'Assemble Prompt',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'block', type: 'Text' }
  ],
  outputs: [
    { name: 'sendMessages', type: 'Messages' },
    { name: 'params', type: 'Any' }
  ],
  run: (_ctx, inputs) => {
    const gen = inputs.gen as GenContext
    const matched = matchWorldInfo(gen)
    const { sendMessages, params } = assemblePrompt(gen, matched, inputs.block as string)
    return { outputs: { sendMessages, params } }
  }
}
