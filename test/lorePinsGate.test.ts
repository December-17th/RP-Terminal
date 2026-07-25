import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'

/**
 * Context pins are APP-GATED (`settings.lorebook.context_pins`, default OFF). A card declaring
 * `pin_paths` must not be able to widen what the lore matcher sees on its own — with the flag off,
 * production retrieval stays exactly ST's keyword scan over conversation text.
 *
 * Runs the REAL stack (node:sqlite adapter + a tmp data root — the assemblyEpoch/retrievalPreview
 * idiom) so `buildGenContext` executes end-to-end and the assertion is about the scan text a real
 * turn would match against, not about `buildPinBlock` in isolation (that is `lorePins.test.ts`).
 */
const DATA_DIR = path.join(os.tmpdir(), `rpt-lore-pins-gate-${randomUUID()}`)

vi.mock('better-sqlite3', () => import('./mocks/betterSqlite3Node'))
vi.mock('../src/main/services/storageService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/storageService')>()
  return { ...actual, getAppDir: () => DATA_DIR }
})

import { getDb } from '../src/main/services/db'
import * as sessionDbService from '../src/main/services/sessionDbService'
import { saveFloor } from '../src/main/services/floorService'
import { saveCharacter } from '../src/main/services/characterService'
import { saveLorebookById } from '../src/main/services/lorebookService'
import { getSettings, saveSettings } from '../src/main/services/settingsService'
import { buildGenContext } from '../src/main/services/generation/genContext'
import { RPTerminalCardSchema, LorebookSchema } from '../src/main/types/character'

const PROFILE = 'p-pins-gate'
const CHAR = 'hero'
const BOOK = 'gatebook'
const CHAT = 'chat-gate'

/** Flip the app-level pin gate, preserving the rest of the profile's settings. */
const setPinGate = (on: boolean): void => {
  const settings = getSettings(PROFILE)
  saveSettings(PROFILE, {
    ...settings,
    lorebook: { ...settings.lorebook, context_pins: on }
  })
}

beforeAll(() => {
  const now = new Date().toISOString()
  getDb()
    .prepare('INSERT OR IGNORE INTO profiles (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
    .run(PROFILE, 'P', now, now)
  getDb()
    .prepare(
      'INSERT INTO chats (id, profile_id, character_id, created_at, updated_at, lorebook_ids) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(CHAT, PROFILE, CHAR, now, now, JSON.stringify([BOOK]))

  saveCharacter(
    PROFILE,
    CHAR,
    RPTerminalCardSchema.parse({
      data: { name: 'Hero', extensions: { rp_terminal: { pin_paths: ['location'] } } }
    })
  )
  saveLorebookById(
    PROFILE,
    BOOK,
    LorebookSchema.parse({ name: 'B', entries: [{ keys: ['王都'], content: 'Capital lore.' }] })
  )
  // One floor whose variables carry the pinned value; the conversation text never names it.
  saveFloor(PROFILE, CHAT, {
    floor: 0,
    chat_id: CHAT,
    timestamp: now,
    user_message: { content: 'We keep walking.', timestamp: now },
    response: { content: 'The road stretches on.', model: 'm', provider: 'openai' },
    events: [],
    variables: { location: '王都' }
  } as never)
  getDb().prepare('UPDATE chats SET floor_count = 1 WHERE id = ?').run(CHAT)
})

afterAll(() => {
  sessionDbService.closeAllSessionDbs?.()
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* best-effort tmp cleanup */
  }
})

describe('context pins are app-gated (default OFF)', () => {
  it('by default the scan text carries NO pin block — pure ST keyword retrieval', () => {
    setPinGate(false)
    const ctx = buildGenContext(PROFILE, CHAT, 'What now?')
    expect(ctx.scanText).not.toContain('[PINS]')
    // The card DOES declare a pin and the value IS resolvable — the gate is what suppresses it.
    expect(ctx.card.data.extensions.rp_terminal?.pin_paths).toEqual(['location'])
    expect(ctx.workingVars.location).toBe('王都')
    expect(ctx.scanText).not.toContain('王都')
  })

  it('enabling the setting appends the pin block a card declared', () => {
    setPinGate(true)
    const ctx = buildGenContext(PROFILE, CHAT, 'What now?')
    expect(ctx.scanText).toContain('[PINS] location: 王都')
  })

  it('the gate is what changes: scan text with pins off equals the no-pin baseline byte-for-byte', () => {
    setPinGate(true)
    const on = buildGenContext(PROFILE, CHAT, 'What now?').scanText
    setPinGate(false)
    const off = buildGenContext(PROFILE, CHAT, 'What now?').scanText
    expect(on).toBe(off + '\n[PINS] location: 王都')
  })

  it('buildGenContext stamps the chat’s CURRENT assembly epoch onto the context', () => {
    setPinGate(false)
    // saveSettings bumps every chat in the profile (ADR 0023), so the epoch is non-zero by now.
    const ctx = buildGenContext(PROFILE, CHAT, '')
    const row = getDb()
      .prepare('SELECT assembly_epoch FROM chats WHERE id = ?')
      .get(CHAT) as { assembly_epoch: number | null }
    expect(ctx.assemblyEpoch).toBe(row.assembly_epoch ?? 0)
  })
})
