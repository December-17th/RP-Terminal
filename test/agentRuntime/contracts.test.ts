import { describe, expect, it } from 'vitest'
import {
  parseAgentDefinition,
  parseInputBindings,
  parseInvocationOptions,
  parseInvocationPlan,
  parseResultContract,
  parseWritableVariablesPath,
  resolveInvocationOptions
} from '../../src/shared/agentRuntime'
import { MONTHLY_PROPERTY_AGENT, MONTHLY_WORLD_PLAN } from './fixtures/contracts'

describe('AgentContracts', () => {
  it('accepts portable processing only on formatVersion 2', () => {
    const processing = {
      runtime: 'rpt-processor-v1' as const,
      preprocess: { code: 'return input.value' },
      postprocess: { code: 'return input.value', output: { mode: 'text' as const } }
    }
    expect(
      parseAgentDefinition({
        format: 'rpt-agent', formatVersion: 2, name: 'Scripted',
        prompt: [{ role: 'system', content: 'Run.' }], result: { mode: 'text' }, processing
      })
    ).toMatchObject({ ok: true, value: { formatVersion: 2, processing } })
    expect(
      parseAgentDefinition({
        format: 'rpt-agent', formatVersion: 1, name: 'Declarative',
        prompt: [{ role: 'system', content: 'Run.' }], result: { mode: 'text' }, processing
      })
    ).toMatchObject({ ok: false })
    expect(
      parseAgentDefinition({
        format: 'rpt-agent', formatVersion: 2, name: 'Tools',
        prompt: [{ role: 'system', content: 'Run.' }], result: { mode: 'tools-only' },
        tools: [{ name: 'x', description: 'x', inputSchema: { type: 'object' } }],
        processing: { runtime: 'rpt-processor-v1', postprocess: { code: 'return input.value', output: { mode: 'text' } } }
      })
    ).toMatchObject({ ok: false })
  })
  it('normalizes static prompt strings through the Agent Definition Interface', () => {
    const result = parseAgentDefinition(MONTHLY_PROPERTY_AGENT)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.prompt[0]).toEqual({
      role: 'system',
      content: [
        {
          type: 'text',
          text: "Update the player's properties using only supplied facts."
        }
      ]
    })
  })

  it('rejects pre-authored tool messages at the prompt role field', () => {
    const result = parseAgentDefinition({
      ...MONTHLY_PROPERTY_AGENT,
      prompt: [{ role: 'tool', content: 'fabricated tool result' }]
    })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          path: ['prompt', 0, 'role'],
          location: {
            kind: 'field',
            agent: 'Property Management',
            field: 'prompt.0.role'
          }
        })
      ]
    })
  })

  it('locates unknown Agent Definition fields instead of silently stripping them', () => {
    const result = parseAgentDefinition({
      ...MONTHLY_PROPERTY_AGENT,
      scheduler: { every: 'month' }
    })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'UNKNOWN_FIELD',
          path: ['scheduler'],
          location: {
            kind: 'field',
            agent: 'Property Management',
            field: 'scheduler'
          }
        })
      ]
    })
  })

  it('applies version-1 defaults without inventing history or extra model turns', () => {
    const result = parseAgentDefinition({
      format: 'rpt-agent',
      formatVersion: 1,
      name: 'Concise Summary',
      prompt: [{ role: 'system', content: 'Summarize the supplied input.' }],
      result: { mode: 'text' }
    })

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        inputSchema: { type: 'object' },
        tools: [],
        defaults: {
          required: true,
          maxSteps: 1,
          maxRetryAttempts: 5,
          retryDelayMs: 5000,
          blocksNextTurn: false,
          toolResultMaxTokens: 10000,
          notification: 'failure'
        }
      })
    })
  })

  it('uses the bounded tool-loop default only when the Agent declares a tool', () => {
    const result = parseAgentDefinition({
      format: 'rpt-agent',
      formatVersion: 1,
      name: 'Property Updater',
      prompt: [{ role: 'system', content: 'Apply one validated property update.' }],
      result: { mode: 'tools-only' },
      tools: [
        {
          name: 'update_property',
          description: 'Stages one property update.',
          inputSchema: { type: 'object' }
        }
      ]
    })

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        defaults: expect.objectContaining({ maxSteps: 8 }),
        tools: [
          expect.objectContaining({
            name: 'update_property',
            required: true,
            transactionMode: 'transactional',
            parallelSafe: false
          })
        ]
      })
    })
  })

  it('requires variable Input Bindings to use full rooted paths', () => {
    const result = parseInputBindings({
      month: {
        source: { type: 'variables', path: 'stat_data.world.month' }
      }
    })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'FULL_PATH_REQUIRED',
          path: ['month', 'source', 'path'],
          location: {
            kind: 'binding',
            binding: 'month',
            field: 'source.path'
          }
        })
      ]
    })
  })

  it('requires Result Slot reads to use an explicit result source', () => {
    const result = parseInputBindings({
      priorSummary: {
        source: {
          type: 'variables',
          path: 'variables.__rpt.agent_results.property.monthly'
        }
      }
    })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'RESULT_SOURCE_REQUIRED',
          path: ['priorSummary', 'source', 'path'],
          location: {
            kind: 'binding',
            binding: 'priorSummary',
            field: 'source.path'
          }
        })
      ]
    })
  })

  it('allows missing-path defaults only on bindings that can actually be missing', () => {
    const result = parseInputBindings({
      month: {
        source: { type: 'literal', value: 3 },
        default: 1
      }
    })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'INVALID_DEFAULT',
          path: ['month', 'default'],
          location: {
            kind: 'binding',
            binding: 'month',
            field: 'default'
          }
        })
      ]
    })
  })

  it('requires json Result Contracts to carry a schema and Result Slots to use the reserved root', () => {
    const missingSchema = parseResultContract({ mode: 'json' })
    const badSlot = parseResultContract({
      mode: 'text',
      saveAs: 'variables.stat_data.agent_results.summary'
    })

    expect(missingSchema).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          path: ['schema'],
          location: { kind: 'field', field: 'schema' }
        })
      ]
    })
    expect(badSlot).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'RESULT_SLOT_PATH_REQUIRED',
          path: ['saveAs'],
          location: { kind: 'field', field: 'saveAs' }
        })
      ]
    })
  })

  it('accepts the restricted Yuzu annotated-floor validator distinctly from standard yss', () => {
    expect(parseResultContract({ mode: 'text', validator: 'yuzu-annotated-floor' })).toEqual({
      ok: true,
      value: { mode: 'text', validator: 'yuzu-annotated-floor' }
    })
  })

  it('rejects writes through the runtime-owned variables branch', () => {
    const result = parseWritableVariablesPath('variables.__rpt.agent_results.property.monthly')

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'RESERVED_PATH',
          path: ['path'],
          location: { kind: 'field', field: 'path' }
        })
      ]
    })
  })

  it('keeps direct invocation input unambiguous from late-resolved Input Bindings', () => {
    const result = parseInvocationOptions({
      input: { month: 3 },
      inputBindings: {
        month: {
          source: { type: 'variables', path: 'variables.stat_data.world.month' }
        }
      }
    })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'AMBIGUOUS_INPUT',
          path: ['inputBindings'],
          location: { kind: 'field', field: 'inputBindings' }
        })
      ]
    })
  })

  it('rejects undeclared invocation controls instead of enabling hidden fallback behavior', () => {
    const result = parseInvocationOptions({ fallbackPresetId: 'larger-model' })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'UNKNOWN_FIELD',
          path: ['fallbackPresetId'],
          location: { kind: 'field', field: 'fallbackPresetId' }
        })
      ]
    })
  })

  it('rejects non-object direct invocation input at the input field', () => {
    const result = parseInvocationOptions({ input: ['not', 'an', 'object'] })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'INVALID_TYPE',
          path: ['input'],
          location: { kind: 'field', field: 'input' }
        })
      ]
    })
  })

  it('validates Agent input JSON Schema semantics at the exact schema field', () => {
    const result = parseAgentDefinition({
      ...MONTHLY_PROPERTY_AGENT,
      inputSchema: {
        type: 'object',
        properties: {
          month: { type: 'calendar-month' }
        }
      }
    })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'INVALID_JSON_SCHEMA',
          path: ['inputSchema', 'properties', 'month', 'type'],
          location: {
            kind: 'field',
            agent: 'Property Management',
            field: 'inputSchema.properties.month.type'
          }
        })
      ]
    })
  })

  it('requires Agent and tool input schemas to explicitly describe objects', () => {
    const agentResult = parseAgentDefinition({
      ...MONTHLY_PROPERTY_AGENT,
      inputSchema: {}
    })
    const toolResult = parseAgentDefinition({
      ...MONTHLY_PROPERTY_AGENT,
      tools: [
        {
          name: 'lookup',
          description: 'Look up a value.',
          inputSchema: { type: 'array', items: { type: 'string' } }
        }
      ]
    })

    expect(agentResult).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'INPUT_SCHEMA_OBJECT',
          path: ['inputSchema', 'type'],
          location: {
            kind: 'field',
            agent: 'Property Management',
            field: 'inputSchema.type'
          }
        })
      ]
    })
    expect(toolResult).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'INPUT_SCHEMA_OBJECT',
          path: ['tools', 0, 'inputSchema', 'type'],
          location: {
            kind: 'tool',
            agent: 'Property Management',
            tool: 0,
            field: 'inputSchema.type'
          }
        })
      ]
    })
  })

  it('validates JSON Result Contract schema semantics at the result schema field', () => {
    const result = parseAgentDefinition({
      ...MONTHLY_PROPERTY_AGENT,
      result: {
        mode: 'json',
        schema: {
          type: 'object',
          required: 'summary'
        }
      }
    })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'INVALID_JSON_SCHEMA',
          path: ['result', 'schema', 'required'],
          location: {
            kind: 'field',
            agent: 'Property Management',
            field: 'result.schema.required'
          }
        })
      ]
    })
  })

  it('validates standalone JSON Result Contracts through the same public Interface', () => {
    const result = parseResultContract({
      mode: 'json',
      schema: { type: 'object', required: 'summary' }
    })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'INVALID_JSON_SCHEMA',
          path: ['schema', 'required'],
          location: { kind: 'field', field: 'schema.required' }
        })
      ]
    })
  })

  it('rejects runtime-unsupported JSON Schema keywords at activation', () => {
    const result = parseAgentDefinition({
      ...MONTHLY_PROPERTY_AGENT,
      result: {
        mode: 'json',
        schema: {
          type: 'object',
          dependentSchemas: {
            summary: {
              required: ['details']
            }
          }
        }
      }
    })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'UNSUPPORTED_JSON_SCHEMA',
          path: ['result', 'schema', 'dependentSchemas'],
          location: {
            kind: 'field',
            agent: 'Property Management',
            field: 'result.schema.dependentSchemas'
          }
        })
      ]
    })
  })

  it('rejects JSON Schema assertions the runtime validator would silently ignore', () => {
    const result = parseResultContract({
      mode: 'json',
      schema: {
        type: 'array',
        uniqueItems: true
      }
    })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'UNSUPPORTED_JSON_SCHEMA',
          path: ['schema', 'uniqueItems'],
          location: { kind: 'field', field: 'schema.uniqueItems' }
        })
      ]
    })
  })

  it('accepts all existing generation sampler fields', () => {
    const result = parseInvocationOptions({
      generationParameters: {
        repetition_penalty: 1.1,
        min_p: 0.05,
        top_a: 0.2
      }
    })

    expect(result).toEqual({
      ok: true,
      value: {
        generationParameters: {
          repetition_penalty: 1.1,
          min_p: 0.05,
          top_a: 0.2
        }
      }
    })
  })

  it('resolves effective invocation options from Definition defaults and step overrides', () => {
    const definition = parseAgentDefinition({
      ...MONTHLY_PROPERTY_AGENT,
      defaults: {
        ...MONTHLY_PROPERTY_AGENT.defaults,
        generationParameters: { max_tokens: 1200, temperature: 0.8 }
      }
    })
    expect(definition.ok).toBe(true)
    if (!definition.ok) return

    const result = resolveInvocationOptions(definition.value, {
      maxRetryAttempts: 2,
      generationParameters: { temperature: 0.2 }
    })

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        required: true,
        maxSteps: 1,
        maxRetryAttempts: 2,
        retryDelayMs: 5000,
        blocksNextTurn: false,
        toolResultMaxTokens: 10000,
        saveAs: 'variables.__rpt.agent_results.property.monthly',
        generationParameters: { max_tokens: 1200, temperature: 0.2 },
        notification: 'failure'
      })
    })
  })

  it('does not let invocation overrides turn a tool-free Agent into a hidden loop', () => {
    const definition = parseAgentDefinition(MONTHLY_PROPERTY_AGENT)
    expect(definition.ok).toBe(true)
    if (!definition.ok) return

    const result = resolveInvocationOptions(definition.value, { maxSteps: 2 })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'ONE_CALL_MAX_STEPS',
          path: ['maxSteps'],
          location: {
            kind: 'field',
            agent: 'Property Management',
            field: 'maxSteps'
          }
        })
      ]
    })
  })

  it('accepts only the approved sequence and flat parallel Invocation Plan grammar', () => {
    expect(parseInvocationPlan(MONTHLY_WORLD_PLAN)).toEqual({
      ok: true,
      value: MONTHLY_WORLD_PLAN
    })
  })

  it('rejects nested parallel groups at the nested plan member', () => {
    const result = parseInvocationPlan({
      steps: [
        {
          parallel: [
            {
              parallel: [{ agent: 'Nested Agent' }]
            }
          ]
        }
      ]
    })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'NESTED_PARALLEL',
          path: ['steps', 0, 'parallel', 0, 'parallel'],
          location: {
            kind: 'plan',
            step: 0,
            parallel: 0,
            field: 'parallel'
          }
        })
      ]
    })
  })

  it('rejects duplicate Agent membership anywhere on one Invocation Floor', () => {
    const result = parseInvocationPlan({
      steps: [
        { agent: 'Property Management' },
        {
          parallel: [{ agent: 'World Progression' }, { agent: 'Property Management' }]
        }
      ]
    })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'DUPLICATE_AGENT',
          path: ['steps', 1, 'parallel', 1, 'agent'],
          location: {
            kind: 'plan',
            step: 1,
            parallel: 1,
            field: 'agent'
          }
        })
      ]
    })
  })

  it('rejects plan conditionals as unknown fields on the responsible step', () => {
    const result = parseInvocationPlan({
      steps: [{ agent: 'Property Management', when: 'monthChanged' }]
    })

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'UNKNOWN_FIELD',
          path: ['steps', 0, 'when'],
          location: { kind: 'plan', step: 0, field: 'when' }
        })
      ]
    })
  })
})
