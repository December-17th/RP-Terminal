import { z } from 'zod'
import { log } from '../../logService'
import { NodeImpl } from '../types'

/**
 * Terminal for any branch — most usefully an ERROR branch (spec §10): wiring a fallible node's
 * `error` port here makes the branch fail-open-with-a-log instead of aborting the turn (the
 * spec §6 reference-wiring pattern). Logs its input to the app log under the configured label.
 */
export const utilLog: NodeImpl = {
  type: 'util.log',
  title: 'Log',
  inputs: [{ name: 'value', type: 'Any' }],
  outputs: [],
  configSchema: z.object({ label: z.string().optional() }),
  run: (_ctx, inputs, node) => {
    const label = (node?.config?.label as string | undefined) || 'workflow'
    const v = inputs.value
    let text: string
    try {
      text = typeof v === 'string' ? v : JSON.stringify(v)
    } catch {
      text = String(v)
    }
    log('info', `[${label}] ${text ?? 'undefined'}`)
    return { outputs: {} }
  }
}
