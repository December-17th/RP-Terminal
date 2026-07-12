// test/notesMemoryService.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmp: string
// Point the service's app dir at a temp dir by mocking storageService.getAppDir (the writeTextSyncAtomic
// helper under test stays real — only the data root is redirected).
vi.mock('../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})

import {
  notesFilePath,
  readNotes,
  writeNotes,
  removeNotes
} from '../src/main/services/notesMemoryService'
import { deleteChat } from '../src/main/services/chatService'

vi.mock('../src/main/services/db', () => ({
  getDb: () => ({ prepare: () => ({ run: () => ({ changes: 0 }) }) })
}))

const P = 'profNotes'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-notes-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('notesFilePath', () => {
  it('lives under the profile in its own chat-notes dir, not the app DB', () => {
    const p = notesFilePath(P, 'chatA')
    expect(p).toBe(path.join(tmp, 'profiles', P, 'chat-notes', 'chatA.md'))
    expect(p).not.toContain('rpterminal.db')
  })
})

describe('notesMemoryService round-trip', () => {
  it('returns empty string for a chat with no notes file', () => {
    expect(readNotes(P, 'no-such-chat')).toBe('')
  })

  it('round-trips markdown notes content verbatim', () => {
    const notes = '## 序章\n<!-- keywords: 黑塔, 遗迹 -->\n主角进入遗迹。\n'
    writeNotes(P, 'chat1', notes)
    expect(readNotes(P, 'chat1')).toBe(notes)
    expect(fs.existsSync(notesFilePath(P, 'chat1'))).toBe(true)
  })

  it('isolates chats from each other', () => {
    writeNotes(P, 'chatA', '## A\nalpha')
    writeNotes(P, 'chatB', '## B\nbeta')
    expect(readNotes(P, 'chatA')).toBe('## A\nalpha')
    expect(readNotes(P, 'chatB')).toBe('## B\nbeta')
  })

  it('replaces (not appends) on a subsequent write', () => {
    writeNotes(P, 'chatC', '## first\none')
    writeNotes(P, 'chatC', '## second\ntwo')
    expect(readNotes(P, 'chatC')).toBe('## second\ntwo')
  })

  it('removes the file when written empty/whitespace-only (idempotent with never-written)', () => {
    writeNotes(P, 'chatD', '## x\nbody')
    expect(fs.existsSync(notesFilePath(P, 'chatD'))).toBe(true)
    writeNotes(P, 'chatD', '   \n  ')
    expect(fs.existsSync(notesFilePath(P, 'chatD'))).toBe(false)
    expect(readNotes(P, 'chatD')).toBe('')
  })
})

describe('removeNotes', () => {
  it('deletes an existing notes file and is idempotent', () => {
    writeNotes(P, 'chatE', '## x\nbody')
    expect(fs.existsSync(notesFilePath(P, 'chatE'))).toBe(true)
    removeNotes(P, 'chatE')
    expect(fs.existsSync(notesFilePath(P, 'chatE'))).toBe(false)
    // Second call on a missing file must not throw.
    expect(() => removeNotes(P, 'chatE')).not.toThrow()
  })
})

describe('deleteChat notes cleanup', () => {
  it('removes the chat notes file (the file lives outside the app DB)', () => {
    writeNotes(P, 'chatF', '## keep-until-delete\nbody')
    expect(fs.existsSync(notesFilePath(P, 'chatF'))).toBe(true)
    deleteChat(P, 'chatF')
    expect(fs.existsSync(notesFilePath(P, 'chatF'))).toBe(false)
  })
})
