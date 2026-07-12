import { describe, it, expect, vi, beforeEach } from 'vitest'

// Finding D3 — the composed-prompt PREVIEW IPC for the two plot-recall planner nodes
// (recall-planner-preview / notes-maintain-preview, registered by registerNotesMemoryIpc). Each must
// compose the planner prompt via the SAME exported cores the node's run() uses and return
// `{ messages }` WITHOUT a model call. The mock harness mirrors notesMaintain.test.ts so buildGenContext
// self-seeds a Context off mocked chat/floor/settings services (no disk, no network).

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

const mockNotes = vi.hoisted(() => ({
  readNotes: vi.fn(() => ''),
  writeNotes: vi.fn(),
  removeNotes: vi.fn()
}))
vi.mock('../../src/main/services/notesMemoryService', () => mockNotes)

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

import { registerNotesMemoryIpc } from '../../src/main/ipc/notesMemoryIpc'
import type { IpcMain } from 'electron'

type Handler = (event: unknown, ...args: unknown[]) => unknown
type PreviewResult = { messages?: { role: string; content: string }[]; error?: string }

/** Register the IPC surface against a fake ipcMain that captures handlers by channel. */
const collectHandlers = (): Map<string, Handler> => {
  const handlers = new Map<string, Handler>()
  const fake = { handle: (ch: string, fn: Handler) => handlers.set(ch, fn) } as unknown as IpcMain
  registerNotesMemoryIpc(fake)
  return handlers
}

beforeEach(() => {
  mockFloor.getAllFloors.mockReset().mockReturnValue(floors)
  mockNotes.readNotes.mockReset().mockReturnValue('')
  mockChat.getChatTableTemplateId.mockReset().mockReturnValue(null)
})

describe('plot-recall preview IPC handlers', () => {
  it('registers both preview channels', () => {
    const handlers = collectHandlers()
    expect(handlers.has('recall-planner-preview')).toBe(true)
    expect(handlers.has('notes-maintain-preview')).toBe(true)
  })

  it('recall-planner-preview composes messages without throwing (default config)', async () => {
    const handlers = collectHandlers()
    const res = (await handlers.get('recall-planner-preview')!(null, 'prof', 'c1', {})) as PreviewResult
    expect(res.error).toBeUndefined()
    expect(Array.isArray(res.messages)).toBe(true)
    expect(res.messages!.length).toBeGreaterThan(0)
    // The pending-action slot resolves to the clearly-preview sample, never a raw {{action}} leak.
    const joined = res.messages!.map((m) => m.content).join('\n')
    expect(joined).not.toContain('{{action}}')
  })

  it('notes-maintain-preview composes messages and splices the current notes', async () => {
    mockNotes.readNotes.mockReturnValue('## Secrets\nThe butler did it.')
    const handlers = collectHandlers()
    const res = (await handlers.get('notes-maintain-preview')!(null, 'prof', 'c1', {})) as PreviewResult
    expect(res.error).toBeUndefined()
    expect(res.messages!.length).toBeGreaterThan(0)
    const joined = res.messages!.map((m) => m.content).join('\n')
    expect(joined).toContain('The butler did it.')
    expect(joined).not.toContain('{{notes}}')
  })
})
