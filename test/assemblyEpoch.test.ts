import { describe, it, expect, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'

/**
 * Assembly Epoch (lore-runtime V8 WP-G1 / ADR 0023): a persisted per-chat counter bumped by any
 * assembly-relevant edit, with each floor stamping the epoch it was assembled under. This suite runs
 * the REAL stack (node:sqlite adapter + a tmp data root — the chatSessionListing idiom) so the central
 * `chats` epoch column and the per-session `floors` stamp are both observable end-to-end. It pins the
 * accessors, every bump call site (and the deliberate NON-bumps: latest-floor edits, truncation), and
 * the persistFloor stamp. The Resample consumer that reads the epoch is a separate WP and not tested here.
 */
const DATA_DIR = path.join(os.tmpdir(), `rpt-assembly-epoch-${randomUUID()}`)

vi.mock('better-sqlite3', () => import('./mocks/betterSqlite3Node'))
vi.mock('../src/main/services/storageService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/storageService')>()
  return { ...actual, getAppDir: () => DATA_DIR }
})

import { getDb } from '../src/main/services/db'
import * as sessionDbService from '../src/main/services/sessionDbService'
import {
  getAssemblyEpoch,
  bumpAssemblyEpoch,
  bumpAssemblyEpochForLorebook,
  bumpAssemblyEpochForCharacter,
  bumpAllAssemblyEpochs,
  stampFloorAssemblyEpoch,
  getFloorAssemblyEpoch
} from '../src/main/services/assemblyEpochService'
import {
  saveFloor,
  updateFloorFields,
  addSwipe,
  setActiveSwipe
} from '../src/main/services/floorService'
import { applyVariableOps } from '../src/main/services/generation/varsWrite'
import { setChatLorebookIds, setChatMode, setVnMode, truncateFloors } from '../src/main/services/chatService'
import { setFloorStatData } from '../src/main/services/generationService'
import { saveChat } from '../src/main/services/chatWriteService'
import { saveLorebookById } from '../src/main/services/lorebookService'
import { savePreset } from '../src/main/services/presetService'
import { saveSettings } from '../src/main/services/settingsService'
import { persistFloor } from '../src/main/services/generation/persistFloor'
import type { GenContext } from '../src/main/services/generation/types'
import type { FloorFile } from '../src/main/types/chat'
import type { Preset } from '../src/main/types/preset'
import type { Settings } from '../src/main/types/models'

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

const PROFILE = 'p-epoch'

const ensureProfile = (profileId = PROFILE): void => {
  const now = new Date().toISOString()
  getDb()
    .prepare('INSERT OR IGNORE INTO profiles (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
    .run(profileId, 'P', now, now)
}

const insertChat = (
  chatId: string,
  opts: { profileId?: string; characterId?: string; lorebookIds?: string[] | null } = {}
): void => {
  const now = new Date().toISOString()
  const profileId = opts.profileId ?? PROFILE
  ensureProfile(profileId)
  getDb()
    .prepare(
      'INSERT INTO chats (id, profile_id, character_id, created_at, updated_at, lorebook_ids) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      chatId,
      profileId,
      opts.characterId ?? 'char',
      now,
      now,
      opts.lorebookIds === undefined || opts.lorebookIds === null
        ? null
        : JSON.stringify(opts.lorebookIds)
    )
}

const writeFloor = (chatId: string, floor: number, response = `r${floor}`): void =>
  saveFloor(PROFILE, chatId, {
    floor,
    chat_id: chatId,
    timestamp: new Date().toISOString(),
    user_message: { content: floor === 0 ? '' : `u${floor}`, timestamp: new Date().toISOString() },
    response: { content: response, model: 'm', provider: floor === 0 ? 'greeting' : 'p' },
    events: [],
    variables: {}
  })

/** A 3-floor chat: floor 0 (greeting) + floors 1..2 (real turns); latest floor index = 2. */
const seedChat = (chatId: string, floors = 3): void => {
  insertChat(chatId)
  for (let i = 0; i < floors; i++) writeFloor(chatId, i)
}

describe('assemblyEpochService — accessors', () => {
  it('reads 0 for a fresh chat (NULL column) and increments on bump, scoped to (profile, chat)', () => {
    insertChat('acc-a')
    insertChat('acc-b')
    expect(getAssemblyEpoch(PROFILE, 'acc-a')).toBe(0)
    bumpAssemblyEpoch(PROFILE, 'acc-a')
    bumpAssemblyEpoch(PROFILE, 'acc-a')
    expect(getAssemblyEpoch(PROFILE, 'acc-a')).toBe(2)
    // Untouched sibling stays at 0 — the bump is per-chat.
    expect(getAssemblyEpoch(PROFILE, 'acc-b')).toBe(0)
  })

  it('bumpForCharacter bumps only that character’s chats', () => {
    insertChat('char-x1', { characterId: 'cx' })
    insertChat('char-x2', { characterId: 'cx' })
    insertChat('char-y', { characterId: 'cy' })
    bumpAssemblyEpochForCharacter(PROFILE, 'cx')
    expect(getAssemblyEpoch(PROFILE, 'char-x1')).toBe(1)
    expect(getAssemblyEpoch(PROFILE, 'char-x2')).toBe(1)
    expect(getAssemblyEpoch(PROFILE, 'char-y')).toBe(0)
  })

  it('bumpForLorebook hits explicit-selection chats AND default-selection chats on the embedded book', () => {
    // Selection explicitly lists bookA (character unrelated).
    insertChat('lb-sel', { characterId: 'other', lorebookIds: ['bookA'] })
    // Default selection (null) whose character IS bookA → embedded book (id == characterId).
    insertChat('lb-default', { characterId: 'bookA', lorebookIds: null })
    // Selection lists a different book.
    insertChat('lb-otherbook', { characterId: 'other', lorebookIds: ['bookB'] })
    // Default selection on a different character.
    insertChat('lb-otherchar', { characterId: 'other', lorebookIds: null })
    bumpAssemblyEpochForLorebook(PROFILE, 'bookA')
    expect(getAssemblyEpoch(PROFILE, 'lb-sel')).toBe(1)
    expect(getAssemblyEpoch(PROFILE, 'lb-default')).toBe(1)
    expect(getAssemblyEpoch(PROFILE, 'lb-otherbook')).toBe(0)
    expect(getAssemblyEpoch(PROFILE, 'lb-otherchar')).toBe(0)
  })

  it('bumpAll bumps every chat in the profile and no other profile', () => {
    insertChat('all-1')
    insertChat('all-2')
    insertChat('all-other', { profileId: 'p-other' })
    bumpAllAssemblyEpochs(PROFILE)
    expect(getAssemblyEpoch(PROFILE, 'all-1')).toBe(1)
    expect(getAssemblyEpoch(PROFILE, 'all-2')).toBe(1)
    expect(getAssemblyEpoch('p-other', 'all-other')).toBe(0)
  })

  it('stamps and reads a floor epoch; an unstamped floor reads null', () => {
    seedChat('stamp-c')
    expect(getFloorAssemblyEpoch('stamp-c', 1)).toBeNull()
    stampFloorAssemblyEpoch('stamp-c', 1, 4)
    expect(getFloorAssemblyEpoch('stamp-c', 1)).toBe(4)
  })
})

describe('assemblyEpochService — transcript/variable edit call sites', () => {
  it('bumps on an in-place text edit BELOW the latest floor, not on the latest floor', () => {
    seedChat('edit-below')
    updateFloorFields(PROFILE, 'edit-below', 1, null, 'edited response')
    expect(getAssemblyEpoch(PROFILE, 'edit-below')).toBe(1)

    seedChat('edit-latest')
    updateFloorFields(PROFILE, 'edit-latest', 2, null, 'edited latest')
    expect(getAssemblyEpoch(PROFILE, 'edit-latest')).toBe(0)
  })

  it('bumps on a swipe append below the latest floor, not on the latest floor', () => {
    seedChat('swipe-below')
    addSwipe(PROFILE, 'swipe-below', 1, 'alt for floor 1')
    expect(getAssemblyEpoch(PROFILE, 'swipe-below')).toBe(1)

    seedChat('swipe-latest')
    addSwipe(PROFILE, 'swipe-latest', 2, 'alt for latest')
    expect(getAssemblyEpoch(PROFILE, 'swipe-latest')).toBe(0)
  })

  it('bumps on a user variable edit below the latest floor, not on the latest floor', () => {
    seedChat('var-below')
    setFloorStatData(PROFILE, 'var-below', 1, { gold: 5 })
    expect(getAssemblyEpoch(PROFILE, 'var-below')).toBe(1)

    seedChat('var-latest')
    setFloorStatData(PROFILE, 'var-latest', 2, { gold: 9 })
    expect(getAssemblyEpoch(PROFILE, 'var-latest')).toBe(0)
  })

  it('bumps on a panel/card variable write (applyVariableOps) below the latest floor, not the latest', () => {
    seedChat('ops-below')
    applyVariableOps(PROFILE, 'ops-below', 1, [{ op: 'add', path: '/gold', value: 7 } as never])
    expect(getAssemblyEpoch(PROFILE, 'ops-below')).toBe(1)

    seedChat('ops-latest')
    applyVariableOps(PROFILE, 'ops-latest', 2, [{ op: 'add', path: '/gold', value: 7 } as never])
    expect(getAssemblyEpoch(PROFILE, 'ops-latest')).toBe(0)
  })

  it('does NOT bump when switching swipes on the LATEST floor (browse-then-swipe stays a Resample)', () => {
    seedChat('swipe-switch-latest')
    // Add a 2nd alternate on the latest floor, then switch the active swipe back and forth — all on the
    // latest floor, so none of it invalidates a stored prompt.
    addSwipe(PROFILE, 'swipe-switch-latest', 2, 'alt A')
    setActiveSwipe(PROFILE, 'swipe-switch-latest', 2, 0)
    setActiveSwipe(PROFILE, 'swipe-switch-latest', 2, 1)
    expect(getAssemblyEpoch(PROFILE, 'swipe-switch-latest')).toBe(0)
  })

  it('bumps when a card save (saveChat) changes a floor below the latest, not the latest only', () => {
    seedChat('card-below')
    // assistant[i] maps to floor i in order; change floor 1's response (below latest 2).
    saveChat(PROFILE, 'card-below', [
      { is_user: false, mes: 'r0' },
      { is_user: false, mes: 'changed-1' },
      { is_user: false, mes: 'r2' }
    ])
    expect(getAssemblyEpoch(PROFILE, 'card-below')).toBe(1)

    seedChat('card-latest')
    saveChat(PROFILE, 'card-latest', [
      { is_user: false, mes: 'r0' },
      { is_user: false, mes: 'r1' },
      { is_user: false, mes: 'changed-2' }
    ])
    expect(getAssemblyEpoch(PROFILE, 'card-latest')).toBe(0)
  })

  it('does NOT bump on a truncation (the surviving floors’ prompts are unaffected)', () => {
    seedChat('cut-c')
    truncateFloors(PROFILE, 'cut-c', 1)
    expect(getAssemblyEpoch(PROFILE, 'cut-c')).toBe(0)
  })
})

describe('assemblyEpochService — selection / config / library call sites', () => {
  it('bumps on lorebook selection, FSM mode, and VN mode changes', () => {
    insertChat('cfg-lore')
    setChatLorebookIds(PROFILE, 'cfg-lore', ['bookZ'])
    expect(getAssemblyEpoch(PROFILE, 'cfg-lore')).toBe(1)

    insertChat('cfg-mode')
    setChatMode(PROFILE, 'cfg-mode', 'combat')
    expect(getAssemblyEpoch(PROFILE, 'cfg-mode')).toBe(1)

    insertChat('cfg-vn')
    setVnMode(PROFILE, 'cfg-vn', true)
    expect(getAssemblyEpoch(PROFILE, 'cfg-vn')).toBe(1)
  })

  it('bumps referencing chats when the lorebook is saved', () => {
    insertChat('save-lb', { characterId: 'other', lorebookIds: ['book-saved'] })
    insertChat('save-lb-unrelated', { characterId: 'other', lorebookIds: ['book-x'] })
    saveLorebookById(PROFILE, 'book-saved', { name: 'B', entries: [] } as never)
    expect(getAssemblyEpoch(PROFILE, 'save-lb')).toBe(1)
    expect(getAssemblyEpoch(PROFILE, 'save-lb-unrelated')).toBe(0)
  })

  it('bumps all chats when a preset is saved', () => {
    insertChat('preset-1')
    insertChat('preset-2')
    const preset: Preset = { name: 'P', parameters: { temperature: 0.9, max_tokens: 100 }, prompts: [] }
    savePreset(PROFILE, 'some-preset', preset)
    expect(getAssemblyEpoch(PROFILE, 'preset-1')).toBe(1)
    expect(getAssemblyEpoch(PROFILE, 'preset-2')).toBe(1)
  })

  it('bumps all chats when settings are saved', () => {
    insertChat('settings-1')
    insertChat('settings-2')
    saveSettings(PROFILE, {
      api: { api_key: '' },
      active_api_preset_id: 'x',
      api_presets: [],
      logs: {}
    } as unknown as Settings)
    expect(getAssemblyEpoch(PROFILE, 'settings-1')).toBe(1)
    expect(getAssemblyEpoch(PROFILE, 'settings-2')).toBe(1)
  })
})

describe('persistFloor — stamps the current epoch', () => {
  it('stamps the new floor with the chat’s epoch at persist time', () => {
    insertChat('persist-c')
    bumpAssemblyEpoch(PROFILE, 'persist-c')
    bumpAssemblyEpoch(PROFILE, 'persist-c')
    bumpAssemblyEpoch(PROFILE, 'persist-c') // epoch = 3
    const ctx = {
      profileId: PROFILE,
      chatId: 'persist-c',
      userAction: 'hi',
      chat: { floor_count: 0 },
      settings: { api: { model: 'm', provider: 'openai' } },
      globals: {}
    } as unknown as GenContext
    persistFloor(ctx, {
      userAction: 'hi',
      raw: 'reply',
      sendMessages: [{ role: 'user', content: 'hi' }] as unknown as FloorFile['request'],
      events: [],
      variables: {},
      metrics: {} as never
    })
    expect(getFloorAssemblyEpoch('persist-c', 0)).toBe(3)
  })
})
