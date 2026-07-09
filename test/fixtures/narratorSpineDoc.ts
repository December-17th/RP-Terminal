import { WorkflowDoc } from '../../src/shared/workflow/types'

/** The narrator-only generation spine — the exact node graph the deleted builtin `DEFAULT_GRAPH`
 *  carried (src/main/services/nodes/builtin/defaultGraph.ts, removed in the memory-default refactor).
 *  Kept as a TEST-ONLY fixture: the product no longer ships a narrator-only builtin (the builtin
 *  fallback is now the SQL-table memory doc), but many characterization tests still need a plain,
 *  runnable narrator doc as a compose/trace baseline. Copied VERBATIM so those tests keep pinning the
 *  same wiring they did against DEFAULT_GRAPH. Not imported by any `src/` code. */
export const NARRATOR_SPINE_DOC: WorkflowDoc = {
  id: 'default',
  name: 'Default Generation',
  version: 1,
  schemaVersion: 1,
  description: 'Built-in generation pipeline: assemble, sample, parse, apply, write.',
  nodes: [
    { id: 'ctx', type: 'input.context' },
    { id: 'assemble', type: 'prompt.assemble' },
    { id: 'llm', type: 'llm.sample' },
    { id: 'parse', type: 'parse.response' },
    { id: 'apply', type: 'apply.state' },
    { id: 'write', type: 'output.writeFloor', isMainOutput: true }
  ],
  edges: [
    { from: { node: 'ctx', port: 'gen' }, to: { node: 'assemble', port: 'gen' } },

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
    { from: { node: 'parse', port: 'metrics' }, to: { node: 'write', port: 'metrics' } }
  ]
}
