// Build-time setvar capture: the WRITE-RECORDING half.
//
// The original capture DIFFED `workingVars` across assembly. A diff can record that state CHANGED; it
// cannot record that a WRITE HAPPENED — so `setvar('x', 1)` while `x` is already `1` journaled nothing,
// and an edit of an earlier floor then replayed the floor with whatever it inherited instead of the
// value live assembly forced. That is precisely the case the journal exists for.
//
// These pin the fix: BOTH build-time dialects — the EJS engine and the `{{setvar}}` / `{{addvar}}`
// MACROS in shared/macros.ts, which never enter the engine — report every write through the SAME
// `onVarWrite` contract into ONE recorder, and capture journals the FINAL value at each recorded path.
// The diff stays on as a SECOND PATH SOURCE (never a second value source) for the one writer no hook can
// describe: the engine's keyless wholesale `setvar(null, {…})`, which has no path to report.
import { describe, it, expect, beforeAll, vi } from 'vitest'

vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))
vi.mock('../../src/main/services/logService', () => ({ log: vi.fn() }))

import Adapter from '../mocks/betterSqlite3Node'
import { SESSION_SCHEMA } from '../../src/main/services/sessionDbService'
import { createFloorState } from '../../src/main/services/agentRuntime/floorState/FloorState'
import {
  captureTemplateWrites,
  createTemplateWriteRecorder,
  snapshotTemplateVars
} from '../../src/main/services/generation/assemble'
import {
  initTemplates,
  evalTemplate,
  buildTemplateContext
} from '../../src/main/services/templateService'
import { expandMacros } from '../../src/shared/macros'

describe('the EJS engine write hook (VarWriteHook)', () => {
  beforeAll(async () => {
    await initTemplates()
  })

  /** Run a template with a recording hook; returns the output plus one row per reported write. */
  const run = (
    source: string,
    vars: Record<string, unknown> = {},
    globals: Record<string, unknown> = {}
  ): {
    output: string
    writes: Array<{ path: string; kind: string; onFloorStore: boolean }>
    vars: Record<string, unknown>
    globals: Record<string, unknown>
  } => {
    const writes: Array<{ path: string; kind: string; onFloorStore: boolean }> = []
    const output = evalTemplate(
      source,
      buildTemplateContext(vars, {
        globals,
        onVarWrite: (path, kind, store) => writes.push({ path, kind, onFloorStore: store === vars })
      })
    )
    return { output, writes, vars, globals }
  }

  it('reports a setvar against the floor store', () => {
    const { writes, vars } = run("<% setvar('flag', 'ready') %>")
    expect(writes).toEqual([{ path: 'flag', kind: 'set', onFloorStore: true }])
    expect(vars.flag).toBe('ready')
  })

  it('reports the same-valued write a diff cannot see', () => {
    const { writes } = run("<% setvar('flag', 'ready') %>", { flag: 'ready' })
    expect(writes).toEqual([{ path: 'flag', kind: 'set', onFloorStore: true }])
  })

  it('reports delvar as a delete and incvar/decvar as sets', () => {
    const { writes } = run("<% delvar('gone'); incvar('n'); decvar('n') %>", { gone: 1, n: 5 })
    expect(writes).toEqual([
      { path: 'gone', kind: 'delete', onFloorStore: true },
      { path: 'n', kind: 'set', onFloorStore: true },
      { path: 'n', kind: 'set', onFloorStore: true }
    ])
  })

  it('reports the scope aliases that route to the floor store, and marks a global write as elsewhere', () => {
    // storeFor() sends EVERY non-global scope to ctx.vars — i.e. local/chat/message writes really do
    // land on the floor's variables. Only scope:'global' goes to the separate globals bag.
    const { writes, globals } = run(
      "<% setLocalVar('l', 1); setMessageVar('m', 2); setChatVar('c', 3); setGlobalVar('g', 4) %>"
    )
    expect(writes).toEqual([
      { path: 'l', kind: 'set', onFloorStore: true },
      { path: 'm', kind: 'set', onFloorStore: true },
      { path: 'c', kind: 'set', onFloorStore: true },
      { path: 'g', kind: 'set', onFloorStore: false }
    ])
    expect(globals.g).toBe(4)
  })

  it('is purely observational — same output, same return values, hook or no hook', () => {
    const source = "<%= setvar('x', 1) %>[<%= incvar('n', 2) %>][<%= getvar('x') %>]"
    const hooked = run(source, { n: 1 })
    const plain = evalTemplate(source, buildTemplateContext({ n: 1 }, {}))
    expect(hooked.output).toBe(plain)
    expect(hooked.output).toBe('[3][1]')
  })

  it('swallows a throwing hook without touching the write or the output', () => {
    const vars: Record<string, unknown> = {}
    const output = evalTemplate(
      "<% setvar('flag', 'ready') %>done",
      buildTemplateContext(vars, {
        onVarWrite: () => {
          throw new Error('recorder blew up')
        }
      })
    )
    expect(output).toBe('done')
    expect(vars.flag).toBe('ready')
  })
})

describe('the MACRO dialect write hook (shared/macros.ts)', () => {
  /** Expand macros with a recording hook; returns the output plus one row per reported write. */
  const run = (
    source: string,
    vars: Record<string, unknown> = {},
    globals: Record<string, unknown> = {}
  ): {
    output: string
    writes: Array<{ path: string; kind: string; onFloorStore: boolean }>
    vars: Record<string, unknown>
    globals: Record<string, unknown>
  } => {
    const writes: Array<{ path: string; kind: string; onFloorStore: boolean }> = []
    const output = expandMacros(source, {
      vars,
      globals,
      onVarWrite: (path, kind, store) => writes.push({ path, kind, onFloorStore: store === vars })
    })
    return { output, writes, vars, globals }
  }

  it('reports a {{setvar}} against the floor store', () => {
    const { writes, vars } = run('{{setvar::flag::ready}}')
    expect(writes).toEqual([{ path: 'flag', kind: 'set', onFloorStore: true }])
    expect(vars.flag).toBe('ready')
  })

  it('reports the same-valued write a diff cannot see', () => {
    const { writes } = run('{{setvar::flag::ready}}', { flag: 'ready' })
    expect(writes).toEqual([{ path: 'flag', kind: 'set', onFloorStore: true }])
  })

  it('reports {{addvar}} as a set', () => {
    const { writes, vars } = run('{{addvar::n::2}}', { n: 5 })
    expect(writes).toEqual([{ path: 'n', kind: 'set', onFloorStore: true }])
    expect(vars.n).toBe(7)
  })

  it('reports a nested/dotted path exactly as the macro wrote it', () => {
    const { writes, vars } = run('{{setvar::quest.step::3}}')
    expect(writes).toEqual([{ path: 'quest.step', kind: 'set', onFloorStore: true }])
    expect(vars).toEqual({ quest: { step: '3' } })
  })

  it('has NO variable-writing scope — the global bag is read-only to this dialect', () => {
    // {{getglobalvar}}/{{get_global_variable}} READ ctx.globals; there is no {{setglobalvar}} — an
    // unknown macro passes through verbatim, so nothing is written and nothing is reported.
    const { output, writes, globals, vars } = run(
      '{{getglobalvar::g}}|{{setglobalvar::g::9}}|{{set_global_variable::g::9}}',
      {},
      { g: 'seed' }
    )
    expect(output).toBe('seed|{{setglobalvar::g::9}}|{{set_global_variable::g::9}}')
    expect(writes).toEqual([])
    expect(globals).toEqual({ g: 'seed' })
    expect(vars).toEqual({})
  })

  it('is purely observational — same output, hook or no hook', () => {
    const source = '[{{setvar::x::1}}][{{addvar::n::2}}][{{getvar::x}}]'
    const hooked = run(source, { n: 1 })
    const plain = expandMacros(source, { vars: { n: 1 } })
    expect(hooked.output).toBe(plain)
    expect(hooked.output).toBe('[][][1]')
  })

  it('swallows a throwing hook without touching the write or the output', () => {
    const vars: Record<string, unknown> = {}
    const output = expandMacros('{{setvar::flag::ready}}done', {
      vars,
      onVarWrite: () => {
        throw new Error('recorder blew up')
      }
    })
    expect(output).toBe('done')
    expect(vars.flag).toBe('ready')
  })
})

describe('ONE recorder for BOTH dialects', () => {
  beforeAll(async () => {
    await initTemplates()
  })

  it('journals a macro {{setvar}} that wrote a value already present (the diff sees nothing)', () => {
    const vars: Record<string, unknown> = { difficulty: 'hard' }
    const recorder = createTemplateWriteRecorder(vars)
    const before = snapshotTemplateVars(vars)

    expandMacros('{{setvar::difficulty::hard}}', { vars, onVarWrite: recorder.onVarWrite })

    expect(recorder.paths()).toEqual(['difficulty'])
    expect(captureTemplateWrites(before, vars)).toEqual([])
    expect(captureTemplateWrites(before, vars, recorder.paths())).toEqual([
      { kind: 'set', path: 'variables.difficulty', value: 'hard' }
    ])
  })

  it('journals ONE operation with the final value when a macro and the engine write the same path', () => {
    const vars: Record<string, unknown> = { turn: 1 }
    const recorder = createTemplateWriteRecorder(vars)
    const before = snapshotTemplateVars(vars)

    expandMacros('{{setvar::turn::2}}', { vars, onVarWrite: recorder.onVarWrite })
    evalTemplate(
      "<% setvar('turn', 3) %>",
      buildTemplateContext(vars, { onVarWrite: recorder.onVarWrite })
    )

    expect(recorder.paths()).toEqual(['turn'])
    expect(captureTemplateWrites(before, vars, recorder.paths())).toEqual([
      { kind: 'set', path: 'variables.turn', value: 3 }
    ])
  })

  it('drops a macro write that landed on the L1 frozen snapshot instead of the floor store', () => {
    // promptBuilder renders the frozen frontier with `vars` swapped for `frozenVars` and forwards the
    // SAME hook — store identity is what keeps that phantom write out of the journal.
    const floorStore: Record<string, unknown> = {}
    const frozen: Record<string, unknown> = {}
    const recorder = createTemplateWriteRecorder(floorStore)

    expandMacros('{{setvar::stale::1}}', { vars: frozen, onVarWrite: recorder.onVarWrite })
    expandMacros('{{setvar::live::1}}', { vars: floorStore, onVarWrite: recorder.onVarWrite })

    expect(recorder.paths()).toEqual(['live'])
    expect(frozen).toEqual({ stale: '1' })
  })
})

describe('createTemplateWriteRecorder', () => {
  it('records only the writes that landed on the floor store, deduplicated in first-write order', () => {
    const floorStore: Record<string, unknown> = {}
    const globals: Record<string, unknown> = {}
    // The L1 frozen frontier renders against a SEPARATE snapshot (promptBuilder swaps `vars` for
    // `frozenVars`); a write there never reaches the floor, so journaling it would force a phantom value.
    const frozen: Record<string, unknown> = {}
    const recorder = createTemplateWriteRecorder(floorStore)

    recorder.onVarWrite('flag', 'set', floorStore)
    recorder.onVarWrite('secret', 'set', globals)
    recorder.onVarWrite('stale', 'set', frozen)
    recorder.onVarWrite('flag', 'delete', floorStore)

    expect(recorder.paths()).toEqual(['flag'])
  })
})

describe('captureTemplateWrites', () => {
  it('journals a recorded write whose value never changed', () => {
    const before = { flag: 'ready' }
    const after = { flag: 'ready' }

    // The diff alone is blind to it — this is the bug.
    expect(captureTemplateWrites(before, after)).toEqual([])
    expect(captureTemplateWrites(before, after, ['flag'])).toEqual([
      { kind: 'set', path: 'variables.flag', value: 'ready' }
    ])
  })

  it('journals ONE operation carrying the last value for a path written twice', () => {
    expect(captureTemplateWrites({ turn: 1 }, { turn: 3 }, ['turn', 'turn'])).toEqual([
      { kind: 'set', path: 'variables.turn', value: 3 }
    ])
  })

  it('journals a delete for a path written then deleted, and nothing when it never existed', () => {
    expect(captureTemplateWrites({ tmp: 'scratch' }, {}, ['tmp'])).toEqual([
      { kind: 'delete', path: 'variables.tmp' }
    ])
    expect(captureTemplateWrites({}, {}, ['tmp'])).toEqual([])
  })

  it('never journals the fold-owned roots or the runtime-owned __rpt subtree', () => {
    expect(
      captureTemplateWrites({}, { stat_data: { hp: 1 }, __rpt: { agent_results: {} } }, [
        'stat_data.hp',
        '__rpt.agent_results.x'
      ])
    ).toEqual([])
  })

  it('journals a nested write once, at the ancestor the diff already carries wholesale', () => {
    expect(captureTemplateWrites({}, { quest: { step: 3 } }, ['quest.step'])).toEqual([
      { kind: 'set', path: 'variables.quest', value: { step: 3 } }
    ])
  })

  it('truncates a recorded path that runs through a non-object container', () => {
    // The journal walks plain objects only (floorFold `variablesParentAt`), so `party[0].name` is
    // journaled at `party` wholesale rather than as an unreachable `variables.party.0.name`.
    expect(captureTemplateWrites({}, { party: [{ name: '苔' }] }, ['party[0].name'])).toEqual([
      { kind: 'set', path: 'variables.party', value: [{ name: '苔' }] }
    ])
  })

  it('still journals a changed value with no recorded path — the diff source stays load-bearing', () => {
    // Why the diff survives: the engine's KEYLESS wholesale replace `setvar(null, {…})`
    // (templateEngine.ts:334-345) clears the store and Object.assigns a new one. There is no path to
    // report, so the hook is silent and only a snapshot/diff can see the result.
    expect(captureTemplateWrites({ mood: 'calm' }, { mood: 'tense' })).toEqual([
      { kind: 'set', path: 'variables.mood', value: 'tense' }
    ])
    expect(captureTemplateWrites({ mood: 'calm' }, { replaced: true })).toEqual([
      { kind: 'set', path: 'variables.replaced', value: true },
      { kind: 'delete', path: 'variables.mood' }
    ])
  })

  it('snapshotTemplateVars clones the capturable roots so a later in-place fold cannot rewrite them', () => {
    const working = { stat_data: { hp: 10 }, quest: { step: 1 } }
    const snapshot = snapshotTemplateVars(working)
    working.quest.step = 2

    expect(snapshot).toEqual({ quest: { step: 1 } })
  })
})

describe('a same-valued build-time setvar survives an earlier-floor edit', () => {
  const seedFloor = (
    db: InstanceType<typeof Adapter>,
    number: number,
    variables: Record<string, unknown>,
    response: string
  ): void => {
    db.prepare(
      `INSERT INTO floors
        (chat_id, floor, timestamp, user_content, response_content, events, variables)
       VALUES (?, ?, ?, '', ?, '[]', ?)`
    ).run('chat', number, '2026-07-22T12:00:00.000Z', response, JSON.stringify(variables))
  }

  const variablesAt = (db: InstanceType<typeof Adapter>, number: number): Record<string, unknown> =>
    JSON.parse(
      (
        db
          .prepare('SELECT variables FROM floors WHERE chat_id = ? AND floor = ?')
          .get('chat', number) as { variables: string }
      ).variables
    )

  /** Floor 1's assembly ran `setvar('difficulty', 'hard')` against a store that ALREADY held 'hard'. */
  const seedChat = (): {
    db: InstanceType<typeof Adapter>
    state: ReturnType<typeof createFloorState>
  } => {
    const db = new Adapter(':memory:')
    db.exec(SESSION_SCHEMA)
    seedFloor(db, 0, { stat_data: { hp: 10 }, difficulty: 'hard' }, 'Opening.')
    seedFloor(db, 1, { stat_data: { hp: 10 }, difficulty: 'hard' }, 'Second.')
    const state = createFloorState({ db: db as never })
    state.setBaseline('chat', { stat_data: { hp: 10 }, difficulty: 'hard' })
    return { db, state }
  }

  it('loses the forced value when the same-valued write is not journaled (the old diff)', () => {
    const { db, state } = seedChat()
    expect(captureTemplateWrites({ difficulty: 'hard' }, { difficulty: 'hard' })).toEqual([])

    state.append('chat', 0, 'user', [{ kind: 'set', path: 'variables.difficulty', value: 'easy' }])

    expect(variablesAt(db, 1).difficulty).toBe('easy')
  })

  it('keeps the forced value once the recorded write is journaled', () => {
    const { db, state } = seedChat()
    state.journal(
      'chat',
      1,
      'template',
      captureTemplateWrites({ difficulty: 'hard' }, { difficulty: 'hard' }, ['difficulty'])
    )

    state.append('chat', 0, 'user', [{ kind: 'set', path: 'variables.difficulty', value: 'easy' }])

    expect(variablesAt(db, 0).difficulty).toBe('easy')
    expect(variablesAt(db, 1).difficulty).toBe('hard')
  })

  it('keeps the forced value when the same-valued write came from the MACRO dialect', () => {
    const { db, state } = seedChat()
    // Floor 1's assembly ran `{{setvar::difficulty::hard}}` against a store that ALREADY held 'hard' —
    // the same hole as the engine's, one dialect over, now closed by the same recorder.
    const vars: Record<string, unknown> = { stat_data: { hp: 10 }, difficulty: 'hard' }
    const recorder = createTemplateWriteRecorder(vars)
    const before = snapshotTemplateVars(vars)
    expandMacros('{{setvar::difficulty::hard}}', { vars, onVarWrite: recorder.onVarWrite })
    state.journal('chat', 1, 'template', captureTemplateWrites(before, vars, recorder.paths()))

    state.append('chat', 0, 'user', [{ kind: 'set', path: 'variables.difficulty', value: 'easy' }])

    expect(variablesAt(db, 0).difficulty).toBe('easy')
    expect(variablesAt(db, 1).difficulty).toBe('hard')
  })
})
