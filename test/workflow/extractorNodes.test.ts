import { describe, it, expect, vi, beforeEach } from 'vitest'

// Extractor + variable nodes (extractor-nodes plan §2): vars.get/vars.save (floor/session
// variable read-write), context.history/context.card/context.persona (turn-context slices).

const floorSvc = vi.hoisted(() => ({
  getAllFloors: vi.fn(),
  saveFloor: vi.fn(),
  getFloor: vi.fn()
}))
vi.mock('../../src/main/services/floorService', () => floorSvc)

const chatVarsSvc = vi.hoisted(() => ({
  getChatCardVars: vi.fn(),
  setChatCardVars: vi.fn()
}))
vi.mock('../../src/main/services/chatCardVarsService', () => chatVarsSvc)

import { varsGet, varsSave } from '../../src/main/services/nodes/builtin/varsNodes'
import {
  contextHistory,
  contextCard,
  contextPersona,
  contextAction,
  contextParams
} from '../../src/main/services/nodes/builtin/contextNodes'
import { NodeRunFailure, RunContext, NodeImpl } from '../../src/main/services/nodes/types'

const ctx: RunContext = {
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
}

/** Mirrors the engine's node.config parsing: parse raw config through the impl's configSchema
 *  before handing it to run(), as NodeMeta (mvuNodes.test.ts pattern). */
const meta = (impl: NodeImpl, id: string, rawConfig: Record<string, unknown> = {}) => ({
  id,
  config: impl.configSchema ? (impl.configSchema.parse(rawConfig) as Record<string, unknown>) : {}
})

const gen = {
  profileId: 'p1',
  chatId: 'c1',
  userName: 'Ash',
  workingVars: { fallback: true },
  settings: {
    persona: { description: 'A wandering trainer.' }
  },
  card: {
    data: {
      name: 'Misty',
      description: 'A gym leader.',
      personality: 'Confident.',
      scenario: 'A rainy gym.',
      first_mes: 'Hello there.'
    }
  },
  floors: [
    {
      floor: 0,
      user_message: { content: 'Hi!' },
      response: { content: '<think>plan</think>Hello, trainer.' },
      variables: { custom: { note: 'floor0' }, stat_data: { hp: 5 } }
    },
    {
      floor: 1,
      user_message: { content: 'How are you?' },
      response: { content: 'I am well.' },
      variables: { custom: { note: 'floor1' }, stat_data: { hp: 8 } }
    }
  ]
}

beforeEach(() => {
  floorSvc.getAllFloors.mockReset()
  floorSvc.saveFloor.mockReset()
  floorSvc.getFloor.mockReset()
  chatVarsSvc.getChatCardVars.mockReset()
  chatVarsSvc.setChatCardVars.mockReset()
})

describe('vars.get', () => {
  it('case 1: floor scope reads latest-floor variables (custom key AND stat_data.hp)', () => {
    floorSvc.getAllFloors.mockReturnValue(gen.floors)
    const r1 = varsGet.run(ctx, { gen }, meta(varsGet, 'n1', { path: 'custom.note' }))
    expect(r1).toEqual({ outputs: { value: 'floor1', text: 'floor1' } })

    const r2 = varsGet.run(ctx, { gen }, meta(varsGet, 'n1', { path: 'stat_data.hp' }))
    expect(r2).toEqual({ outputs: { value: 8, text: '8' } })
  })

  it('case 2: session scope reads the chat KV', () => {
    chatVarsSvc.getChatCardVars.mockReturnValue({ world: { month: 3 } })
    const r = varsGet.run(
      ctx,
      { gen },
      meta(varsGet, 'n1', { scope: 'session', path: 'world.month' })
    )
    expect(r).toEqual({ outputs: { value: 3, text: '3' } })
    expect(chatVarsSvc.getChatCardVars).toHaveBeenCalledWith('p1', 'c1')
  })
})

describe('vars.save', () => {
  it('case 3: floor scope writes a custom path and persists via saveFloor; stat_data sibling untouched', () => {
    const last = {
      floor: 1,
      user_message: { content: 'x' },
      response: { content: 'y' },
      variables: { custom: { note: 'old' }, stat_data: { hp: 8 } }
    }
    const originalVariables = last.variables
    floorSvc.getAllFloors.mockReturnValue([gen.floors[0], last])
    const r = varsSave.run(
      ctx,
      { gen, value: 'new note' },
      meta(varsSave, 'n1', { path: 'custom.note' })
    )
    // context-epochs plan §1: a completed write now emits the `done: Any` ordering output.
    expect(r).toEqual({ outputs: { done: true } })
    expect(floorSvc.saveFloor).toHaveBeenCalledTimes(1)
    const [profileId, chatId, savedFloor] = floorSvc.saveFloor.mock.calls[0]
    expect(profileId).toBe('p1')
    expect(chatId).toBe('c1')
    expect(savedFloor.variables.custom.note).toBe('new note')
    expect(savedFloor.variables.stat_data).toEqual({ hp: 8 })
    // the `variables` object itself is a fresh copy (`{ ...last.variables }`, per plan §2.2) —
    // saveFloor gets a distinct object from the one `last` originally pointed to.
    expect(savedFloor.variables).not.toBe(originalVariables)
  })

  it('case 4: refuses stat_data.* -> NodeRunFailure kind B, code reserved-path, no save', () => {
    floorSvc.getAllFloors.mockReturnValue(gen.floors)
    let err: unknown
    try {
      varsSave.run(ctx, { gen, value: 99 }, meta(varsSave, 'n1', { path: 'stat_data.hp' }))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(NodeRunFailure)
    expect((err as NodeRunFailure).kind).toBe('B')
    expect((err as NodeRunFailure).code).toBe('reserved-path')
    expect(floorSvc.saveFloor).not.toHaveBeenCalled()
  })

  it('case 4b: refuses a bracket-index stat_data root (toParts, not a hand-rolled dot split)', () => {
    // A hand-rolled `.split('.')` would read the root of "stat_data[0].hp" as the literal
    // "stat_data[0]" (not "stat_data"), missing the guard — while setPath/getPath (which use
    // the SAME toParts dialect) would still resolve the write straight into stat_data. Using
    // toParts for the guard, as this node does, catches it.
    floorSvc.getAllFloors.mockReturnValue(gen.floors)
    let err: unknown
    try {
      varsSave.run(ctx, { gen, value: 99 }, meta(varsSave, 'n1', { path: 'stat_data[0].hp' }))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(NodeRunFailure)
    expect((err as NodeRunFailure).code).toBe('reserved-path')
    expect(floorSvc.saveFloor).not.toHaveBeenCalled()
  })

  it('case 5: session scope round-trips through get->setPath->set (whole-object write asserted)', () => {
    chatVarsSvc.getChatCardVars.mockReturnValue({ world: { month: 3 }, other: 'kept' })
    const r = varsSave.run(
      ctx,
      { gen, value: 4 },
      meta(varsSave, 'n1', { scope: 'session', path: 'world.month' })
    )
    expect(r).toEqual({ outputs: { done: true } })
    expect(chatVarsSvc.setChatCardVars).toHaveBeenCalledWith('p1', 'c1', {
      world: { month: 4 },
      other: 'kept'
    })
  })

  it('case 6: value === undefined -> { outputs: {} }, no writes', () => {
    const r = varsSave.run(
      ctx,
      { gen, value: undefined },
      meta(varsSave, 'n1', { path: 'custom.note' })
    )
    expect(r).toEqual({ outputs: {} })
    expect(floorSvc.getAllFloors).not.toHaveBeenCalled()
    expect(floorSvc.saveFloor).not.toHaveBeenCalled()
    expect(chatVarsSvc.getChatCardVars).not.toHaveBeenCalled()
    expect(chatVarsSvc.setChatCardVars).not.toHaveBeenCalled()
  })
})

describe('context.history', () => {
  it('case 7: transcript + messages for last N floors, thinking stripped', () => {
    const r = contextHistory.run(ctx, { gen }, meta(contextHistory, 'n1', {}))
    const outputs = r.outputs as { transcript: string; messages: unknown[] }
    expect(outputs.transcript).toBe(
      'User: Hi!\nAssistant: Hello, trainer.\nUser: How are you?\nAssistant: I am well.'
    )
    expect(outputs.messages).toEqual([
      { role: 'user', content: 'Hi!' },
      { role: 'assistant', content: 'Hello, trainer.' },
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: 'I am well.' }
    ])
  })

  it('case 8: include: "user" narrows both outputs', () => {
    const r = contextHistory.run(ctx, { gen }, meta(contextHistory, 'n1', { include: 'user' }))
    const outputs = r.outputs as { transcript: string; messages: unknown[] }
    expect(outputs.transcript).toBe('User: Hi!\nUser: How are you?')
    expect(outputs.messages).toEqual([
      { role: 'user', content: 'Hi!' },
      { role: 'user', content: 'How are you?' }
    ])
  })
})

describe('context.card', () => {
  it('case 9: single field; all contains labelled blocks', () => {
    const r1 = contextCard.run(ctx, { gen }, meta(contextCard, 'n1', {}))
    expect(r1).toEqual({ outputs: { text: 'A gym leader.' } })

    const r2 = contextCard.run(ctx, { gen }, meta(contextCard, 'n1', { field: 'all' }))
    const text = (r2.outputs as { text: string }).text
    expect(text).toContain('[name]\nMisty')
    expect(text).toContain('[description]\nA gym leader.')
    expect(text).toContain('[personality]\nConfident.')
    expect(text).toContain('[scenario]\nA rainy gym.')
  })
})

describe('context.persona', () => {
  it('case 10: name + description', () => {
    const r = contextPersona.run(ctx, { gen }, meta(contextPersona, 'n1', {}))
    expect(r).toEqual({ outputs: { name: 'Ash', text: 'A wandering trainer.' } })
  })
})

// Decomposed-default additions: expand flags + the two new extractors.
// interpolate() needs globals + userName + card name on gen (messageNodes.test.ts fixture shape).
const genExpand = {
  ...gen,
  userAction: 'Attack the gym!',
  globals: {},
  workingVars: { mood: 'stormy' },
  settings: { ...gen.settings, templates: { enabled: true } },
  card: {
    data: { ...gen.card.data, description: '{{char}} sizes up {{user}}. Mood: {{getvar::mood}}.' }
  },
  preset: { parameters: { temperature: 0.7, max_tokens: 2000 } },
  fsmEnabled: false,
  modeConfig: { max_output_tokens: 500 }
}

describe('context.card / context.persona expand flag', () => {
  it('expand: true runs macros over the card field ({{char}}/{{user}}/{{getvar}})', () => {
    const r = contextCard.run(ctx, { gen: genExpand }, meta(contextCard, 'n1', { expand: true }))
    expect(r).toEqual({ outputs: { text: 'Misty sizes up Ash. Mood: stormy.' } })
  })

  it('expand unset leaves the field raw (macros untouched)', () => {
    const r = contextCard.run(ctx, { gen: genExpand }, meta(contextCard, 'n1', {}))
    expect(r).toEqual({ outputs: { text: '{{char}} sizes up {{user}}. Mood: {{getvar::mood}}.' } })
  })

  it('persona expand: true expands the description', () => {
    const g = {
      ...genExpand,
      settings: { ...genExpand.settings, persona: { description: 'Trainer of {{char}}.' } }
    }
    const r = contextPersona.run(ctx, { gen: g }, meta(contextPersona, 'n1', { expand: true }))
    expect(r).toEqual({ outputs: { name: 'Ash', text: 'Trainer of Misty.' } })
  })
})

describe('context.action', () => {
  it('returns the pending user action text', () => {
    const r = contextAction.run(ctx, { gen: genExpand }, meta(contextAction, 'n1'))
    expect(r).toEqual({ outputs: { text: 'Attack the gym!' } })
  })
})

describe('context.params', () => {
  it('classic mode: the preset parameters pass through unchanged', () => {
    const r = contextParams.run(ctx, { gen: genExpand }, meta(contextParams, 'n1'))
    expect(r).toEqual({ outputs: { params: { temperature: 0.7, max_tokens: 2000 } } })
  })

  it('FSM mode caps max_tokens at the mode limit, never above the preset', () => {
    const fsm = { ...genExpand, fsmEnabled: true, modeConfig: { max_output_tokens: 500 } }
    const r = contextParams.run(ctx, { gen: fsm }, meta(contextParams, 'n1'))
    expect(r).toEqual({ outputs: { params: { temperature: 0.7, max_tokens: 500 } } })

    // Preset BELOW the mode cap: the preset value wins.
    const low = { ...fsm, preset: { parameters: { max_tokens: 300 } } }
    const r2 = contextParams.run(ctx, { gen: low }, meta(contextParams, 'n1'))
    expect(r2).toEqual({ outputs: { params: { max_tokens: 300 } } })

    // Preset without max_tokens: the mode limit applies.
    const unset = { ...fsm, preset: { parameters: { temperature: 1 } } }
    const r3 = contextParams.run(ctx, { gen: unset }, meta(contextParams, 'n1'))
    expect(r3).toEqual({ outputs: { params: { temperature: 1, max_tokens: 500 } } })
  })
})
