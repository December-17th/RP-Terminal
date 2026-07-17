// test/yuzu/fixture-card.test.ts
//
// Project Yuzu WP-Y2 — the synthetic fixture CARD is the test substrate for all later yuzu WPs.
// This drives the REAL card-import path (`importCharacterFromFile`) on `test/yuzu/fixture-card/card.json`
// into a temp profile and asserts the whole substrate is wired end-to-end:
//   - the character row exists and `getCharacter` returns the card with the `yuzu` extension block intact
//     (opening string non-empty) — i.e. `data.extensions.rp_terminal.yuzu` survives schema import untouched;
//   - the embedded character_book landed in the lorebook store under id == characterId (how embedded books
//     get their id — see lorebookService.saveCharacterLorebook);
//   - assets installed against that lorebook id (via the real `importAssetsZip` surface, zipping the
//     fixture `assets/` dir) are indexed by `getIndex` (sprites/backgrounds/CG);
//   - the InitVar block seeds floor-0 `stat_data` through the real session-create path (`createChat`,
//     which calls `buildInitialStatData`).
//
// Exports `installFixtureCard(profileId)` for reuse by later yuzu test files.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
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
import { importCharacterFromFile, getCharacter } from '../../src/main/services/characterService'
import { getCharacterLorebook } from '../../src/main/services/lorebookService'
import {
  importAssetsZip,
  getIndex,
  clearAssetCache
} from '../../src/main/services/worldAssetService'
import { createChat } from '../../src/main/services/chatService'
import { getFloor } from '../../src/main/services/floorService'
import { closeAll } from '../../src/main/services/sessionDbService'

const P = 'pFixture'

/** Absolute path to the fixture-card deliverable directory (co-located with this test). */
export const FIXTURE_CARD_DIR = path.join(__dirname, 'fixture-card')
const FIXTURE_CARD_JSON = path.join(FIXTURE_CARD_DIR, 'card.json')
const FIXTURE_ASSETS_DIR = path.join(FIXTURE_CARD_DIR, 'assets')

/**
 * Import the fixture card into `profileId` through the real service path, then install its `assets/`
 * against the resulting lorebook (id == characterId). Returns the new character/lorebook id + the import
 * summary. Reusable by other yuzu test files. Requires the same DB/storage mocks this file sets up.
 */
export const installFixtureCard = (profileId: string): { id: string; assetsImported: number } => {
  const res = importCharacterFromFile(profileId, FIXTURE_CARD_JSON)
  if (!res) throw new Error('fixture card import returned null')
  // Zip the on-disk assets dir (importAssetsZip is the only convention surface) and install it against
  // the world's lorebook (embedded book id == characterId).
  const zip = new AdmZip()
  zip.addLocalFolder(FIXTURE_ASSETS_DIR)
  const zipPath = path.join(tmp, `fixture-assets-${res.id}.zip`)
  fs.writeFileSync(zipPath, zip.toBuffer())
  const imported = importAssetsZip(profileId, res.id, zipPath)
  return { id: res.id, assetsImported: imported.imported }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-yuzu-fixture-'))
  clearAssetCache()
  getDb()
    .prepare('INSERT INTO profiles (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
    .run(P, 'Fixture', 't', 't')
})

afterEach(() => {
  closeAll()
  closeDb()
  clearAssetCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('WP-Y2 fixture card imports through the real service path', () => {
  it('the character row exists and getCharacter returns the yuzu extension block intact', () => {
    const { id } = installFixtureCard(P)

    const card = getCharacter(P, id)
    expect(card).not.toBeNull()
    expect(card!.data.name).toBe('Yuzu Fixture')

    // The yuzu opt-in play-mode block survives schema import untouched (RPTerminalExtSchema.catchall).
    const yuzu = card!.data.extensions?.rp_terminal?.yuzu as
      | { version?: number; opening?: string }
      | undefined
    expect(yuzu).toBeDefined()
    expect(yuzu!.version).toBe(1)
    expect(typeof yuzu!.opening).toBe('string')
    expect(yuzu!.opening!.length).toBeGreaterThan(0)
    // The ADR-0008 MVU effect form round-trips inside the opening.
    expect(yuzu!.opening).toContain("_.set('好感度.kaede'")
  })

  it('the embedded character_book lands under id == characterId', () => {
    const { id } = installFixtureCard(P)

    // Embedded books are stored by lorebookService.saveCharacterLorebook under id == characterId, so the
    // lorebook id is discoverable directly from the imported character id.
    const book = getCharacterLorebook(P, id)
    expect(book).not.toBeNull()
    expect(book!.entries.length).toBe(2)
    expect(book!.entries.some((e) => e.comment === '[initvar]')).toBe(true)
    expect(book!.entries.some((e) => e.keys.includes('classroom'))).toBe(true)
  })

  it('assets installed against the lorebook id are indexed (sprites / backgrounds / CG)', () => {
    const { id, assetsImported } = installFixtureCard(P)
    // 6 sprites + 2 backgrounds + 1 CG = 9 convention-parsing files; audio stubs are not an asset category.
    expect(assetsImported).toBe(9)

    const index = getIndex(P, id)
    expect(Object.keys(index.character ?? {})).toEqual(expect.arrayContaining(['kaede', 'yuzu']))
    expect(Object.keys(index.location ?? {})).toEqual(
      expect.arrayContaining(['classroom', 'rooftop'])
    )
    expect(Object.keys(index.cg ?? {})).toEqual(expect.arrayContaining(['cg_confession']))

    // A sprite's mood variants are indexed under its 立绘 type.
    expect(Object.keys(index.character!.kaede!['立绘']!.moods)).toEqual(
      expect.arrayContaining(['neutral', 'smile', 'worried'])
    )
  })

  it('the InitVar block seeds floor-0 stat_data via the real session-create path', async () => {
    const { id } = installFixtureCard(P)

    const chat = await createChat(P, id)
    expect(chat).toBeTruthy()

    const floor0 = getFloor(P, chat.id, 0)
    expect(floor0).not.toBeNull()
    const statData = (floor0!.variables as any)?.stat_data
    expect(statData).toBeDefined()
    // [initvar] JSON block seeded into stat_data (MVU [value, description] tuples).
    expect(statData.好感度.kaede).toEqual([0, '羁绊值'])
    expect(statData.flags.confessed).toEqual([false, '是否已表白'])
  })
})
