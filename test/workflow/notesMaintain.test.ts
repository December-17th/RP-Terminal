import { describe, it, expect, vi, beforeEach } from 'vitest'

// PLOT-RECALL WP6 — the notes.maintain node END TO END with a mock LLM: it self-seeds its Context,
// reads the current notes + recent transcript, composes the maintainer scaffold, calls the model,
// parses <MemoryNote> edits, merges them by heading (mergeNotes), and writes the file back. Mocks
// follow the memoryMaintain / memoryFillChain idiom (readNotes/writeNotes are mocked so no fs touches).

const floors = Array.from({ length: 3 }, (_, i) => ({
  floor: i,
  user_message: { content: `player action ${i}` },
  response: { content: `ai reply ${i}` },
  variables: {}
}))
const mockChat = vi.hoisted(() => ({
  getChat: vi.fn(() => ({ character_id: 'w1', floor_count: 3 })),
  getChatTableTemplateId: vi.fn(() => null),
  getChatLorebookIds: vi.fn(() => null),
  getChatMode: vi.fn(() => 'explore'),
  getChatWorkflowId: vi.fn(() => null),
  getCachedWorldInfo: vi.fn(() => null),
  setCachedWorldInfo: vi.fn()
}))
vi.mock('../../src/main/services/chatService', () => mockChat)

const mockFloor = vi.hoisted(() => ({
  getFloor: vi.fn(() => floors[floors.length - 1]),
  getAllFloors: vi.fn(() => floors),
  saveFloor: vi.fn()
}))
vi.mock('../../src/main/services/floorService', () => mockFloor)

// The per-chat notes store — mocked so the node never touches disk.
const mockNotes = vi.hoisted(() => ({
  readNotes: vi.fn(() => ''),
  writeNotes: vi.fn(),
  removeNotes: vi.fn()
}))
vi.mock('../../src/main/services/notesMemoryService', () => mockNotes)

// The model call — returns <MemoryNote> edits. Captured so we assert the composed prompt reached it.
const mockCallModel = vi.hoisted(() => ({
  callModel: vi.fn(async () => ({ raw: '', rawUsage: {} }))
}))
vi.mock('../../src/main/services/generation/callModel', () => mockCallModel)

const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../../src/main/services/logService', () => mockLog)

import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
vi.mock('../../src/main/services/settingsService', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  const s = (real.getDefaultSettings as typeof getDefaultSettings)()
  s.api = { provider: 'openai', endpoint: 'https://x/v1', api_key: 'k', model: 'm' }
  return { ...real, getSettings: () => s }
})
vi.mock('../../src/main/services/characterService', () => ({
  getCharacter: () => ({ id: 'w1', data: { name: 'C', description: '', extensions: {} } })
}))
vi.mock('../../src/main/services/lorebookService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getLorebookById: () => ({ id: 'w1', name: 'lb', entries: [] })
}))
vi.mock('../../src/main/services/regexService', () => ({ getPromptRules: () => [] }))
vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadGlobals: () => ({})
}))
vi.mock('../../src/main/services/presetService', () => ({
  getActivePreset: () => getDefaultPreset(),
  getActivePresetId: () => 'p'
}))

import {
  notesMaintain,
  composeNotesMaintainerMessages,
  parseMemoryNotes,
  NOTES_MAINTAINER_MESSAGES
} from '../../src/main/services/nodes/builtin/notesNodes'
import { buildGenContext } from '../../src/main/services/generation/genContext'
import { RunContext } from '../../src/main/services/nodes/types'

const ctx = (): RunContext => ({
  profileId: 'prof',
  chatId: 'c1',
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

const parsedConfig = (): Record<string, unknown> => notesMaintain.configSchema!.parse({})

beforeEach(() => {
  mockFloor.getAllFloors.mockReset().mockReturnValue(floors)
  mockNotes.readNotes.mockReset().mockReturnValue('')
  mockNotes.writeNotes.mockReset()
  mockCallModel.callModel.mockReset().mockResolvedValue({ raw: '', rawUsage: {} })
})

describe('notes.maintain — end to end', () => {
  it('composes the maintainer prompt (current notes + spliced transcript) and applies append + replace edits', async () => {
    mockNotes.readNotes.mockReturnValue('## 人物关系\n旧的关系记录。')
    mockCallModel.callModel.mockResolvedValue({
      raw: `<MemoryNote section="人物关系" mode="append">阿尔忒弥斯承认了秘密。</MemoryNote>
<MemoryNote section="悬念" mode="replace">神殿钥匙的下落仍未知。</MemoryNote>`,
      rawUsage: {}
    })
    const res = await notesMaintain.run(ctx(), {}, { id: 'n', config: parsedConfig() })

    // The model was called with the composed prompt: current notes + the recent transcript.
    expect(mockCallModel.callModel).toHaveBeenCalled()
    const sent = mockCallModel.callModel.mock.calls[0][1] as { role: string; content: string }[]
    const joined = sent.map((m) => `${m.role}:${m.content}`).join('\n')
    expect(joined).toContain('旧的关系记录。')
    expect(joined).toContain('ai reply 2')
    expect(joined).toContain('player action 2')

    // The merged file was written: append kept the old body + added the new; replace created a section.
    expect(mockNotes.writeNotes).toHaveBeenCalledTimes(1)
    const written = mockNotes.writeNotes.mock.calls[0][2] as string
    expect(written).toContain('旧的关系记录。')
    expect(written).toContain('阿尔忒弥斯承认了秘密。')
    expect(written).toContain('## 悬念')
    expect(written).toContain('神殿钥匙的下落仍未知。')

    expect(res.outputs!.report).toBe('applied 2 note edit(s)')
    expect(res.debug!['prompt (sent)']).toContain('旧的关系记录。')
  })

  it('a blank reply (no <MemoryNote>) → no write, reports "no notes", still traces the prompt', async () => {
    mockNotes.readNotes.mockReturnValue('## 人物关系\n旧记录。')
    mockCallModel.callModel.mockResolvedValue({ raw: '本轮没有值得记录的新信息。', rawUsage: {} })
    const res = await notesMaintain.run(ctx(), {}, { id: 'n', config: parsedConfig() })
    expect(mockNotes.writeNotes).not.toHaveBeenCalled()
    expect(res.outputs!.report).toBe('no notes')
    expect(res.debug!['prompt (sent)']).toBeTruthy()
  })

  it('no notes file AND no transcript → silent no-op (no model call, no write)', async () => {
    mockNotes.readNotes.mockReturnValue('')
    mockFloor.getAllFloors.mockReturnValue([])
    const res = await notesMaintain.run(ctx(), {}, { id: 'n', config: parsedConfig() })
    expect(res).toEqual({ outputs: {} })
    expect(mockCallModel.callModel).not.toHaveBeenCalled()
    expect(mockNotes.writeNotes).not.toHaveBeenCalled()
  })

  it('runs (calls the model) when there is a transcript even with no notes file yet', async () => {
    mockNotes.readNotes.mockReturnValue('')
    mockCallModel.callModel.mockResolvedValue({
      raw: `<MemoryNote section="线索" mode="append">发现了一枚徽章。</MemoryNote>`,
      rawUsage: {}
    })
    const res = await notesMaintain.run(ctx(), {}, { id: 'n', config: parsedConfig() })
    expect(mockCallModel.callModel).toHaveBeenCalled()
    const written = mockNotes.writeNotes.mock.calls[0][2] as string
    expect(written).toContain('## 线索')
    expect(written).toContain('发现了一枚徽章。')
    expect(res.outputs!.report).toBe('applied 1 note edit(s)')
  })

  // A6 — memory-trio input symmetry: an OPTIONAL `gen` Context port (mirrors memory.recall) that reuses
  // an upstream bundle when wired and self-seeds when not.
  it('declares an optional `gen` Context input (memory-trio symmetry)', () => {
    const gen = notesMaintain.inputs.find((i) => i.name === 'gen')
    expect(gen).toEqual({ name: 'gen', type: 'Context' })
  })

  it('reuses a wired `gen` input instead of self-seeding (transcript still reaches the model)', async () => {
    mockNotes.readNotes.mockReturnValue('## 已有\n内容')
    const wired = buildGenContext('prof', 'c1', 'WIRED_ACTION')
    await notesMaintain.run(ctx(), { gen: wired }, { id: 'n', config: parsedConfig() })
    const sent = mockCallModel.callModel.mock.calls[0][1] as { role: string; content: string }[]
    const joined = sent.map((m) => m.content).join('\n')
    expect(joined).toContain('ai reply 2')
  })
})

describe('parseMemoryNotes (the shared edit parser)', () => {
  it('drops notes with no section heading or an empty body; defaults an unknown mode to replace', () => {
    const edits = parseMemoryNotes(
      `<MemoryNote mode="append">no section — dropped</MemoryNote>
<MemoryNote section="空的" mode="replace">   </MemoryNote>
<MemoryNote section="有效" mode="weird">保留，模式回退为 replace</MemoryNote>`
    )
    expect(edits).toEqual([{ heading: '有效', body: '保留，模式回退为 replace', mode: 'replace' }])
  })
})

describe('composeNotesMaintainerMessages (the shared node/preview core)', () => {
  it('substitutes {{notes}} + flattens {history}, ending on a user turn', () => {
    const gen = buildGenContext('prof', 'c1', '')
    const composed = composeNotesMaintainerMessages(
      gen,
      { messages: NOTES_MAINTAINER_MESSAGES, lastNFloors: 6 },
      '## 已有\n内容'
    )
    expect(composed[composed.length - 1].role).toBe('user')
    const joined = composed.map((m) => `${m.role}:${m.content}`).join('\n')
    expect(joined).toContain('## 已有')
    expect(joined).toContain('ai reply 2')
  })
})
