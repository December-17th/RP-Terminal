// test/chatCardVars.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmp: string
// Point the service's app dir at a temp dir by mocking storageService.getAppDir.
vi.mock('../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})

import { getChatCardVars, setChatCardVars } from '../src/main/services/chatCardVarsService'

const P = 'profA'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-chatcardvars-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('chatCardVarsService', () => {
  it('returns {} for an unknown chat', () => {
    expect(getChatCardVars(P, 'no-such-chat')).toEqual({})
  })

  it('round-trips a per-chat KV object', () => {
    setChatCardVars(P, 'chat1', { 'party.members': ['爱莎', '凯尔'], 'party.stripPos': { x: 12, y: 30 } })
    expect(getChatCardVars(P, 'chat1')).toEqual({
      'party.members': ['爱莎', '凯尔'],
      'party.stripPos': { x: 12, y: 30 }
    })
  })

  it('isolates chats from each other', () => {
    setChatCardVars(P, 'chatA', { 'party.members': ['甲'] })
    setChatCardVars(P, 'chatB', { 'party.members': ['乙'] })
    expect(getChatCardVars(P, 'chatA')).toEqual({ 'party.members': ['甲'] })
    expect(getChatCardVars(P, 'chatB')).toEqual({ 'party.members': ['乙'] })
  })

  it('replaces (not merges) a chat KV on set', () => {
    setChatCardVars(P, 'chatC', { a: 1, b: 2 })
    setChatCardVars(P, 'chatC', { a: 9 })
    expect(getChatCardVars(P, 'chatC')).toEqual({ a: 9 })
  })
})
