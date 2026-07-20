import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Execution-plan M5b2, task A — the one-time settings SEED that re-homes the OLD workflow-doc memory
// group settings (cadence / mode-off / API preset) onto the built-in Memory Maintenance Agent, once per
// pre-existing profile, keyed by the `profiles.memory_settings_seeded` marker. The four required cases:
// (1) doc customized + Agent untouched → seeded; (2) Agent already customized → untouched; (3) fresh
// profile with no memory doc → marker set, nothing copied; (4) re-run → no-op.

let tmp: string
vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))
vi.mock('../../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})

import { closeDb, getDb } from '../../src/main/services/db'
import { AgentCatalog } from '../../src/main/services/agentRuntime/catalog'
import { seedMemoryMaintenanceSettings } from '../../src/main/services/memoryMaintenanceSettingsSeed'
import { MEMORY_MAINTENANCE_AGENT_NAME } from '../../src/main/services/agentRuntime/memoryMaintenanceSlot'

/** Insert a pre-existing profile with the seed marker UNSET (0) — the pre-M5b2 profile shape. */
const preExistingProfile = (id: string): void => {
  getDb()
    .prepare(
      'INSERT INTO profiles (id, name, created_at, last_active, memory_settings_seeded) VALUES (?, ?, ?, ?, 0)'
    )
    .run(id, id, 'now', 'now')
}

/** Write a memory-group doc to the profile's workflows dir with the given exposed group settings. */
const writeMemoryDoc = (
  profileId: string,
  settings: { everyNFloors?: number; mode?: string; apiPresetId?: string }
): void => {
  const dir = path.join(tmp, 'profiles', profileId, 'workflows')
  fs.mkdirSync(dir, { recursive: true })
  const doc = {
    id: 'default-memory',
    name: 'Default',
    nodes: [
      { id: 'trigger-cadence', type: 'trigger.cadence', config: { everyNFloors: settings.everyNFloors ?? 3 } },
      { id: 'mode', type: 'control.mode', config: { selected: settings.mode ?? 'every_turn' } },
      { id: 'maintain', type: 'memory.maintain', config: { api_preset_id: settings.apiPresetId ?? '' } }
    ]
  }
  fs.writeFileSync(path.join(dir, 'default-memory.json'), JSON.stringify(doc), 'utf-8')
}

const marker = (id: string): number =>
  (getDb().prepare('SELECT memory_settings_seeded AS m FROM profiles WHERE id = ?').get(id) as { m: number }).m

const memoryAgent = (id: string) => new AgentCatalog(id).get(MEMORY_MAINTENANCE_AGENT_NAME)!

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-mem-seed-'))
})

afterEach(() => {
  closeDb()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('seedMemoryMaintenanceSettings', () => {
  it('(1) copies the OLD doc-group settings onto a pristine Agent, then marks the profile seeded', () => {
    preExistingProfile('p')
    writeMemoryDoc('p', { everyNFloors: 7, mode: 'off', apiPresetId: 'preset-9' })

    seedMemoryMaintenanceSettings('p')

    const agent = memoryAgent('p')
    expect(agent.effective.trigger?.onFloorCommitted?.everyNFloors).toBe(7)
    expect(agent.enabled).toBe(false) // mode 'off' → disabled
    expect(agent.invocationConfig).toEqual({ apiPresetId: 'preset-9' })
    expect(marker('p')).toBe(1)
  })

  it('(2) does NOT overwrite an Agent the user already customized — just marks it seeded', () => {
    preExistingProfile('p')
    writeMemoryDoc('p', { everyNFloors: 7, mode: 'off', apiPresetId: 'preset-9' })
    // A prior user edit (description change) → a customization exists.
    const before = memoryAgent('p')
    new AgentCatalog('p').edit(before.id, { ...before.effective, description: 'user-edited' })

    seedMemoryMaintenanceSettings('p')

    const agent = memoryAgent('p')
    expect(agent.customized).toBe(true)
    expect(agent.effective.description).toBe('user-edited')
    // The default cadence (3), enabled, and empty invocation config are all untouched by the seed.
    expect(agent.effective.trigger?.onFloorCommitted?.everyNFloors).toBe(3)
    expect(agent.enabled).toBe(true)
    expect(agent.invocationConfig).toEqual({})
    expect(marker('p')).toBe(1)
  })

  it('(3) a fresh profile with no memory doc: marker set, nothing copied', () => {
    preExistingProfile('p')
    // No workflows dir at all.
    seedMemoryMaintenanceSettings('p')

    const agent = memoryAgent('p')
    expect(agent.effective.trigger?.onFloorCommitted?.everyNFloors).toBe(3)
    expect(agent.enabled).toBe(true)
    expect(agent.invocationConfig).toEqual({})
    expect(marker('p')).toBe(1)
  })

  it('(4) re-running after a seed is a no-op (does not re-read or re-copy)', () => {
    preExistingProfile('p')
    writeMemoryDoc('p', { everyNFloors: 7, mode: 'off', apiPresetId: 'preset-9' })
    seedMemoryMaintenanceSettings('p')

    // Change the doc AFTER the first seed; a re-run must ignore it (marker already 1).
    writeMemoryDoc('p', { everyNFloors: 12, mode: 'every_turn', apiPresetId: 'preset-other' })
    seedMemoryMaintenanceSettings('p')

    const agent = memoryAgent('p')
    expect(agent.effective.trigger?.onFloorCommitted?.everyNFloors).toBe(7)
    expect(agent.enabled).toBe(false)
    expect(agent.invocationConfig).toEqual({ apiPresetId: 'preset-9' })
    expect(marker('p')).toBe(1)
  })

  it('copies only the non-default values that are present (cadence only)', () => {
    preExistingProfile('p')
    writeMemoryDoc('p', { everyNFloors: 5, mode: 'every_turn' })

    seedMemoryMaintenanceSettings('p')

    const agent = memoryAgent('p')
    expect(agent.effective.trigger?.onFloorCommitted?.everyNFloors).toBe(5)
    expect(agent.enabled).toBe(true) // mode not 'off'
    expect(agent.invocationConfig).toEqual({}) // no api preset in the doc
  })
})
