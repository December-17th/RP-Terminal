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
import {
  AgentCatalog,
  AgentCatalogError,
  type AgentImportPackage
} from '../../src/main/services/agentRuntime/catalog/AgentCatalog'
import { getProfiles } from '../../src/main/services/profileService'

const textAgent = (name: string, prompt = `${name} prompt`) => ({
  format: 'rpt-agent' as const,
  formatVersion: 1 as const,
  name,
  prompt: [{ role: 'system' as const, content: prompt }],
  result: { mode: 'text' as const }
})

const profile = (id: string): void => {
  getDb()
    .prepare('INSERT INTO profiles (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
    .run(id, id, 'now', 'now')
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-agent-catalog-'))
  profile('p')
})

afterEach(() => {
  closeDb()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('AgentCatalog', () => {
  it('seeds no decoy role defaults (M5a/D6) and enforces profile-wide names across sources', () => {
    const catalog = new AgentCatalog('p')
    // The Classic Narrator / Yuzu Scene Director decoys no longer seed, so no role is auto-bound.
    expect(catalog.getRoleBindings()).toEqual({})

    catalog.create(textAgent('Shared Name'))
    expect(() =>
      catalog.installPackage({
        source: { kind: 'card', key: 'card-a', version: '1' },
        agents: [textAgent('Shared Name')]
      })
    ).toThrowError(AgentCatalogError)
  })

  it('idempotently seeds existing SQLite profiles during ordinary profile load', () => {
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM agent_catalog WHERE profile_id = ?').get('p')
    ).toEqual({ n: 0 })

    expect(getProfiles().map((item) => item.id)).toEqual(['p'])
    expect(new AgentCatalog('p').getRoleBindings()).toEqual({})
    const seededCount = new AgentCatalog('p').list().length
    getProfiles()
    expect(new AgentCatalog('p').list()).toHaveLength(seededCount)
  })

  it('uses one Unicode-normalized, locale-independent name key in validation and SQLite', () => {
    const catalog = new AgentCatalog('p')
    catalog.create(textAgent('Ågent'))
    expect(() => catalog.create(textAgent('A\u030Agent'))).toThrowError(AgentCatalogError)
    catalog.create(textAgent('Straße'))
    expect(() => catalog.create(textAgent('STRASSE'))).toThrowError(AgentCatalogError)
    expect(() =>
      catalog.inspectPackage({
        source: { kind: 'card', key: 'unicode-card', version: '1' },
        agents: [textAgent('Keeper'), textAgent('keeper')]
      })
    ).toThrowError(AgentCatalogError)
  })

  it('requires incoming collision renames and rewrites same-package role references atomically', () => {
    const catalog = new AgentCatalog('p')
    catalog.create(textAgent('Existing'))
    const incoming: AgentImportPackage = {
      source: { kind: 'card', key: 'card-a', version: '1' },
      agents: [textAgent('Existing')],
      roleRecommendations: { 'classic.narrator': 'Existing' }
    }

    expect(catalog.inspectPackage(incoming).collisions).toEqual([
      expect.objectContaining({ incomingName: 'Existing' })
    ])
    const result = catalog.installPackage(incoming, { Existing: 'Card Narrator' })

    expect(result.installed.map((agent) => agent.name)).toEqual(['Card Narrator'])
    expect(result.installed[0].enabled).toBe(true)
    expect(result.roleRecommendations).toEqual({ 'classic.narrator': 'Card Narrator' })
    expect(incoming.agents[0].name).toBe('Existing')
  })

  it('customizes and restores an Agent through the effective definition', () => {
    const catalog = new AgentCatalog('p')
    const created = catalog.create(textAgent('Editable', 'baseline'))
    const edited = catalog.edit(created.id, textAgent('Editable', 'custom'))

    expect(edited.effective.prompt[0].content).toEqual([{ type: 'text', text: 'custom' }])
    expect(edited.customized).toBe(true)
    expect(catalog.restore(created.id).effective.prompt[0].content).toEqual([
      { type: 'text', text: 'baseline' }
    ])
  })

  it('shows source upgrades and blocks overlapping customization conflicts until resolved', () => {
    const catalog = new AgentCatalog('p')
    const [agent] = catalog.installPackage({
      source: { kind: 'card', key: 'card-a', version: '1' },
      agents: [textAgent('Upgradeable', 'v1')]
    }).installed
    catalog.edit(agent.id, textAgent('Upgradeable', 'mine'))

    const diff = catalog.inspectUpgrade(agent.id, textAgent('Upgradeable', 'v2'), '2')
    expect(diff.changedPaths).toContain('prompt.0.content.0.text')
    expect(diff.conflicts).toContain('prompt.0.content.0.text')
    expect(() => catalog.upgrade(agent.id, textAgent('Upgradeable', 'v2'), '2')).toThrow(
      /conflict/i
    )

    const upgraded = catalog.upgrade(agent.id, textAgent('Upgradeable', 'v2'), '2', {
      conflicts: 'keep-customization'
    })
    expect(upgraded.source.version).toBe('2')
    expect(upgraded.effective.prompt[0].content).toEqual([{ type: 'text', text: 'mine' }])
  })

  it('enforces source-backed deletion and compatible role-binding constraints', () => {
    const catalog = new AgentCatalog('p')
    const [cardAgent] = catalog.installPackage({
      source: { kind: 'card', key: 'card-a', version: '1' },
      agents: [textAgent('Card Agent')]
    }).installed
    expect(() => catalog.delete(cardAgent.id)).toThrow(/source-backed/i)

    const created = catalog.create(textAgent('Replacement'))
    catalog.bindRole('classic.narrator', created.id)
    expect(() => catalog.setEnabled(created.id, false)).toThrow(/role/i)
    expect(() => catalog.bindRole('yuzu.sceneDirector', created.id)).toThrow(/compatible/i)
  })

  it('distinguishes Agent Definition files from legacy workflow packs', () => {
    const catalog = new AgentCatalog('p')
    expect(catalog.inspectStandalone(JSON.stringify(textAgent('Imported'))).ok).toBe(true)
    expect(catalog.importStandalone(JSON.stringify(textAgent('Imported'))).source.kind).toBe(
      'user-imported'
    )
    expect(
      catalog.inspectStandalone(
        JSON.stringify({ kind: 'rptagent', formatVersion: 0, pack: { manifest: {} } })
      )
    ).toEqual(expect.objectContaining({ ok: false, format: 'legacy-workflow-pack' }))
    expect(catalog.list().some((agent) => agent.name === 'Imported')).toBe(true)
  })
})
