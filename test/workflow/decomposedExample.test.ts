import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { validateWorkflowDoc } from '../../src/main/services/workflowService'
import { WorkflowDoc } from '../../src/shared/workflow/types'

// Pins the shipped decomposed-default example (docs/workflows/decomposed-default.rptflow)
// to the real builtin registry: if a node type, port, or config schema it uses ever changes
// shape, this fails HERE instead of at the owner's import.

const examplePath = path.join(__dirname, '../../docs/workflows/decomposed-default.rptflow')

describe('decomposed-default example workflow', () => {
  const raw = JSON.parse(fs.readFileSync(examplePath, 'utf-8')) as WorkflowDoc

  it('passes the full save gate (structure + graph + per-node config)', () => {
    const result = validateWorkflowDoc(raw)
    if (!result.ok) throw new Error(result.error)
    expect(result.ok).toBe(true)
  })

  it('is a turn doc with write as the sole main output and no assemble node', () => {
    expect(raw.kind).toBeUndefined()
    const mains = raw.nodes.filter((n) => n.isMainOutput)
    expect(mains.map((n) => n.id)).toEqual(['write'])
    // The whole point: the prompt is composed from components, not prompt.assemble.
    expect(raw.nodes.some((n) => n.type === 'prompt.assemble')).toBe(false)
    expect(raw.nodes.some((n) => n.type === 'context.action')).toBe(true)
    expect(raw.nodes.some((n) => n.type === 'context.params')).toBe(true)
  })

  it('llm params is wired (providers dereference params — must not be unwired on a main path)', () => {
    const paramsEdge = raw.edges.find(
      (e) => e.to.node === 'llm' && e.to.port === 'params'
    )
    expect(paramsEdge?.from).toEqual({ node: 'params', port: 'params' })
  })
})
