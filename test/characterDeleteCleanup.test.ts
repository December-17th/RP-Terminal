import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { importCharacterFromFile, deleteCharacter } from '../src/main/services/characterService'
import * as regexService from '../src/main/services/regexService'
import * as scriptService from '../src/main/services/scriptService'
import { getAppDir } from '../src/main/services/storageService'

// File-based stores are real here; the DB layer is a no-op stub (test/mocks/better-sqlite3),
// which is all `deleteCharacter`'s row/chat deletes need — the cleanup we assert on is the
// world-scoped regex/script files in the profile dir.
const profileId = `test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
const tmpFiles: string[] = []
afterAll(() => {
  fs.rmSync(profileDir, { recursive: true, force: true })
  for (const f of tmpFiles) fs.rmSync(f, { force: true })
})

const regexRule = (name: string): any => ({
  id: name,
  scriptName: name,
  findRegex: '/x/g',
  replaceString: 'y',
  placement: [2]
})

const worldCard = (): any => ({
  spec: 'chara_card_v3',
  data: {
    name: 'Cleanup World',
    extensions: {
      regex_scripts: [regexRule('beautify-a'), regexRule('beautify-b')],
      tavern_helper: {
        scripts: [{ type: 'script', enabled: true, name: 'card-script', content: '//x' }]
      },
      rp_terminal: { world_card: '1.0' }
    }
  }
})

const writeTmpCard = (raw: any): string => {
  const p = path.join(os.tmpdir(), `rpt-card-${randomUUID()}.json`)
  fs.writeFileSync(p, JSON.stringify(raw), 'utf-8')
  tmpFiles.push(p)
  return p
}

describe('deleteCharacter — world-scoped artifact cleanup', () => {
  it('removes the regex/scripts a World Card brought in (no orphans left in the managers)', () => {
    const file = writeTmpCard(worldCard())
    const result = importCharacterFromFile(profileId, file)
    expect(result).not.toBeNull()
    const charId = result!.id

    // The two bundled regex scripts landed as world-scoped, owned by this card.
    const ownedRegex = regexService.listScripts(profileId).filter((s) => s.owner === charId)
    expect(ownedRegex).toHaveLength(2)
    expect(ownedRegex.every((s) => s.scope === 'world')).toBe(true)

    // The card's Tavern Helper script (extensions.tavern_helper.scripts) was routed into the
    // script store as a world-scoped script owned by this card.
    const ownedScripts = scriptService.listScripts(profileId).filter((s) => s.owner === charId)
    expect(ownedScripts).toHaveLength(1)
    expect(ownedScripts[0]).toMatchObject({ name: 'card-script', scope: 'world' })

    deleteCharacter(profileId, charId)

    // After delete nothing remains for that owner — the profile's stores are empty again.
    expect(regexService.listScripts(profileId).filter((s) => s.owner === charId)).toHaveLength(0)
    expect(scriptService.listScripts(profileId).filter((s) => s.owner === charId)).toHaveLength(0)
    expect(regexService.listScripts(profileId)).toHaveLength(0)
    expect(scriptService.listScripts(profileId)).toHaveLength(0)
  })
})
