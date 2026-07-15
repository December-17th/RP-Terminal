import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TableTemplateSchema } from '../src/main/types/tableTemplate'
import type { TableRead } from '../src/main/services/tableDbService'

/**
 * WS4 — the READER that folds the capped table-memory block into the main prompt (`assemblePrompt`
 * calls this; its output rides `buildPrompt`'s `memoryBlock` tail splice). Proves the I/O wiring
 * (template resolution + global cap + sandbox read → the pure renderer) and the FAIL-OPEN / silent-empty
 * degradations. The pure decisions themselves are covered in `test/tableInject.test.ts`.
 */

const mockChat = vi.hoisted(() => ({ getChatTableTemplateId: vi.fn<() => string | null>() }))
vi.mock('../src/main/services/chatService', () => mockChat)
const mockTemplate = vi.hoisted(() => ({ getTableTemplateById: vi.fn() }))
vi.mock('../src/main/services/tableTemplateService', () => mockTemplate)
const mockDb = vi.hoisted(() => ({ readAllTablesBounded: vi.fn(() => [] as TableRead[]) }))
vi.mock('../src/main/services/tableDbService', () => mockDb)
const mockSettings = vi.hoisted(() => ({ getSettings: vi.fn(() => ({ tables: { injection_max_rows: 2 } })) }))
vi.mock('../src/main/services/settingsService', () => mockSettings)
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))

import { renderChatTablesInjectionBlock } from '../src/main/services/tablesInjectionService'

const TEMPLATE = TableTemplateSchema.parse({
  name: 'mem',
  tables: [
    {
      uid: 't1',
      sqlName: 'summary',
      displayName: '纪要',
      ddl: 'CREATE TABLE summary (row_id INTEGER, text TEXT)',
      headers: ['row_id', 'text']
    }
  ]
})

const read = (rows: unknown[][]): TableRead => ({
  sqlName: 'summary',
  displayName: '纪要',
  columns: ['row_id', 'text'],
  rows,
  rowids: rows.map((_, i) => i + 1)
})

beforeEach(() => {
  mockChat.getChatTableTemplateId.mockReset().mockReturnValue('tmpl')
  mockTemplate.getTableTemplateById.mockReset().mockReturnValue(TEMPLATE)
  mockDb.readAllTablesBounded.mockReset().mockReturnValue([])
  mockSettings.getSettings.mockReset().mockReturnValue({ tables: { injection_max_rows: 2 } })
})

describe('renderChatTablesInjectionBlock', () => {
  it('renders the capped block from the bound template + sandbox rows, honoring the global cap', () => {
    mockDb.readAllTablesBounded.mockReturnValue([read([['1', 'a'], ['2', 'b'], ['3', 'c']])])
    const out = renderChatTablesInjectionBlock('p', 'c')
    expect(out).toContain('【记忆表格】')
    expect(out).toContain('## 纪要（summary）')
    // Global cap 2 → last two rows, one omitted.
    expect(out).toContain('3 | c')
    expect(out).not.toContain('1 | a')
    expect(out).toContain('…（省略 1 行较早记录）')
  })

  it('returns "" when no template is bound (silent — no injection)', () => {
    mockChat.getChatTableTemplateId.mockReturnValue(null)
    expect(renderChatTablesInjectionBlock('p', 'c')).toBe('')
    expect(mockDb.readAllTablesBounded).not.toHaveBeenCalled()
  })

  it('returns "" when the bound template has no rows (empty tables → no block)', () => {
    mockDb.readAllTablesBounded.mockReturnValue([read([])])
    expect(renderChatTablesInjectionBlock('p', 'c')).toBe('')
  })

  it('FAIL-OPEN: a read error degrades to "" (never crashes the turn)', () => {
    mockDb.readAllTablesBounded.mockImplementation(() => {
      throw new Error('sandbox exploded')
    })
    expect(renderChatTablesInjectionBlock('p', 'c')).toBe('')
  })
})
