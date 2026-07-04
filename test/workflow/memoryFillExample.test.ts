import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { validateWorkflowDoc } from '../../src/main/services/workflowService'
import { WorkflowDoc } from '../../src/shared/workflow/types'

// Pins the two shipped consolidated-node memory examples (one-canvas rebuild WP6.2; ADR 0011):
//   docs/workflows/memory-fill.rptflow        (cadence trigger — the every-turn spirit)
//   docs/workflows/memory-fill-async.rptflow  (state trigger on backlog — the async variant)
// If a node type, port, or config schema they use ever changes shape, this fails HERE instead of at
// the owner's import. Same pattern as tableMemoryExample.test.ts.

const load = (name: string): WorkflowDoc =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, `../../docs/workflows/${name}`), 'utf-8')
  ) as WorkflowDoc

describe('memory-fill example workflows (consolidated agent nodes)', () => {
  const fill = load('memory-fill.rptflow')
  const asyncFill = load('memory-fill-async.rptflow')

  for (const [label, doc] of [
    ['memory-fill', fill],
    ['memory-fill-async', asyncFill]
  ] as const) {
    describe(label, () => {
      it('passes the full save gate (structure + graph + per-node config)', () => {
        const result = validateWorkflowDoc(doc)
        if (!result.ok) throw new Error(result.error)
        expect(result.ok).toBe(true)
      })

      it('is a turn doc with write as the sole main output', () => {
        expect(doc.kind).toBeUndefined()
        expect(doc.nodes.filter((n) => n.isMainOutput).map((n) => n.id)).toEqual(['write'])
      })

      it('is the consolidated five-node agent chain: trigger → history.recent → agent.llm → parse.extract → table.apply', () => {
        const types = new Set(doc.nodes.map((n) => n.type))
        expect(types.has('history.recent')).toBe(true)
        expect(types.has('agent.llm')).toBe(true)
        // Parser role = parse.extract (no separate parse.sql node); SQL ops = table.apply.
        const sql = doc.nodes.find((n) => n.id === 'sql')
        expect(sql?.type).toBe('parse.extract')
        expect((sql?.config as { tag?: string }).tag).toBe('TableEdit')
        expect(doc.nodes.find((n) => n.id === 'tableapply')?.type).toBe('table.apply')
      })

      it("the trigger's fired signal GATES the chain head (history.recent.when)", () => {
        const gate = doc.edges.find(
          (e) => e.from.node === 'trigger' && e.to.node === 'history' && e.to.port === 'when'
        )
        expect(gate?.from.port).toBe('fired')
      })

      it("wires table.export projection into the main prompt (assemble entries port) — turn-coupled", () => {
        const entriesEdge = doc.edges.find(
          (e) => e.to.node === 'assemble' && e.to.port === 'entries'
        )
        expect(entriesEdge?.from).toEqual({ node: 'export', port: 'entries' })
      })

      it('runs the agent non-streaming (a side call, never the player stream)', () => {
        const agent = doc.nodes.find((n) => n.id === 'agent')
        expect((agent?.config as { stream?: boolean }).stream).toBe(false)
      })

      it('ships WITHOUT an api_preset_id on the agent (runs on the active connection)', () => {
        const agent = doc.nodes.find((n) => n.id === 'agent')
        expect((agent?.config as { api_preset_id?: string }).api_preset_id).toBeUndefined()
      })
    })
  }

  it('memory-fill uses a CADENCE trigger (every-turn spirit)', () => {
    const trig = fill.nodes.find((n) => n.id === 'trigger')
    expect(trig?.type).toBe('trigger.cadence')
    expect((trig?.config as { everyNFloors?: number }).everyNFloors).toBe(3)
  })

  it('memory-fill-async uses a STATE trigger on the table backlog (gte 6)', () => {
    const trig = asyncFill.nodes.find((n) => n.id === 'trigger')
    expect(trig?.type).toBe('trigger.state')
    expect(trig?.config).toMatchObject({
      source: { scope: 'table', table: 'summary', stat: 'unprocessed' },
      op: 'gte',
      value: 6
    })
  })

  it('memory-fill-async trims the prompt history inline (context.trimProcessed on the narrator path)', () => {
    expect(asyncFill.nodes.some((n) => n.type === 'context.trimProcessed')).toBe(true)
    // The trim is inline: ctx.gen → trim.gen, and assemble reads trim.gen (not ctx.gen).
    expect(
      asyncFill.edges.some((e) => e.from.node === 'trim' && e.to.node === 'assemble' && e.to.port === 'gen')
    ).toBe(true)
  })
})
