import { describe, it, expect } from 'vitest'
import {
  addRow,
  dynamicEnumOptions,
  exposedEnumOptions,
  insertAtCaret,
  moveRow,
  normalizeRows,
  removeRow,
  resolveSelection,
  setContent,
  setRole,
  visibleTabs,
  type PromptRow
} from '../../src/renderer/src/components/workflow/detailsPanelModel'

describe('resolveSelection', () => {
  it('an agent group', () => {
    expect(resolveSelection('g1', null, true)).toEqual({ kind: 'agent', groupId: 'g1' })
  })
  it('a plain group', () => {
    expect(resolveSelection('g1', null, false)).toEqual({ kind: 'group', groupId: 'g1' })
  })
  it('a node', () => {
    expect(resolveSelection(null, 'n1', false)).toEqual({ kind: 'node', nodeId: 'n1' })
  })
  it('nothing', () => {
    expect(resolveSelection(null, null, false)).toEqual({ kind: 'none' })
  })
  it('a group wins over a node (mutually exclusive in the store)', () => {
    expect(resolveSelection('g1', 'n1', true).kind).toBe('agent')
  })
})

describe('visibleTabs', () => {
  it('agent + node show the four-tab shell, Prompt only when a prompt exists', () => {
    expect(visibleTabs({ kind: 'node', nodeId: 'n' }, true)).toEqual([
      'settings',
      'prompt',
      'runs',
      'docs'
    ])
    expect(visibleTabs({ kind: 'node', nodeId: 'n' }, false)).toEqual(['settings', 'runs', 'docs'])
    expect(visibleTabs({ kind: 'agent', groupId: 'g' }, true)).toContain('prompt')
  })
  it('plain group + nothing render no tab rail', () => {
    expect(visibleTabs({ kind: 'group', groupId: 'g' }, true)).toEqual([])
    expect(visibleTabs({ kind: 'none' }, true)).toEqual([])
  })
})

describe('prompt row ops', () => {
  const rows: PromptRow[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u' }
  ]
  it('normalizeRows coerces fail-soft', () => {
    expect(normalizeRows('nope')).toEqual([])
    expect(normalizeRows([{ role: 'user', content: 'x' }, { content: 'y' }, null])).toEqual([
      { role: 'user', content: 'x' },
      { role: 'system', content: 'y' },
      { role: 'system', content: '' }
    ])
  })
  it('setRole / setContent are pure updates', () => {
    expect(setRole(rows, 1, 'assistant')[1]).toEqual({ role: 'assistant', content: 'u' })
    expect(setContent(rows, 0, 'new')[0]).toEqual({ role: 'system', content: 'new' })
    // originals untouched
    expect(rows[1].role).toBe('user')
  })
  it('addRow / removeRow', () => {
    expect(addRow(rows)).toHaveLength(3)
    expect(addRow(rows, 'assistant')[2]).toEqual({ role: 'assistant', content: '' })
    expect(removeRow(rows, 0)).toEqual([{ role: 'user', content: 'u' }])
  })
  it('moveRow reorders + clamps', () => {
    expect(moveRow(rows, 0, 1)).toEqual([
      { role: 'user', content: 'u' },
      { role: 'system', content: 'sys' }
    ])
    expect(moveRow(rows, 0, 99)).toEqual([
      { role: 'user', content: 'u' },
      { role: 'system', content: 'sys' }
    ])
    expect(moveRow(rows, 0, 0)).toBe(rows) // no-op returns the same ref
    expect(moveRow(rows, 5, 0)).toBe(rows) // out-of-range from
  })
  it('round-trips: normalize → reorder → normalize is stable', () => {
    const arr: unknown = [
      { role: 'user', content: 'a' },
      { role: 'system', content: 'b' }
    ]
    const moved = moveRow(normalizeRows(arr), 1, 0)
    expect(normalizeRows(moved)).toEqual(moved)
  })
})

describe('insertAtCaret', () => {
  it('inserts at the caret', () => {
    expect(insertAtCaret('hello world', '{{x}}', 5)).toBe('hello{{x}} world')
  })
  it('appends when caret is null or out of range', () => {
    expect(insertAtCaret('abc', '{{x}}', null)).toBe('abc{{x}}')
    expect(insertAtCaret('abc', '{{x}}', 99)).toBe('abc{{x}}')
  })
})

describe('exposed-enum resolution (WP-E/WP-F Mode dropdown)', () => {
  const dynHint = { path: 'selected', optionsPath: 'options', keyField: 'key', labelField: 'label' }
  it('dynamicEnumOptions maps a sibling options array by key/label', () => {
    const config = {
      selected: 'async',
      options: [
        { key: 'every_turn', label: 'Every turn' },
        { key: 'async', label: 'Async backlog' },
        { key: 'off' } // no label → key is the label
      ]
    }
    expect(dynamicEnumOptions(config, dynHint)).toEqual([
      { key: 'every_turn', label: 'Every turn' },
      { key: 'async', label: 'Async backlog' },
      { key: 'off', label: 'off' }
    ])
  })
  it('dynamicEnumOptions is fail-soft on a missing/!array options path', () => {
    expect(dynamicEnumOptions({ selected: 'x' }, dynHint)).toEqual([])
  })
  it('exposedEnumOptions resolves a dynamicEnum field', () => {
    const config = { selected: 'off', options: [{ key: 'off', label: 'Off' }] }
    expect(exposedEnumOptions(config, undefined, dynHint, 'selected')).toEqual([
      { key: 'off', label: 'Off' }
    ])
  })
  it('exposedEnumOptions resolves a STATIC enum field from the schema', () => {
    const schema = {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['a', 'b'] } }
    }
    expect(exposedEnumOptions({}, schema, undefined, 'mode')).toEqual([
      { key: 'a', label: 'a' },
      { key: 'b', label: 'b' }
    ])
  })
  it('exposedEnumOptions returns null for a non-enum field (renders as its normal control)', () => {
    const schema = { type: 'object', properties: { n: { type: 'number' } } }
    expect(exposedEnumOptions({}, schema, undefined, 'n')).toBeNull()
    expect(exposedEnumOptions({}, undefined, undefined, 'whatever')).toBeNull()
  })
})
