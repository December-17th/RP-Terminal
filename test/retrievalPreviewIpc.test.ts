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
// A second world whose card declares NO pins — used to prove ad-hoc pins fire an entry on their own.
const PLAIN_CHAR = 'plain'
const PLAIN_BOOK = 'pinbook2'
const PLAIN_CHAT = 'chat-plain'

const handlers = new Map<string, (...args: any[]) => unknown>()
const fakeIpcMain = {
  handle: (ch: string, fn: (...a: any[]) => unknown) => void handlers.set(ch, fn)
} as unknown as IpcMain

const invoke = (
  chatId: string,
  action = '',
  extra?: string[],
  scoring?: Record<string, number>
): RetrievalPreviewResponse =>
  handlers.get('retrieval-preview')!(
    {},
    PROFILE,
    chatId,
    action,
    extra,
    scoring
  ) as RetrievalPreviewResponse

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

  // A lorebook entry keyed on a word that appears ONLY in the pinned variable value, plus a constant
  // entry (always-on) used to exercise the deterministic-scorer PoC output.
  saveLorebookById(
    PROFILE,
    BOOK,
    LorebookSchema.parse({
      name: 'Pin World',
      entries: [
        { keys: ['Zephyros'], content: 'The floating city.', comment: 'City' },
        { constant: true, content: 'Always present.', comment: 'AlwaysOn' }
      ]
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

  // Second world: card declares NO pins; a variable holds a keyword only an ad-hoc pin can surface.
  getDb()
    .prepare(
      'INSERT INTO chats (id, profile_id, character_id, created_at, updated_at, lorebook_ids) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(PLAIN_CHAT, PROFILE, PLAIN_CHAR, now, now, JSON.stringify([PLAIN_BOOK]))
  saveCharacter(PROFILE, PLAIN_CHAR, RPTerminalCardSchema.parse({ data: { name: 'Plain' } }))
  saveLorebookById(
    PROFILE,
    PLAIN_BOOK,
    LorebookSchema.parse({
      name: 'Plain World',
      entries: [{ keys: ['Aeloria'], content: 'The old realm.', comment: 'Realm' }]
    })
  )
  for (let i = 0; i < 2; i++) {
    saveFloor(PROFILE, PLAIN_CHAT, {
      floor: i,
      chat_id: PLAIN_CHAT,
      timestamp: now,
      user_message: { content: i === 0 ? '' : `hi ${i}`, timestamp: now },
      response: { content: `resp ${i}`, model: 'm', provider: i === 0 ? 'greeting' : 'p' },
      events: [],
      variables: i === 1 ? { region: 'Aeloria' } : {}
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

  it('reports the declared pin paths and their resolved values', () => {
    const res = invoke(CHAT)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.pinPaths).toEqual(['location'])
    expect(res.extraPinPaths).toEqual([])
    expect(res.resolvedPins).toEqual([{ path: 'location', value: 'Zephyros' }])
  })

  it('ad-hoc pins fire an entry under RPT but not baseline on a card with no declared pins', () => {
    const res = invoke(PLAIN_CHAT, '', ['region'])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.pinPaths).toEqual([]) // card declares none
    expect(res.extraPinPaths).toEqual(['region'])
    expect(res.resolvedPins).toEqual([{ path: 'region', value: 'Aeloria', adhoc: true }])
    expect(res.pinBlock).toContain('Aeloria')

    const realmRpt = res.rpt.find((r) => r.comment === 'Realm')!
    expect(realmRpt.fired).toBe(true)
    expect(realmRpt.matchedKey).toBe('Aeloria')
    const realmBaseline = res.baseline.find((r) => r.comment === 'Realm')!
    expect(realmBaseline.fired).toBe(false)
  })

  it('combines declared + ad-hoc pins with dedupe (declared paths dropped from extra)', () => {
    // 'location' is declared → removed from extra; the duplicate collapses; 'region' survives.
    const res = invoke(CHAT, '', ['location', 'region', 'location'])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.pinPaths).toEqual(['location'])
    expect(res.extraPinPaths).toEqual(['region'])
    // 'region' is absent from this chat's vars → resolves to nothing; only the declared pin resolves.
    expect(res.resolvedPins).toEqual([{ path: 'location', value: 'Zephyros' }])
  })

  it('returns { ok: false, code: "not-found" } for an unknown chat', () => {
    expect(invoke('no-such-chat')).toEqual({ ok: false, code: 'not-found' })
  })

  it('includes the deterministic-scorer output with default params', () => {
    const res = invoke(CHAT)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(Array.isArray(res.scored)).toBe(true)
    // Defaults are applied when no scoring arg is passed.
    expect(res.scoringParams).toEqual({ lambda: 0.6, hopDecay: 0.5, pinBoost: 2.5, topK: 8 })
    // The constant entry appears fired in the scorer output (and first).
    const always = res.scored.find((r) => r.comment === 'AlwaysOn')!
    expect(always.constant).toBe(true)
    expect(always.fired).toBe(true)
    // The pin-triggered City entry is scored with a pin key hit.
    const city = res.scored.find((r) => r.comment === 'City')!
    expect(city.keyHits.some((h) => h.pin)).toBe(true)
  })

  it('respects a custom scoring arg (topK cap and sanitized params)', () => {
    const res = invoke(CHAT, '', undefined, { topK: 1, lambda: -5 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // topK floored/kept; the negative lambda is rejected and falls back to the default.
    expect(res.scoringParams.topK).toBe(1)
    expect(res.scoringParams.lambda).toBe(0.6)
    // At most one non-constant entry fires under topK=1.
    expect(res.scored.filter((r) => r.fired && !r.constant).length).toBeLessThanOrEqual(1)
  })
})
