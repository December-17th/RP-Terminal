import type Database from 'better-sqlite3'
import {
  type AgentDefinition,
  type AgentRunAttempt,
  type AgentRunCancelResult,
  type AgentRunEvent,
  type AgentRunMessage,
  type AgentRunMetrics,
  type AgentRunRecord,
  type AgentRunReplayOutcome,
  type AgentRunStatus,
  type EffectiveInvocationOptions,
  type JsonObject,
  type JsonValue
} from '../../../../shared/agentRuntime'
import { getSessionDb, getSessionDbByChat } from '../../sessionDbService'
import type { HarnessAttemptEvidence, HarnessEvidence, HarnessFailure } from '../harness/types'

export interface AgentRunStart {
  invocationId: string
  profileId: string
  chatId: string
  floor: number
  agentVersion: string | number
  agentHash: string
  definition: AgentDefinition
  config: EffectiveInvocationOptions
  input: JsonObject
  renderedPrompt: AgentRunMessage[]
  history: JsonValue
}

export interface AgentRunFinal {
  status: Exclude<AgentRunStatus, 'running'>
  result?: JsonValue
  failure?: HarnessFailure
  replay: AgentRunReplayOutcome
  evidence: HarnessEvidence
  warnings?: string[]
}

export interface AgentRunHandle {
  record: AgentRunRecord
  signal: AbortSignal
}

export interface AgentRunStore {
  create(start: AgentRunStart): AgentRunHandle
  update(
    invocationId: string,
    evidence: HarnessEvidence,
    warnings?: string[]
  ): AgentRunRecord | null
  finalize(invocationId: string, final: AgentRunFinal): AgentRunRecord | null
  get(chatId: string, invocationId: string): AgentRunRecord | null
  list(chatId: string): AgentRunRecord[]
  cancel(invocationId: string): AgentRunCancelResult
  deleteFromFloor(chatId: string, fromFloor: number): void
  deleteChat(chatId: string): void
  deleteChatForProfile(profileId: string, chatId: string): void
  shutdown(): void
  subscribe(listener: (event: AgentRunEvent) => void): () => void
}

interface Dependencies {
  getDb?: (chatId: string) => Database.Database | null
  getDbForProfile?: (profileId: string, chatId: string) => Database.Database | null
  now?: () => string
}

const REDACTED_KEYS = new Set([
  'password',
  'passwordhash',
  'passwd',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'bearertoken',
  'secret',
  'clientsecret',
  'cookie',
  'setcookie',
  'xapikey',
  'apikey',
  'authorization',
  'proxyauthorization',
  'reasoning',
  'rawreasoning',
  'reasoningtext',
  'reasoningcontent',
  'chainofthought',
  'thinking',
  'thought'
])

const REASONING_DISCRIMINATORS = new Set([
  'reasoning',
  'reasoningcontent',
  'thinking',
  'thought',
  'chainofthought'
])
const DISCRIMINATOR_KEYS = new Set(['type', 'kind', 'channel', 'role'])
const normalizedKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '')
const REDACTED = '[redacted]'
const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'accesstoken',
  'apikey',
  'key',
  'secret',
  'password',
  'cookie'
])
const STRUCTURED_REASONING_TAG =
  /<(reasoning_content|raw_reasoning|reasoning|chain_of_thought|thinking|thought)(\b[^>]*)>[\s\S]*?<\/\1\s*>/gi

const redactedStringValue = (key: string, value: unknown): string => {
  if (
    (normalizedKey(key) === 'authorization' ||
      normalizedKey(key) === 'proxyauthorization') &&
    typeof value === 'string'
  ) {
    const scheme = value.match(/^\s*(Bearer|Basic)\b/i)?.[1]
    if (scheme) return `${scheme} ${REDACTED}`
  }
  return REDACTED
}

const sanitizeUrl = (candidate: string): string => {
  const trailing = candidate.match(/[\]),.;!]+$/)?.[0] ?? ''
  const urlText = trailing ? candidate.slice(0, -trailing.length) : candidate
  try {
    const url = new URL(urlText)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return candidate
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(normalizedKey(key))) {
        url.searchParams.set(key, REDACTED)
      }
    }
    return `${url.toString().replace(/%5Bredacted%5D/gi, REDACTED)}${trailing}`
  } catch {
    return candidate
  }
}

const sanitizeEmbeddedJsonValue = (value: unknown): unknown => {
  if (typeof value === 'string') return sanitizeString(value)
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map(sanitizeEmbeddedJsonValue)
  if (typeof value !== 'object') return value

  const entries = Object.entries(value)
  const reasoningBlock = entries.some(
    ([key, child]) =>
      DISCRIMINATOR_KEYS.has(normalizedKey(key)) &&
      typeof child === 'string' &&
      REASONING_DISCRIMINATORS.has(normalizedKey(child))
  )
  return Object.fromEntries(
    entries.map(([key, child]) => {
      if (REDACTED_KEYS.has(normalizedKey(key))) {
        return [key, redactedStringValue(key, child)]
      }
      if (reasoningBlock && !DISCRIMINATOR_KEYS.has(normalizedKey(key))) {
        return [key, REDACTED]
      }
      return [key, sanitizeEmbeddedJsonValue(child)]
    })
  )
}

function sanitizeString(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.stringify(sanitizeEmbeddedJsonValue(JSON.parse(trimmed)))
    } catch {
      // Continue with non-JSON string redaction for malformed or ordinary text.
    }
  }

  return value
    .replace(STRUCTURED_REASONING_TAG, (_match, tag: string, attributes: string) => {
      return `<${tag}${attributes}>${REDACTED}</${tag}>`
    })
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, sanitizeUrl)
    .replace(
      /(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:(Bearer|Basic)\s+)?([^\s,;]+)/gi,
      (_match, prefix: string, scheme: string | undefined) =>
        `${prefix}${scheme ? `${scheme} ` : ''}${REDACTED}`
    )
    .replace(
      /(\bx-api-key\s*[:=]\s*)([^\s,;]+)/gi,
      (_match, prefix: string) => `${prefix}${REDACTED}`
    )
    .replace(/(\bcookie\s*:\s*)([^\r\n]+)/gi, (_match, prefix: string) => {
      return `${prefix}${REDACTED}`
    })
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
      (match) => `${match.slice(0, match.indexOf(' ') + 1)}${REDACTED}`
    )
}

const sanitizeValue = (value: unknown): JsonValue | undefined => {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return sanitizeString(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) {
    return value.flatMap((child) => {
      const safe = sanitizeValue(child)
      return safe === undefined ? [] : [safe]
    })
  }
  if (typeof value !== 'object') return undefined
  const entries = Object.entries(value)
  if (
    entries.some(
      ([key, child]) =>
        DISCRIMINATOR_KEYS.has(normalizedKey(key)) &&
        typeof child === 'string' &&
        REASONING_DISCRIMINATORS.has(normalizedKey(child))
    )
  ) {
    return undefined
  }
  const result: JsonObject = {}
  for (const [key, child] of entries) {
    if (REDACTED_KEYS.has(normalizedKey(key)) || child === undefined) continue
    const safe = sanitizeValue(child)
    if (safe !== undefined) result[key] = safe
  }
  return result
}

const sanitize = (value: unknown): JsonValue => sanitizeValue(value) ?? null

const clone = <T>(value: T): T => structuredClone(value)

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const publicRecord = (record: AgentRunRecord): AgentRunRecord => deepFreeze(clone(record))

const emptyMetrics = (): AgentRunMetrics => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 0,
  retries: 0,
  rateLimits: []
})

const attemptRecord = (attempt: HarnessAttemptEvidence): AgentRunAttempt => {
  const complete = sanitize(attempt) as unknown as Omit<AgentRunAttempt, 'messages'>
  return {
    ...complete,
    repairs: [...(attempt.repairs ?? [])],
    messages: sanitize([
      ...attempt.immutablePrefix,
      ...attempt.appendOnlyLog
    ]) as unknown as AgentRunMessage[]
  }
}

const aggregateMetrics = (attempts: HarnessAttemptEvidence[]): AgentRunMetrics => {
  const metrics = emptyMetrics()
  metrics.retries = Math.max(0, attempts.length - 1)
  for (const attempt of attempts) {
    for (const usage of attempt.usage) {
      metrics.inputTokens += usage.inputTokens
      metrics.outputTokens += usage.outputTokens
    }
    for (const cache of attempt.cache) {
      metrics.cacheReadTokens += cache.readTokens
      metrics.cacheWriteTokens += cache.writeTokens
    }
    metrics.latencyMs += attempt.latencyMs.reduce((sum, latency) => sum + latency, 0)
    metrics.rateLimits.push(...(sanitize(attempt.rateLimits) as JsonValue[]))
  }
  return metrics
}

const summary = (record: AgentRunRecord) => ({
  invocationId: record.invocationId,
  chatId: record.chatId,
  floor: record.floor,
  agentName: record.agentName,
  status: record.status,
  startedAt: record.startedAt,
  ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
  notification: record.notification,
  ...(record.failure ? { failure: clone(record.failure) } : {}),
  ...(record.provider?.model ? { model: record.provider.model } : {}),
  metrics: clone(record.metrics)
})

export const createAgentRunStore = (dependencies: Dependencies = {}): AgentRunStore => {
  const dbFor = dependencies.getDb ?? ((chatId: string) => getSessionDbByChat(chatId))
  const dbForProfile =
    dependencies.getDbForProfile ??
    ((profileId: string, chatId: string) => getSessionDb(profileId, chatId))
  const now = dependencies.now ?? (() => new Date().toISOString())
  const controllers = new Map<
    string,
    { chatId: string; floor: number; controller: AbortController }
  >()
  const listeners = new Set<(event: AgentRunEvent) => void>()
  const emit = (event: AgentRunEvent): void => {
    for (const listener of listeners) {
      try {
        listener(clone(event))
      } catch {
        // Observation must never affect invocation persistence.
      }
    }
  }
  const read = (
    chatId: string,
    invocationId: string,
    db = dbFor(chatId)
  ): AgentRunRecord | null => {
    const row = db
      ?.prepare('SELECT record FROM agent_runs WHERE chat_id = ? AND invocation_id = ?')
      .get(chatId, invocationId) as { record: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.record) as AgentRunRecord
    } catch {
      return null
    }
  }
  const persist = (record: AgentRunRecord, db = dbFor(record.chatId)): void => {
    if (!db) throw new Error(`Agent run session is unavailable for chat ${record.chatId}`)
    const safe = sanitize(record) as unknown as AgentRunRecord
    db.prepare(
      `INSERT INTO agent_runs
         (invocation_id, chat_id, floor, status, started_at, finished_at, record)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(invocation_id) DO UPDATE SET
         status = excluded.status,
         finished_at = excluded.finished_at,
         record = excluded.record`
    ).run(
      safe.invocationId,
      safe.chatId,
      safe.floor,
      safe.status,
      safe.startedAt,
      safe.finishedAt ?? null,
      JSON.stringify(safe)
    )
  }
  const markCancelled = (
    invocationId: string,
    code: 'CANCELLED' | 'APP_SHUTDOWN',
    db?: Database.Database | null
  ): AgentRunRecord | null => {
    const live = controllers.get(invocationId)
    if (!live) return null
    const activeDb = db === undefined ? dbFor(live.chatId) : db
    live.controller.abort(code)
    const record = read(live.chatId, invocationId, activeDb)
    if (!record || record.status !== 'running') {
      controllers.delete(invocationId)
      return record
    }
    const cancelled: AgentRunRecord = {
      ...record,
      status: 'cancelled',
      finishedAt: now(),
      failure: {
        code,
        message:
          code === 'APP_SHUTDOWN'
            ? 'Agent Invocation cancelled during app shutdown'
            : 'Agent Invocation cancelled',
        retryable: false
      },
      replay: { status: 'discarded', operations: 0 }
    }
    persist(cancelled, activeDb)
    controllers.delete(invocationId)
    emit({ type: 'finished', run: summary(cancelled) })
    return cancelled
  }
  const withEvidence = (
    record: AgentRunRecord,
    evidence: HarnessEvidence,
    warnings: string[]
  ): AgentRunRecord =>
    sanitize({
      ...record,
      ...(evidence.preset
        ? {
            provider: {
              presetId: evidence.preset.id,
              presetName: evidence.preset.name,
              provider: evidence.preset.provider,
              endpoint: evidence.preset.endpoint,
              model: evidence.preset.model,
              parameters: evidence.preset.parameters
            }
          }
        : {}),
      attempts: evidence.attempts.map(attemptRecord),
      evidence: sanitize(evidence),
      ...(evidence.contextBudget ? { contextBudget: evidence.contextBudget } : {}),
      metrics: aggregateMetrics(evidence.attempts),
      warnings
    }) as unknown as AgentRunRecord

  const deleteFromFloor = (
    chatId: string,
    fromFloor: number,
    db: Database.Database | null
  ): void => {
    for (const [invocationId, live] of controllers) {
      if (live.chatId === chatId && live.floor >= fromFloor)
        markCancelled(invocationId, 'CANCELLED', db)
    }
    const rows = (db
      ?.prepare('SELECT invocation_id, floor FROM agent_runs WHERE chat_id = ? AND floor >= ?')
      .all(chatId, fromFloor) ?? []) as Array<{ invocation_id: string; floor: number }>
    db?.prepare('DELETE FROM agent_runs WHERE chat_id = ? AND floor >= ?').run(chatId, fromFloor)
    for (const row of rows) {
      emit({
        type: 'deleted',
        invocationId: row.invocation_id,
        chatId,
        floor: row.floor
      })
    }
  }

  return {
    create(start) {
      if (read(start.chatId, start.invocationId)) {
        throw new Error(`Agent Invocation ID already exists: ${start.invocationId}`)
      }
      const controller = new AbortController()
      const record: AgentRunRecord = sanitize({
        invocationId: start.invocationId,
        profileId: start.profileId,
        chatId: start.chatId,
        floor: start.floor,
        agentName: start.definition.name,
        agentVersion: start.agentVersion,
        agentHash: start.agentHash,
        status: 'running',
        startedAt: now(),
        notification: start.config.notification,
        definition: clone(start.definition),
        config: clone(start.config),
        input: clone(start.input),
        renderedPrompt: clone(start.renderedPrompt),
        history: clone(start.history),
        contracts: {
          input: clone(start.definition.inputSchema),
          result: clone(start.definition.result),
          tools: clone(start.definition.tools)
        },
        attempts: [],
        evidence: { attempts: [] },
        replay: { status: 'not-applicable', operations: 0 },
        metrics: emptyMetrics(),
        warnings: []
      }) as unknown as AgentRunRecord
      persist(record)
      controllers.set(start.invocationId, {
        chatId: start.chatId,
        floor: start.floor,
        controller
      })
      emit({ type: 'started', run: summary(record) })
      return { record: publicRecord(record), signal: controller.signal }
    },
    update(invocationId, evidence, warnings = []) {
      const live = controllers.get(invocationId)
      if (!live) return null
      const record = read(live.chatId, invocationId)
      if (!record || record.status !== 'running') return record ? publicRecord(record) : null
      const updated = withEvidence(record, evidence, warnings)
      persist(updated)
      emit({ type: 'updated', run: summary(updated) })
      return publicRecord(updated)
    },
    finalize(invocationId, final) {
      const live = controllers.get(invocationId)
      if (!live) return null
      const record = read(live.chatId, invocationId)
      if (!record || record.status !== 'running') {
        controllers.delete(invocationId)
        return record ? publicRecord(record) : null
      }
      const evidenced = withEvidence(record, final.evidence, final.warnings ?? [])
      const finished: AgentRunRecord = sanitize({
        ...evidenced,
        status: final.status,
        finishedAt: now(),
        ...(final.result !== undefined ? { result: final.result } : {}),
        ...(final.failure ? { failure: final.failure } : {}),
        replay: final.replay
      }) as unknown as AgentRunRecord
      persist(finished)
      controllers.delete(invocationId)
      emit({ type: 'finished', run: summary(finished) })
      return publicRecord(finished)
    },
    get(chatId, invocationId) {
      const record = read(chatId, invocationId)
      return record ? publicRecord(record) : null
    },
    list(chatId) {
      const rows = (dbFor(chatId)
        ?.prepare('SELECT record FROM agent_runs WHERE chat_id = ? ORDER BY started_at DESC')
        .all(chatId) ?? []) as Array<{ record: string }>
      return rows.flatMap((row) => {
        try {
          return [publicRecord(JSON.parse(row.record) as AgentRunRecord)]
        } catch {
          return []
        }
      })
    },
    cancel(invocationId) {
      const cancelled = markCancelled(invocationId, 'CANCELLED')
      return { invocationId, cancelled: cancelled?.status === 'cancelled' }
    },
    deleteFromFloor(chatId, fromFloor) {
      deleteFromFloor(chatId, fromFloor, dbFor(chatId))
    },
    deleteChat(chatId) {
      this.deleteFromFloor(chatId, Number.MIN_SAFE_INTEGER)
    },
    deleteChatForProfile(profileId, chatId) {
      deleteFromFloor(chatId, Number.MIN_SAFE_INTEGER, dbForProfile(profileId, chatId))
    },
    shutdown() {
      for (const invocationId of [...controllers.keys()]) {
        try {
          markCancelled(invocationId, 'APP_SHUTDOWN')
        } catch {
          // Continue cancelling other invocations; one unavailable session must not strand the rest.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

export const agentRunStore = createAgentRunStore()
