import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))

import Adapter from '../mocks/betterSqlite3Node'
import { SESSION_SCHEMA } from '../../src/main/services/sessionDbService'
import {
  createFloorState,
  FloorStateError,
  type FloorStateOperation
} from '../../src/main/services/agentRuntime/floorState/FloorState'

const floor = (
  db: InstanceType<typeof Adapter>,
  number: number,
  variables: Record<string, unknown>,
  response = ''
): void => {
  db.prepare(
    `INSERT INTO floors
      (chat_id, floor, timestamp, user_content, response_content, events, variables)
     VALUES (?, ?, ?, '', ?, '[]', ?)`
  ).run('chat', number, '2026-07-18T12:00:00.000Z', response, JSON.stringify(variables))
}

const variablesAt = (db: InstanceType<typeof Adapter>, number: number): Record<string, unknown> =>
  JSON.parse(
    (
      db
        .prepare('SELECT variables FROM floors WHERE chat_id = ? AND floor = ?')
        .get('chat', number) as { variables: string }
    ).variables
  )

describe('FloorState', () => {
  let db: InstanceType<typeof Adapter>

  beforeEach(() => {
    db = new Adapter(':memory:')
    db.exec(SESSION_SCHEMA)
  })

  it('incorporates a late floor-12 result and deterministically replays floor 13', () => {
    floor(db, 11, { stat_data: { gold: 1 } })
    floor(db, 12, { stat_data: { gold: 1 } })
    floor(
      db,
      13,
      { stat_data: { gold: 3 } },
      "<UpdateVariable>\n_.add('gold', 2);\n</UpdateVariable>"
    )
    const refresh = vi.fn()
    const state = createFloorState({ db: db as never, onStateRefresh: refresh })

    state.append('chat', 12, 'agent', [
      { kind: 'set', path: 'variables.stat_data.gold', value: 10 }
    ])

    expect(variablesAt(db, 12)).toEqual({ stat_data: { gold: 10 } })
    expect(variablesAt(db, 13)).toEqual({
      stat_data: { gold: 12 },
      delta_data: [{ path: 'gold', old: 10, new: 12 }]
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith({ chatId: 'chat', fromFloor: 12, throughFloor: 13 })
  })

  it('replays additive floor-0 model changes exactly once from the persisted pre-floor baseline', () => {
    floor(
      db,
      0,
      { stat_data: { gold: 12 } },
      "<UpdateVariable>\n_.add('gold', 2);\n</UpdateVariable>"
    )
    const state = createFloorState({ db: db as never })
    state.setBaseline('chat', { stat_data: { gold: 10 } })

    state.replay('chat', 0)

    expect(variablesAt(db, 0)).toEqual({
      stat_data: { gold: 12 },
      delta_data: [{ path: 'gold', old: 10, new: 12 }]
    })
  })

  it('drops stale floor-0 keys that are absent from the true pre-floor baseline and replay', () => {
    floor(db, 0, { stat_data: { hp: 10, stale: true } })
    const state = createFloorState({ db: db as never })
    state.setBaseline('chat', { stat_data: { hp: 10 } })

    state.replay('chat', 0)

    expect(variablesAt(db, 0)).toEqual({ stat_data: { hp: 10 } })
  })

  it('removes a deleted floor operation and rejects a late result for that floor', () => {
    floor(db, 12, { stat_data: {} })
    const state = createFloorState({ db: db as never })
    state.setBaseline('chat', { stat_data: {} })
    db.prepare(
      `INSERT INTO vars_ops (chat_id, floor, seq, kind, payload)
       VALUES (?, ?, ?, ?, ?)`
    ).run('chat', 12, 0, 'replace', JSON.stringify({ legacy: true }))
    state.append('chat', 12, 'agent', [
      { kind: 'set', path: 'variables.stat_data.report', value: 'late' }
    ])

    state.deleteFromFloor('chat', 12)
    expect(state.list('chat')).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS n FROM floors').get() as { n: number }).n).toBe(0)
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM floor_operations').get() as { n: number }).n
    ).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM vars_ops').get() as { n: number }).n).toBe(0)
    expect(() =>
      state.append('chat', 12, 'agent', [
        { kind: 'set', path: 'variables.stat_data.report', value: 'stale' }
      ])
    ).toThrowError(FloorStateError)
  })

  it('applies overlapping operations in floor and sequence order', () => {
    floor(db, 1, { stat_data: {} })
    const state = createFloorState({ db: db as never })
    state.append('chat', 1, 'card', [
      { kind: 'set', path: 'variables.stat_data.party', value: { leader: 'A', hp: 5 } },
      { kind: 'set', path: 'variables.stat_data.party.leader', value: 'B' },
      { kind: 'increment', path: 'variables.stat_data.party.hp', value: 3 }
    ])

    expect(variablesAt(db, 1)).toEqual({
      stat_data: { party: { leader: 'B', hp: 8 } }
    })
  })

  it('atomically journals a card JSON Patch in the general journal and replays the suffix', () => {
    floor(db, 0, { stat_data: { gold: 1 } })
    floor(db, 1, { stat_data: { gold: 1 } })
    const state = createFloorState({ db: db as never })
    state.setBaseline('chat', { stat_data: { gold: 1 } })

    state.appendPatch('chat', 0, 'card', [{ op: 'replace', path: '/gold', value: 5 }])

    expect(variablesAt(db, 0)).toEqual({
      stat_data: { gold: 5 },
      delta_data: [{ path: 'gold', old: 1, new: 5 }]
    })
    expect(variablesAt(db, 1)).toEqual({
      stat_data: { gold: 5 },
      delta_data: [{ path: 'gold', old: 1, new: 5 }]
    })
    expect(db.prepare('SELECT source, kind, path FROM floor_operations').get()).toEqual({
      source: 'card',
      kind: 'patch',
      path: 'variables.stat_data'
    })
    expect((db.prepare('SELECT COUNT(*) AS n FROM vars_ops').get() as { n: number }).n).toBe(0)
  })

  it('records model, card, user, and agent provenance in one ordered journal', () => {
    floor(db, 1, { stat_data: {} })
    const state = createFloorState({ db: db as never })
    for (const [index, source] of ['model', 'card', 'user', 'agent'].entries()) {
      state.append('chat', 1, source as 'model' | 'card' | 'user' | 'agent', [
        { kind: 'set', path: `variables.stat_data.source${index}`, value: true }
      ])
    }

    expect(state.list('chat').map((operation) => operation.source)).toEqual([
      'model',
      'card',
      'user',
      'agent'
    ])
  })

  it('journals a historical user edit and removes it with its floor', () => {
    floor(db, 4, { stat_data: { choice: 'old' } })
    floor(db, 5, { stat_data: { choice: 'old' } })
    const state = createFloorState({ db: db as never })

    state.append('chat', 4, 'user', [
      { kind: 'set', path: 'variables.stat_data.choice', value: 'new' }
    ])
    expect(variablesAt(db, 5)).toEqual({ stat_data: { choice: 'new' } })

    state.deleteFromFloor('chat', 4)
    expect(state.list('chat')).toEqual([])
  })

  it.each([
    [{ kind: 'set', path: 'stat_data.hp', value: 1 }],
    [{ kind: 'set', path: 'variables.__rpt.secret', value: 1 }],
    [{ kind: 'increment', path: 'variables.stat_data.hp', value: 'bad' }]
  ] as unknown as FloorStateOperation[][])(
    'rejects malformed or reserved operations without partial writes',
    (operations) => {
      floor(db, 2, { stat_data: { hp: 5 } })
      const state = createFloorState({ db: db as never })
      expect(() => state.append('chat', 2, 'user', operations)).toThrowError(FloorStateError)
      expect(variablesAt(db, 2)).toEqual({ stat_data: { hp: 5 } })
      expect(state.list('chat')).toEqual([])
    }
  )

  it('keeps result slots reserved for the Result Incorporation interface', () => {
    floor(db, 2, { stat_data: {} })
    const state = createFloorState({ db: db as never })
    const resultSlot = {
      kind: 'set' as const,
      path: 'variables.__rpt.agent_results.property.monthly',
      value: { income: 12 }
    }

    expect(() => state.append('chat', 2, 'agent', [resultSlot])).toThrowError(FloorStateError)
    state.incorporateAgent('chat', 2, [resultSlot])
    expect(variablesAt(db, 2)).toEqual({
      stat_data: {},
      __rpt: { agent_results: { property: { monthly: { income: 12 } } } }
    })
  })

  it('rolls back every snapshot and operation when the last replayed floor fails', () => {
    floor(db, 1, { stat_data: { hp: 1 } })
    floor(db, 2, { stat_data: { hp: 1 } })
    const state = createFloorState({
      db: db as never,
      validateSnapshot: ({ floor, variables }) =>
        floor === 2 && (variables.stat_data as { hp?: number }).hp === 9
          ? 'floor 2 rejects hp 9'
          : undefined
    })

    expect(() =>
      state.append('chat', 1, 'agent', [{ kind: 'set', path: 'variables.stat_data.hp', value: 9 }])
    ).toThrowError(FloorStateError)
    expect(variablesAt(db, 1)).toEqual({ stat_data: { hp: 1 } })
    expect(variablesAt(db, 2)).toEqual({ stat_data: { hp: 1 } })
    expect(state.list('chat')).toEqual([])
  })

  it('rolls back earlier snapshot updates and the journal row on a SQLite failure at the suffix tail', () => {
    floor(db, 1, { stat_data: { hp: 1 } })
    floor(db, 2, { stat_data: { hp: 1 } })
    db.exec(`
      CREATE TRIGGER reject_floor_2_variables
      BEFORE UPDATE OF variables ON floors
      WHEN NEW.floor = 2
      BEGIN
        SELECT RAISE(ABORT, 'floor 2 persistence rejected');
      END;
    `)
    const state = createFloorState({ db: db as never })

    expect(() =>
      state.append('chat', 1, 'user', [{ kind: 'set', path: 'variables.stat_data.hp', value: 9 }])
    ).toThrow()
    expect(variablesAt(db, 1)).toEqual({ stat_data: { hp: 1 } })
    expect(variablesAt(db, 2)).toEqual({ stat_data: { hp: 1 } })
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM floor_operations').get() as { n: number }).n
    ).toBe(0)
  })

  it('cancels before commit when transcript text changes during calculation', () => {
    floor(db, 1, { stat_data: { hp: 1 } })
    floor(db, 2, { stat_data: { hp: 1 } })
    const state = createFloorState({
      db: db as never,
      beforeCommit: () => {
        db.prepare('UPDATE floors SET response_content = ? WHERE chat_id = ? AND floor = ?').run(
          'edited concurrently',
          'chat',
          2
        )
      }
    })

    expect(() =>
      state.append('chat', 1, 'agent', [{ kind: 'set', path: 'variables.stat_data.hp', value: 9 }])
    ).toThrowError(FloorStateError)
    expect(variablesAt(db, 1)).toEqual({ stat_data: { hp: 1 } })
    expect(variablesAt(db, 2)).toEqual({ stat_data: { hp: 1 } })
    expect(state.list('chat')).toEqual([])
  })

  it('imports legacy vars_ops without changing or removing the legacy rows', () => {
    floor(db, 0, { stat_data: {} })
    const state = createFloorState({ db: db as never })
    state.setBaseline('chat', { stat_data: {} })
    db.prepare(
      `INSERT INTO vars_ops (chat_id, floor, seq, kind, payload)
       VALUES (?, ?, ?, ?, ?)`
    ).run('chat', 0, 0, 'patch', JSON.stringify([{ op: 'add', path: '/choice', value: 'mage' }]))
    state.replay('chat', 0)

    expect(variablesAt(db, 0)).toEqual({
      stat_data: { choice: 'mage' },
      delta_data: [{ path: 'choice', new: 'mage' }]
    })
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM vars_ops WHERE chat_id = ?').get('chat') as {
          n: number
        }
      ).n
    ).toBe(1)
    expect(state.list('chat')).toHaveLength(1)
  })

  it('reports a malformed legacy operation as a typed failure without partial writes', () => {
    floor(db, 0, { stat_data: { intact: true } })
    db.prepare(
      `INSERT INTO vars_ops (chat_id, floor, seq, kind, payload)
       VALUES (?, ?, ?, ?, ?)`
    ).run('chat', 0, 0, 'patch', '{bad json')
    const state = createFloorState({ db: db as never })

    expect(() => state.replay('chat', 0)).toThrowError(FloorStateError)
    expect(variablesAt(db, 0)).toEqual({ stat_data: { intact: true } })
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM floor_operations').get() as {
          n: number
        }
      ).n
    ).toBe(0)
  })

  it('does not create a floor during a state refresh', () => {
    const state = createFloorState({ db: db as never })
    expect(() => state.replay('chat', 7)).toThrowError(FloorStateError)
    expect((db.prepare('SELECT COUNT(*) AS n FROM floors').get() as { n: number }).n).toBe(0)
  })
})
