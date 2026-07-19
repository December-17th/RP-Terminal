import { beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createAgentPromptRenderer,
  type AgentPromptRendererDeps
} from '../../src/main/services/agentRuntime/prompt'
import { buildAttemptLog } from '../../src/main/services/agentRuntime/harness/attemptLog'
import {
  createAgentHarness,
  createToolRegistry
} from '../../src/main/services/agentRuntime/harness'
import {
  createProviderDispatch,
  createScriptedProviderAdapter,
  type ProviderAdapter,
  type ProviderConnection
} from '../../src/main/services/agentRuntime/provider'
import {
  createInvocationRuntime,
  type InvocationFloorPort,
  type InvocationHarnessPort
} from '../../src/main/services/agentRuntime/invocation'
import type { CatalogAgent } from '../../src/main/services/agentRuntime/catalog'
import type { HarnessExecutionResult } from '../../src/main/services/agentRuntime/harness'
import {
  parseAgentDefinition,
  resolveInvocationOptions,
  type AgentDefinition
} from '../../src/shared/agentRuntime'
import {
  evalTemplateDetailed,
  initTemplates,
  isEngineReady
} from '../../src/main/services/templateService'
import type { Settings } from '../../src/main/types/models'
import type { Preset } from '../../src/main/types/preset'

/**
 * ADR 0021 slice 2 — an Agent's own prompt messages evaluate through the existing
 * ST-Prompt-Template/EJS engine before dispatch. Pins the four load-bearing properties: tags
 * render, tag-free text is byte-identical, every failure degrades to the raw text instead of taking
 * down the invocation, and `executePrepared` (Classic's seam) gains nothing.
 */

beforeAll(async () => {
  await initTemplates()
})

// --- the renderer itself -------------------------------------------------------------------

const rendererDeps = (
  overrides: Partial<AgentPromptRendererDeps> = {}
): AgentPromptRendererDeps & { warnings: Array<{ message: string; detail?: unknown }> } => {
  const warnings: Array<{ message: string; detail?: unknown }> = []
  return {
    readFloorVariables: () => ({ 系统核心名: '虚海', stat_data: { 潮位: 3 } }),
    readGlobals: () => ({ 纪元: 7 }),
    readNames: () => ({ user: '旅人', char: '守灯人' }),
    templatesEnabled: () => true,
    engineReady: isEngineReady,
    evaluate: evalTemplateDetailed,
    warn: (message, detail) => warnings.push({ message, detail }),
    warnings,
    ...overrides
  }
}

const scope = { profileId: 'p', chatId: 'c', floor: 4 }

describe('Agent prompt renderer', () => {
  it('evaluates the EJS dialect the shipped Agents are written in', () => {
    const render = createAgentPromptRenderer(rendererDeps())(scope)!

    expect(render("优先级: <%= getvar('系统核心名') %> > Participant")).toBe(
      '优先级: 虚海 > Participant'
    )
    // `getMessageVar` + the `defaults` option — the exact call world-progression.rptagent makes.
    expect(render("<%= getMessageVar('缺席的键', { defaults: '—' }) %>")).toBe('—')
    // The stat_data read-fallback and scriptlet blocks both work, as in Classic assembly.
    expect(render("<% const t = getvar('潮位'); %>潮位=<%= t %>")).toBe('潮位=3')
    expect(render("<%= getGlobalVar('纪元') %>")).toBe('7')
  })

  it('expands {{macros}} against the same scope', () => {
    const render = createAgentPromptRenderer(rendererDeps())(scope)!

    expect(render('{{user}} 与 {{char}}')).toBe('旅人 与 守灯人')
    // Unknown macros stay verbatim — the shipped Agents inject `{{WorldDynamic}}` this way.
    expect(render('{{WorldDynamic}}')).toBe('{{WorldDynamic}}')
  })

  it('passes tag-free, macro-free text through byte-identically without loading any scope state', () => {
    const deps = rendererDeps()
    const readFloorVariables = vi.fn(deps.readFloorVariables)
    const render = createAgentPromptRenderer({ ...deps, readFloorVariables })(scope)!

    const authored = '[CLEAR :: RESET ROLE]\n最高权限: VOID\n\n<user> = NPC\n  100% <literal>\n'
    expect(render(authored)).toBe(authored)
    expect(render('')).toBe('')
    expect(readFloorVariables).not.toHaveBeenCalled()
  })

  it('falls back to the raw text and warns when a template errors', () => {
    const deps = rendererDeps()
    const render = createAgentPromptRenderer(deps)(scope)!

    const authored = "before <% throw new Error('boom') %> after"
    expect(render(authored)).toBe(authored)
    expect(deps.warnings).toHaveLength(1)
    expect(deps.warnings[0].message).toContain('unrendered')
  })

  it('falls back to the raw text when the evaluator itself throws', () => {
    const deps = rendererDeps({
      evaluate: () => {
        throw new Error('sandbox exploded')
      }
    })
    const render = createAgentPromptRenderer(deps)(scope)!

    expect(render("x <%= getvar('系统核心名') %>")).toBe("x <%= getvar('系统核心名') %>")
    expect(deps.warnings[0].message).toContain('unrendered')
  })

  it('falls back to the raw text — never stripped tags — when no engine is loaded', () => {
    const deps = rendererDeps({ engineReady: () => false })
    const render = createAgentPromptRenderer(deps)(scope)!

    const authored = "priority <%= getvar('系统核心名') %> end"
    expect(render(authored)).toBe(authored)
    expect(deps.warnings[0].message).toContain('Template engine unavailable')
  })

  it('falls back to the raw text when the scope state cannot be read', () => {
    const deps = rendererDeps({
      readFloorVariables: () => {
        throw new Error('floor is gone')
      }
    })
    const render = createAgentPromptRenderer(deps)(scope)!

    expect(render("<%= getvar('系统核心名') %>")).toBe("<%= getvar('系统核心名') %>")
    expect(deps.warnings[0].detail).toBe('floor is gone')
  })

  it('does not persist build-time setvar back onto the floor variables', () => {
    const floorVars = { 系统核心名: '虚海' }
    const render = createAgentPromptRenderer(
      rendererDeps({ readFloorVariables: () => floorVars })
    )(scope)!

    expect(render("<% setvar('系统核心名', '篡改') %><%= getvar('系统核心名') %>")).toBe('篡改')
    expect(floorVars).toEqual({ 系统核心名: '虚海' })
  })
})

// --- the Harness seam ----------------------------------------------------------------------

const definition = (overrides: Record<string, unknown> = {}): AgentDefinition => {
  const parsed = parseAgentDefinition({
    format: 'rpt-agent',
    formatVersion: 1,
    name: 'Prompt Rendering',
    prompt: [{ role: 'system', content: 'Answer.' }],
    inputSchema: { type: 'object' },
    result: { mode: 'text' },
    tools: [],
    defaults: { retryDelayMs: 0 },
    ...overrides
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.value
}

const effectiveOptions = (def: AgentDefinition) => {
  const resolved = resolveInvocationOptions(def, undefined)
  if (!resolved.ok) throw new Error('invalid fixture options')
  return resolved.value
}

const attemptLogFor = (
  def: AgentDefinition,
  request: Parameters<typeof buildAttemptLog>[1]
): string[] => {
  const built = buildAttemptLog(def, request, effectiveOptions(def), 'POLICY')
  if (!built.ok) throw new Error(built.failure.code)
  return [...built.immutablePrefix, ...built.attemptLog].map((message) => message.content)
}

describe('buildAttemptLog prompt rendering', () => {
  it('renders authored text but never the bound values spliced into it', () => {
    const def = definition({
      prompt: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'core=<%= 1 + 1 %>' },
            { type: 'binding', source: { type: 'variables', path: 'variables.world' } }
          ]
        }
      ]
    })

    const contents = attemptLogFor(def, {
      definition: def,
      input: {},
      profileId: 'p',
      promptValues: { 'variables.world': '<%= 9 * 9 %>' },
      render: (text) => text.replace('<%= 1 + 1 %>', '2')
    })

    // The authored half rendered; the injected value stayed literal data.
    expect(contents).toContain('core=2<%= 9 * 9 %>')
  })

  it('keeps the prompt verbatim when no renderer is injected', () => {
    const def = definition({ prompt: [{ role: 'system', content: "<%= getvar('x') %>" }] })

    expect(attemptLogFor(def, { definition: def, input: {}, profileId: 'p' })).toContain(
      "<%= getvar('x') %>"
    )
  })

  it('survives a renderer that throws or returns a non-string', () => {
    const def = definition({ prompt: [{ role: 'system', content: 'authored' }] })

    expect(
      attemptLogFor(def, {
        definition: def,
        input: {},
        profileId: 'p',
        render: () => {
          throw new Error('renderer blew up')
        }
      })
    ).toContain('authored')
    expect(
      attemptLogFor(def, {
        definition: def,
        input: {},
        profileId: 'p',
        render: () => undefined as unknown as string
      })
    ).toContain('authored')
  })
})

// --- end to end through the Harness, and the Classic path's immunity -----------------------

const connection: ProviderConnection = {
  provider: 'openai',
  endpoint: 'https://provider.test/v1',
  apiKey: 'secret',
  model: 'fixed-model',
  rpmLimit: 0,
  maxConcurrent: 0
}

const dispatchFor = (adapter: ProviderAdapter) =>
  createProviderDispatch({
    adapter,
    getSettings: () =>
      ({
        api: {
          provider: connection.provider,
          endpoint: connection.endpoint,
          api_key: connection.apiKey,
          model: connection.model
        },
        api_presets: [
          {
            id: 'fixed-preset',
            name: 'Fixed preset',
            provider: connection.provider,
            endpoint: connection.endpoint,
            api_key: connection.apiKey,
            model: connection.model
          }
        ],
        active_api_preset_id: 'fixed-preset',
        cache: { mode: 'baseline' }
      }) as Settings,
    getActivePreset: () => ({ parameters: { temperature: 0, max_tokens: 100 } }) as Preset
  })

const textAdapter = () =>
  createScriptedProviderAdapter([
    {
      events: [
        { type: 'text-delta', delta: 'Complete.' },
        { type: 'finish', reason: 'stop' }
      ]
    }
  ])

describe('AgentHarness prompt rendering', () => {
  it('dispatches the RENDERED prompt on the Agent path', async () => {
    const adapter = textAdapter()
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry()
    })
    const def = definition({
      prompt: [{ role: 'system', content: "核心=<%= getvar('系统核心名') %>" }]
    })

    const result = await harness.execute({
      definition: def,
      input: { request: 'answer' },
      profileId: 'p',
      render: createAgentPromptRenderer(rendererDeps())(scope)
    })

    expect(result.ok).toBe(true)
    expect(adapter.requests[0].messages.map((message) => message.content)).toEqual([
      expect.stringContaining('RP Terminal Agent Harness'),
      '核心=虚海',
      '{"request":"answer"}'
    ])
  })

  it('leaves executePrepared — the Classic seam — byte-identical', async () => {
    const adapter = textAdapter()
    const dispatch = dispatchFor(adapter)
    const harness = createAgentHarness({
      providerDispatch: dispatch,
      toolRegistry: createToolRegistry()
    })
    const provider = dispatch.resolve({ profileId: 'p' })
    const messages = [
      { role: 'system' as const, content: "<%= getvar('系统核心名') %>" },
      { role: 'user' as const, content: '{{user}} acts.' }
    ]

    const result = await harness.executePrepared({ provider, messages })

    expect(result.text).toBe('Complete.')
    // No rendering, no harness-policy line, no serialized input: exactly what the caller prepared.
    expect(adapter.requests[0].messages).toEqual(messages)
  })
})

// --- the injected seam reaches the Harness --------------------------------------------------

const catalogAgent = (name: string): CatalogAgent => {
  const parsed = parseAgentDefinition({
    format: 'rpt-agent',
    formatVersion: 1,
    name,
    prompt: [{ role: 'system', content: 'Answer.' }],
    result: { mode: 'text' }
  })
  if (!parsed.ok) throw new Error('invalid fixture')
  return {
    id: name,
    name,
    source: { kind: 'user-created', key: name, version: '1' },
    sourcePresent: true,
    availableSource: null,
    baseline: parsed.value,
    effective: parsed.value,
    effectiveHash: `hash:${name}`,
    customized: false,
    enabled: true,
    createdAt: '',
    updatedAt: ''
  }
}

describe('InvocationRuntime prompt-renderer injection', () => {
  const floorPort: InvocationFloorPort = {
    async resolveSource(request) {
      return { token: `${request.floor}`, input: {}, promptValues: {}, history: null }
    },
    async isSourceCurrent() {
      return true
    },
    async incorporate() {
      return { status: 'committed' }
    }
  }

  it('builds a renderer for the invocation scope and hands it to the Harness', async () => {
    const execute = vi.fn<InvocationHarnessPort['execute']>(
      async (): Promise<HarnessExecutionResult> => ({
        ok: true,
        result: 'done',
        stagedOperations: [],
        evidence: { attempts: [] }
      })
    )
    const promptRenderer = vi.fn(() => (text: string) => `rendered:${text}`)
    const runtime = createInvocationRuntime({
      catalog: { get: () => catalogAgent('A') },
      harness: { execute, stop: () => false },
      floor: floorPort,
      promptRenderer
    })

    await runtime.run({ profileId: 'p', chatId: 'c', floor: 9, agent: 'A' })

    expect(promptRenderer).toHaveBeenCalledWith({ profileId: 'p', chatId: 'c', floor: 9 })
    expect(execute.mock.calls[0][0].render?.('x')).toBe('rendered:x')
  })

  it('omits the renderer entirely when no port is wired', async () => {
    const execute = vi.fn<InvocationHarnessPort['execute']>(
      async (): Promise<HarnessExecutionResult> => ({
        ok: true,
        result: 'done',
        stagedOperations: [],
        evidence: { attempts: [] }
      })
    )
    const runtime = createInvocationRuntime({
      catalog: { get: () => catalogAgent('A') },
      harness: { execute, stop: () => false },
      floor: floorPort
    })

    await runtime.run({ profileId: 'p', chatId: 'c', floor: 9, agent: 'A' })

    expect(execute.mock.calls[0][0]).not.toHaveProperty('render')
  })
})
