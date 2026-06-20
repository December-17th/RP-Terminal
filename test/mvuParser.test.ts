import { describe, it, expect } from 'vitest'
import { parseMvuCommands, applyMvuCommands } from '../src/main/parsers/mvuParser'

describe('parseMvuCommands', () => {
  it('extracts commands from an <UpdateVariable> block and strips it from the text', () => {
    const raw =
      'You strike the goblin.\n<UpdateVariable>\n_.set(\'hp\', 80, \'hit\');\n_.add(\'gold\', 5);\n</UpdateVariable>\nIt reels.'
    const { text, commands } = parseMvuCommands(raw)
    expect(text).toBe('You strike the goblin.\n\nIt reels.')
    expect(commands).toEqual([
      { op: 'set', path: 'hp', value: 80, reason: 'hit' },
      { op: 'add', path: 'gold', value: 5, reason: undefined }
    ])
  })

  it('parses object/array argument values (unquoted keys, nested)', () => {
    const { commands } = parseMvuCommands(
      "<UpdateVariable>_.assign('rel.Aeri', { affinity: 5, tags: ['ally'] });</UpdateVariable>"
    )
    expect(commands[0]).toEqual({
      op: 'assign',
      path: 'rel.Aeri',
      value: { affinity: 5, tags: ['ally'] },
      reason: undefined
    })
  })

  it('handles parentheses and commas inside string values', () => {
    const { commands } = parseMvuCommands(
      "<UpdateVariable>_.set('note', 'hi (there), friend');</UpdateVariable>"
    )
    expect(commands[0].value).toBe('hi (there), friend')
  })

  it('normalizes insert (index form vs append) and delta→add, unset→remove', () => {
    const { commands } = parseMvuCommands(
      "<UpdateVariable>" +
        "_.insert('quests', 0, { name: 'key' });" +
        "_.insert('log', 'entry');" +
        "_.delta('time', 1);" +
        "_.unset('world.place');" +
        "</UpdateVariable>"
    )
    expect(commands).toEqual([
      { op: 'insert', path: 'quests', index: 0, value: { name: 'key' }, reason: undefined },
      { op: 'insert', path: 'log', value: 'entry', reason: undefined },
      { op: 'add', path: 'time', value: 1, reason: undefined },
      { op: 'remove', path: 'world.place', reason: undefined }
    ])
  })

  it('returns no commands and untouched text when there is no block', () => {
    const r = parseMvuCommands('Just narration.')
    expect(r.commands).toEqual([])
    expect(r.text).toBe('Just narration.')
  })
})

describe('applyMvuCommands', () => {
  it('applies set/add/assign/insert/remove to nested stat_data and logs deltas', () => {
    const stat: Record<string, any> = {
      主角: { 生命值: 100 },
      命运点数: 2,
      关系列表: { 艾莉: { 好感: 1 } },
      任务列表: ['旧任务']
    }
    const deltas = applyMvuCommands(stat, [
      { op: 'set', path: '主角.生命值', value: 80, reason: '受到攻击' },
      { op: 'add', path: '命运点数', value: 1 },
      { op: 'assign', path: '关系列表.艾莉', value: { 好感: 5, 信任: 3 } },
      { op: 'insert', path: '任务列表', index: 0, value: '寻找钥匙' },
      { op: 'remove', path: '主角.生命值' }
    ])
    expect(stat.命运点数).toBe(3)
    expect(stat.关系列表.艾莉).toEqual({ 好感: 5, 信任: 3 }) // shallow-merged
    expect(stat.任务列表).toEqual(['寻找钥匙', '旧任务'])
    expect(stat.主角.生命值).toBeUndefined() // removed
    // delta audit captures old/new + reason
    expect(deltas[0]).toEqual({ path: '主角.生命值', old: 100, new: 80, reason: '受到攻击' })
    expect(deltas[1]).toEqual({ path: '命运点数', old: 2, new: 3, reason: undefined })
  })

  it('add coerces a missing/non-numeric path from 0', () => {
    const stat: Record<string, any> = {}
    applyMvuCommands(stat, [{ op: 'add', path: 'score', value: 10 }])
    expect(stat.score).toBe(10)
  })

  it('insert creates the array when the path is empty', () => {
    const stat: Record<string, any> = {}
    applyMvuCommands(stat, [{ op: 'insert', path: 'items', value: 'sword' }])
    expect(stat.items).toEqual(['sword'])
  })
})
