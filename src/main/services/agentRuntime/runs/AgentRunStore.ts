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
  /**
   * Degradation notices known BEFORE the run executes (ADR 0021): a preset Agent whose assembly
   * failed still runs and still bills a provider call, but it lost its card / persona / world info /
   * history. Seeding them here is what makes such a run distinguishable from a healthy one instead of
   * a line in the log nobody reads.
   */
  warnings?: string[]
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
  replaceSource(
    invocationId: string,
    source: Pick<AgentRunStart, 'input' | 'renderedPrompt' | 'history'>
  ): AgentRunRecord | null
  /**
   * Store the prompt exactly as the Harness built it, once it exists. A run is created BEFORE its
   * prompt is rendered (rendering happens inside `execute`, and rendering twice would let the record
   * drift from what was dispatched — ADR 0021), so this back-fills the one field that could not be
   * known at `create` time. Deliberately does NOT emit: `summary()` carries no prompt, so the event
   * would be indistinguishable noise for every subscriber.
   */
  attachRenderedPrompt(invocationId: string, renderedPrompt: AgentRunMessage[]): void
  update(
    invocationId: string,
    evidence: HarnessEvidence,
    warnings?: string[]
  ): AgentRunRecord | null
  finalize(invocationId: string, final: AgentRunFinal): AgentRunRecord | null
  get(chatId: string, invocationId: string): AgentRunRecord | null
  list(chatId: string): AgentRunRecord[]
  /**
   * The highest floor at which a Run Record exists for `agentName` in this chat, or null when the
   * Agent has never run here. This is the DERIVED cadence state the floor-commit trigger reads: an
   * Agent is "due" when the latest committed floor is ≥ `everyNFloors` beyond this. Deriving it from
   * runs (rather than a separate pointer table) makes cadence automatically rewind-correct — deleting
   * floors deletes their runs, so the pointer recedes and the Agent refires (M3).
   */
  latestRunFloor(chatId: string, agentName: string): number | null
  cancel(invocationId: string): AgentRunCancelResult
  cancelFromFloor(chatId: string, fromFloor: number): void
  deleteFromFloor(chatId: string, fromFloor: number): void
  deleteFromFloorInTransaction(
    chatId: string,
    fromFloor: number,
    db: Database.Database
  ): () => void
  deleteChat(chatId: string): void
  deleteChatForProfile(profileId: string, chatId: string): void
  onBeforeDeleteFromFloor(listener: (chatId: string, fromFloor: number) => void): () => void
  shutdown(): void
  subscribe(listener: (event: AgentRunEvent) => void): () => void
}

interface Dependencies {
  getDb?: (chatId: string) => Database.Database | null
  getDbForProfile?: (profileId: string, chatId: string) => Database.Database | null
  now?: () => string
  /** Rolling-retention window: keep the most-recent N run rows per chat (default
   *  {@link DEFAULT_AGENT_RUN_RETENTION}). <= 0 keeps none. */
  retention?: number
}

/**
 * Default rolling-retention window for Agent run rows (Finding 4). Every run persists its full
 * renderedPrompt plus per-attempt message logs, and only floor deletion pruned them, so agent_runs
 * grew unboundedly over a long chat. Mirrors the execution-record retention pattern
 * (executionRecordStore), pruning past the cap after each new run is created.
 */
export const DEFAULT_AGENT_RUN_RETENTION = 200

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
  metrics.retries = attempts.filter((attempt) => attempt.outcome === 'retry').length
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
  const rawDbFor = dependencies.getDb ?? ((chatId: string) => getSessionDbByChat(chatId))
  const rawDbForProfile =
    dependencies.getDbForProfile ??
    ((profileId: string, chatId: string) => getSessionDb(profileId, chatId))
  const now = dependencies.now ?? (() => new Date().toISOString())
  const retention = dependencies.retention ?? DEFAULT_AGENT_RUN_RETENTION
  const controllers = new Map<
    string,
    { chatId: string; floor: number; controller: AbortController }
  >()
  // Finding 2: a hard crash never runs `shutdown()`/`markCancelled`, so its in-flight rows stay at
  // status='running' forever — the UI shows a perpetual "running" run and cadence logic
  // (latestRunFloor) counts a ghost fire. There is no per-profile init hook (session DBs open
  // lazily, LRU-evicted), so reconcile the FIRST time this store touches each handle: sweep every
  // still-'running' row that this process is NOT actively driving (its invocation_id is absent from
  // the live `controllers`) to a terminal, distinguishable state. Keyed on the handle object so a
  // handle reopened after eviction re-sweeps — but the live-controller exclusion keeps it from
  // clobbering a run that is genuinely in flight in this process.
  const reconciled = new WeakSet<Database.Database>()
  const reconcileStranded = (db: Database.Database | null): void => {
    if (!db || reconciled.has(db)) return
    reconciled.add(db)
    const liveIds = [...controllers.keys()]
    const exclusion = liveIds.length
      ? ` AND invocation_id NOT IN (${liveIds.map(() => '?').join(',')})`
      : ''
    const rows = db
      .prepare(`SELECT invocation_id, record FROM agent_runs WHERE status = 'running'${exclusion}`)
      .all(...liveIds) as Array<{ invocation_id: string; record: string }>
    if (!rows.length) return
    const stamp = now()
    const update = db.prepare(
      'UPDATE agent_runs SET status = ?, finished_at = ?, record = ? WHERE invocation_id = ?'
    )
    for (const row of rows) {
      let record: AgentRunRecord
      try {
        record = JSON.parse(row.record) as AgentRunRecord
      } catch {
        continue
      }
      const finished = sanitize({
        ...record,
        status: 'cancelled',
        finishedAt: record.finishedAt ?? stamp,
        failure: {
          code: 'INTERRUPTED',
          message: 'Agent Invocation interrupted by shutdown',
          retryable: false
        },
        replay: { status: 'discarded', operations: 0 }
      }) as unknown as AgentRunRecord
      update.run(
        finished.status,
        finished.finishedAt ?? null,
        JSON.stringify(finished),
        finished.invocationId
      )
    }
  }
  const dbFor = (chatId: string): Database.Database | null => {
    const db = rawDbFor(chatId)
    reconcileStranded(db)
    return db
  }
  const dbForProfile = (profileId: string, chatId: string): Database.Database | null => {
    const db = rawDbForProfile(profileId, chatId)
    reconcileStranded(db)
    return db
  }
  // Finding 4: keep only the most-recent `retention` run rows per chat (by start time), pruning the
  // rest after each new run is created. Mirrors pruneExecutionRecords.
  const pruneRuns = (chatId: string, db: Database.Database | null): void => {
    if (!db) return
    const keep = Math.max(0, Math.floor(retention))
    if (keep <= 0) {
      db.prepare('DELETE FROM agent_runs WHERE chat_id = ?').run(chatId)
      return
    }
    db.prepare(
      `DELETE FROM agent_runs
         WHERE chat_id = ?
           AND invocation_id NOT IN (
             SELECT invocation_id FROM agent_runs WHERE chat_id = ?
               ORDER BY started_at DESC, rowid DESC LIMIT ?
           )`
    ).run(chatId, chatId, keep)
  }
  const listeners = new Set<(event: AgentRunEvent) => void>()
  const beforeFloorDeleteListeners = new Set<(chatId: string, fromFloor: number) => void>()
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
      // UNION, not replace. `update`/`finalize` default this argument to `[]`, so replacing would
      // erase a degradation notice seeded at `create` the moment the first evidence arrives — the
      // run would silently look healthy again. De-duplicated so a repeated notice appears once.
      warnings: [...new Set([...(record.warnings ?? []), ...warnings])]
    }) as unknown as AgentRunRecord

  const deleteFromFloor = (
    chatId: string,
    fromFloor: number,
    db: Database.Database | null
  ): (() => void) => {
    const rows = (db
      ?.prepare('SELECT invocation_id, floor FROM agent_runs WHERE chat_id = ? AND floor >= ?')
      .all(chatId, fromFloor) ?? []) as Array<{ invocation_id: string; floor: number }>
    db?.prepare('DELETE FROM agent_runs WHERE chat_id = ? AND floor >= ?').run(chatId, fromFloor)
    return () => {
      for (const row of rows) {
        emit({
          type: 'deleted',
          invocationId: row.invocation_id,
          chatId,
          floor: row.floor
        })
      }
    }
  }

  const cancelFromFloor = (chatId: string, fromFloor: number): void => {
    for (const listener of beforeFloorDeleteListeners) listener(chatId, fromFloor)
    for (const [invocationId, live] of controllers) {
      if (live.chatId === chatId && live.floor >= fromFloor) {
        markCancelled(invocationId, 'CANCELLED')
      }
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
        warnings: [...(start.warnings ?? [])]
      }) as unknown as AgentRunRecord
      persist(record)
      // Finding 4: bound agent_runs growth — a new row was just added, so prune past the retention
      // window now (mirrors executionRecordStore's prune-after-write).
      pruneRuns(start.chatId, dbFor(start.chatId))
      controllers.set(start.invocationId, {
        chatId: start.chatId,
        floor: start.floor,
        controller
      })
      emit({ type: 'started', run: summary(record) })
      return { record: publicRecord(record), signal: controller.signal }
    },
    attachRenderedPrompt(invocationId, renderedPrompt) {
      const live = controllers.get(invocationId)
      if (!live) return
      const record = read(live.chatId, invocationId)
      if (!record || record.status !== 'running') return
      persist(
        sanitize({ ...record, renderedPrompt: clone(renderedPrompt) }) as unknown as AgentRunRecord
      )
    },
    replaceSource(invocationId, source) {
      const live = controllers.get(invocationId)
      if (!live) return null
      const record = read(live.chatId, invocationId)
      if (!record || record.status !== 'running') return record ? publicRecord(record) : null
      const updated = sanitize({
        ...record,
        input: clone(source.input),
        renderedPrompt: clone(source.renderedPrompt),
        history: clone(source.history)
      }) as unknown as AgentRunRecord
      persist(updated)
      emit({ type: 'updated', run: summary(updated) })
      return publicRecord(updated)
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
    latestRunFloor(chatId, agentName) {
      // `agentName` lives at the top level of the persisted JSON record (never a redacted key), so a
      // json_extract filter is exact and index-free. A run row is created the moment `run()` dispatches
      // (status 'running'), so a still-running or failed run counts as a "fire" — matching the workflow
      // cadence, which advances its baseline on fire regardless of outcome.
      const row = dbFor(chatId)
        ?.prepare(
          "SELECT MAX(floor) AS floor FROM agent_runs WHERE chat_id = ? AND json_extract(record, '$.agentName') = ?"
        )
        .get(chatId, agentName) as { floor: number | null } | undefined
      return row?.floor ?? null
    },
    cancel(invocationId) {
      const cancelled = markCancelled(invocationId, 'CANCELLED')
      return { invocationId, cancelled: cancelled?.status === 'cancelled' }
    },
    cancelFromFloor,
    deleteFromFloor(chatId, fromFloor) {
      cancelFromFloor(chatId, fromFloor)
      const db = dbFor(chatId)
      if (!db) return
      const notify = db.transaction(() => deleteFromFloor(chatId, fromFloor, db))()
      notify()
    },
    deleteFromFloorInTransaction(chatId, fromFloor, db) {
      return deleteFromFloor(chatId, fromFloor, db)
    },
    deleteChat(chatId) {
      this.deleteFromFloor(chatId, Number.MIN_SAFE_INTEGER)
    },
    deleteChatForProfile(profileId, chatId) {
      cancelFromFloor(chatId, Number.MIN_SAFE_INTEGER)
      const db = dbForProfile(profileId, chatId)
      if (!db) return
      const notify = db.transaction(() =>
        deleteFromFloor(chatId, Number.MIN_SAFE_INTEGER, db)
      )()
      notify()
    },
    onBeforeDeleteFromFloor(listener) {
      beforeFloorDeleteListeners.add(listener)
      return () => beforeFloorDeleteListeners.delete(listener)
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
