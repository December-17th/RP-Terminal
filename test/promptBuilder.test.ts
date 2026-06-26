import { describe, it, expect, beforeAll } from 'vitest'
import {
  buildPrompt,
  buildScanText,
  collectRenderMarkers,
  estimateTokens,
  fitToBudget,
  ChatMessage
} from '../src/main/services/promptBuilder'
import { RPTerminalCardSchema, LorebookSchema } from '../src/main/types/character'
import { initTemplates } from '../src/main/services/templateService'

// --- tiny factories -------------------------------------------------------
const card = (data: any = {}): any =>
  RPTerminalCardSchema.parse({ data: { name: 'Aria', ...data } })
const book = (entries: any[]): any => LorebookSchema.parse({ name: 'B', entries })
const blk = (marker: string, content = '', role = 'system'): any => ({
  identifier: marker || 'lit',
  name: marker || 'lit',
  role,
  content,
  enabled: true,
  marker: marker || 'none'
})
const preset = (prompts: any[]): any => ({
  name: 'P',
  parameters: { temperature: 0.9, max_tokens: 100 },
  prompts
})
const floor = (n: number, user: string, resp: string): any => ({
  floor: n,
  chat_id: 'c',
  timestamp: 't',
  user_message: { content: user, timestamp: 't' },
  response: { content: resp, model: '', provider: '' },
  events: [],
  variables: {}
})
const last = (m: ChatMessage[]): ChatMessage => m[m.length - 1]

describe('buildScanText', () => {
  it('joins the last scanDepth turns plus the action, skipping blanks', () => {
    const floors = [floor(0, '', 'greet'), floor(1, 'u1', 'a1'), floor(2, 'u2', 'a2')]
    const txt = buildScanText(floors, 'my action', 1)
    expect(txt).toContain('u2')
    expect(txt).toContain('a2')
    expect(txt).toContain('my action')
    expect(txt).not.toContain('u1') // floor 1 is outside scanDepth 1
    expect(txt).not.toContain('greet') // floor 0 greeting too
  })

  it('clamps scanDepth to at least 1', () => {
    const floors = [floor(0, 'u0', 'a0'), floor(1, 'u1', 'a1')]
    const txt = buildScanText(floors, 'act', 0)
    expect(txt).toContain('u1') // last turn still included
    expect(txt).toContain('act')
  })
})

describe('estimateTokens', () => {
  it('is 0 for empty, ~chars/4 for latin, ~1/char for CJK', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('hello world')).toBe(3) // 11 chars -> ceil(11/4)
    expect(estimateTokens('你好')).toBe(2) // 2 CJK chars
  })
})

describe('fitToBudget', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'S'.repeat(40) },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' }
  ]

  it('returns everything unchanged under a generous budget', () => {
    const { messages, dropped } = fitToBudget(msgs, 10_000)
    expect(dropped).toBe(0)
    expect(messages).toEqual(msgs)
  })

  it('drops the oldest turns but keeps the system prefix and the final turn', () => {
    const { messages, dropped } = fitToBudget(msgs, 20)
    expect(dropped).toBe(2)
    expect(messages[0].role).toBe('system')
    expect(last(messages).content).toBe('u2')
  })

  it('trims oldest HISTORY turns but never the static world-info prefix', () => {
    // Large constant lore + a couple of small turns; a tiny budget must evict the old turns,
    // not the lore (regression: a preset with a user-role block ahead of world_info used to make
    // fitToBudget classify the lore as droppable "history").
    const bigLore = 'L'.repeat(400)
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('world_info'), blk('chat_history')]),
      lorebooks: [book([{ keys: [], content: bigLore, constant: true, enabled: true }])],
      floors: [floor(0, '', 'greet'), floor(1, 'old user turn', 'old reply')],
      userAction: 'latest turn'
    })
    expect(messages.some((m) => m.content.includes(bigLore))).toBe(true)

    const { messages: fit, dropped } = fitToBudget(messages, 1)
    expect(dropped).toBeGreaterThan(0)
    expect(fit.some((m) => m.content.includes(bigLore))).toBe(true) // lore survived
    expect(last(fit).content).toBe('latest turn') // latest turn survived
    expect(fit.some((m) => m.content === 'old user turn')).toBe(false) // oldest turn evicted
  })
})

describe('buildPrompt — depth-scoped prompt regex (minDepth)', () => {
  const placeholderRule = {
    id: 'r1',
    scriptName: 'keep-latest-user-input',
    source: '^([\\s\\S]*)$',
    flags: 'g',
    replace: '<|placeholder|>',
    placement: [1],
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
    trimStrings: [],
    minDepth: 1,
    maxDepth: null
  }

  it('blanks OLDER user turns but preserves the latest input (depth 0)', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('chat_history')]),
      lorebooks: [],
      floors: [floor(0, '', 'greet'), floor(1, 'old input', 'a reply')],
      userAction: 'latest input',
      promptRegex: [placeholderRule]
    })
    expect(last(messages).content).toBe('latest input') // depth 0 → minDepth:1 rule skipped
    const placeholders = messages.filter((m) => m.content === '<|placeholder|>')
    expect(placeholders.length).toBe(1) // only the older user turn was blanked
  })
})

describe('buildPrompt', () => {
  it('expands char_description + chat_history and ends on the user action', () => {
    const messages = buildPrompt({
      card: card({ description: 'A knight.' }),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [],
      floors: [floor(0, '', 'Hello traveler')],
      userAction: 'I wave back'
    })
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('Name: Aria')
    expect(messages[0].content).toContain('A knight.')
    expect(messages.some((m) => m.role === 'assistant' && m.content === 'Hello traveler')).toBe(
      true
    )
    expect(last(messages)).toEqual({ role: 'user', content: 'I wave back' })
  })

  it('injects a per-mode addendum as a system block before the conversation, action still last', () => {
    const messages = buildPrompt({
      card: card({ description: 'A knight.' }),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [],
      floors: [floor(0, '', 'Hello traveler')],
      userAction: 'I draw my sword',
      modeAddendum: 'Combat mode: be terse.'
    })
    const addendumIdx = messages.findIndex((m) => m.content === 'Combat mode: be terse.')
    expect(addendumIdx).toBeGreaterThanOrEqual(0)
    expect(messages[addendumIdx].role).toBe('system')
    // It sits within the system prefix, before the first non-system (conversation) message.
    const convoStart = messages.findIndex((m) => m.role !== 'system')
    expect(addendumIdx).toBeLessThan(convoStart)
    expect(last(messages)).toEqual({ role: 'user', content: 'I draw my sword' })
  })

  it('omits the mode addendum block when it is empty/whitespace', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [],
      floors: [],
      userAction: 'hi',
      modeAddendum: '   '
    })
    expect(messages.every((m) => m.content.trim() !== '')).toBe(true)
  })

  it('uses matchedEntries verbatim and skips the keyword scan when provided (L2 cache)', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('world_info'), blk('chat_history')]),
      // This book WOULD match on "dragon" if the scan ran...
      lorebooks: [book([{ keys: ['dragon'], content: 'FROM-LIVE-MATCH' }])],
      floors: [],
      userAction: 'I see a dragon',
      // ...but a pre-matched (cached) set is supplied, so the scan is bypassed.
      matchedEntries: book([{ keys: [], content: 'FROM-CACHE' }]).entries
    })
    const wi = messages.find((m) => m.content.startsWith('World Info:'))
    expect(wi?.content).toContain('FROM-CACHE')
    expect(wi?.content).not.toContain('FROM-LIVE-MATCH')
  })

  it('treats an empty matchedEntries cache as "nothing matched" (no re-scan)', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('world_info'), blk('chat_history')]),
      lorebooks: [book([{ keys: ['dragon'], content: 'SHOULD-NOT-APPEAR' }])],
      floors: [],
      userAction: 'I see a dragon',
      matchedEntries: []
    })
    expect(messages.some((m) => m.content.includes('SHOULD-NOT-APPEAR'))).toBe(false)
  })

  it('injects top (depth-null) lorebook entries into a World Info block', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('world_info'), blk('chat_history')]),
      lorebooks: [book([{ keys: ['dragon'], content: 'Dragons breathe fire' }])],
      floors: [],
      userAction: 'I see a dragon'
    })
    const wi = messages.find((m) => m.content.startsWith('World Info:'))
    expect(wi?.content).toContain('Dragons breathe fire')
  })

  it('places a depth-tagged entry near the bottom but keeps the user action last', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [book([{ keys: ['dragon'], content: 'DRAGON-LORE', insertion_depth: 1 }])],
      floors: [floor(0, '', 'greet'), floor(1, 'u1', 'a1')],
      userAction: 'attack the dragon'
    })
    expect(last(messages).content).toBe('attack the dragon')
    const penultimate = messages[messages.length - 2]
    expect(penultimate.role).toBe('system')
    expect(penultimate.content).toContain('DRAGON-LORE')
  })

  it('injects the persona at the top and expands {{persona}}/{{user}} macros', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([
        blk('char_description'),
        blk('none', 'Bio: {{user}} is {{persona}}'),
        blk('chat_history')
      ]),
      lorebooks: [],
      floors: [floor(0, '', 'hi')],
      userAction: 'hello',
      userName: 'Lyra',
      persona: { description: 'a wanderer', inject: true, depth: null }
    })
    const personaBlock = messages.find((m) => m.content.includes("[Lyra's Persona]"))
    expect(personaBlock).toBeTruthy()
    expect(personaBlock!.content).toContain('a wanderer')
    // The {{persona}} / {{user}} macros expanded inside the literal block.
    expect(messages.some((m) => m.content === 'Bio: Lyra is a wanderer')).toBe(true)
  })

  it('can place the persona at a depth instead of the top', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [],
      floors: [floor(0, 'u0', 'a0')],
      userAction: 'go',
      userName: 'Lyra',
      persona: { description: 'a wanderer', inject: true, depth: 1 }
    })
    expect(last(messages).content).toBe('go')
    expect(
      messages.some((m) => m.role === 'system' && m.content.includes("[Lyra's Persona]"))
    ).toBe(true)
  })

  it('does not inject the persona when inject is false or description is blank', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [],
      floors: [],
      userAction: 'go',
      persona: { description: 'hidden', inject: false, depth: null }
    })
    expect(messages.some((m) => m.content.includes('Persona'))).toBe(false)
  })

  it('merges matches across multiple lorebooks', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('world_info'), blk('chat_history')]),
      lorebooks: [
        book([{ keys: ['alpha'], content: 'AAA' }]),
        book([{ keys: ['beta'], content: 'BBB' }])
      ],
      floors: [],
      userAction: 'alpha and beta'
    })
    const wi = messages.find((m) => m.content.startsWith('World Info:'))
    expect(wi?.content).toContain('AAA')
    expect(wi?.content).toContain('BBB')
  })

  it('injects a depth-tagged literal preset block into history, keeping its role', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([
        blk('char_description'),
        { ...blk('none', 'AUTHOR NOTE', 'assistant'), injection_depth: 1 },
        blk('chat_history')
      ]),
      lorebooks: [],
      floors: [floor(0, 'u0', 'a0')],
      userAction: 'go'
    })
    expect(last(messages).content).toBe('go')
    const penultimate = messages[messages.length - 2]
    expect(penultimate.content).toBe('AUTHOR NOTE')
    expect(penultimate.role).toBe('assistant')
  })

  it('respects scanDepth — keywords only in turns beyond the depth do not match', () => {
    const args = {
      card: card(),
      preset: preset([blk('world_info'), blk('chat_history')]),
      lorebooks: [book([{ keys: ['dragon'], content: 'DRAGON-LORE' }])],
      floors: [floor(0, 'a dragon!', 'ok'), floor(1, 'b', 'c'), floor(2, 'd', 'e')],
      userAction: 'nothing relevant'
    }
    // depth 1 scans only the last turn + action -> 'dragon' (3 turns back) is missed.
    const shallow = buildPrompt({ ...args, scanDepth: 1 })
    expect(shallow.some((m) => m.content.includes('DRAGON-LORE'))).toBe(false)
    // depth 5 covers the older turn -> it matches.
    const deep = buildPrompt({ ...args, scanDepth: 5 })
    expect(deep.some((m) => m.content.includes('DRAGON-LORE'))).toBe(true)
  })

  it('applies prompt-time regex to history/user text (placement 1, not the AI turn)', () => {
    const promptRegex = [
      {
        id: 'r',
        scriptName: 's',
        source: 'FOO',
        flags: 'g',
        replace: 'BAR',
        placement: [1],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
        trimStrings: []
      }
    ]
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('chat_history')]),
      lorebooks: [],
      floors: [floor(0, 'I say FOO', 'ok FOO')],
      userAction: 'and FOO again',
      promptRegex
    })
    expect(messages.some((m) => m.role === 'user' && m.content === 'I say BAR')).toBe(true)
    expect(last(messages).content).toBe('and BAR again')
    // The AI turn is placement 2, so the placement-1 rule leaves it untouched.
    expect(messages.some((m) => m.role === 'assistant' && m.content === 'ok FOO')).toBe(true)
  })

  it('safety nets: an empty preset still injects world info and history', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([]),
      lorebooks: [book([{ content: 'CONST-LORE', constant: true }])],
      floors: [floor(0, '', 'hi')],
      userAction: 'go'
    })
    expect(messages.some((m) => m.content.includes('CONST-LORE'))).toBe(true)
    expect(messages.some((m) => m.role === 'assistant' && m.content === 'hi')).toBe(true)
    expect(last(messages)).toEqual({ role: 'user', content: 'go' })
  })

  // --- Phase D: injection markers ---
  it('drains a [GENERATE:BEFORE] marker entry to the prompt start (not into World Info)', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('world_info'), blk('chat_history')]),
      lorebooks: [
        book([{ comment: '[GENERATE:BEFORE]', content: 'INJECTED-BEFORE', constant: true }])
      ],
      floors: [],
      userAction: 'go'
    })
    expect(messages[0].content).toBe('INJECTED-BEFORE')
    const wi = messages.find((m) => m.content.startsWith('World Info:'))
    expect(wi?.content.includes('INJECTED-BEFORE') ?? false).toBe(false)
  })

  it('drains [GENERATE:AFTER] and the @@generate_after decorator form to the prompt end', () => {
    const fromComment = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [
        book([{ comment: '[GENERATE:AFTER]', content: 'INJECTED-AFTER', constant: true }])
      ],
      floors: [],
      userAction: 'go'
    })
    expect(last(fromComment).content).toBe('INJECTED-AFTER')

    const fromDecorator = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [
        book([{ comment: '', content: '@@generate_after\nDECOR-AFTER', constant: true }])
      ],
      floors: [],
      userAction: 'go'
    })
    expect(last(fromDecorator).content).toBe('DECOR-AFTER') // the @@ line is stripped
  })

  it('drops a marker entry tagged @@dont_activate', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('world_info'), blk('chat_history')]),
      lorebooks: [
        book([{ comment: '[GENERATE:BEFORE]', content: '@@dont_activate\nNOPE', constant: true }])
      ],
      floors: [],
      userAction: 'go'
    })
    expect(messages.some((m) => m.content.includes('NOPE'))).toBe(false)
  })

  it('@INJECT pos=0 inserts a message of the given role at the start', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [
        book([{ comment: '@INJECT pos=0,role=user', content: 'INJ-AT-0', constant: true }])
      ],
      floors: [],
      userAction: 'go'
    })
    expect(messages[0]).toEqual({ role: 'user', content: 'INJ-AT-0' })
  })

  it('@INJECT target=user,index=1,at=after inserts after the first user message', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [
        book([
          {
            comment: '@INJECT target=user,index=1,at=after,role=system',
            content: 'AFTER-U1',
            constant: true
          }
        ])
      ],
      floors: [floor(0, 'u1', 'a1')],
      userAction: 'u2'
    })
    const firstUserIdx = messages.findIndex((m) => m.role === 'user')
    expect(messages[firstUserIdx + 1]).toEqual({ role: 'system', content: 'AFTER-U1' })
  })

  it('[GENERATE:REGEX:p] injects relative to the first matching message', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [
        book([{ comment: '[GENERATE:REGEX:dragon]', content: 'NEAR-DRAGON', constant: true }])
      ],
      floors: [floor(0, 'I see a dragon', 'ok')],
      userAction: 'go'
    })
    const injIdx = messages.findIndex((m) => m.content === 'NEAR-DRAGON')
    expect(injIdx).toBeGreaterThanOrEqual(0)
    expect(messages[injIdx + 1]?.content).toContain('dragon') // injected just before the match
  })

  it('@@activate force-activates a marker entry the keyword scan did not match', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('chat_history')]),
      // no keys + not constant → the scan won't match it, but @@activate forces it in.
      lorebooks: [book([{ comment: '[GENERATE:BEFORE]', content: '@@activate\nFORCED' }])],
      floors: [],
      userAction: 'go'
    })
    expect(messages[0].content).toBe('FORCED')
  })

  it('keeps an [InitialVariables] entry out of the prompt (it seeds vars, not lore)', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('world_info'), blk('chat_history')]),
      lorebooks: [
        book([{ comment: '[InitialVariables]', content: '{"主角":{"hp":100}}', constant: true }])
      ],
      floors: [],
      userAction: 'go'
    })
    expect(messages.some((m) => m.content.includes('主角') || m.content.includes('hp'))).toBe(false)
  })
})

describe('buildPrompt — EJS in constant lore (命定之诗 real-card shape)', () => {
  beforeAll(async () => {
    await initTemplates()
  })

  it('evaluates <% getvar("stat_data…") %> in a constant entry into World Info', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('world_info'), blk('chat_history')]),
      lorebooks: [
        book([
          {
            comment: '命定系统-核心', // a category label (no marker)
            content: '等级:<%= getvar("stat_data.主角.等级") %>',
            constant: true
          }
        ])
      ],
      floors: [],
      userAction: 'go',
      // Build-time vars root at the raw floor object, so getvar reads the full stat_data path.
      template: { vars: { stat_data: { 主角: { 等级: 7 } } }, globals: {}, constants: {} }
    })
    const wi = messages.find((m) => m.content.startsWith('World Info:'))
    expect(wi?.content).toContain('等级:7')
  })

  it('keeps the PROSE of a lorebook entry whose trailing EJS block errors (艾莉亚 shape)', () => {
    // 命定之诗's 艾莉亚 entry = lots of character prose + a trailing `await TavernHelper…` seeder that
    // our sync/TavernHelper-less prompt engine can't run. The bad EJS must not take the prose down.
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('world_info'), blk('chat_history')]),
      lorebooks: [
        book([
          {
            comment: '命定系统-艾莉亚核心',
            content:
              '艾莉亚是<user>的同伴。\n<%_ if (true) { const x = await something(); } _%>',
            constant: true
          }
        ])
      ],
      floors: [],
      userAction: 'go',
      template: { vars: {}, globals: {}, constants: {} }
    })
    const wi = messages.find((m) => m.content.startsWith('World Info:'))
    expect(wi?.content).toContain('艾莉亚是') // prose survived the EJS SyntaxError
    expect(wi?.content).not.toContain('await') // the dead EJS block was stripped
  })
})

describe('buildPrompt — EJS conditionals: lastMessageId + fail-loud', () => {
  beforeAll(async () => {
    await initTemplates()
  })

  it('renders exactly one branch of a lastMessageId conditional (no branch leak)', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([
        blk('none', '<%_ if (lastMessageId === 1) { _%>OPENING<%_ } else { _%>LATER<%_ } _%>'),
        blk('chat_history')
      ]),
      lorebooks: [],
      floors: [],
      userAction: 'go',
      template: { vars: {}, globals: {}, constants: { lastMessageId: 1 } }
    })
    expect(messages.some((m) => m.content === 'OPENING')).toBe(true)
    expect(messages.some((m) => m.content.includes('LATER'))).toBe(false) // the other branch never leaks
  })

  it('an EJS getvar() block sees a {{setvar}} authored in a LATER preset block (first prompt)', () => {
    // The 命定之诗 CoT block reads getvar('ai模型'); a model-toggle block AFTER it does
    // {{setvar::ai模型::…}}. ST runs the whole macro pass before the EJS pass, so the CoT sees it even on
    // turn 1. RPT must do the same (not per-block macro→EJS in order).
    const messages = buildPrompt({
      card: card(),
      preset: preset([
        blk('none', "<%_ if (getvar('mdl') === 'Gemini') { _%>COT-BODY<%_ } _%>"), // reader
        blk('none', '{{setvar::mdl::Gemini}}'), // setter — AFTER the reader
        blk('chat_history')
      ]),
      lorebooks: [],
      floors: [],
      userAction: 'go',
      template: { vars: {}, globals: {}, constants: {} }
    })
    expect(messages.some((m) => m.content === 'COT-BODY')).toBe(true)
  })

  it('FAILS THE TURN (throws) when a preset block references a missing identifier', () => {
    expect(() =>
      buildPrompt({
        card: card(),
        preset: preset([blk('none', '<% notDefinedAnywhere %>X'), blk('chat_history')]),
        lorebooks: [],
        floors: [],
        userAction: 'go',
        template: { vars: {}, globals: {}, constants: {} }
      })
    ).toThrow(/notDefinedAnywhere|preset template/i)
  })

  it('a missing-var conditional throws instead of leaking every branch (the original bug)', () => {
    // Pre-fix: ReferenceError → stripTags → "GEMDEEPOTHER" leaked into the prompt. Now: fail loud.
    expect(() =>
      buildPrompt({
        card: card(),
        preset: preset([
          blk(
            'none',
            "<%_ if (m === 'a') { _%>GEM<%_ } else if (m === 'b') { _%>DEEP<%_ } else { _%>OTHER<%_ } _%>"
          )
        ]),
        lorebooks: [],
        floors: [],
        userAction: 'go',
        template: { vars: {}, globals: {}, constants: {} }
      })
    ).toThrow()
  })
})

describe('collectRenderMarkers', () => {
  it('collects active [RENDER:*] templates by side; skips inactive / @@dont_activate', () => {
    const lb = book([
      { comment: '[RENDER:BEFORE]', content: 'HEADER', constant: true },
      { comment: '', content: '@@render_after\nFOOTER', constant: true },
      { comment: '[RENDER:BEFORE]', content: 'INACTIVE' }, // not constant/forced → skipped
      { comment: '[RENDER:AFTER]', content: '@@dont_activate\nNOPE', constant: true } // dropped
    ])
    expect(collectRenderMarkers([lb])).toEqual({ before: ['HEADER'], after: ['FOOTER'] })
  })
})

describe('buildPrompt — L1 Frozen Core', () => {
  beforeAll(async () => {
    await initTemplates()
  })

  const mkArgs = (statLevel: number, cacheLevel: number, l1Mode: 'partition' | 'diff'): any => ({
    card: card(),
    preset: preset([blk('char_description'), blk('world_info'), blk('chat_history')]),
    lorebooks: [
      book([
        {
          comment: '命定系统-核心',
          content: '等级:<%= getvar("stat_data.主角.等级") %>',
          constant: true
        }
      ])
    ],
    floors: [],
    userAction: 'go',
    cacheLevel,
    l1Mode,
    // floor-0 frozen vars (level 1 renders the frontier against these)
    frozenVars:
      l1Mode === 'partition'
        ? { stat_data: { 主角: { 等级: '⟦state⟧' } } }
        : { stat_data: { 主角: { 等级: 1 } } },
    template: {
      vars: { stat_data: { 主角: { 等级: statLevel } } },
      globals: {},
      constants: {}
    }
  })

  it('level 0 still renders live state into world info (unchanged behavior)', () => {
    const messages = buildPrompt(mkArgs(7, 0, 'partition'))
    const wi = messages.find((m) => m.content.startsWith('World Info:'))
    expect(wi?.content).toContain('等级:7')
  })

  it('partition: frontier world info is byte-identical across differing live state', () => {
    const a = buildPrompt(mkArgs(7, 1, 'partition'))
    const b = buildPrompt(mkArgs(42, 1, 'partition'))
    const wiA = a.find((m) => m.content.startsWith('World Info:'))!
    const wiB = b.find((m) => m.content.startsWith('World Info:'))!
    expect(wiA.content).toBe(wiB.content) // frozen → identical bytes
    expect(wiA.content).toContain('等级:⟦state⟧') // placeholder, not a real value
  })

  it('diff: frontier shows the floor-0 value (stable) regardless of live state', () => {
    const a = buildPrompt(mkArgs(7, 1, 'diff'))
    const b = buildPrompt(mkArgs(42, 1, 'diff'))
    const wiA = a.find((m) => m.content.startsWith('World Info:'))!
    const wiB = b.find((m) => m.content.startsWith('World Info:'))!
    expect(wiA.content).toBe(wiB.content)
    expect(wiA.content).toContain('等级:1') // floor-0 seed value
  })

  it('appends the current-state tail block right before the user action', () => {
    const messages = buildPrompt(mkArgs(7, 1, 'partition'))
    expect(last(messages)).toEqual({ role: 'user', content: 'go' })
    const penultimate = messages[messages.length - 2]
    expect(penultimate.role).toBe('system')
    expect(penultimate.content).toContain('[Current State]')
    expect(penultimate.content).toContain('"等级":7') // the LIVE value, in the tail
  })

  it('omits the tail state block when there is no stat_data', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [],
      floors: [],
      userAction: 'go',
      cacheLevel: 1,
      l1Mode: 'partition',
      frozenVars: {},
      template: { vars: {}, globals: {}, constants: {} }
    })
    expect(messages.some((m) => m.content.includes('[Current State]'))).toBe(false)
    expect(last(messages)).toEqual({ role: 'user', content: 'go' })
  })
})
