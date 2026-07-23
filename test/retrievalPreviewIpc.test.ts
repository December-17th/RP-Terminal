import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import type { IpcMain } from 'electron'

/**
 * WP-D2 — the `retrieval-preview` IPC: a side-effect-free dry-run of lorebook retrieval. This runs the
 * REAL stack (node:sqlite adapter + a tmp data root — the assemblyEpoch idiom) so buildGenContext, the
 * pin block, and the traced matcher all execute end-to-end. It pins the pin-vs-baseline contrast (a
 * keyword present ONLY in a pinned variable fires under RPT but not the ST-keyword baseline) and the
 * not-found path. The Debug window service is mocked so no BrowserWindow is touched.
 */
const DATA_DIR = path.join(os.tmpdir(), `rpt-retrieval-preview-${randomUUID()}`)

vi.mock('better-sqlite3', () => import('./mocks/betterSqlite3Node'))
vi.mock('../src/main/services/storageService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/storageService')>()
  return { ...actual, getAppDir: () => DATA_DIR }
})
vi.mock('../src/main/services/debugWindowService', () => ({ openDebugWindow: vi.fn() }))

import { getDb } from '../src/main/services/db'
import * as sessionDbService from '../src/main/services/sessionDbService'
import { saveFloor } from '../src/main/services/floorService'
import { saveCharacter } from '../src/main/services/characterService'
import { saveLorebookById } from '../src/main/services/lorebookService'
import { registerDebugIpc } from '../src/main/ipc/debugIpc'
import { RPTerminalCardSchema, LorebookSchema } from '../src/main/types/character'
import type { RetrievalPreviewResponse } from '../src/shared/retrievalTrace'

const PROFILE = 'p-retrieval'
const CHAR = 'hero'
const BOOK = 'pinbook'
const CHAT = 'chat-pin'

const handlers = new Map<string, (...args: any[]) => unknown>()
const fakeIpcMain = {
  handle: (ch: string, fn: (...a: any[]) => unknown) => void handlers.set(ch, fn)
} as unknown as IpcMain

const invoke = (chatId: string, action = ''): RetrievalPreviewResponse =>
  handlers.get('retrieval-preview')!({}, PROFILE, chatId, action) as RetrievalPreviewResponse

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

  // Card carries a context pin on `location`.
  saveCharacter(
    PROFILE,
    CHAR,
    RPTerminalCardSchema.parse({
      data: { name: 'Hero', extensions: { rp_terminal: { pin_paths: ['location'] } } }
    })
  )

  // A lorebook entry keyed on a word that appears ONLY in the pinned variable value.
  saveLorebookById(
    PROFILE,
    BOOK,
    LorebookSchema.parse({
      name: 'Pin World',
      entries: [{ keys: ['Zephyros'], content: 'The floating city.', comment: 'City' }]
    })
  )

  // Three floors; the latest carries the pinned variable. None of the message text names 'Zephyros'.
  for (let i = 0; i < 3; i++) {
    saveFloor(PROFILE, CHAT, {
      floor: i,
      chat_id: CHAT,
      timestamp: now,
      user_message: { content: i === 0 ? '' : `hello ${i}`, timestamp: now },
      response: { content: `reply ${i}`, model: 'm', provider: i === 0 ? 'greeting' : 'p' },
      events: [],
      variables: i === 2 ? { location: 'Zephyros' } : {}
    })
  }

  registerDebugIpc(fakeIpcMain)
})

afterAll(() => {
  try {
    sessionDbService.closeAll()
  } catch {
    /* ignore */
  }
  try {
    ;(getDb() as unknown as { close: () => void }).close()
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* best-effort temp cleanup */
  }
})

describe('retrieval-preview IPC', () => {
  it('registers the retrieval-preview handler', () => {
    expect(handlers.has('retrieval-preview')).toBe(true)
  })

  it('fires a pin-triggered entry under RPT but not under the ST-keyword baseline', () => {
    const res = invoke(CHAT)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // The pin block carries the keyword; the base scan text does not.
    expect(res.pinBlock).toContain('[PINS]')
    expect(res.pinBlock).toContain('Zephyros')
    expect(res.baseScanText).not.toContain('Zephyros')
    expect(res.lorebookNames).toEqual(['Pin World'])

    const cityRpt = res.rpt.find((r) => r.comment === 'City')!
    expect(cityRpt.fired).toBe(true)
    expect(cityRpt.reason).toBe('key')
    expect(cityRpt.matchedKey).toBe('Zephyros')

    const cityBaseline = res.baseline.find((r) => r.comment === 'City')!
    expect(cityBaseline.fired).toBe(false)
    expect(cityBaseline.reason).toBe('none')
  })

  it('returns { ok: false, code: "not-found" } for an unknown chat', () => {
    expect(invoke('no-such-chat')).toEqual({ ok: false, code: 'not-found' })
  })
})
