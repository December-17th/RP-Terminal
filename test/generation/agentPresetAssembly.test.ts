// ADR 0021 slices 3 + 4 — a preset Agent's prompt is ASSEMBLED through the real preset pipeline.
//
// What is pinned here: the bundled preset (not the profile's active one) drives assembly, the card
// and persona reach the prompt, world info is selectable per Agent, and history is opt-in and
// BOUNDED. The Agent's own `prompt` is the task instruction and lands last.
import { describe, it, expect, vi } from 'vitest'
import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
import type { FloorFile } from '../../src/main/types/chat'
import type { Lorebook } from '../../src/main/types/character'
import { parseAgentDefinition, type AgentDefinition } from '../../src/shared/agentRuntime'

const settings = (() => {
  const s = getDefaultSettings()
  s.api = { provider: 'openai', endpoint: 'https://x/v1', api_key: 'k', model: 'test-model' }
  s.agent = { mode: 'off' }
  s.persona = { name: 'Ilsa', description: 'A cartographer with ink-stained hands.', inject: true }
  return s
})()

const card = {
  id: 'card1',
  data: { name: 'Testchar', description: 'A calm guide.', personality: '', extensions: {} }
} as any

const floor = (n: number, user: string, response: string): FloorFile => ({
  floor: n,
  chat_id: 'chat1',
  timestamp: '2020-01-01T00:00:00.000Z',
  user_message: { content: user, timestamp: '2020-01-01T00:00:00.000Z' },
  response: { content: response, model: 'test-model', provider: 'openai' },
  events: [],
  variables: { stat_data: { hp: 10 }, __rpt: { agent_results: { last_report: 'stable' } } }
})

const floors: FloorFile[] = [
  floor(0, '', 'The gate opens.'),
  floor(1, 'I step through.', 'Dust rises.'),
  floor(2, 'I look around.', 'A market hums.')
]

const book = (name: string, entries: Array<{ comment: string; content: string }>): Lorebook =>
  ({
    name,
    entries: entries.map((entry, index) => ({
      uid: `${name}-${index}`,
      keys: [],
      secondary_keys: [],
      comment: entry.comment,
      content: entry.content,
      constant: true,
      enabled: true,
      selective: false,
      insertion_order: index,
      position: 'before_char',
      depth: 4,
      probability: 100,
      exclude_recursion: false,
      prevent_recursion: false
    }))
  }) as unknown as Lorebook

const SESSION_BOOK = book('Session Lore', [
  { comment: 'Economy', content: 'Grain prices are climbing.' },
  { comment: 'Spoilers', content: 'The regent is an impostor.' },
  { comment: 'Economy', content: 'A second Economy entry, same title.' }
])
const OTHER_BOOK = book('World Politics', [
  { comment: 'Factions', content: 'Three houses hold the river.' }
])

vi.mock('../../src/main/services/chatService', () => ({
  getChat: () => ({ id: 'chat1', character_id: 'card1', floor_count: 3, lorebook_ids: null }),
  getChatLorebookIds: () => ['session-book'],
  getChatMode: () => 'explore',
  isYuzuMode: () => false,
  getCachedWorldInfo: () => null,
  setCachedWorldInfo: () => {}
}))
vi.mock('../../src/main/services/characterService', () => ({ getCharacter: () => card }))
vi.mock('../../src/main/services/settingsService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSettings: () => settings
}))
vi.mock('../../src/main/services/presetService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  // The PROFILE's active preset. Nothing it says may appear in a bundled Agent's prompt.
  getActivePreset: () => getDefaultPreset(),
  getActivePresetId: () => 'preset1'
}))
vi.mock('../../src/main/services/lorebookService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listLorebooks: () => [
    { id: 'session-book', name: 'Session Lore' },
    { id: 'other-book', name: 'World Politics' }
  ],
  getLorebookById: (_profile: string, id: string) =>
    id === 'session-book' ? SESSION_BOOK : id === 'other-book' ? OTHER_BOOK : null
}))
vi.mock('../../src/main/services/floorService', () => ({
  getAllFloors: () => floors,
  getFloorRequest: () => undefined
}))
vi.mock('../../src/main/services/regexService', () => ({
  getPromptRules: () => [],
  getWorldInfoRules: () => []
}))
vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadGlobals: () => ({})
}))
vi.mock('../../src/main/services/tablesInjectionService', () => ({
  renderChatTablesInjectionBlock: () => ''
}))

const { assembleAgentPresetPrompt } = await import(
  '../../src/main/services/generation/agentPresetAssembly'
)

const BUNDLED_PRESET = {
  name: 'Agent Preset',
  parameters: { temperature: 0.4, max_tokens: 900 },
  prompts: [
    { identifier: 'main', content: 'BUNDLED-MAIN: you are a world simulator.' },
    { identifier: 'charDescription', marker: 'char_description', content: '' },
    { identifier: 'persona', marker: 'persona_description', content: '' },
    { identifier: 'worldInfo', marker: 'world_info', content: '' },
    { identifier: 'chatHistory', marker: 'chat_history', content: '' }
  ]
}

const agent = (overrides: Record<string, unknown> = {}): AgentDefinition => {
  const parsed = parseAgentDefinition({
    format: 'rpt-agent',
    formatVersion: 1,
    name: 'World Progression',
    prompt: [{ role: 'user', content: 'TASK: report the month.' }],
    result: { mode: 'text' },
    preset: { preset: { parsed: BUNDLED_PRESET } },
    ...overrides
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.value
}

const assemble = (definition: AgentDefinition, extra: Record<string, unknown> = {}): string[] => {
  const messages = assembleAgentPresetPrompt({
    profileId: 'p',
    chatId: 'chat1',
    floor: 2,
    definition,
    ...extra
  })
  if (!messages) throw new Error('assembly produced nothing')
  return messages.map((message) =>
    message.content.map((segment) => (segment.type === 'text' ? segment.text : '')).join('')
  )
}

const joined = (contents: string[]): string => contents.join('\n---\n')

describe('preset Agent assembly', () => {
  it('assembles the BUNDLED preset with card, persona and world info', () => {
    const text = joined(assemble(agent()))

    expect(text).toContain('BUNDLED-MAIN: you are a world simulator.')
    // The profile's active preset must not leak in.
    expect(text).not.toContain('expert roleplay partner')
    expect(text).toContain('A calm guide.')
    expect(text).toContain('A cartographer with ink-stained hands.')
    expect(text).toContain('Grain prices are climbing.')
  })

  it("appends the Agent's own prompt as the task instruction, last", () => {
    const contents = assemble(agent())

    expect(contents[contents.length - 1]).toBe('TASK: report the month.')
  })

  it('renders the task instruction through the injected renderer', () => {
    const contents = assemble(
      agent({ prompt: [{ role: 'user', content: 'TASK <%= 1 + 1 %>' }] }),
      { render: (text: string) => text.replace('<%= 1 + 1 %>', '2') }
    )

    expect(contents[contents.length - 1]).toBe('TASK 2')
  })

  describe('history is opt-in and bounded', () => {
    it('includes NO history when the Agent declares no History Policy', () => {
      const text = joined(assemble(agent()))

      expect(text).not.toContain('Dust rises.')
      expect(text).not.toContain('A market hums.')
      expect(text).not.toContain('I step through.')
    })

    it('includes narration once a History Policy is declared', () => {
      const text = joined(
        assemble(agent(), {
          history: { includeUserMessages: false, includePlayerResults: false }
        })
      )

      expect(text).toContain('A market hums.')
      expect(text).toContain('Dust rises.')
      // Player turns stay out until asked for.
      expect(text).not.toContain('I step through.')
    })

    it('honours maxFloors by keeping the newest floors', () => {
      const text = joined(
        assemble(agent(), {
          history: { maxFloors: 1, includeUserMessages: true, includePlayerResults: false }
        })
      )

      expect(text).toContain('A market hums.')
      expect(text).toContain('I look around.')
      expect(text).not.toContain('Dust rises.')
      expect(text).not.toContain('The gate opens.')
    })

    it('honours maxTokens by dropping the oldest messages', () => {
      const text = joined(
        assemble(agent(), {
          history: { maxTokens: 4, includeUserMessages: false, includePlayerResults: false }
        })
      )

      expect(text).toContain('A market hums.')
      expect(text).not.toContain('The gate opens.')
    })

    it('includes player-facing Agent results only when asked', () => {
      const without = joined(
        assemble(agent(), { history: { includeUserMessages: false, includePlayerResults: false } })
      )
      const with_ = joined(
        assemble(agent(), { history: { includeUserMessages: false, includePlayerResults: true } })
      )

      expect(without).not.toContain('last_report')
      expect(with_).toContain('last_report')
    })
  })

  describe('lorebook selection', () => {
    const withLorebooks = (lorebooks: unknown): AgentDefinition =>
      agent({ preset: { preset: { parsed: BUNDLED_PRESET }, lorebooks } })

    it('uses the session set by default', () => {
      const text = joined(assemble(withLorebooks({ mode: 'session' })))

      expect(text).toContain('Grain prices are climbing.')
      expect(text).not.toContain('Three houses hold the river.')
    })

    it('an explicit selection excludes the unselected session books', () => {
      const text = joined(
        assemble(withLorebooks({ mode: 'explicit', lorebooks: ['World Politics'] }))
      )

      expect(text).toContain('Three houses hold the river.')
      expect(text).not.toContain('Grain prices are climbing.')
      expect(text).not.toContain('The regent is an impostor.')
    })

    it('narrows by entry title, include before exclude', () => {
      const text = joined(
        assemble(withLorebooks({ mode: 'session', entries: { exclude: ['Spoilers'] } }))
      )

      expect(text).toContain('Grain prices are climbing.')
      expect(text).not.toContain('The regent is an impostor.')
    })

    it('a title filter matches EVERY entry with that title — comments are not unique', () => {
      const included = joined(
        assemble(withLorebooks({ mode: 'session', entries: { include: ['Economy'] } }))
      )

      expect(included).toContain('Grain prices are climbing.')
      expect(included).toContain('A second Economy entry, same title.')
      expect(included).not.toContain('The regent is an impostor.')

      const excluded = joined(
        assemble(withLorebooks({ mode: 'session', entries: { exclude: ['Economy'] } }))
      )

      expect(excluded).not.toContain('Grain prices are climbing.')
      expect(excluded).not.toContain('A second Economy entry, same title.')
      expect(excluded).toContain('The regent is an impostor.')
    })
  })

  it('returns nothing for an Agent with no bundle, so it stays a messages Agent', () => {
    const parsed = parseAgentDefinition({
      format: 'rpt-agent',
      formatVersion: 1,
      name: 'Plain',
      prompt: [{ role: 'system', content: 'Answer.' }],
      result: { mode: 'text' }
    })
    if (!parsed.ok) throw new Error('invalid fixture')

    expect(
      assembleAgentPresetPrompt({
        profileId: 'p',
        chatId: 'chat1',
        floor: 2,
        definition: parsed.value
      })
    ).toBeUndefined()
  })
})
