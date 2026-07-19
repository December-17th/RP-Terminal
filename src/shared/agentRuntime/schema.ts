import { z } from 'zod'
import {
  contractError,
  contractErrorsFromZod,
  type AgentContractError,
  type AgentContractResult
} from './errors'
import { isFullVariablesPath, isResultSlotPath, isWritableVariablesPath } from './paths'
import { isObjectInputSchema, validateJsonSchemaSemantics } from './jsonSchema'
import type {
  AgentDefinition,
  EffectiveInvocationOptions,
  FullVariablesPath,
  InputBindings,
  InvocationOptions,
  InvocationPlanCall,
  PromptMessage,
  ResultContract
} from './types'

const NonEmptyStringSchema = z.string().trim().min(1)
const JsonObjectSchema = z.record(z.string(), z.json())
const JsonSchemaSchema = JsonObjectSchema

const CardVariablesPathSchema = z
  .string()
  .superRefine((path, context) => {
    if (!isFullVariablesPath(path)) {
      context.addIssue({
        code: 'custom',
        message: 'path must be a full dot path rooted at variables'
      })
    } else if (!isWritableVariablesPath(path)) {
      context.addIssue({
        code: 'custom',
        message: 'Result Slot reads must use a result source'
      })
    }
  })
  .transform((path) => path as FullVariablesPath)
const ResultSlotPathSchema = z
  .string()
  .refine(isResultSlotPath, 'path must be beneath variables.__rpt.agent_results')

const InputBindingSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('literal'), value: z.json() }),
  z.strictObject({ type: z.literal('input') }),
  z.strictObject({ type: z.literal('variables'), path: CardVariablesPathSchema }),
  z.strictObject({ type: z.literal('result'), path: ResultSlotPathSchema })
])

const InputBindingSchema = z
  .strictObject({
    source: InputBindingSourceSchema,
    default: z.json().optional()
  })
  .superRefine((binding, context) => {
    if (
      binding.default !== undefined &&
      binding.source.type !== 'variables' &&
      binding.source.type !== 'result'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['default'],
        message: 'default is only valid for a variables or result source'
      })
    }
  })

const InputBindingsSchema = z.record(NonEmptyStringSchema, InputBindingSchema)

const PromptBindingSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('input') }),
  z.strictObject({ type: z.literal('history') }),
  z.strictObject({ type: z.literal('variables'), path: CardVariablesPathSchema }),
  z.strictObject({ type: z.literal('result'), path: ResultSlotPathSchema })
])

const PromptSegmentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({
    type: z.literal('binding'),
    source: PromptBindingSourceSchema,
    default: z.json().optional()
  })
])

const PromptContentSchema = z.union([
  z.string().transform((text) => [{ type: 'text' as const, text }]),
  z.array(PromptSegmentSchema).min(1)
])

const PromptMessageSchema = z.strictObject({
  role: z.enum(['system', 'user', 'assistant']),
  content: PromptContentSchema
})

const PromptSchema = z.array(PromptMessageSchema).min(1)

const TextResultContractSchema = z.strictObject({
  mode: z.literal('text'),
  saveAs: ResultSlotPathSchema.optional(),
  validator: z.literal('yss').optional()
})

const JsonResultContractSchema = z.strictObject({
  mode: z.literal('json'),
  schema: JsonSchemaSchema,
  saveAs: ResultSlotPathSchema.optional()
})

const ToolsOnlyResultContractSchema = z.strictObject({
  mode: z.literal('tools-only')
})

const ResultContractSchema = z.discriminatedUnion('mode', [
  TextResultContractSchema,
  JsonResultContractSchema,
  ToolsOnlyResultContractSchema
])

const HistoryPolicySchema = z.strictObject({
  maxFloors: z.int().positive().optional(),
  maxTokens: z.int().positive().optional(),
  includeUserMessages: z.boolean().default(false),
  includePlayerResults: z.boolean().default(false)
})

const GenerationParametersSchema = z.strictObject({
  temperature: z.number().optional(),
  max_tokens: z.int().positive().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  repetition_penalty: z.number().optional(),
  min_p: z.number().optional(),
  top_a: z.number().optional(),
  stop: z.array(z.string()).optional()
})

const LorebookEntryFilterSchema = z
  .strictObject({
    include: z.array(NonEmptyStringSchema).min(1).optional(),
    exclude: z.array(NonEmptyStringSchema).min(1).optional()
  })
  .superRefine((filter, context) => {
    if (filter.include === undefined && filter.exclude === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'entries must narrow with include or exclude'
      })
      return
    }
    const included = new Set(filter.include ?? [])
    for (const [index, name] of (filter.exclude ?? []).entries()) {
      if (included.has(name)) {
        context.addIssue({
          code: 'custom',
          path: ['exclude', index],
          message: `entry "${name}" cannot be both included and excluded`
        })
      }
    }
  })

const LorebookSelectionSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('session'),
    entries: LorebookEntryFilterSchema.optional()
  }),
  z.strictObject({
    mode: z.literal('explicit'),
    lorebooks: z.array(NonEmptyStringSchema).min(1),
    entries: LorebookEntryFilterSchema.optional()
  })
])

const AgentPresetBundleSchema = z.strictObject({
  preset: JsonObjectSchema,
  generationParameters: GenerationParametersSchema.optional(),
  lorebooks: LorebookSelectionSchema.optional()
})

const InvocationDefaultFields = {
  required: z.boolean().default(true),
  maxSteps: z.int().positive().optional(),
  maxRetryAttempts: z.int().nonnegative().default(5),
  retryDelayMs: z.int().nonnegative().default(5000),
  blocksNextTurn: z.boolean().default(false),
  toolResultMaxTokens: z.int().positive().default(10000),
  history: HistoryPolicySchema.optional(),
  generationParameters: GenerationParametersSchema.optional(),
  notification: z.enum(['none', 'failure', 'completion']).default('failure')
}

const AgentDefaultsSchema = z.strictObject(InvocationDefaultFields).default({
  required: true,
  maxRetryAttempts: 5,
  retryDelayMs: 5000,
  blocksNextTurn: false,
  toolResultMaxTokens: 10000,
  notification: 'failure'
})

const AgentToolDefinitionSchema = z.strictObject({
  name: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  inputSchema: JsonSchemaSchema,
  required: z.boolean().default(true),
  transactionMode: z
    .enum(['read-only', 'transactional', 'non-transactional'])
    .default('transactional'),
  parallelSafe: z.boolean().default(false),
  resultMaxTokens: z.int().positive().optional()
})

/**
 * The single declarative trigger kind (M3, D1(a)). `strictObject` at BOTH levels is the enforcement:
 * any other trigger kind or extra field (a timer, cron, `onVariableChanged`, …) is rejected at parse
 * time, so no other trigger shape can ever reach the runtime. `everyNFloors` must be a positive
 * integer (≥ 1).
 */
const AgentTriggerSchema = z.strictObject({
  onFloorCommitted: z.strictObject({
    everyNFloors: z.int().positive()
  })
})

const RawAgentDefinitionSchema = z.strictObject({
  format: z.literal('rpt-agent'),
  formatVersion: z.literal(1),
  name: NonEmptyStringSchema,
  description: NonEmptyStringSchema.optional(),
  prompt: PromptSchema,
  preset: AgentPresetBundleSchema.optional(),
  inputSchema: JsonSchemaSchema.default({ type: 'object' }),
  result: ResultContractSchema,
  tools: z.array(AgentToolDefinitionSchema).default([]),
  modelHint: NonEmptyStringSchema.optional(),
  trigger: AgentTriggerSchema.optional(),
  defaults: AgentDefaultsSchema
})

/**
 * Zod adapter for embedding Agent Definitions in larger strict contracts (for example World Cards).
 * Standalone callers should prefer parseAgentDefinition so they retain structured contract errors.
 */
export const AgentDefinitionSchema: z.ZodType<AgentDefinition> = z
  .unknown()
  .transform((raw, context) => {
    const result = parseAgentDefinition(raw)
    if (result.ok) return result.value
    for (const error of result.errors) {
      context.addIssue({
        code: 'custom',
        path: error.path,
        message: error.message
      })
    }
    return z.NEVER
  })

const InvocationOptionsSchema = z.strictObject({
  floor: z.int().positive().optional(),
  input: JsonObjectSchema.optional(),
  inputBindings: InputBindingsSchema.optional(),
  required: z.boolean().optional(),
  maxSteps: z.int().positive().optional(),
  maxRetryAttempts: z.int().nonnegative().optional(),
  retryDelayMs: z.int().nonnegative().optional(),
  blocksNextTurn: z.boolean().optional(),
  toolResultMaxTokens: z.int().positive().optional(),
  history: HistoryPolicySchema.optional(),
  saveAs: ResultSlotPathSchema.optional(),
  apiPresetId: NonEmptyStringSchema.optional(),
  model: NonEmptyStringSchema.optional(),
  generationParameters: GenerationParametersSchema.optional(),
  notification: z.enum(['none', 'failure', 'completion']).optional(),
  addendum: z.string().optional()
})

export const InvocationPlanCallSchema: z.ZodType<InvocationPlanCall> = z.strictObject({
  agent: NonEmptyStringSchema,
  input: InputBindingsSchema.optional(),
  required: z.boolean().optional(),
  maxSteps: z.int().positive().optional(),
  maxRetryAttempts: z.int().nonnegative().optional(),
  retryDelayMs: z.int().nonnegative().optional(),
  blocksNextTurn: z.boolean().optional(),
  toolResultMaxTokens: z.int().positive().optional(),
  history: HistoryPolicySchema.optional(),
  saveAs: ResultSlotPathSchema.optional(),
  apiPresetId: NonEmptyStringSchema.optional(),
  model: NonEmptyStringSchema.optional(),
  generationParameters: GenerationParametersSchema.optional(),
  notification: z.enum(['none', 'failure', 'completion']).optional(),
  addendum: z.string().optional()
})

const resultFromSchema = <T>(
  result: z.ZodSafeParseResult<T>,
  context: Parameters<typeof contractErrorsFromZod>[1]
): AgentContractResult<T> =>
  result.success
    ? { ok: true, value: result.data }
    : { ok: false, errors: contractErrorsFromZod(result.error.issues, context) }

export function normalizePrompt(raw: unknown): AgentContractResult<PromptMessage[]> {
  return resultFromSchema(PromptSchema.safeParse(raw), { kind: 'field' })
}

export function parseResultContract(raw: unknown): AgentContractResult<ResultContract> {
  const parsed = resultFromSchema(ResultContractSchema.safeParse(raw), { kind: 'field' })
  if (!parsed.ok || parsed.value.mode !== 'json') return parsed
  const errors = validateJsonSchemaSemantics(parsed.value.schema).map((schemaIssue) =>
    contractError(
      schemaIssue.code === 'unsupported' ? 'UNSUPPORTED_JSON_SCHEMA' : 'INVALID_JSON_SCHEMA',
      schemaIssue.message,
      ['schema', ...schemaIssue.path],
      {
        kind: 'field'
      }
    )
  )
  return errors.length ? { ok: false, errors } : parsed
}

export function parseInputBindings(raw: unknown): AgentContractResult<InputBindings> {
  return resultFromSchema(InputBindingsSchema.safeParse(raw), { kind: 'bindings' })
}

export function parseInvocationOptions(raw: unknown): AgentContractResult<InvocationOptions> {
  const result = resultFromSchema(InvocationOptionsSchema.safeParse(raw), { kind: 'field' })
  if (!result.ok || result.value.input === undefined || result.value.inputBindings === undefined) {
    return result
  }
  return {
    ok: false,
    errors: [
      contractError(
        'AMBIGUOUS_INPUT',
        'input and inputBindings cannot both be supplied',
        ['inputBindings'],
        { kind: 'field' }
      )
    ]
  }
}

export function resolveInvocationOptions(
  definition: AgentDefinition,
  raw: unknown = {}
): AgentContractResult<EffectiveInvocationOptions> {
  const parsed = parseInvocationOptions(raw)
  if (!parsed.ok) return parsed

  const options = parsed.value
  const maxSteps = options.maxSteps ?? definition.defaults.maxSteps
  if (definition.tools.length === 0 && maxSteps !== 1) {
    return {
      ok: false,
      errors: [
        contractError(
          'ONE_CALL_MAX_STEPS',
          'an Agent without tools must use maxSteps 1',
          ['maxSteps'],
          { kind: 'field', agent: definition.name }
        )
      ]
    }
  }

  const definitionSaveAs =
    definition.result.mode === 'tools-only' ? undefined : definition.result.saveAs
  const saveAs = options.saveAs ?? definitionSaveAs
  if (definition.result.mode === 'tools-only' && saveAs !== undefined) {
    return {
      ok: false,
      errors: [
        contractError(
          'TOOLS_ONLY_RESULT_SLOT',
          'a tools-only Result Contract cannot write a Result Slot',
          ['saveAs'],
          { kind: 'field', agent: definition.name }
        )
      ]
    }
  }

  const generationParameters =
    definition.defaults.generationParameters || options.generationParameters
      ? {
          ...definition.defaults.generationParameters,
          ...options.generationParameters
        }
      : undefined

  return {
    ok: true,
    value: {
      ...options,
      required: options.required ?? definition.defaults.required,
      maxSteps,
      maxRetryAttempts: options.maxRetryAttempts ?? definition.defaults.maxRetryAttempts,
      retryDelayMs: options.retryDelayMs ?? definition.defaults.retryDelayMs,
      blocksNextTurn: options.blocksNextTurn ?? definition.defaults.blocksNextTurn,
      toolResultMaxTokens: options.toolResultMaxTokens ?? definition.defaults.toolResultMaxTokens,
      ...((options.history ?? definition.defaults.history)
        ? { history: options.history ?? definition.defaults.history }
        : {}),
      ...(saveAs ? { saveAs } : {}),
      ...(generationParameters ? { generationParameters } : {}),
      notification: options.notification ?? definition.defaults.notification
    }
  }
}

export function parseAgentDefinition(raw: unknown): AgentContractResult<AgentDefinition> {
  const agent =
    typeof raw === 'object' && raw !== null && typeof (raw as { name?: unknown }).name === 'string'
      ? (raw as { name: string }).name
      : undefined
  const parsed = RawAgentDefinitionSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      errors: contractErrorsFromZod(parsed.error.issues, { kind: 'agent', agent })
    }
  }

  const value = parsed.data
  const errors: AgentContractError[] = []
  const addSchemaErrors = (
    schema: typeof value.inputSchema,
    prefix: Array<string | number>
  ): void => {
    for (const schemaIssue of validateJsonSchemaSemantics(schema)) {
      errors.push(
        contractError(
          schemaIssue.code === 'unsupported' ? 'UNSUPPORTED_JSON_SCHEMA' : 'INVALID_JSON_SCHEMA',
          schemaIssue.message,
          [...prefix, ...schemaIssue.path],
          { kind: 'agent', agent: value.name }
        )
      )
    }
  }

  addSchemaErrors(value.inputSchema, ['inputSchema'])
  if (!isObjectInputSchema(value.inputSchema)) {
    errors.push(
      contractError(
        'INPUT_SCHEMA_OBJECT',
        'inputSchema must explicitly describe a JSON object',
        ['inputSchema', 'type'],
        { kind: 'agent', agent: value.name }
      )
    )
  }
  if (value.result.mode === 'json') addSchemaErrors(value.result.schema, ['result', 'schema'])

  const toolNames = new Map<string, number>()
  for (const [index, tool] of value.tools.entries()) {
    addSchemaErrors(tool.inputSchema, ['tools', index, 'inputSchema'])
    if (!isObjectInputSchema(tool.inputSchema)) {
      errors.push(
        contractError(
          'INPUT_SCHEMA_OBJECT',
          'tool inputSchema must explicitly describe a JSON object',
          ['tools', index, 'inputSchema', 'type'],
          { kind: 'agent', agent: value.name }
        )
      )
    }
    const prior = toolNames.get(tool.name)
    if (prior !== undefined) {
      errors.push(
        contractError(
          'DUPLICATE_TOOL',
          `tool "${tool.name}" is already declared at index ${prior}`,
          ['tools', index, 'name'],
          { kind: 'agent', agent: value.name }
        )
      )
    } else {
      toolNames.set(tool.name, index)
    }
  }

  const maxSteps = value.defaults.maxSteps ?? (value.tools.length ? 8 : 1)
  if (value.tools.length === 0 && maxSteps !== 1) {
    errors.push(
      contractError(
        'ONE_CALL_MAX_STEPS',
        'an Agent without tools must use maxSteps 1',
        ['defaults', 'maxSteps'],
        { kind: 'agent', agent: value.name }
      )
    )
  }
  if (value.result.mode === 'tools-only' && value.tools.length === 0) {
    errors.push(
      contractError(
        'TOOLS_REQUIRED',
        'a tools-only Result Contract requires at least one declared tool',
        ['result', 'mode'],
        { kind: 'agent', agent: value.name }
      )
    )
  }
  if (errors.length) return { ok: false, errors }

  return {
    ok: true,
    value: {
      ...value,
      defaults: {
        ...value.defaults,
        maxSteps
      }
    } as AgentDefinition
  }
}
