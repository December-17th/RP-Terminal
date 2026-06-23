import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  saveRegexScript,
  setScriptRenderMode,
  getAllRules,
  listScripts
} from '../src/main/services/regexService'
import { getAppDir } from '../src/main/services/storageService'

const profileId = `test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

describe('regexService renderMode', () => {
  it('rules carry no renderMode by default', () => {
    saveRegexScript(profileId, {
      scriptName: 'Card',
      findRegex: '/x/g',
      replaceString: '<html></html>',
      placement: [2]
    })
    expect(getAllRules(profileId)[0].renderMode).toBeUndefined()
  })
  it('setScriptRenderMode stamps the rule + script info', () => {
    const file = listScripts(profileId)[0].file
    setScriptRenderMode(profileId, file, 'isolated')
    expect(getAllRules(profileId)[0].renderMode).toBe('isolated')
    expect(listScripts(profileId).find((s) => s.file === file)?.renderMode).toBe('isolated')
  })
  it('null clears it', () => {
    const file = listScripts(profileId)[0].file
    setScriptRenderMode(profileId, file, null)
    expect(getAllRules(profileId)[0].renderMode).toBeUndefined()
  })
})
