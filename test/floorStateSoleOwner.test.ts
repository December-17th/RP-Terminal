import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * FloorState is the SOLE writer of `floors.variables`.
 *
 * Two consequences are pinned here, over the REAL SQLite stack (node:sqlite adapter + SESSION_SCHEMA,
 * the harness from test/agentRuntime/floorState.test.ts):
 *  1. `saveFloor`'s upsert no longer writes `variables` on the UPDATE branch, so a caller that
 *     round-tripped a floor it read BEFORE a journaled write can no longer clobber that write.
 *  2. The two writers that used to reach the column outside the journal now go through FloorState:
 *     `pluginService.pluginVars` (a card/script variable write — journaled, so a later replay
 *     re-applies it) and `pluginService.setMessage` (a card text edit — re-folded, epoch-bumped and
 *     listener-announced exactly like the UI edit path `floorService.updateFloorFields`, because both
 *     now call the ONE transcript-edit operation, `floorService.editFloorTranscript`).
 */

vi.mock('better-sqlite3', () => import('./mocks/betterSqlite3Node'))
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))

const harness = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof Adapter> }))

// The CENTRAL index only receives the denormalized chat summary (refreshChatSummary); floors and the
// journal live in the per-chat session DB below.
vi.mock('../src/main/services/db', () => ({
  getDb: () => ({
    prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] })
  }),
  transact: (fn: () => unknown) => fn()
}))

vi.mock('../src/main/services/sessionDbService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/sessionDbService')>()
  return { ...actual, getSessionDbByChat: () => harness.db }
})

vi.mock('../src/main/services/chatService', () => ({
  getChat: (_profileId: string, chatId: string) => ({
    floor_count: (
      harness.db.prepare('SELECT COUNT(*) AS n FROM floors WHERE chat_id = ?').get(chatId) as {
        n: number
      }
    ).n
  }),
  appendFloor: vi.fn(),
  truncateFloors: vi.fn()
}))

import Adapter from './mocks/betterSqlite3Node'
import { SESSION_SCHEMA } from '../src/main/services/sessionDbService'
import {
  addSwipe,
  getFloor,
  onTranscriptEdited,
  saveFloor,
  setActiveSwipe,
  transcriptEpoch,
  updateActiveFloorResponse,
  updateFloorFields
} from '../src/main/services/floorService'
import { createFloorState } from '../src/main/services/agentRuntime/floorState/FloorState'
import { setCombatModeResolver } from '../src/main/services/agentRuntime/floorState'
import { pluginVars, setMessage } from '../src/main/services/pluginService'

const seedFloor = (
  chatId: string,
  floor: number,
  variables: Record<string, unknown>,
  response = ''
): void => {
  harness.db
    .prepare(
      `INSERT INTO floors
        (chat_id, floor, timestamp, user_content, response_content, events, variables)
       VALUES (?, ?, ?, '', ?, '[]', ?)`
    )
    .run(chatId, floor, '2026-07-22T00:00:00.000Z', response, JSON.stringify(variables))
}

const variablesAt = (chatId: string, floor: number): Record<string, unknown> =>
  JSON.parse(
    (
      harness.db
        .prepare('SELECT variables FROM floors WHERE chat_id = ? AND floor = ?')
        .get(chatId, floor) as { variables: string }
    ).variables
  )

const journalRows = (chatId: string): number =>
  (
    harness.db
      .prepare('SELECT COUNT(*) AS n FROM floor_operations WHERE chat_id = ?')
      .get(chatId) as { n: number }
  ).n

describe('FloorState is the sole writer of floors.variables', () => {
  beforeEach(() => {
    harness.db = new Adapter(':memory:')
    harness.db.exec(SESSION_SCHEMA)
  })

  it('saveFloor cannot clobber variables that a journaled write already published', () => {
    seedFloor('stale', 0, { stat_data: { gold: 1 } })
    // The snapshot a caller read BEFORE the journaled write (swipe restore, metrics backfill, …).
    const readEarlier = getFloor('p', 'stale', 0)!
    createFloorState({ db: harness.db as never }).append('stale', 0, 'card', [
      { kind: 'set', path: 'variables.stat_data.gold', value: 99 }
    ])
    expect(variablesAt('stale', 0)).toEqual({ stat_data: { gold: 99 } })

    saveFloor('p', 'stale', {
      ...readEarlier,
      response: { ...readEarlier.response, content: 'restored' }
    })

    // The journaled value stands; every other column the stale floor carries is still written.
    expect(variablesAt('stale', 0)).toEqual({ stat_data: { gold: 99 } })
    expect(
      (
        harness.db
          .prepare('SELECT response_content FROM floors WHERE chat_id = ? AND floor = ?')
          .get('stale', 0) as { response_content: string }
      ).response_content
    ).toBe('restored')
  })

  it('journals a card variable write so a later replay re-applies it', () => {
    for (const floor of [0, 1, 2]) seedFloor('script', floor, { stat_data: { gold: 1 } })

    const result = pluginVars('p', 'script', {
      op: 'set',
      scope: 'message',
      messageId: 1,
      key: 'stat_data.gold',
      value: 42
    })

    expect(result).toEqual({ value: 42, scope: 'message', store: { stat_data: { gold: 42 } } })
    expect(variablesAt('script', 1)).toEqual({ stat_data: { gold: 42 } })
    expect(variablesAt('script', 2)).toEqual({ stat_data: { gold: 42 } })
    expect(journalRows('script')).toBe(1)

    // A later replay from an EARLIER floor (a user edit upstream) re-folds floors 1..2 from scratch.
    updateFloorFields('p', 'script', 0, null, 'the user rewrites an earlier reply')

    expect(variablesAt('script', 1)).toEqual({ stat_data: { gold: 42 } })
    expect(variablesAt('script', 2)).toEqual({ stat_data: { gold: 42 } })
  })

  it('keeps a get a pure read — no journal row, no republished floor', () => {
    seedFloor('read', 0, { stat_data: { gold: 7 } })

    expect(pluginVars('p', 'read', { op: 'get', key: 'stat_data.gold' })).toEqual({
      value: 7,
      scope: 'local',
      store: { stat_data: { gold: 7 } }
    })
    expect(journalRows('read')).toBe(0)
    expect(variablesAt('read', 0)).toEqual({ stat_data: { gold: 7 } })
  })

  it('journals inc/dec RELATIVELY, so a re-fold that moves the base carries the card write along', () => {
    seedFloor('inc', 0, { stat_data: { gold: 1 } })
    seedFloor(
      'inc',
      1,
      { stat_data: { gold: 3 } },
      "<UpdateVariable>\n_.add('gold', 2);\n</UpdateVariable>"
    )

    const bonus = pluginVars('p', 'inc', {
      op: 'inc',
      scope: 'message',
      messageId: 1,
      key: 'stat_data.gold',
      value: 5
    })
    expect(bonus.value).toBe(8) // the base the card observed (1 + 2) plus its own +5
    expect((variablesAt('inc', 1).stat_data as { gold: number }).gold).toBe(8)
    expect(
      harness.db.prepare('SELECT kind, path, value FROM floor_operations').get()
    ).toMatchObject({ kind: 'increment', path: 'variables.stat_data.gold', value: '5' })

    // The model fold underneath the write now yields a DIFFERENT base (1 + 10). A journaled `set 8`
    // would pin the old absolute; the relative +5 the card actually asked for rides on top.
    updateFloorFields(
      'p',
      'inc',
      1,
      null,
      "<UpdateVariable>\n_.add('gold', 10);\n</UpdateVariable>"
    )

    expect((variablesAt('inc', 1).stat_data as { gold: number }).gold).toBe(16)
  })

  it('keeps a set for the inc/dec cases FloorState cannot replay, and dec treats an absent base as 0', () => {
    seedFloor('coerce', 0, { stat_data: { label: '5' } })

    // An existing NON-NUMBER base: applyOp coerces it, replay would reject an increment there.
    expect(pluginVars('p', 'coerce', { op: 'inc', key: 'stat_data.label', value: 2 }).value).toBe(7)
    // An ABSENT base is 0 for both, so it stays a relative write.
    expect(pluginVars('p', 'coerce', { op: 'dec', key: 'stat_data.debt', value: 3 }).value).toBe(-3)

    expect(
      harness.db
        .prepare('SELECT kind FROM floor_operations WHERE chat_id = ? ORDER BY seq')
        .all('coerce')
    ).toEqual([{ kind: 'set' }, { kind: 'increment' }])
    expect(variablesAt('coerce', 0)).toEqual({ stat_data: { label: 7, debt: -3 } })
  })

  // A LIVE no-op must stay a no-op on replay. The journal's fall-through is an ABSOLUTE `set`, so
  // journaling an op that wrote nothing turns "leave this alone" into "pin this value".
  it('journals nothing for an insert onto a key that already exists', () => {
    seedFloor('insert', 0, { stat_data: { gold: 1 } })
    seedFloor(
      'insert',
      1,
      { stat_data: { gold: 3 } },
      "<UpdateVariable>\n_.add('gold', 2);\n</UpdateVariable>"
    )

    // `insert` = write only if absent. gold exists, so applyOp leaves it and returns what is there.
    const kept = pluginVars('p', 'insert', {
      op: 'insert',
      scope: 'message',
      messageId: 1,
      key: 'stat_data.gold',
      value: 99
    })
    expect(kept.value).toBe(3)
    expect(journalRows('insert')).toBe(0)
    expect((variablesAt('insert', 1).stat_data as { gold: number }).gold).toBe(3)

    // The model fold underneath moves the base to 1 + 10. A journaled `set 3` would replay over that
    // newer value with the stale one — the exact inversion of "do not overwrite an existing key".
    updateFloorFields(
      'p',
      'insert',
      1,
      null,
      "<UpdateVariable>\n_.add('gold', 10);\n</UpdateVariable>"
    )

    expect((variablesAt('insert', 1).stat_data as { gold: number }).gold).toBe(11)
  })

  it('journals a write that really wrote, and nothing for a set/del that changed nothing', () => {
    seedFloor('noop', 0, { stat_data: { gold: 7 } })

    // Rewriting the value already stored, and deleting a key that is not there.
    expect(pluginVars('p', 'noop', { op: 'set', key: 'stat_data.gold', value: 7 }).value).toBe(7)
    expect(pluginVars('p', 'noop', { op: 'del', key: 'stat_data.missing' }).value).toBeUndefined()
    expect(journalRows('noop')).toBe(0)

    // The SAME insert whose existing-key form journals nothing does journal on an absent key.
    expect(pluginVars('p', 'noop', { op: 'insert', key: 'stat_data.silver', value: 2 }).value).toBe(
      2
    )
    expect(harness.db.prepare('SELECT kind, path, value FROM floor_operations').get()).toMatchObject(
      { kind: 'set', path: 'variables.stat_data.silver', value: '2' }
    )
    expect(journalRows('noop')).toBe(1)
    expect(variablesAt('noop', 0)).toEqual({ stat_data: { gold: 7, silver: 2 } })
  })

  it('journals a nested delete, and a write through an array without flattening the array', () => {
    seedFloor('paths', 0, { stat_data: { party: [{ hp: 3 }], flag: true } })

    pluginVars('p', 'paths', { op: 'del', key: 'stat_data.flag' })
    const written = pluginVars('p', 'paths', {
      op: 'set',
      key: 'stat_data.party[0].hp',
      value: 9
    })

    expect(written.value).toBe(9)
    expect(variablesAt('paths', 0)).toEqual({ stat_data: { party: [{ hp: 9 }] } })
  })

  it('re-folds a card text edit exactly like the UI edit path, with the same epoch + listener', () => {
    for (const chatId of ['ui', 'card']) {
      seedFloor(chatId, 0, { stat_data: { gold: 1 } })
      seedFloor(
        chatId,
        1,
        { stat_data: { gold: 3 } },
        "<UpdateVariable>\n_.add('gold', 2);\n</UpdateVariable>"
      )
    }
    const edited = "<UpdateVariable>\n_.add('gold', 5);\n</UpdateVariable>"
    updateFloorFields('p', 'ui', 1, null, edited)

    const edits: number[] = []
    onTranscriptEdited((_profileId, chatId, floor) => {
      if (chatId === 'card') edits.push(floor)
    })
    const epochBefore = transcriptEpoch('card')

    expect(setMessage('p', 'card', 1, { response: edited })).toBe(true)

    expect((variablesAt('card', 1).stat_data as { gold: number }).gold).toBe(6)
    expect(variablesAt('card', 1)).toEqual(variablesAt('ui', 1))
    expect(transcriptEpoch('card')).toBe(epochBefore + 1)
    expect(edits).toEqual([1])
  })

  // The composition adapter (`floorStateForChat`) carries the registered chat→card combat-mode
  // resolver into every replaying write. Without it a duel card's cue is re-folded as 'grid'.
  it('carries the registered combat mode through a floorService replay', () => {
    const cue = 'They draw steel.\n<rpt-combat-start enemies="Bandit x2" map="road"></rpt-combat-start>'
    for (const chatId of ['duelcard', 'gridcard']) {
      seedFloor(chatId, 0, { stat_data: { hp: 10 } }, 'Opening.')
      seedFloor(chatId, 1, { stat_data: { hp: 10 } }, cue)
    }

    updateFloorFields('p', 'gridcard', 0, null, 'Opening, edited.')
    expect(variablesAt('gridcard', 1).combat_cue).toMatchObject({ mode: 'grid' })

    setCombatModeResolver(() => 'duel')
    try {
      updateFloorFields('p', 'duelcard', 0, null, 'Opening, edited.')
    } finally {
      setCombatModeResolver(null)
    }
    expect(variablesAt('duelcard', 1).combat_cue).toMatchObject({
      enemies: 'Bandit x2',
      map: 'road',
      mode: 'duel'
    })
  })

  // Yuzu's Scene Director annotates a response the commit already folded: presentation only.
  it('updateActiveFloorResponse rewrites the response text without re-folding stat_data', () => {
    seedFloor(
      'yuzu',
      0,
      { stat_data: { gold: 1 } },
      "The bell rings.\n<UpdateVariable>\n_.add('gold', 2);\n</UpdateVariable>"
    )
    // With a baseline present, a re-fold of floor 0 WOULD move gold 1 → 3; nothing may move it.
    createFloorState({ db: harness.db as never }).setBaseline('yuzu', { stat_data: { gold: 1 } })
    const edits: number[] = []
    onTranscriptEdited((_profileId, chatId, floor) => {
      if (chatId === 'yuzu') edits.push(floor)
    })
    const epochBefore = transcriptEpoch('yuzu')

    const annotated =
      "The bell rings.\n<UpdateVariable>\n_.add('gold', 2);\n</UpdateVariable>\n<stage mood=\"smile\" />"
    const updated = updateActiveFloorResponse('p', 'yuzu', 0, annotated)

    expect(updated?.response.content).toBe(annotated)
    expect(getFloor('p', 'yuzu', 0)?.response.content).toBe(annotated)
    expect(variablesAt('yuzu', 0)).toEqual({ stat_data: { gold: 1 } })
    expect(journalRows('yuzu')).toBe(0)
    expect(transcriptEpoch('yuzu')).toBe(epochBefore + 1)
    expect(edits).toEqual([0])
  })

  // Every in-place text edit IS the same operation, so the swipe paths carry the memory-maintain
  // staleness fence and the refill engine's edit signal exactly as the UI / card edits do.
  it('carries the epoch bump and the edit listener through the swipe paths too', () => {
    seedFloor('swipe', 0, { stat_data: { gold: 1 } }, 'first')
    const edits: number[] = []
    onTranscriptEdited((_profileId, chatId, floor) => {
      if (chatId === 'swipe') edits.push(floor)
    })
    const epochBefore = transcriptEpoch('swipe')

    expect(addSwipe('p', 'swipe', 0, 'second')?.response.content).toBe('second')
    expect(getFloor('p', 'swipe', 0)?.swipes).toEqual(['first', 'second'])
    expect(setActiveSwipe('p', 'swipe', 0, 0)?.response.content).toBe('first')
    expect(getFloor('p', 'swipe', 0)?.response.content).toBe('first')

    expect(transcriptEpoch('swipe')).toBe(epochBefore + 2)
    expect(edits).toEqual([0, 0])

    // An edit carrying NO text is the one case that does none of the four.
    updateFloorFields('p', 'swipe', 0, null, null)
    expect(transcriptEpoch('swipe')).toBe(epochBefore + 2)
    expect(edits).toEqual([0, 0])
  })
})
