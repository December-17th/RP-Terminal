import { WorkflowDoc } from '../../../../shared/workflow/types'

/** The default generation graph: the built-in nodes wired to reproduce the existing
 *  `generate()` flow exactly (spec §5, plan decision A). `write` (output.writeFloor) is the
 *  phase-boundary / main-output node. Memory compaction runs after it, off the hot path, as
 *  the DECOMPOSED gate → extract → write chain (spec D5) with the §6 reference error wiring:
 *  extract/write failures land in util.log nodes — fail-open, visibly, as ordinary graph edges. */
export const DEFAULT_GRAPH: WorkflowDoc = {
  id: 'default',
  name: 'Default Generation',
  version: 1,
  schemaVersion: 1,
  description:
    'Built-in generation pipeline: recall, assemble, sample, parse, apply, write, then gated memory compaction (gate → extract → write, errors logged).',
  nodes: [
    { id: 'ctx', type: 'input.context' },
    { id: 'recall', type: 'memory.recall' },
    { id: 'assemble', type: 'prompt.assemble' },
    { id: 'llm', type: 'llm.sample' },
    { id: 'parse', type: 'parse.response' },
    { id: 'apply', type: 'apply.state' },
    { id: 'write', type: 'output.writeFloor', isMainOutput: true },
    { id: 'gate', type: 'memory.gate' },
    { id: 'extract', type: 'memory.extract' },
    { id: 'memwrite', type: 'memory.write' },
    { id: 'log-extract', type: 'util.log', config: { label: 'memory.extract' } },
    { id: 'log-write', type: 'util.log', config: { label: 'memory.write' } }
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

    // Memory compaction (post-response, spec D5): gate fires only when a checkpoint batch has
    // aged out. Ordering edge (owner requirement): the gate reads the chat only AFTER the floor
    // is persisted — action → recall → response → write floor → gate → extract → write memories.
    // The newest keep_recent floors stay out of the summarized range regardless.
    { from: { node: 'ctx', port: 'gen' }, to: { node: 'gate', port: 'gen' } },
    { from: { node: 'write', port: 'floor' }, to: { node: 'gate', port: 'floor' } },

    { from: { node: 'ctx', port: 'gen' }, to: { node: 'extract', port: 'gen' } },
    { from: { node: 'gate', port: 'due' }, to: { node: 'extract', port: 'when' } },
    { from: { node: 'gate', port: 'batch' }, to: { node: 'extract', port: 'batch' } },

    { from: { node: 'ctx', port: 'gen' }, to: { node: 'memwrite', port: 'gen' } },
    { from: { node: 'extract', port: 'done' }, to: { node: 'memwrite', port: 'when' } },
    { from: { node: 'extract', port: 'batch' }, to: { node: 'memwrite', port: 'batch' } },
    { from: { node: 'extract', port: 'memories' }, to: { node: 'memwrite', port: 'memories' } },

    // Reference error wiring (spec §6): memory failures fail OPEN into the log — visible graph
    // edges, not bespoke engine behavior. The main llm's error stays deliberately unwired.
    { from: { node: 'extract', port: 'error' }, to: { node: 'log-extract', port: 'value' } },
    { from: { node: 'memwrite', port: 'error' }, to: { node: 'log-write', port: 'value' } }
  ]
}
