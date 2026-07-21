import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createAgentLabStore,
  type AgentLabStore
} from '../../src/main/services/agentRuntime/lab/AgentLabStore'
import { AGENT_LAB_RUN_REF_CAP, type AgentRunRecord } from '../../src/shared/agentRuntime'

/**
 * AgentLabStore CRUD + run-ref cap (plan §Verification gate). File-per-case under a tmp data root, so
 * these assertions exercise the real atomic write/read path with no session DB.
 */

const sourceRecord = (invocationId: string): AgentRunRecord =>
  ({
    invocationId,
    agentName: 'Summarizer',
    agentHash: 'hash:v1',
    input: { q: 'hello' },
    renderedPrompt: [],
    attempts: []
  }) as unknown as AgentRunRecord

describe('AgentLabStore', () => {
  let tmp: string
  let store: AgentLabStore
  let ids: string[]

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-agent-lab-'))
    ids = []
    let counter = 0
    store = createAgentLabStore({
      baseDir: () => tmp,
      now: () => '2026-07-21T00:00:00.000Z',
      createId: () => {
        const id = `case-${counter++}`
        ids.push(id)
        return id
      }
    })
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('captures a case from a run and reads it back', () => {
    const summary = store.captureFromRun('p1', {
      agentId: 'agent-1',
      agentName: 'Summarizer',
      name: 'Baseline',
      sourceRecord: sourceRecord('inv-1')
    })
    expect(summary).toMatchObject({
      agentId: 'agent-1',
      agentName: 'Summarizer',
      name: 'Baseline',
      hasSource: true,
      agentHash: 'hash:v1',
      sourceInvocationId: 'inv-1',
      runs: []
    })

    const full = store.get('p1', summary.id)
    expect(full?.input).toEqual({ q: 'hello' })
    expect(full?.sourceRecord?.invocationId).toBe('inv-1')
  })

  it('authors a live-only case from input (no source)', () => {
    const summary = store.createFromInput('p1', {
      agentId: 'agent-1',
      agentName: 'Summarizer',
      name: 'Authored',
      input: { topic: 'x' }
    })
    expect(summary.hasSource).toBe(false)
    expect(summary.agentHash).toBeUndefined()
    expect(store.get('p1', summary.id)?.input).toEqual({ topic: 'x' })
    expect(store.get('p1', summary.id)?.sourceRecord).toBeUndefined()
  })

  it('lists only cases for the requested agent, scoped per profile', () => {
    store.createFromInput('p1', { agentId: 'a1', agentName: 'A', name: 'one', input: {} })
    store.createFromInput('p1', { agentId: 'a2', agentName: 'B', name: 'two', input: {} })
    store.createFromInput('p2', { agentId: 'a1', agentName: 'A', name: 'three', input: {} })

    const forA1 = store.list('p1', 'a1')
    expect(forA1).toHaveLength(1)
    expect(forA1[0].name).toBe('one')
    expect(store.list('p2', 'a1')).toHaveLength(1)
  })

  it('renames and removes a case', () => {
    const created = store.createFromInput('p1', {
      agentId: 'a1',
      agentName: 'A',
      name: 'old',
      input: {}
    })
    expect(store.rename('p1', created.id, 'new')?.name).toBe('new')
    expect(store.get('p1', created.id)?.name).toBe('new')

    expect(store.remove('p1', created.id)).toBe(true)
    expect(store.get('p1', created.id)).toBeNull()
    expect(store.remove('p1', created.id)).toBe(false)
  })

  it('returns null/false for unknown cases and rejects unsafe ids', () => {
    expect(store.get('p1', 'missing')).toBeNull()
    expect(store.rename('p1', 'missing', 'x')).toBeNull()
    expect(store.get('p1', '../escape')).toBeNull()
    expect(store.remove('p1', '../escape')).toBe(false)
  })

  it('caps retained run references at AGENT_LAB_RUN_REF_CAP, dropping oldest', () => {
    const created = store.createFromInput('p1', {
      agentId: 'a1',
      agentName: 'A',
      name: 'c',
      input: {}
    })
    const total = AGENT_LAB_RUN_REF_CAP + 5
    let last: ReturnType<AgentLabStore['appendRun']> = null
    for (let index = 0; index < total; index++) {
      last = store.appendRun('p1', created.id, {
        invocationId: `run-${index}`,
        chatId: 'c1',
        mode: 'replay',
        startedAt: '2026-07-21T00:00:00.000Z',
        status: 'succeeded'
      })
    }
    expect(last?.runs).toHaveLength(AGENT_LAB_RUN_REF_CAP)
    // Oldest 5 dropped: first retained is index 5, newest is last.
    expect(last?.runs[0].invocationId).toBe(`run-${total - AGENT_LAB_RUN_REF_CAP}`)
    expect(last?.runs.at(-1)?.invocationId).toBe(`run-${total - 1}`)
    expect(store.get('p1', created.id)?.runs).toHaveLength(AGENT_LAB_RUN_REF_CAP)
  })
})
