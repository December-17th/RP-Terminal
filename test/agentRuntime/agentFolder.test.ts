import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmp: string
vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))
vi.mock('../../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})

import { closeDb, getDb } from '../../src/main/services/db'
import { AgentCatalog } from '../../src/main/services/agentRuntime/catalog/AgentCatalog'
import {
  listAgentFiles,
  resolveAgentFolder,
  syncAgentFolder
} from '../../src/main/services/agentRuntime/catalog/agentFolder'

let dir: string

const definition = (name: string, prompt = `${name} prompt`): Record<string, unknown> => ({
  format: 'rpt-agent',
  formatVersion: 1,
  name,
  prompt: [{ role: 'system', content: prompt }],
  result: { mode: 'text' }
})

const writeAgent = (file: string, value: unknown): void =>
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value, null, 2), 'utf8')

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-agent-folder-'))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-agent-files-'))
  getDb()
    .prepare('INSERT INTO profiles (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
    .run('p', 'p', 'now', 'now')
})

afterEach(() => {
  closeDb()
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('syncAgentFolder', () => {
  it('installs each .rptagent file once and reports it unchanged on re-scan', () => {
    writeAgent('alpha.rptagent', definition('Alpha'))
    const catalog = new AgentCatalog('p')

    expect(syncAgentFolder(catalog, dir).items).toEqual([
      { file: 'alpha.rptagent', status: 'installed', name: 'Alpha', agentId: expect.any(String) }
    ])
    // Re-scanning must not duplicate: the filename is a stable source key.
    expect(syncAgentFolder(catalog, dir).items).toMatchObject([
      { file: 'alpha.rptagent', status: 'unchanged', name: 'Alpha' }
    ])
    expect(catalog.list().filter((agent) => agent.source.kind === 'user-imported')).toHaveLength(1)
  })

  it('treats an edited file as an upgrade of the same row, not a second Agent', () => {
    writeAgent('alpha.rptagent', definition('Alpha'))
    const catalog = new AgentCatalog('p')
    const installed = syncAgentFolder(catalog, dir).items[0]

    writeAgent('alpha.rptagent', definition('Alpha', 'edited prompt'))
    const result = syncAgentFolder(catalog, dir).items[0]

    expect(result).toMatchObject({ status: 'upgraded', agentId: installed.agentId })
    expect(catalog.list().filter((agent) => agent.source.kind === 'user-imported')).toHaveLength(1)
    expect(catalog.require(installed.agentId!).effective.prompt[0].content).toMatchObject([
      { type: 'text', text: 'edited prompt' }
    ])
  })

  it('reports a conflict instead of discarding an in-app customization', () => {
    writeAgent('alpha.rptagent', definition('Alpha'))
    const catalog = new AgentCatalog('p')
    const id = syncAgentFolder(catalog, dir).items[0]!.agentId!

    // User edits the same field in the app, then the file changes it too.
    catalog.edit(id, { ...definition('Alpha', 'user edited in app') })
    writeAgent('alpha.rptagent', definition('Alpha', 'file edited on disk'))

    const conflicted = syncAgentFolder(catalog, dir).items[0]
    expect(conflicted).toMatchObject({ status: 'conflict' })
    expect(conflicted!.conflicts?.length).toBeGreaterThan(0)
    // The customization survives an unresolved conflict.
    expect(catalog.require(id).effective.prompt[0].content).toMatchObject([
      { type: 'text', text: 'user edited in app' }
    ])

    const resolved = syncAgentFolder(catalog, dir, { conflicts: 'use-source' }).items[0]
    expect(resolved).toMatchObject({ status: 'upgraded' })
    expect(catalog.require(id).effective.prompt[0].content).toMatchObject([
      { type: 'text', text: 'file edited on disk' }
    ])
  })

  it('fails one bad file without blocking the rest of the folder', () => {
    writeAgent('bad.rptagent', { format: 'rpt-agent', formatVersion: 1, name: 'Broken' })
    writeAgent('good.rptagent', definition('Good'))
    fs.writeFileSync(path.join(dir, 'notjson.rptagent'), 'this is not json', 'utf8')
    fs.writeFileSync(path.join(dir, 'ignored.txt'), 'not an agent file', 'utf8')

    const items = syncAgentFolder(new AgentCatalog('p'), dir).items

    expect(items.map((item) => item.file)).toEqual([
      'bad.rptagent',
      'good.rptagent',
      'notjson.rptagent'
    ])
    expect(items.find((item) => item.file === 'good.rptagent')).toMatchObject({
      status: 'installed'
    })
    for (const file of ['bad.rptagent', 'notjson.rptagent']) {
      expect(items.find((item) => item.file === file)).toMatchObject({ status: 'failed' })
    }
  })

  it('reports a name collision as a failure rather than throwing', () => {
    const catalog = new AgentCatalog('p')
    catalog.create(definition('Taken'))
    writeAgent('taken.rptagent', definition('Taken'))

    expect(syncAgentFolder(catalog, dir).items).toMatchObject([
      { file: 'taken.rptagent', status: 'failed' }
    ])
  })

  it('returns an empty sync for a missing folder', () => {
    const missing = path.join(dir, 'nope')

    expect(listAgentFiles(missing)).toEqual([])
    expect(syncAgentFolder(new AgentCatalog('p'), missing)).toEqual({ dir: missing, items: [] })
  })

  it('resolves the folder from RPT_AGENT_DIR when set', () => {
    const previous = process.env.RPT_AGENT_DIR
    process.env.RPT_AGENT_DIR = dir
    try {
      expect(resolveAgentFolder()).toBe(dir)
    } finally {
      if (previous === undefined) delete process.env.RPT_AGENT_DIR
      else process.env.RPT_AGENT_DIR = previous
    }
  })
})
