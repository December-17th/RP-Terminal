import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { validateWorkflowDoc } from '../../src/main/services/workflowService'
import { WorkflowDoc } from '../../src/shared/workflow/types'

// Pins the shipped SQL-table-memory example (docs/workflows/table-memory-default.rptflow)
// to the real builtin registry: if a node type, port, or config schema it uses ever changes
// shape, this fails HERE instead of at the owner's import. Same pattern as decomposedExample.test.ts.

const examplePath = path.join(__dirname, '../../docs/workflows/table-memory-default.rptflow')

describe('table-memory-default example workflow', () => {
  const raw = JSON.parse(fs.readFileSync(examplePath, 'utf-8')) as WorkflowDoc

  it('passes the full save gate (structure + graph + per-node config)', () => {
    const result = validateWorkflowDoc(raw)
    if (!result.ok) throw new Error(result.error)
    expect(result.ok).toBe(true)
  })

  it('is a turn doc with write as the sole main output', () => {
    expect(raw.kind).toBeUndefined()
    const mains = raw.nodes.filter((n) => n.isMainOutput)
    expect(mains.map((n) => n.id)).toEqual(['write'])
  })

  it('wires table.export projection into the main prompt (assemble entries port)', () => {
    const entriesEdge = raw.edges.find(
      (e) => e.to.node === 'assemble' && e.to.port === 'entries'
    )
    expect(entriesEdge?.from).toEqual({ node: 'export', port: 'entries' })
  })

  it('gate re-reads the floor AFTER the turn (ordering edge from write.floor)', () => {
    const floorEdge = raw.edges.find((e) => e.to.node === 'gate' && e.to.port === 'floor')
    expect(floorEdge?.from).toEqual({ node: 'write', port: 'floor' })
  })

  it('runs the maintenance side-call non-streaming and extracts the TableEdit tag', () => {
    const side = raw.nodes.find((n) => n.id === 'side')
    expect(side?.type).toBe('llm.sample')
    expect((side?.config as { stream?: boolean }).stream).toBe(false)
    const sql = raw.nodes.find((n) => n.id === 'sql')
    expect(sql?.type).toBe('parse.extract')
    expect((sql?.config as { tag?: string }).tag).toBe('TableEdit')
  })

  it('ships WITHOUT an api_preset_id on the side call (runs on the active connection)', () => {
    const side = raw.nodes.find((n) => n.id === 'side')
    expect((side?.config as { api_preset_id?: string }).api_preset_id).toBeUndefined()
  })

  it('routes both side-call and apply failures to util.log (fail-open)', () => {
    const sideErr = raw.edges.find((e) => e.from.node === 'side' && e.from.port === 'error')
    expect(sideErr?.to).toEqual({ node: 'log-side', port: 'value' })
    const applyErr = raw.edges.find(
      (e) => e.from.node === 'tableapply' && e.from.port === 'error'
    )
    expect(applyErr?.to).toEqual({ node: 'log-apply', port: 'value' })
  })
})
