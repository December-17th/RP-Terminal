import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

import type { Settings } from '../../../src/main/types/models'
import type { PresetParameters } from '../../../src/main/types/preset'
import type { P0Context } from '../../../src/shared/yuzu/p0/fixtureContext'
import { SceneSchema } from '../../../src/shared/yuzu/p0/sceneDraftSchema'
import type { CallProvider, ProviderSpec, RunRecord } from '../../../src/shared/yuzu/p0/runP0Batch'
import { formatReadout, type Readout } from '../../../src/shared/yuzu/p0/metrics'
import { FailureShape } from '../../../src/shared/yuzu/p0/validate'

/** Shared, non-test plumbing for the env-gated JSON and inline P0 harnesses. */

const HERE = dirname(fileURLToPath(import.meta.url))
export const RESULTS_DIR = join(HERE, 'results')
export const LOCAL_PROVIDERS = join(HERE, 'providers.local.json')

export interface LocalProvider {
  name: string
  provider: string
  endpoint: string
  api_key: string
  model: string
  rpm_limit?: number
  max_concurrent?: number
}

type Warn = (message: string) => void
type HarnessEnv = Record<string, string | undefined>

const localProviderSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  endpoint: z.string().min(1),
  api_key: z.string().min(1),
  model: z.string().min(1),
  rpm_limit: z.number().int().nonnegative().optional(),
  max_concurrent: z.number().int().nonnegative().optional()
})

const attemptRecordSchema = z.object({
  raw: z.string(),
  providerError: z.string().optional(),
  latencyMs: z.number().nonnegative(),
  applied: z.array(z.string()),
  ok: z.boolean(),
  failures: z.array(z.enum(FailureShape))
})

const runRecordFields = {
  ts: z.string(),
  providerName: z.string().min(1),
  model: z.string().min(1),
  checkpointKey: z.string().min(1).optional(),
  format: z.enum(['json', 'inline']).optional()
}
const successfulAttemptSchema = attemptRecordSchema.extend({ ok: z.literal(true) })
const failedAttemptSchema = attemptRecordSchema.extend({ ok: z.literal(false) })
const runRecordSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      ...runRecordFields,
      attempt1: successfulAttemptSchema,
      repair: z.never().optional(),
      outcome: z.literal('valid'),
      fallbackScene: z.never().optional()
    })
    .passthrough(),
  z
    .object({
      ...runRecordFields,
      attempt1: failedAttemptSchema,
      repair: successfulAttemptSchema,
      outcome: z.literal('repaired'),
      fallbackScene: z.never().optional()
    })
    .passthrough(),
  z
    .object({
      ...runRecordFields,
      attempt1: failedAttemptSchema,
      repair: failedAttemptSchema,
      outcome: z.literal('fallback'),
      fallbackScene: SceneSchema
    })
    .passthrough()
])

/** Validate entries independently so one bad preset cannot abort a paid batch. */
export const parseLocalProviders = (
  input: unknown,
  onWarning: Warn = console.warn
): LocalProvider[] => {
  if (!Array.isArray(input)) {
    onWarning('providers.local.json must contain an array; no providers were loaded')
    return []
  }
  const providers: LocalProvider[] = []
  const seenNames = new Set<string>()
  input.forEach((entry, index) => {
    const parsed = localProviderSchema.safeParse(entry)
    if (!parsed.success) {
      onWarning(`Skipping invalid provider entry ${index}: ${parsed.error.issues[0]?.message}`)
      return
    }
    if (seenNames.has(parsed.data.name)) {
      onWarning(`Skipping duplicate provider name at entry ${index}: ${parsed.data.name}`)
      return
    }
    seenNames.add(parsed.data.name)
    providers.push(parsed.data)
  })
  return providers
}

export const loadLocalProviders = (onWarning: Warn = console.warn): LocalProvider[] => {
  if (!existsSync(LOCAL_PROVIDERS)) {
    throw new Error(
      `Missing ${LOCAL_PROVIDERS}. Copy providers.example.json to providers.local.json and fill in your real keys (see README.md).`
    )
  }
  try {
    return parseLocalProviders(JSON.parse(readFileSync(LOCAL_PROVIDERS, 'utf-8')), onWarning)
  } catch (error) {
    onWarning(
      `Could not parse ${LOCAL_PROVIDERS}: ${error instanceof Error ? error.message : error}`
    )
    return []
  }
}

export const settingsFor = (p: LocalProvider): Settings =>
  ({
    api: {
      provider: p.provider,
      endpoint: p.endpoint,
      api_key: p.api_key,
      model: p.model,
      rpm_limit: 0,
      max_concurrent: 0
    },
    cache: { mode: 'baseline' }
  }) as unknown as Settings

const numericEnv = (
  env: HarnessEnv,
  key: string,
  fallback: number,
  valid: (value: number) => boolean,
  onWarning: Warn
): number => {
  const raw = env[key]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (Number.isFinite(value) && valid(value)) return value
  onWarning(`Ignoring invalid ${key}=${JSON.stringify(raw)}; using ${fallback}`)
  return fallback
}

export const paramsFromEnv = (
  env: HarnessEnv = process.env,
  onWarning: Warn = console.warn
): PresetParameters => ({
  temperature: numericEnv(env, 'YUZU_P0_TEMP', 0.8, (value) => value >= 0 && value <= 2, onWarning),
  max_tokens: numericEnv(
    env,
    'YUZU_P0_MAX_TOKENS',
    1500,
    (value) => Number.isInteger(value) && value > 0,
    onWarning
  )
})

export const runsPerProviderFromEnv = (
  env: HarnessEnv = process.env,
  onWarning: Warn = console.warn
): number =>
  numericEnv(env, 'YUZU_P0_RUNS', 20, (value) => Number.isInteger(value) && value > 0, onWarning)

/** Parse append-only JSONL checkpoints, skipping dirty or partial tail lines safely. */
export const parseCheckpointJsonl = (text: string, onWarning: Warn = console.warn): RunRecord[] => {
  const records: RunRecord[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return
    try {
      const parsed = runRecordSchema.safeParse(JSON.parse(line))
      if (parsed.success) records.push(parsed.data as RunRecord)
      else
        onWarning(
          `Skipping invalid checkpoint line ${index + 1}: ${parsed.error.issues[0]?.message}`
        )
    } catch (error) {
      onWarning(
        `Skipping unreadable checkpoint line ${index + 1}: ${error instanceof Error ? error.message : error}`
      )
    }
  })
  return records
}

export const formatProgress = (
  completed: number,
  total: number,
  record: Pick<RunRecord, 'providerName' | 'model' | 'outcome'> & { format?: string }
): string =>
  `[${completed}/${total}] ${record.providerName} / ${record.model} (${record.format ?? 'json'}): ${record.outcome}`

export const formatCheckpointAppend = (record: RunRecord, needsLeadingNewline: boolean): string =>
  `${needsLeadingNewline ? '\n' : ''}${JSON.stringify(record)}\n`

/** Resume writes are restricted to JSONL artifacts owned by this harness. */
export const resolveResumePath = (input: string): string => {
  const resolved = resolve(input)
  if (extname(resolved).toLowerCase() !== '.jsonl') {
    throw new Error(`YUZU_P0_RESUME must name a .jsonl file: ${input}`)
  }
  const fromResults = relative(RESULTS_DIR, resolved)
  if (fromResults.startsWith('..') || isAbsolute(fromResults)) {
    throw new Error(`YUZU_P0_RESUME must stay inside ${RESULTS_DIR}: ${input}`)
  }
  return resolved
}

/** Non-secret fingerprint of every input that affects the A/B result. */
export const buildCheckpointKey = (
  format: 'json' | 'inline',
  ctx: P0Context,
  providers: LocalProvider[],
  params: PresetParameters
): string => {
  const safeProviders = providers.map((provider) => ({
    name: provider.name,
    provider: provider.provider,
    endpoint: provider.endpoint,
    model: provider.model,
    rpm_limit: provider.rpm_limit ?? 0,
    max_concurrent: provider.max_concurrent ?? 0
  }))
  const config = { version: 1, format, ctx, providers: safeProviders, params }
  return createHash('sha256').update(JSON.stringify(config)).digest('hex')
}

/** Load Electron/network-bearing modules only after an enabled harness test starts running. */
export const loadRealHarnessDeps = async (): Promise<{
  callProvider: CallProvider<Settings, PresetParameters>
  buildProviderSpecs: (
    local: LocalProvider[],
    params: PresetParameters,
    signal: AbortSignal
  ) => {
    providers: ProviderSpec<Settings, PresetParameters>[]
    acquireSlot: (spec: ProviderSpec<Settings, PresetParameters>) => Promise<() => void>
  }
}> => {
  const [{ streamProvider, rpmEndpointKey }, { acquireRpmSlot, acquireConcurrencySlot }] =
    await Promise.all([
      import('../../../src/main/services/apiService'),
      import('../../../src/main/services/rpmLimiter')
    ])

  const callProvider: CallProvider<Settings, PresetParameters> = (
    settings,
    messages,
    params,
    onDelta,
    signal
  ) => streamProvider(settings, messages, params, onDelta, signal)

  const buildProviderSpecs = (
    local: LocalProvider[],
    params: PresetParameters,
    signal: AbortSignal
  ): {
    providers: ProviderSpec<Settings, PresetParameters>[]
    acquireSlot: (spec: ProviderSpec<Settings, PresetParameters>) => Promise<() => void>
  } => {
    const budgets = new Map<string, { key: string; rpm: number; max: number }>()
    const providers: ProviderSpec<Settings, PresetParameters>[] = local.map((p) => {
      const settings = settingsFor(p)
      budgets.set(p.name, {
        key: rpmEndpointKey(settings.api),
        rpm: p.rpm_limit ?? 0,
        max: p.max_concurrent ?? 0
      })
      return { name: p.name, model: p.model, settings, params }
    })

    const acquireSlot = async (
      spec: ProviderSpec<Settings, PresetParameters>
    ): Promise<() => void> => {
      const budget = budgets.get(spec.name)!
      if (budget.rpm > 0) await acquireRpmSlot(budget.key, budget.rpm, signal)
      return acquireConcurrencySlot(budget.key, budget.max, signal)
    }
    return { providers, acquireSlot }
  }

  return { callProvider, buildProviderSpecs }
}

export const makeResultSink = (
  suffix = '',
  checkpointKey?: string,
  resumePath = process.env.YUZU_P0_RESUME,
  onWarning: Warn = console.warn
): {
  jsonlPath: string
  readoutPath: string
  priorRecords: RunRecord[]
  onRecord: (r: RunRecord) => void
} => {
  mkdirSync(RESULTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const resolvedResumePath = resumePath ? resolveResumePath(resumePath) : undefined
  if (resolvedResumePath && !existsSync(resolvedResumePath)) {
    throw new Error(`YUZU_P0_RESUME checkpoint does not exist: ${resolvedResumePath}`)
  }
  const jsonlPath = resolvedResumePath ?? join(RESULTS_DIR, `${stamp}${suffix}.jsonl`)
  const readoutPath = resolvedResumePath
    ? `${resolvedResumePath.replace(/\.jsonl$/i, '')}.readout.txt`
    : join(RESULTS_DIR, `${stamp}${suffix}.readout.txt`)
  const checkpointText = resolvedResumePath ? readFileSync(resolvedResumePath, 'utf-8') : ''
  const priorRecords = parseCheckpointJsonl(checkpointText, onWarning)
  if (
    resolvedResumePath &&
    checkpointKey &&
    priorRecords.some((record) => record.checkpointKey !== checkpointKey)
  ) {
    throw new Error(
      `YUZU_P0_RESUME checkpoint configuration does not match this run: ${resolvedResumePath}`
    )
  }
  let needsLeadingNewline = checkpointText.length > 0 && !checkpointText.endsWith('\n')
  const onRecord = (record: RunRecord): void => {
    appendFileSync(jsonlPath, formatCheckpointAppend(record, needsLeadingNewline), 'utf-8')
    needsLeadingNewline = false
  }
  return { jsonlPath, readoutPath, priorRecords, onRecord }
}

export const writeReadout = (readoutPath: string, jsonlPath: string, readout: Readout): void => {
  const text = formatReadout(readout)
  writeFileSync(readoutPath, text + '\n', 'utf-8')
  console.log(`\n${text}\n\nRecords: ${jsonlPath}\nReadout: ${readoutPath}\n`)
}
