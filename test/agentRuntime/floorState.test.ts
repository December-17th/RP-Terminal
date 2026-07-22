import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))
vi.mock('../../src/main/services/logService', () => ({ log: vi.fn() }))

import Adapter from '../mocks/betterSqlite3Node'
import { SESSION_SCHEMA } from '../../src/main/services/sessionDbService'
import {
  computeFloorSuffix,
  createFloorState,
  FloorStateError,
  setCombatModeResolver,
  type FloorStateOperation
} from '../../src/main/services/agentRuntime/floorState/FloorState'
import { foldState } from '../../src/main/services/generation/foldState'
import { parseContent, stripThinking } from '../../src/main/parsers/contentParser'
import { parseMvuCommands } from '../../src/main/parsers/mvuParser'

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

  // The combat cue is a PER-TURN signal (foldState drops any inherited cue each turn). Replay must
  // fold it the same way, or an "Enter Combat" banner resurrected by a replay never clears again.
  it('drops an inherited combat cue on a replayed floor that emits no <rpt-combat-start>', () => {
    floor(db, 0, {
      stat_data: { hp: 10 },
      combat_cue: { enemies: 'Bandit x2', map: 'road', mode: 'grid' }
    })
    floor(
      db,
      1,
      { stat_data: { hp: 10 }, combat_cue: { enemies: 'Bandit x2', map: 'road', mode: 'grid' } },
      'You keep talking; the moment passes, no fight.'
    )
    const state = createFloorState({ db: db as never })

    state.replay('chat', 1)

    expect(variablesAt(db, 1)).toEqual({ stat_data: { hp: 10 } })
  })

  // ── build-time {{setvar}} (source 'template') ─────────────────────────────────────────────────
  //
  // Assembly mutates the working variables IN PLACE before the model turn exists, so those writes
  // reach the stored floor but are NOT re-derivable from the response. Without a journal entry any
  // replay (an edit of an EARLIER floor is the everyday trigger) rebuilds the floor without them.

  it('drops an UNJOURNALED build-time setvar value when an earlier floor is edited', () => {
    floor(db, 0, { stat_data: { hp: 10 } }, 'Opening.')
    floor(db, 1, { stat_data: { hp: 10 }, campaign_flag: 'planted-at-build' }, 'Second.')
    const state = createFloorState({ db: db as never })
    state.setBaseline('chat', { stat_data: { hp: 10 } })

    state.updateTranscript('chat', [{ floor: 0, responseContent: 'Opening, edited.' }])

    expect(variablesAt(db, 1)).toEqual({ stat_data: { hp: 10 } })
  })

  it('keeps a journaled build-time setvar value when an earlier floor is edited', () => {
    floor(db, 0, { stat_data: { hp: 10 } }, 'Opening.')
    floor(db, 1, { stat_data: { hp: 10 }, campaign_flag: 'planted-at-build' }, 'Second.')
    const state = createFloorState({ db: db as never })
    state.setBaseline('chat', { stat_data: { hp: 10 } })
    state.journal('chat', 1, 'template', [
      { kind: 'set', path: 'variables.campaign_flag', value: 'planted-at-build' }
    ])

    state.updateTranscript('chat', [{ floor: 0, responseContent: 'Opening, edited.' }])

    expect(variablesAt(db, 1)).toEqual({
      stat_data: { hp: 10 },
      campaign_flag: 'planted-at-build'
    })
  })

  it('applies a template operation before the model fold and every other source after it', () => {
    floor(db, 0, {}, "<UpdateVariable>\n_.add('gold', 2);\n</UpdateVariable>")
    const state = createFloorState({ db: db as never })
    state.setBaseline('chat', { stat_data: { gold: 0 } })
    state.journal('chat', 0, 'template', [
      { kind: 'set', path: 'variables.stat_data.gold', value: 10 }
    ])
    state.journal('chat', 0, 'user', [{ kind: 'set', path: 'variables.note', value: 'after' }])

    state.replay('chat', 0)

    // gold 12 (not 10) and a delta whose OLD value is 10 both prove the fold started from the
    // template write; `note` proves the user operation still lands after the fold.
    expect(variablesAt(db, 0)).toEqual({
      stat_data: { gold: 12 },
      delta_data: [{ path: 'gold', old: 10, new: 12 }],
      note: 'after'
    })
  })

  it('migrates a session DB whose floor_operations predates the template source', () => {
    const legacy = new Adapter(':memory:')
    legacy.exec(SESSION_SCHEMA)
    // Recreate the table with the SHIPPED-BEFORE CHECK constraint — SQLite cannot ALTER one, which is
    // exactly why the migration has to rebuild the table.
    legacy.exec(`
      DROP TABLE floor_operations;
      CREATE TABLE floor_operations (
        chat_id TEXT NOT NULL,
        floor INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('model','card','user','agent')),
        kind TEXT NOT NULL CHECK(kind IN ('set','delete','increment','patch','legacy-patch','legacy-replace')),
        path TEXT NOT NULL,
        value TEXT,
        created_at TEXT,
        legacy_ref TEXT UNIQUE,
        PRIMARY KEY (chat_id, floor, seq)
      );`)
    const insert = (
      target: InstanceType<typeof Adapter>,
      seq: number,
      source: string
    ): unknown =>
      target
        .prepare(
          `INSERT INTO floor_operations (chat_id, floor, seq, source, kind, path, value)
           VALUES (?, ?, ?, ?, 'set', 'variables.flag', '"on"')`
        )
        .run('chat', 0, seq, source)
    insert(legacy, 0, 'card')
    expect(() => insert(legacy, 1, 'template')).toThrow()

    createFloorState({ db: legacy as never })

    insert(legacy, 1, 'template')
    expect(
      legacy.prepare('SELECT seq, source, path FROM floor_operations ORDER BY seq').all()
    ).toEqual([
      { seq: 0, source: 'card', path: 'variables.flag' },
      { seq: 1, source: 'template', path: 'variables.flag' }
    ])
    legacy.close()
  })

  // OWNER DECISION (supersedes the pinned `BASELINE_NOT_FOUND` throw). A save written before
  // floor-state baselines existed can hold legacy `vars_ops` rows with no `floor_state_baselines`
  // row, so floor 0 has no pre-floor snapshot to replay FROM — and its stored variables already
  // contain the model fold and the applied operation, so re-deriving from them would double-apply.
  // Replay now SKIPS floor 0 instead of refusing the whole chat (the renderer's Re-evaluate button
  // and every card write route through here): floor 0's stored variables seed floors 1..N.
  it('skips an unreplayable floor 0 of a legacy save and replays the rest from its stored state', () => {
    floor(db, 0, { stat_data: { gold: 5 } })
    floor(
      db,
      1,
      { stat_data: { gold: 5 } },
      "<UpdateVariable>\n_.add('gold', 2);\n</UpdateVariable>"
    )
    db.prepare(
      `INSERT INTO vars_ops (chat_id, floor, seq, kind, payload)
       VALUES (?, ?, ?, ?, ?)`
    ).run('chat', 0, 0, 'patch', JSON.stringify([{ op: 'add', path: '/gold', value: 5 }]))
    const state = createFloorState({ db: db as never })

    const suffix = state.replay('chat', 0)

    // Floor 0 stands exactly as stored — never re-derived, so the legacy patch is not applied twice.
    expect(variablesAt(db, 0)).toEqual({ stat_data: { gold: 5 } })
    expect(suffix.map((snapshot) => snapshot.floor)).toEqual([1])
    expect(variablesAt(db, 1)).toEqual({
      stat_data: { gold: 7 },
      delta_data: [{ path: 'gold', old: 5, new: 7 }]
    })
    // No baseline row is invented: this seed is the state AFTER floor 0, not before it.
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM floor_state_baselines').get() as { n: number }
      ).n
    ).toBe(0)
  })

  it('replays nothing (and announces nothing) when the skipped floor 0 is the only floor', () => {
    floor(db, 0, { stat_data: { gold: 5 } })
    db.prepare(
      `INSERT INTO vars_ops (chat_id, floor, seq, kind, payload)
       VALUES (?, ?, ?, ?, ?)`
    ).run('chat', 0, 0, 'patch', JSON.stringify([{ op: 'add', path: '/gold', value: 5 }]))
    const refresh = vi.fn()
    const state = createFloorState({ db: db as never, onStateRefresh: refresh })

    expect(state.replay('chat', 0)).toEqual([])
    expect(refresh).not.toHaveBeenCalled()
    expect(variablesAt(db, 0)).toEqual({ stat_data: { gold: 5 } })
  })

  // A card's `combat` bundle picks which system an `<rpt-combat-start>` cue opens, and only the
  // composition root can see it (floorState/index.ts registers the resolver). Unresolved, replay
  // would silently downgrade a duel card's cue to 'grid' on every re-fold.
  it('stamps the resolved combat mode on a replayed cue instead of defaulting to grid', () => {
    floor(db, 0, { stat_data: { hp: 10 } }, 'Opening.')
    floor(
      db,
      1,
      { stat_data: { hp: 10 } },
      'They draw steel.\n<rpt-combat-start enemies="Bandit x2" map="road"></rpt-combat-start>'
    )
    const duel = createFloorState({ db: db as never, resolveCombatMode: () => 'duel' })

    duel.replay('chat', 1)

    expect(variablesAt(db, 1).combat_cue).toMatchObject({
      enemies: 'Bandit x2',
      map: 'road',
      mode: 'duel'
    })

    // Same transcript, no resolver — the documented 'grid' default.
    createFloorState({ db: db as never }).replay('chat', 1)
    expect(variablesAt(db, 1).combat_cue).toMatchObject({ mode: 'grid' })
  })

  // The resolver is registered process-wide rather than injected per construction, because two
  // construction sites cannot go through `floorStateForChat`: floorService's deletion path and
  // Agent Result Incorporation (InvocationRuntimeService builds `createFloorState({ db })` with its
  // own transaction-scoped db). Incorporation REPLAYS, so an uninherited resolver silently
  // downgraded a duel card's cue to 'grid' on every incorporated Agent result.
  it('inherits the registered combat mode in a bare createFloorState, incorporation included', () => {
    floor(db, 0, { stat_data: { hp: 10 } }, 'Opening.')
    floor(
      db,
      1,
      { stat_data: { hp: 10 } },
      'They draw steel.\n<rpt-combat-start enemies="Bandit x2" map="road"></rpt-combat-start>'
    )
    setCombatModeResolver(() => 'duel')
    try {
      // Constructed EXACTLY as InvocationRuntimeService.incorporate does — no injected dependency.
      createFloorState({ db: db as never }).incorporateAgent('chat', 1, [
        { kind: 'set', path: 'variables.stat_data.scouted', value: true }
      ])
    } finally {
      setCombatModeResolver(null)
    }

    expect(variablesAt(db, 1)).toMatchObject({
      stat_data: { hp: 10, scouted: true },
      combat_cue: { enemies: 'Bandit x2', map: 'road', mode: 'duel' }
    })
  })

  it('lets an injected resolveCombatMode override the registered resolver', () => {
    floor(db, 0, { stat_data: {} }, 'Opening.')
    floor(db, 1, { stat_data: {} }, '<rpt-combat-start enemies="Bandit x2"></rpt-combat-start>')
    setCombatModeResolver(() => 'duel')
    try {
      createFloorState({ db: db as never, resolveCombatMode: () => 'grid' }).replay('chat', 1)
    } finally {
      setCombatModeResolver(null)
    }

    expect(variablesAt(db, 1).combat_cue).toMatchObject({ mode: 'grid' })
  })

  // Yuzu's Scene Director annotates a response that was ALREADY folded at commit time.
  it('writes transcript text without re-folding when refold is false', () => {
    floor(db, 0, { stat_data: { gold: 1 } }, 'Opening.')
    floor(
      db,
      1,
      { stat_data: { gold: 3 } },
      "<UpdateVariable>\n_.add('gold', 2);\n</UpdateVariable>"
    )
    const refresh = vi.fn()
    const state = createFloorState({ db: db as never, onStateRefresh: refresh })

    expect(
      state.updateTranscript('chat', [{ floor: 1, responseContent: 'annotated, no MVU' }], {
        refold: false
      })
    ).toEqual([])

    expect(
      (
        db
          .prepare('SELECT response_content FROM floors WHERE chat_id = ? AND floor = ?')
          .get('chat', 1) as { response_content: string }
      ).response_content
    ).toBe('annotated, no MVU')
    // A re-fold of that text would have dropped the MVU result back to the seed; it stands.
    expect(variablesAt(db, 1)).toEqual({ stat_data: { gold: 3 } })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('folds one model turn identically through foldState and computeFloorSuffix', () => {
    const raw =
      'The bandits attack!\n' +
      '<rpt-event type="state" action="add" path="stat_data.gold" value="3" />\n' +
      "<UpdateVariable>\n_.add('hp', -2);\n</UpdateVariable>\n" +
      '<rpt-combat-start enemies="Bandit x2" map="road"></rpt-combat-start>'
    const seed = {
      stat_data: { gold: 1, hp: 10 },
      combat_cue: { enemies: 'Stale x1', map: 'old', mode: 'grid' }
    }
    const parsed = parseContent(stripThinking(raw))
    const mvu = parseMvuCommands(parsed.text)

    const live = JSON.parse(JSON.stringify(seed)) as Record<string, unknown>
    foldState(
      { workingVars: live, chat: { floor_count: 1 }, card: { data: {} } } as never,
      parsed,
      mvu,
      raw
    )
    const [replayed] = computeFloorSuffix(
      [{ floor: 1, response: raw, events: parsed.events, variables: {} }],
      [],
      seed
    )

    expect(replayed.variables).toEqual(live)
    expect((live.combat_cue as { enemies: string }).enemies).toBe('Bandit x2')
  })
})
