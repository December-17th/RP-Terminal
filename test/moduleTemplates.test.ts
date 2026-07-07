import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  listModuleTemplates,
  getModuleTemplate,
  saveModuleToLibrary
} from '../src/main/services/moduleTemplates'
import { setMemorySeedingEnabled, listWorkflows } from '../src/main/services/workflowService'
import { getAppDir } from '../src/main/services/storageService'
import { buildDefaultMemoryDoc } from '../src/main/services/nodes/builtin/defaultMemoryTemplate'
import type { ModulePayload } from '../src/shared/workflow/moduleEnvelope'

// The agent library (agent-memory-ux WP-G; spec §2): built-in module templates + the per-profile
// user library under workflows/_library. Real fs against getAppDir with a throwaway profile (the
// workflowService.test idiom). Seeding is disabled for the listWorkflows isolation check — that
// suite's concern, not this one's.
setMemorySeedingEnabled(false)

const profileId = `mtpl-test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

/** A minimal VALID module payload (2 nodes, one internal edge — passes the envelope gate). */
const validModule = (name = 'My Saved Agent'): ModulePayload => ({
  name,
  nodes: [
    { id: 'a', type: 'trigger.cadence', position: { x: 0, y: 0 }, config: { everyNFloors: 2 } },
    { id: 'b', type: 'util.log', position: { x: 200, y: 0 } }
  ],
  edges: [{ from: { node: 'a', port: 'fired' }, to: { node: 'b', port: 'when' } }],
  note: 'setup me'
})

describe('moduleTemplates: built-in registry', () => {
  it('lists the "Table memory" builtin first', () => {
    const list = listModuleTemplates(profileId)
    expect(list.length).toBeGreaterThanOrEqual(1)
    expect(list[0]).toMatchObject({
      id: 'builtin:table-memory',
      name: 'Table memory',
      source: 'builtin'
    })
    expect(list[0].nodeCount).toBeGreaterThan(0)
  })

  it('getModuleTemplate returns the WP-C group extraction (nodes + exposed + note; internal edges only)', () => {
    const payload = getModuleTemplate(profileId, 'builtin:table-memory')
    expect(payload).not.toBeNull()
    const doc = buildDefaultMemoryDoc()
    const group = doc.groups![0]
    // Byte-for-byte the seeded group's members — one source of truth (defaultMemoryTemplate.ts).
    expect(payload!.nodes.map((n) => n.id).sort()).toEqual([...group.nodeIds].sort())
    expect(payload!.exposed).toEqual(group.exposed)
    expect(payload!.note).toBe(group.note)
    // INTERNAL edges only: no edge end may point outside the membership.
    const members = new Set(group.nodeIds)
    for (const e of payload!.edges) {
      expect(members.has(e.from.node)).toBe(true)
      expect(members.has(e.to.node)).toBe(true)
    }
  })

  it('unknown ids and path-escaping ids return null', () => {
    expect(getModuleTemplate(profileId, 'builtin:nope')).toBeNull()
    expect(getModuleTemplate(profileId, 'no-such-entry')).toBeNull()
    expect(getModuleTemplate(profileId, '../../evil')).toBeNull()
  })
})

describe('moduleTemplates: user library', () => {
  it('save → list → get round-trips through the shared envelope format', () => {
    const saved = saveModuleToLibrary(profileId, validModule())
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    const list = listModuleTemplates(profileId)
    const mine = list.find((e) => e.id === saved.id)
    expect(mine).toMatchObject({ name: 'My Saved Agent', source: 'user', nodeCount: 2 })

    const payload = getModuleTemplate(profileId, saved.id)
    expect(payload).not.toBeNull()
    expect(payload!.name).toBe('My Saved Agent')
    expect(payload!.note).toBe('setup me')
    expect(payload!.nodes).toHaveLength(2)
    expect(payload!.edges).toHaveLength(1)
  })

  it('rejects an invalid module (the envelope gate: < 2 nodes)', () => {
    const bad: ModulePayload = {
      name: 'Too small',
      nodes: [{ id: 'only', type: 'util.log', position: { x: 0, y: 0 } }],
      edges: []
    }
    const result = saveModuleToLibrary(profileId, bad)
    expect(result.ok).toBe(false)
  })

  it('rejects a module with an external edge (envelope gate)', () => {
    const bad = validModule('External edge')
    bad.edges = [{ from: { node: 'a', port: 'fired' }, to: { node: 'ghost', port: 'when' } }]
    expect(saveModuleToLibrary(profileId, bad).ok).toBe(false)
  })

  it('library files never leak into listWorkflows (the _library dir is invisible to the doc scan)', () => {
    const saved = saveModuleToLibrary(profileId, validModule('Not A Workflow'))
    expect(saved.ok).toBe(true)
    const docs = listWorkflows(profileId)
    expect(docs.some((w) => w.name === 'Not A Workflow')).toBe(false)
  })

  it('a corrupt library file is skipped fail-soft (listed entries stay readable)', () => {
    const dir = path.join(profileDir, 'workflows', '_library')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'corrupt.json'), '{ "kind": "not-a-module" }', 'utf-8')
    const list = listModuleTemplates(profileId)
    expect(list.some((e) => e.id === 'corrupt')).toBe(false)
    expect(getModuleTemplate(profileId, 'corrupt')).toBeNull()
  })
})
