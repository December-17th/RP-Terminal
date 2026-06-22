import { describe, it, expect } from 'vitest'
import {
  parseMvuCommands,
  applyMvuCommands,
  parseJsonPatch,
  applyJsonPatch
} from '../src/main/parsers/mvuParser'

describe('parseMvuCommands', () => {
  it('uses the LAST arg as the new value and the //comment as the reason, strips the block', () => {
    // Real MVU: _.set(path, old, new) — old (100) is ignored, new (80) applied; reason is //comment.
    const raw =
      'You strike the goblin.\n<UpdateVariable>\n_.set(\'hp\', 100, 80);//took damage\n_.add(\'gold\', 5);\n</UpdateVariable>\nIt reels.'
    const { text, commands } = parseMvuCommands(raw)
    expect(text).toBe('You strike the goblin.\n\nIt reels.')
    expect(commands).toEqual([
      { op: 'set', path: 'hp', value: 80, reason: 'took damage' },
      { op: 'add', path: 'gold', value: 5, reason: undefined }
    ])
  })

  it('parses the key/index forms and move, with //comment reasons', () => {
    const { commands } = parseMvuCommands(
      '<UpdateVariable>\n' +
        "_.assign('inv', 'sword', 3);//forged\n" +
        "_.remove('party', 0);//left\n" +
        "_.move('bag.gem', 'vault.gem');\n" +
        '</UpdateVariable>'
    )
    expect(commands).toEqual([
      { op: 'assign', path: 'inv', key: 'sword', value: 3, reason: 'forged' },
      { op: 'remove', path: 'party', key: 0, reason: 'left' },
      { op: 'move', path: 'bag.gem', to: 'vault.gem', reason: undefined }
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

  it('ignores a stray unclosed <UpdateVariable> mention and strips only the real block', () => {
    // The reported bug: a stray "<UpdateVariable>" (no close) before the real block made the
    // lazy match span to the real close, deleting the narrative. Tempered match must not.
    const raw =
      'I will output <UpdateVariable> next.\nThe rain falls hard.\n' +
      "<UpdateVariable>\n_.set('hp', 100, 80);//hit\n</UpdateVariable>"
    const { text, commands } = parseMvuCommands(raw)
    expect(text).toContain('I will output <UpdateVariable> next.')
    expect(text).toContain('The rain falls hard.')
    expect(commands).toEqual([{ op: 'set', path: 'hp', value: 80, reason: 'hit' }])
  })

  it('extracts <JSONPatch> ops from an <UpdateVariable> block and strips the block', () => {
    const raw =
      'Scene.\n<UpdateVariable>\n<Analysis>note</Analysis>\n<JSONPatch>\n' +
      '[{"op":"replace","path":"/角色/梅芙/HP","value":"750/750"},{"op":"add","path":"/世界/时间","value":"day 1"}]\n' +
      '</JSONPatch>\n</UpdateVariable>\nMore.'
    const { text, commands, patches } = parseMvuCommands(raw)
    expect(text).toBe('Scene.\n\nMore.')
    expect(commands).toEqual([])
    expect(patches).toEqual([
      { op: 'replace', path: '/角色/梅芙/HP', value: '750/750' },
      { op: 'add', path: '/世界/时间', value: 'day 1' }
    ])
  })

  it('parseJsonPatch tolerates malformed/invalid input', () => {
    expect(parseJsonPatch('not json')).toEqual([])
    expect(parseJsonPatch('{"op":"add"}')).toEqual([]) // not an array
    expect(parseJsonPatch('[{"path":"/a"}]')).toEqual([]) // op missing
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

  it('applies JSON Patch (replace/add/remove/move/copy) over JSON-Pointer paths', () => {
    const sd: Record<string, any> = { 角色: { 梅芙: { HP: '1/1' } }, 世界: {}, list: ['a'] }
    const deltas = applyJsonPatch(sd, [
      { op: 'replace', path: '/角色/梅芙/HP', value: '750/750' },
      { op: 'add', path: '/角色/梅芙/MP', value: '1450/1450' },
      { op: 'add', path: '/世界/时间', value: 'day 1' },
      { op: 'remove', path: '/世界/时间' },
      { op: 'move', path: '/角色/梅芙/生命', from: '/角色/梅芙/HP' },
      { op: 'add', path: '/list/-', value: 'b' } // array-append token
    ])
    expect(sd.角色.梅芙.HP).toBeUndefined() // moved away
    expect(sd.角色.梅芙.生命).toBe('750/750')
    expect(sd.角色.梅芙.MP).toBe('1450/1450')
    expect(sd.世界.时间).toBeUndefined() // added then removed
    expect(sd.list).toEqual(['a', 'b'])
    expect(deltas).toContainEqual({ path: '角色.梅芙.MP', old: undefined, new: '1450/1450' })
  })

  it('treats insert/set as add and delete/unset as remove (MVU-framework aliases)', () => {
    // The 命定之诗 card initializes its whole state tree with op:"insert".
    const sd: Record<string, any> = {}
    const deltas = applyJsonPatch(sd, [
      { op: 'insert', path: '/世界', value: { 时间: 'day 1' } },
      { op: 'insert', path: '/主角/属性', value: { 力量: 3 } },
      { op: 'set', path: '/命运点数', value: 0 }
    ])
    expect(sd.世界).toEqual({ 时间: 'day 1' })
    expect(sd.主角.属性).toEqual({ 力量: 3 })
    expect(sd.命运点数).toBe(0)
    expect(deltas).toHaveLength(3) // all applied, not skipped
    applyJsonPatch(sd, [{ op: 'delete', path: '/命运点数' }])
    expect(sd.命运点数).toBeUndefined()
  })

  it('creates an ARRAY (not object) when add targets /- on a missing path (命定之诗 身份/职业)', () => {
    // The opening patch appends with `/主角/身份/-`; the intermediate must be created as an array so it
    // satisfies the card's Zod schema (the bug produced `{ "-": … }` → "expected array, received object").
    const sd: Record<string, any> = {}
    applyJsonPatch(sd, [
      { op: 'add', path: '/主角/身份/-', value: '被召唤的勇者' },
      { op: 'add', path: '/主角/职业/-', value: '暂无' },
      { op: 'add', path: '/主角/身份/-', value: '勇者' }
    ])
    expect(Array.isArray(sd.主角.身份)).toBe(true)
    expect(sd.主角.身份).toEqual(['被召唤的勇者', '勇者'])
    expect(sd.主角.职业).toEqual(['暂无'])
  })

  it('applies op:delta (increment) to numbers, [value,…] tuples, and "current/max" strings', () => {
    // The exact shape 命定之诗 emits (EXP +30, MP -500), plus a [value, label] tuple.
    const sd: Record<string, any> = {
      主角: { 累计经验值: 30, 法力值: '2250/2250', 体力: [1250, '体力值'] }
    }
    const deltas = applyJsonPatch(sd, [
      { op: 'delta', path: '/主角/累计经验值', value: 30 },
      { op: 'delta', path: '/主角/法力值', value: -500 },
      { op: 'delta', path: '/主角/体力', value: -50 }
    ])
    expect(sd.主角.累计经验值).toBe(60)
    expect(sd.主角.法力值).toBe('1750/2250')
    expect(sd.主角.体力).toEqual([1200, '体力值'])
    expect(deltas).toHaveLength(3) // all applied (not skipped as unknown ops)
  })

  it('handles assign-by-key, remove-by-key, and move', () => {
    const stat: Record<string, any> = { inv: { gold: 1 }, party: ['a', 'b', 'c'], bag: { gem: 9 } }
    const deltas = applyMvuCommands(stat, [
      { op: 'assign', path: 'inv', key: 'sword', value: 3 }, // set a specific member
      { op: 'remove', path: 'party', key: 1 }, // drop array index 1
      { op: 'move', path: 'bag.gem', to: 'vault.gem' }
    ])
    expect(stat.inv).toEqual({ gold: 1, sword: 3 })
    expect(stat.party).toEqual(['a', 'c'])
    expect(stat.bag.gem).toBeUndefined()
    expect(stat.vault.gem).toBe(9)
    // move records the destination delta + the source removal
    expect(deltas).toContainEqual({ path: 'vault.gem', old: undefined, new: 9, reason: undefined })
    expect(deltas).toContainEqual({ path: 'bag.gem', old: 9, new: undefined, reason: undefined })
  })
})
