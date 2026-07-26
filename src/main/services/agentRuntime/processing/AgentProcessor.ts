import crypto from 'crypto'

import {
  isPreprocessSkipSignal,
  type AgentDefinition,
  type JsonObject,
  type JsonValue,
  type ProcessorOutputContract
} from '../../../../shared/agentRuntime'
import { runSandbox } from '../../sandboxService'
import { compileJsonSchema } from '../harness/schemaValidation'

export const PROCESSOR_LIMITS = {
  sourceBytes: 64 * 1024,
  jsonBytes: 2 * 1024 * 1024,
  memoryBytes: 32 * 1024 * 1024,
  timeoutMs: 250
} as const

export type ProcessingWarningCode = 'SCRIPT_FAILED' | 'OUTPUT_INVALID' | 'LIMIT_EXCEEDED'
export interface ProcessingWarning {
  phase: 'preprocess' | 'postprocess'
  code: ProcessingWarningCode
  message: string
}

export interface ProcessingResult<T extends JsonValue | undefined> {
  value: T
  logs: string[]
  warning?: ProcessingWarning
  /**
   * Set by {@link runPreprocessor} ONLY when the script returned the skip sentinel (see
   * `isPreprocessSkipSignal`). The Invocation Runtime aborts the run before dispatch — no run record,
   * no cadence advance. `value` is left as the untouched raw input and must be ignored when this is set.
   */
  skip?: true
}

const jsonText = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

const copyJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const warning = (
  phase: ProcessingWarning['phase'],
  code: ProcessingWarningCode,
  message: string
): ProcessingWarning => ({ phase, code, message })

const seedFor = (script: string, inputJson: string): number =>
  crypto.createHash('sha256').update(script).update('\0').update(inputJson).digest().readUInt32LE(0)

const execute = async (
  phase: ProcessingWarning['phase'],
  script: string,
  input: JsonObject
): Promise<ProcessingResult<JsonValue | undefined>> => {
  if (Buffer.byteLength(script, 'utf8') > PROCESSOR_LIMITS.sourceBytes) {
    return {
      value: undefined,
      logs: [],
      warning: warning(phase, 'LIMIT_EXCEEDED', 'Processing script exceeds the 64 KiB source limit')
    }
  }
  const inputJson = jsonText(input)
  if (inputJson === undefined || Buffer.byteLength(inputJson, 'utf8') > PROCESSOR_LIMITS.jsonBytes) {
    return {
      value: undefined,
      logs: [],
      warning: warning(phase, 'LIMIT_EXCEEDED', 'Processing input exceeds the 2 MiB JSON limit')
    }
  }
  const result = await runSandbox({
    code: script,
    input: copyJson(input),
    seed: seedFor(script, inputJson),
    timeoutMs: PROCESSOR_LIMITS.timeoutMs,
    memoryLimitBytes: PROCESSOR_LIMITS.memoryBytes,
    preserveUndefined: true,
    processorMode: true
  })
  if (!result.ok) {
    const limit = /interrupt|memory|out of memory/i.test(result.error ?? '')
    return {
      value: undefined,
      logs: result.logs,
      warning: warning(
        phase,
        limit ? 'LIMIT_EXCEEDED' : 'SCRIPT_FAILED',
        result.error || 'Processing script failed'
      )
    }
  }
  if (result.result === undefined) {
    return {
      value: undefined,
      logs: result.logs,
      warning: warning(phase, 'OUTPUT_INVALID', 'Processing script must explicitly return a value')
    }
  }
  const outputJson = jsonText(result.result)
  if (outputJson === undefined || Buffer.byteLength(outputJson, 'utf8') > PROCESSOR_LIMITS.jsonBytes) {
    return {
      value: undefined,
      logs: result.logs,
      warning: warning(phase, 'LIMIT_EXCEEDED', 'Processing result exceeds the 2 MiB JSON limit')
    }
  }
  return { value: copyJson(result.result as JsonValue), logs: result.logs }
}

const validateSchema = (schema: JsonObject, value: unknown): string | undefined => {
  const compiled = compileJsonSchema(schema)
  if (!compiled.ok) return compiled.message
  const parsed = compiled.validate.safeParse(value)
  return parsed.success
    ? undefined
    : parsed.error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ')
}

export const runPreprocessor = async (
  definition: AgentDefinition,
  rawInput: JsonObject
): Promise<ProcessingResult<JsonObject>> => {
  if (definition.formatVersion !== 2 || !definition.processing?.preprocess) {
    return { value: copyJson(rawInput), logs: [] }
  }
  const run = await execute('preprocess', definition.processing.preprocess.code, { value: copyJson(rawInput) })
  if (run.warning) return { value: copyJson(rawInput), logs: run.logs, warning: run.warning }
  // Skip sentinel: detected BEFORE the object/inputSchema checks so a gate opting out is exempt from
  // the Agent's declared input contract. The raw input is preserved but ignored by the caller on skip.
  if (isPreprocessSkipSignal(run.value)) {
    const reason = typeof run.value.reason === 'string' ? run.value.reason : undefined
    return {
      value: copyJson(rawInput),
      logs: reason ? [...run.logs, `preprocess skip: ${reason}`] : run.logs,
      skip: true
    }
  }
  if (!run.value || typeof run.value !== 'object' || Array.isArray(run.value)) {
    return {
      value: copyJson(rawInput),
      logs: run.logs,
      warning: warning('preprocess', 'OUTPUT_INVALID', 'Preprocessor output must be a JSON object')
    }
  }
  const invalid = validateSchema(definition.inputSchema, run.value)
  return invalid
    ? {
        value: copyJson(rawInput),
        logs: run.logs,
        warning: warning('preprocess', 'OUTPUT_INVALID', `Preprocessor output failed inputSchema: ${invalid}`)
      }
    : { value: run.value as JsonObject, logs: run.logs }
}

const validateOutput = (
  contract: ProcessorOutputContract,
  value: JsonValue
): string | undefined => {
  if (contract.mode === 'text') {
    if (typeof value !== 'string') return 'Postprocessor output must be text'
    return undefined
  }
  return validateSchema(contract.schema, value)
}

export const runPostprocessor = async (
  definition: AgentDefinition,
  validatedModelResult: JsonValue | undefined,
  rawInput: JsonObject,
  processedInput: JsonObject
): Promise<ProcessingResult<JsonValue | undefined>> => {
  if (definition.formatVersion !== 2 || !definition.processing?.postprocess) {
    return { value: validatedModelResult === undefined ? undefined : copyJson(validatedModelResult), logs: [] }
  }
  const run = await execute('postprocess', definition.processing.postprocess.code, {
    value: validatedModelResult ?? null,
    rawInput: copyJson(rawInput),
    processedInput: copyJson(processedInput)
  })
  if (run.warning) return { value: validatedModelResult, logs: run.logs, warning: run.warning }
  const invalid = validateOutput(definition.processing.postprocess.output, run.value as JsonValue)
  return invalid
    ? { value: validatedModelResult, logs: run.logs, warning: warning('postprocess', 'OUTPUT_INVALID', invalid) }
    : run
}
