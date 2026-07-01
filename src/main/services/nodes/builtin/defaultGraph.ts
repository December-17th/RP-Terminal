import { WorkflowDoc } from '../../../../shared/workflow/types'

/** The default generation graph (Phase 2b-1b task 5): the seven built-in nodes wired to
 *  reproduce the existing `generate()` flow exactly (spec §5, plan decision A). `write`
 *  (output.writeFloor) is the phase-boundary / main-output node; `compact` runs after it,
 *  off the hot path, same as `generate()`'s fire-and-forget `compactMemory` call. */
export const DEFAULT_GRAPH: WorkflowDoc = {
  id: 'default',
  name: 'Default Generation',
  version: 1,
  schemaVersion: 1,
  description:
    'Built-in generation pipeline: recall, assemble, sample, parse, apply, write, compact.',
  nodes: [
    { id: 'ctx', type: 'input.context' },
    { id: 'recall', type: 'memory.recall' },
    { id: 'assemble', type: 'prompt.assemble' },
    { id: 'llm', type: 'llm.sample' },
    { id: 'parse', type: 'parse.response' },
    { id: 'apply', type: 'apply.state' },
    { id: 'write', type: 'output.writeFloor', isMainOutput: true },
    { id: 'compact', type: 'memory.compact' }
  ],
  edges: [
    { from: { node: 'ctx', port: 'gen' }, to: { node: 'recall', port: 'gen' } },

    { from: { node: 'ctx', port: 'gen' }, to: { node: 'assemble', port: 'gen' } },
    { from: { node: 'recall', port: 'block' }, to: { node: 'assemble', port: 'block' } },

    { from: { node: 'ctx', port: 'gen' }, to: { node: 'llm', port: 'gen' } },
    { from: { node: 'assemble', port: 'sendMessages' }, to: { node: 'llm', port: 'sendMessages' } },
    { from: { node: 'assemble', port: 'params' }, to: { node: 'llm', port: 'params' } },

    { from: { node: 'ctx', port: 'gen' }, to: { node: 'parse', port: 'gen' } },
    { from: { node: 'llm', port: 'raw' }, to: { node: 'parse', port: 'raw' } },
    {
      from: { node: 'assemble', port: 'sendMessages' },
      to: { node: 'parse', port: 'sendMessages' }
    },
    { from: { node: 'llm', port: 'rawUsage' }, to: { node: 'parse', port: 'rawUsage' } },

    { from: { node: 'ctx', port: 'gen' }, to: { node: 'apply', port: 'gen' } },
    { from: { node: 'parse', port: 'parsed' }, to: { node: 'apply', port: 'parsed' } },
    { from: { node: 'parse', port: 'mvu' }, to: { node: 'apply', port: 'mvu' } },
    { from: { node: 'llm', port: 'raw' }, to: { node: 'apply', port: 'raw' } },

    { from: { node: 'ctx', port: 'gen' }, to: { node: 'write', port: 'gen' } },
    { from: { node: 'llm', port: 'raw' }, to: { node: 'write', port: 'raw' } },
    {
      from: { node: 'assemble', port: 'sendMessages' },
      to: { node: 'write', port: 'sendMessages' }
    },
    { from: { node: 'apply', port: 'variables' }, to: { node: 'write', port: 'variables' } },
    { from: { node: 'parse', port: 'parsed' }, to: { node: 'write', port: 'parsed' } },
    { from: { node: 'parse', port: 'metrics' }, to: { node: 'write', port: 'metrics' } },

    { from: { node: 'ctx', port: 'gen' }, to: { node: 'compact', port: 'gen' } }
  ]
}
