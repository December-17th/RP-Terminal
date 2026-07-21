import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

let tmp: string
vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))
vi.mock('../../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})

import { closeDb, getDb } from '../../src/main/services/db'
import '../../src/main/services/cardAgentCatalogBridge'
import {
  importCharacterFromFile,
  inspectCharacterAgentImport,
  replaceCharacterFromFile,
  updateCharacterInPlace
} from '../../src/main/services/characterService'
import {
  AgentCatalog,
  AgentCatalogError
} from '../../src/main/services/agentRuntime/catalog/AgentCatalog'

const profileId = 'profile'
const textAgent = (name: string, prompt: string) => ({
  format: 'rpt-agent',
  formatVersion: 1,
  name,
  prompt: [{ role: 'system', content: prompt }],
  result: { mode: 'text' }
})
const card = (version: string, agents: unknown[]) => ({
  spec: 'chara_card_v3',
  data: {
    name: 'Catalog World',
    character_version: version,
    extensions: { rp_terminal: { world_card: '1.0', agents } }
  }
})
const writeCard = (value: unknown): string => {
  const file = path.join(tmp, `${crypto.randomUUID()}.json`)
  fs.writeFileSync(file, JSON.stringify(value))
  return file
}

beforeEach(() => {
  tmp = path.join(process.cwd(), '.tmp-tests', `agent-card-${crypto.randomUUID()}`)
  fs.mkdirSync(tmp, { recursive: true })
  getDb()
    .prepare('INSERT INTO profiles (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
    .run(profileId, 'Profile', 'now', 'now')
})

afterEach(() => {
  closeDb()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('card Agent Catalog bridge', () => {
  it('reconciles add/change/remove inventory without changing the pinned effective version', () => {
    const first = importCharacterFromFile(
      profileId,
      writeCard(card('1', [textAgent('Kept', 'v1'), textAgent('Removed', 'old')]))
    )!
    const catalog = new AgentCatalog(profileId)
    const kept = catalog.get('Kept')!
    catalog.edit(kept.id, textAgent('Kept', 'my customization'))

    expect(
      updateCharacterInPlace(
        profileId,
        first.id,
        writeCard(card('2', [textAgent('Kept', 'v2'), textAgent('Added', 'new')]))
      )
    ).not.toBeNull()

    const staged = catalog.get(kept.id)!
    expect(staged.source.version).toBe('1')
    expect(staged.baseline.prompt[0].content).toEqual([{ type: 'text', text: 'v1' }])
    expect(staged.effective.prompt[0].content).toEqual([
      { type: 'text', text: 'my customization' }
    ])
    expect(staged.availableSource?.version).toBe('2')
    expect(catalog.inspectAvailableUpgrade(staged.id)?.changedPaths).toContain(
      'prompt.0.content.0.text'
    )
    expect(catalog.get('Added')).toMatchObject({
      source: { kind: 'card', key: first.id, version: '2' },
      sourcePresent: true
    })

    const removed = catalog.get('Removed')!
    expect(removed.sourcePresent).toBe(false)
    expect(removed.availableSource).toBeNull()
    expect(() => catalog.restore(removed.id)).toThrowError(AgentCatalogError)
    catalog.delete(removed.id)
    expect(catalog.get(removed.id)).toBeNull()
  })

  it('exposes collision inspection and accepts a rename continuation before character writes', () => {
    const catalog = new AgentCatalog(profileId)
    catalog.create(textAgent('Shared', 'user'))
    const file = writeCard(card('1', [textAgent('Shared', 'card')]))

    expect(inspectCharacterAgentImport(profileId, file)).toEqual([
      expect.objectContaining({
        incomingName: 'Shared',
        existing: expect.objectContaining({ name: 'Shared' })
      })
    ])
    expect(importCharacterFromFile(profileId, file)).toBeNull()
    catalog.create(textAgent('Taken Rename', 'user'))
    expect(
      importCharacterFromFile(profileId, file, undefined, {
        agentRenames: { Shared: 'Taken Rename' }
      })
    ).toBeNull()
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM characters WHERE profile_id = ?').get(profileId)
    ).toEqual({ n: 0 })

    const imported = importCharacterFromFile(profileId, file, undefined, {
      agentRenames: { Shared: 'Card Shared' }
    })
    expect(imported).not.toBeNull()
    expect(catalog.get('Card Shared')?.source.key).toBe(imported!.id)
  })

  it('neutralizes an imported card Agent that declares an API preset + model (owner policy)', () => {
    // A card Agent that (out of contract) carries a top-level apiPresetId + model. It must import — with
    // the preset/model neutralized and the model kept only as a display-only modelHint recommendation —
    // rather than failing the whole card at the strict schema boundary.
    const importedCardAgent = {
      format: 'rpt-agent',
      formatVersion: 1,
      name: 'Card Narrator',
      prompt: [{ role: 'system', content: 'narrate' }],
      result: { mode: 'text' },
      apiPresetId: 'card-local-preset',
      model: 'gpt-preview',
      defaults: { maxRetryAttempts: 9 }
    }
    const imported = importCharacterFromFile(profileId, writeCard(card('1', [importedCardAgent])))
    expect(imported).not.toBeNull()

    const agent = new AgentCatalog(profileId).get('Card Narrator')!
    expect(agent.effective).not.toHaveProperty('apiPresetId')
    expect(agent.effective).not.toHaveProperty('model')
    expect(agent.invocationConfig).toEqual({})
    expect(agent.effective.modelHint).toBe('gpt-preview')
    // A legitimate override still rides through.
    expect(agent.effective.defaults.maxRetryAttempts).toBe(9)
  })

  it('reconciles same-card Agents during destructive replace instead of self-colliding', () => {
    const first = importCharacterFromFile(
      profileId,
      writeCard(card('1', [textAgent('Owned', 'v1')]))
    )!

    const replaced = replaceCharacterFromFile(
      profileId,
      first.id,
      writeCard(card('2', [textAgent('Owned', 'v2')]))
    )

    expect(replaced).not.toBeNull()
    expect(replaced!.id).not.toBe(first.id)
    expect(new AgentCatalog(profileId).get('Owned')).toMatchObject({
      source: { kind: 'card', key: replaced!.id }
    })
  })
})
