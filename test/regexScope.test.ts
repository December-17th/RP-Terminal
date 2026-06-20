import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  isScopeActive,
  saveRegexScript,
  setScriptScope,
  setScriptDisabled,
  getScriptScope,
  getAllRules,
  listScripts,
  deleteScript
} from '../src/main/services/regexService'
import { getAppDir } from '../src/main/services/storageService'

describe('isScopeActive (scope resolution)', () => {
  it('global is always active', () => {
    expect(isScopeActive(undefined, {})).toBe(true)
    expect(isScopeActive({ scope: 'global' }, { cardId: 'c', chatId: 's' })).toBe(true)
  })

  it('world is active only when the active card owns it', () => {
    const meta = { scope: 'world' as const, owner: 'card-A' }
    expect(isScopeActive(meta, { cardId: 'card-A' })).toBe(true)
    expect(isScopeActive(meta, { cardId: 'card-B' })).toBe(false)
    expect(isScopeActive(meta, {})).toBe(false)
  })

  it('session is active only when the active chat owns it', () => {
    const meta = { scope: 'session' as const, owner: 'chat-1' }
    expect(isScopeActive(meta, { chatId: 'chat-1' })).toBe(true)
    expect(isScopeActive(meta, { chatId: 'chat-2' })).toBe(false)
    expect(isScopeActive(meta, { cardId: 'chat-1' })).toBe(false)
  })
})

// Integration: exercise the sidecar (_meta.json) round-trip against the test app dir.
const profileId = `test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

const rule = (name: string) => ({ scriptName: name, findRegex: '/a/g', replaceString: 'b' })

describe('regex scope store', () => {
  it('saves with a scope and filters getAllRules by active context', () => {
    saveRegexScript(profileId, rule('global-one')) // default global
    saveRegexScript(profileId, rule('world-A'), 'world', 'card-A')
    saveRegexScript(profileId, rule('session-1'), 'session', 'chat-1')

    // No context → every script (manager view).
    expect(getAllRules(profileId)).toHaveLength(3)
    // Wrong world + wrong session → only the global one.
    expect(getAllRules(profileId, { cardId: 'card-B', chatId: 'chat-9' })).toHaveLength(1)
    // Right world → global + world-A.
    expect(getAllRules(profileId, { cardId: 'card-A' })).toHaveLength(2)
    // Right world + right session → all three.
    expect(getAllRules(profileId, { cardId: 'card-A', chatId: 'chat-1' })).toHaveLength(3)
  })

  it('listScripts surfaces scope/owner and excludes the _meta sidecar', () => {
    const scripts = listScripts(profileId)
    expect(scripts).toHaveLength(3)
    expect(scripts.some((s) => s.file.startsWith('_'))).toBe(false)
    const worldScript = scripts.find((s) => s.scope === 'world')!
    expect(worldScript.owner).toBe('card-A')
  })

  it('setScriptScope reassigns and global clears the entry', () => {
    const target = listScripts(profileId).find((s) => s.scriptName === 'global-one')!
    setScriptScope(profileId, target.file, 'world', 'card-Z')
    expect(getScriptScope(profileId, target.file)).toEqual({ scope: 'world', owner: 'card-Z' })
    setScriptScope(profileId, target.file, 'global')
    expect(getScriptScope(profileId, target.file)).toEqual({ scope: 'global' })
  })

  it('setScriptDisabled hides a script from getAllRules but keeps it listed', () => {
    const target = listScripts(profileId).find((s) => s.scriptName === 'session-1')!
    const before = getAllRules(profileId).length
    setScriptDisabled(profileId, target.file, true)
    expect(getAllRules(profileId)).toHaveLength(before - 1) // dropped from the active rule set
    const listed = listScripts(profileId).find((s) => s.file === target.file)!
    expect(listed.disabled).toBe(true) // still visible in the manager
    setScriptDisabled(profileId, target.file, false)
    expect(getAllRules(profileId)).toHaveLength(before) // re-enabled
  })

  it('deleteScript removes the file and its scope entry', () => {
    const target = listScripts(profileId).find((s) => s.scriptName === 'world-A')!
    deleteScript(profileId, target.file)
    expect(listScripts(profileId).some((s) => s.file === target.file)).toBe(false)
    expect(getScriptScope(profileId, target.file)).toEqual({ scope: 'global' }) // entry gone
  })
})
