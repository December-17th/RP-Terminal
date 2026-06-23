import { describe, it, expect, beforeAll } from 'vitest'
import { buildPrompt, ChatMessage } from '../src/main/services/promptBuilder'
import { stablePrefixTokens } from '../src/main/services/promptCacheMetrics'
import { frozenVarsFor } from '../src/main/services/cacheLayers'
import { RPTerminalCardSchema, LorebookSchema } from '../src/main/types/character'
import { initTemplates } from '../src/main/services/templateService'

// A card whose lorebook embeds live state via EJS (命定之诗 shape).
const card = (): any => RPTerminalCardSchema.parse({ data: { name: 'Aria' } })
const book = (): any =>
  LorebookSchema.parse({
    name: 'B',
    entries: [
      { comment: 'core', content: '好感度:<%= getvar("stat_data.主角.好感度") %>', constant: true }
    ]
  })
const preset = (): any => ({
  name: 'P',
  parameters: { temperature: 0.9, max_tokens: 100 },
  prompts: [
    { identifier: 'cd', name: 'cd', role: 'system', content: '', enabled: true, marker: 'char_description' },
    { identifier: 'wi', name: 'wi', role: 'system', content: '', enabled: true, marker: 'world_info' },
    { identifier: 'ch', name: 'ch', role: 'system', content: '', enabled: true, marker: 'chat_history' }
  ]
})
const floor = (n: number, user: string, resp: string, hp: number): any => ({
  floor: n,
  chat_id: 'c',
  timestamp: 't',
  user_message: { content: user, timestamp: 't' },
  response: { content: resp, model: '', provider: '' },
  events: [],
  variables: { stat_data: { 主角: { 好感度: hp } } }
})

// Assemble turn N at a given cache level/mode, with state that changes every turn.
const assemble = (
  turn: number,
  cacheLevel: number,
  l1Mode: 'partition' | 'diff'
): ChatMessage[] => {
  const floors = Array.from({ length: turn }, (_, i) => floor(i, `u${i}`, `a${i}`, 10 + i * 5))
  const floor0Vars = floors[0]?.variables ?? { stat_data: { 主角: { 好感度: 10 } } }
  const liveVars = { stat_data: { 主角: { 好感度: 10 + turn * 5 } } }
  return buildPrompt({
    card: card(),
    preset: preset(),
    lorebooks: [book()],
    floors,
    userAction: `act ${turn}`,
    cacheLevel,
    l1Mode,
    frozenVars: cacheLevel >= 1 ? frozenVarsFor(l1Mode, floor0Vars) : {},
    template: { vars: liveVars, globals: {}, constants: {} }
  })
}

describe('cache A/B — stable-prefix proxy across L0 / L1a / L1b', () => {
  beforeAll(async () => {
    await initTemplates()
  })

  it('L0 poisons the frontier: the World Info segment is NOT in the stable prefix', () => {
    const t1 = assemble(1, 0, 'partition')
    const t2 = assemble(2, 0, 'partition')
    // The world-info message renders live 好感度, so it differs turn-to-turn → low prefix.
    const wiIdx = t2.findIndex((m) => m.content.startsWith('World Info:'))
    const prefix = stablePrefixTokens(t1, t2)
    expect(prefix.messages).toBeLessThanOrEqual(wiIdx) // cache dies at/before the WI message
  })

  it('L1a (partition) keeps the frontier stable: prefix reaches past World Info', () => {
    const t1 = assemble(1, 1, 'partition')
    const t2 = assemble(2, 1, 'partition')
    const wiIdx = t2.findIndex((m) => m.content.startsWith('World Info:'))
    const prefix = stablePrefixTokens(t1, t2)
    expect(prefix.messages).toBeGreaterThan(wiIdx) // World Info now inside the stable prefix
  })

  it('L1b (diff) also keeps the frontier stable', () => {
    const t1 = assemble(1, 1, 'diff')
    const t2 = assemble(2, 1, 'diff')
    const wiIdx = t2.findIndex((m) => m.content.startsWith('World Info:'))
    expect(stablePrefixTokens(t1, t2).messages).toBeGreaterThan(wiIdx)
  })

  it('L1 strictly beats L0 on the proxy for a state-mutating card', () => {
    const l0 = stablePrefixTokens(assemble(1, 0, 'partition'), assemble(2, 0, 'partition'))
    const l1 = stablePrefixTokens(assemble(1, 1, 'partition'), assemble(2, 1, 'partition'))
    expect(l1.tokens).toBeGreaterThan(l0.tokens)
  })
})
