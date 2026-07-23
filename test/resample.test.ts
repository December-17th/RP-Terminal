import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'

/**
 * Resample (lore-runtime V8 WP-G1b / ADR 0023): regenerate/swipe on a chat whose Assembly Epoch still
 * matches the last floor's stamp replay the stored `request` byte-for-byte and draw only a new model
 * response — skipping recall, trim, table export, lore match, and assembly. This suite runs the REAL
 * stack (node:sqlite adapter + a tmp data root — the assemblyEpoch idiom) so the central epoch, the
 * per-session floor stamp, the FloorState journal, and Forward Replay are all observable end-to-end.
 * Only the provider is mocked, at the `streamProvider` wire seam, so the exact bytes reaching the API
 * and the abort-with-empty behavior are both drivable.
 */
const DATA_DIR = path.join(os.tmpdir(), `rpt-resample-${randomUUID()}`)

vi.mock('better-sqlite3', () => import('./mocks/betterSqlite3Node'))
vi.mock('../src/main/services/storageService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/storageService')>()
  return { ...actual, getAppDir: () => DATA_DIR }
})

// The provider wire seam both paths funnel through (callModel → streamProvider). Capturing its
// `sendMessages` (arg 2) proves byte equality; aborting the turn from inside it drives abort-with-empty.
const { streamProviderMock, calls } = vi.hoisted(() => ({
  streamProviderMock: vi.fn(),
  calls: [] as unknown[][]
}))
vi.mock('../src/main/services/apiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/apiService')>()
  return { ...actual, streamProvider: streamProviderMock }
})

import { getDb } from '../src/main/services/db'
import * as sessionDbService from '../src/main/services/sessionDbService'
import {
  bumpAssemblyEpoch,
  stampFloorAssemblyEpoch,
  getAssemblyEpoch
} from '../src/main/services/assemblyEpochService'
import { saveFloor, getFloor, getFloorRequest } from '../src/main/services/floorService'
import { floorStateForChat } from '../src/main/services/agentRuntime/floorState'
import { regenerate, generateSwipe, abortGeneration } from '../src/main/services/generationService'
import { initTemplates } from '../src/main/services/templateService'
import type { FloorFile } from '../src/main/types/chat'
import type { ChatMessage } from '../src/main/services/promptBuilder'

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

const PROFILE = 'p-resample'

/** The stored provider prompt seeded on the target floor — a distinctive sentinel so byte equality
 *  (resample re-sent it) vs. reassembly (a fresh prompt was built) is unmistakable. */
const SENTINEL: ChatMessage[] = [
  { role: 'system', content: 'SENTINEL-STORED-PROMPT-DO-NOT-REBUILD' } as ChatMessage,
  { role: 'user', content: 'hi there' } as ChatMessage
]

const ensureProfile = (): void => {
  const now = new Date().toISOString()
  getDb()
    .prepare('INSERT OR IGNORE INTO profiles (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
    .run(PROFILE, 'P', now, now)
}

const insertChar = (characterId = 'char'): void => {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO characters (id, profile_id, card, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET card = excluded.card`
    )
    .run(characterId, PROFILE, JSON.stringify({ data: { name: 'Tester' } }), now)
}

const insertChat = (chatId: string, characterId = 'char'): void => {
  const now = new Date().toISOString()
  ensureProfile()
  insertChar(characterId)
  getDb()
    .prepare(
      'INSERT INTO chats (id, profile_id, character_id, created_at, updated_at, lorebook_ids) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(chatId, PROFILE, characterId, now, now, null)
}

const writeFloor = (chatId: string, floor: FloorFile): void => saveFloor(PROFILE, chatId, floor)

/**
 * Seed a 2-floor chat: floor 0 (greeting, vars {mood:'v0'}) + floor 1 (the regenerate target). The
 * target carries the SENTINEL request, a plot block, and a journaled `'template'` op (mood='built')
 * so Resample has ops to replay and re-journal. Returns after stamping floor 1's epoch to `epoch`.
 */
const seedChat = (
  chatId: string,
  opts: { epoch: number; stampFloor?: number | null; withSwipes?: boolean } = { epoch: 1 }
): void => {
  insertChat(chatId)
  const now = new Date().toISOString()
  writeFloor(chatId, {
    floor: 0,
    chat_id: chatId,
    timestamp: now,
    user_message: { content: '', timestamp: now },
    response: { content: 'Hello.', model: 'm', provider: 'greeting' },
    events: [],
    variables: { mood: 'v0' }
  })
  writeFloor(chatId, {
    floor: 1,
    chat_id: chatId,
    timestamp: now,
    user_message: { content: 'hi there', timestamp: now },
    response: { content: 'orig reply', model: 'm', provider: 'p' },
    ...(opts.withSwipes ? { swipes: ['orig reply', 'alt reply'], swipe_id: 0 } : {}),
    events: [],
    variables: { mood: 'built' },
    request: SENTINEL,
    plot_block: 'PLOT-BLOCK-CARRIED'
  })
  // A build-time template write on floor 1 — Resample must capture and re-journal it.
  floorStateForChat(chatId)!.journal(chatId, 1, 'template', [
    { kind: 'set', path: 'variables.mood', value: 'built' }
  ])
  // Set the chat epoch and stamp floor 1 to match (or not, per opts).
  for (let i = 0; i < opts.epoch; i++) bumpAssemblyEpoch(PROFILE, chatId)
  const stamp = opts.stampFloor === undefined ? opts.epoch : opts.stampFloor
  if (stamp !== null) stampFloorAssemblyEpoch(chatId, 1, stamp)
}

beforeAll(async () => {
  await initTemplates()
})

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  streamProviderMock.mockImplementation(
    async (
      _settings: unknown,
      messages: unknown,
      _params: unknown,
      onDelta: (d: string) => void
    ): Promise<string> => {
      calls.push(messages as unknown[])
      onDelta('A brand new reply.')
      return 'A brand new reply.'
    }
  )
})

describe('Resample — clean epoch', () => {
  it('regenerate re-sends the stored request bytes verbatim and persists them', async () => {
    seedChat('rs-bytes', { epoch: 2 })
    const fresh = await regenerate(PROFILE, 'rs-bytes')

    expect(fresh).not.toBeNull()
    // Exactly one provider call (recall/assembly skipped), and it received the stored bytes.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(SENTINEL)
    // The replacement floor stores the same request bytes.
    expect(getFloorRequest(PROFILE, 'rs-bytes', 1)).toEqual(SENTINEL)
    expect(fresh!.response.content).toBe('A brand new reply.')
  })

  it('re-journals the captured template op and Forward Replay reproduces live variables', async () => {
    seedChat('rs-parity', { epoch: 1 })
    const fresh = await regenerate(PROFILE, 'rs-parity')
    expect(fresh).not.toBeNull()

    // The build-time write survived onto the replacement floor's live variables.
    expect((fresh!.variables as Record<string, unknown>).mood).toBe('built')

    // Forward Replay of floor 1 (seeded from floor 0's stored vars) reproduces the same variables —
    // it can only do so if the 'template' op was re-journaled pre-fold on the replacement floor.
    const snaps = floorStateForChat('rs-parity')!.replay('rs-parity', 1)
    const replayed = snaps.find((s) => s.floor === 1)!.variables
    expect(replayed).toEqual(fresh!.variables)
    expect((replayed as Record<string, unknown>).mood).toBe('built')
  })

  it('carries the plot block onto the replacement floor', async () => {
    seedChat('rs-plot', { epoch: 1 })
    const fresh = await regenerate(PROFILE, 'rs-plot')
    expect(fresh).not.toBeNull()
    expect(fresh!.plot_block).toBe('PLOT-BLOCK-CARRIED')
    expect(getFloor(PROFILE, 'rs-plot', 1)!.plot_block).toBe('PLOT-BLOCK-CARRIED')
  })

  it('swipe preserves the prior alternates and appends the new active response', async () => {
    seedChat('rs-swipe', { epoch: 1, withSwipes: true })
    const fresh = await generateSwipe(PROFILE, 'rs-swipe')

    expect(fresh).not.toBeNull()
    expect(calls[0]).toEqual(SENTINEL) // still a byte-replay
    expect(fresh!.swipes).toEqual(['orig reply', 'alt reply', 'A brand new reply.'])
    expect(fresh!.swipe_id).toBe(2)
    expect(fresh!.response.content).toBe('A brand new reply.')
  })

  it('swipe abort-with-empty restores the original floor (loses nothing)', async () => {
    seedChat('rs-swipe-abort', { epoch: 1, withSwipes: true })
    streamProviderMock.mockImplementationOnce(async (): Promise<string> => {
      // Abort this chat's turn and return empty → abort-with-empty (callModel returns null).
      abortGeneration('rs-swipe-abort')
      return ''
    })
    const fresh = await generateSwipe(PROFILE, 'rs-swipe-abort')

    expect(fresh).not.toBeNull()
    // Restored: original active response and its prior alternates are intact.
    expect(fresh!.response.content).toBe('orig reply')
    expect(fresh!.swipes).toEqual(['orig reply', 'alt reply'])
    expect(getFloor(PROFILE, 'rs-swipe-abort', 1)!.response.content).toBe('orig reply')
  })

  it('regenerate abort-with-empty leaves the floor cut (matches today’s regenerate behavior)', async () => {
    seedChat('rs-regen-abort', { epoch: 1 })
    streamProviderMock.mockImplementationOnce(async (): Promise<string> => {
      abortGeneration('rs-regen-abort')
      return ''
    })
    const fresh = await regenerate(PROFILE, 'rs-regen-abort')

    expect(fresh).toBeNull()
    // Floor 1 was cut and never re-persisted — the chat is left with only the greeting.
    expect(getFloor(PROFILE, 'rs-regen-abort', 1)).toBeNull()
    expect(getFloor(PROFILE, 'rs-regen-abort', 0)).not.toBeNull()
  })
})

describe('Resample — falls back to full reassembly', () => {
  const sentSentinel = (): boolean =>
    calls.some((c) => JSON.stringify(c) === JSON.stringify(SENTINEL))

  it('NULL floor epoch (legacy floor) → full path, stored bytes NOT re-sent', async () => {
    seedChat('rs-null', { epoch: 1, stampFloor: null })
    const fresh = await regenerate(PROFILE, 'rs-null')

    expect(fresh).not.toBeNull()
    // The full path reassembled a fresh prompt — the sentinel was never sent, and the new floor's
    // stored request is a freshly-built prompt, not the sentinel.
    expect(sentSentinel()).toBe(false)
    expect(getFloorRequest(PROFILE, 'rs-null', 1)).not.toEqual(SENTINEL)
  })

  it('epoch mismatch (an edit bumped the chat after the floor was stamped) → full path', async () => {
    // Floor stamped at 1, but a later edit bumped the chat epoch to 2.
    seedChat('rs-mismatch', { epoch: 1, stampFloor: 1 })
    bumpAssemblyEpoch(PROFILE, 'rs-mismatch')
    expect(getAssemblyEpoch(PROFILE, 'rs-mismatch')).toBe(2)

    const fresh = await regenerate(PROFILE, 'rs-mismatch')
    expect(fresh).not.toBeNull()
    expect(sentSentinel()).toBe(false)
    expect(getFloorRequest(PROFILE, 'rs-mismatch', 1)).not.toEqual(SENTINEL)
  })
})

describe('Resample — guards', () => {
  it('regenerate on the opening greeting still refuses', async () => {
    insertChat('rs-greeting')
    const now = new Date().toISOString()
    writeFloor('rs-greeting', {
      floor: 0,
      chat_id: 'rs-greeting',
      timestamp: now,
      user_message: { content: '', timestamp: now },
      response: { content: 'Hello.', model: 'm', provider: 'greeting' },
      events: [],
      variables: {}
    })
    await expect(regenerate(PROFILE, 'rs-greeting')).rejects.toThrow(/opening greeting/)
  })
})
