import type Database from 'better-sqlite3'
import { applyJsonPatch, applyMvuCommands, parseMvuCommands } from '../../../parsers/mvuParser'
import { stripThinking } from '../../../parsers/contentParser'
import {
  isFullVariablesPath,
  isResultSlotPath,
  isWritableVariablesPath
} from '../../../../shared/agentRuntime/paths'

export type FloorOperationSource = 'model' | 'card' | 'user' | 'agent'

export type FloorStateOperation =
  | { kind: 'set'; path: string; value: unknown }
  | { kind: 'delete'; path: string }
  | { kind: 'increment'; path: string; value: number }

interface StoredOperation {
  floor: number
  seq: number
  source: FloorOperationSource
  kind: FloorStateOperation['kind'] | 'patch' | 'legacy-patch' | 'legacy-replace'
  path: string
  value?: unknown
  legacyRef?: string
}

interface ReplayFloor {
  floor: number
  response: string
  events: Array<{ type: string; path: string; value: unknown; action: string }>
  variables: Record<string, unknown>
}

export interface ReplaySnapshot {
  floor: number
  variables: Record<string, unknown>
}

export interface FloorStateRefresh {
  chatId: string
  fromFloor: number
  throughFloor: number
}

export class FloorStateError extends Error {
  constructor(
    readonly code:
      | 'FLOOR_NOT_FOUND'
      | 'INVALID_OPERATION'
      | 'FULL_PATH_REQUIRED'
      | 'RESERVED_PATH'
      | 'BASELINE_NOT_FOUND'
      | 'REPLAY_FAILED'
      | 'TRANSCRIPT_CHANGED',
    message: string,
    readonly floor?: number
  ) {
    super(message)
    this.name = 'FloorStateError'
  }
}

export interface FloorStateDependencies {
  db: Database.Database
  onStateRefresh?: (refresh: FloorStateRefresh) => void
  validateSnapshot?: (snapshot: ReplaySnapshot) => string | undefined
  beforeCommit?: () => void
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const parseJournalJson = (value: string, floor: number, description: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    throw new FloorStateError(
      'REPLAY_FAILED',
      `${description} at floor ${floor} is not valid JSON`,
      floor
    )
  }
}

const isJsonValue = (value: unknown): boolean => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).every(
    ([key, nested]) =>
      key !== '__proto__' && key !== 'prototype' && key !== 'constructor' && isJsonValue(nested)
  )
}

const validateOperation = (
  operation: FloorStateOperation,
  source: FloorOperationSource,
  allowRuntimeResultSlot = false
): void => {
  if (!operation || typeof operation !== 'object') {
    throw new FloorStateError('INVALID_OPERATION', 'Floor operation must be an object')
  }
  if (!isFullVariablesPath(operation.path)) {
    throw new FloorStateError(
      'FULL_PATH_REQUIRED',
      'Floor operation path must be a full dot path rooted at variables'
    )
  }
  if (
    !isWritableVariablesPath(operation.path) &&
    !(allowRuntimeResultSlot && source === 'agent' && isResultSlotPath(operation.path))
  ) {
    throw new FloorStateError(
      'RESERVED_PATH',
      `Floor operation source ${source} cannot write runtime-owned variables.__rpt`
    )
  }
  if (!['set', 'delete', 'increment'].includes(operation.kind)) {
    throw new FloorStateError('INVALID_OPERATION', 'Unknown floor operation kind')
  }
  if (operation.kind === 'set' && !isJsonValue(operation.value)) {
    throw new FloorStateError('INVALID_OPERATION', 'Set value must be JSON-compatible')
  }
  if (
    operation.kind === 'increment' &&
    (typeof operation.value !== 'number' || !Number.isFinite(operation.value))
  ) {
    throw new FloorStateError('INVALID_OPERATION', 'Increment value must be a finite number')
  }
}

const pathSegments = (path: string): string[] => path.split('.').slice(1)

const parentAt = (
  variables: Record<string, unknown>,
  path: string,
  create: boolean
): { parent: Record<string, unknown>; key: string } | undefined => {
  const segments = pathSegments(path)
  let parent = variables
  for (const segment of segments.slice(0, -1)) {
    const next = parent[segment]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      if (!create) return undefined
      parent[segment] = {}
    }
    parent = parent[segment] as Record<string, unknown>
  }
  return { parent, key: segments[segments.length - 1] }
}

const applyStoredOperation = (
  variables: Record<string, unknown>,
  operation: StoredOperation
): void => {
  if (operation.kind === 'patch' || operation.kind === 'legacy-patch') {
    if (!Array.isArray(operation.value)) {
      throw new FloorStateError(
        'REPLAY_FAILED',
        `Variable patch at floor ${operation.floor}, seq ${operation.seq} is malformed`,
        operation.floor
      )
    }
    const stat =
      variables.stat_data && typeof variables.stat_data === 'object'
        ? (variables.stat_data as Record<string, unknown>)
        : {}
    variables.stat_data = stat
    const deltas = applyJsonPatch(stat, cloneJson(operation.value) as never)
    if (deltas.length) variables.delta_data = deltas
    return
  }
  if (operation.kind === 'legacy-replace') {
    if (!operation.value || typeof operation.value !== 'object' || Array.isArray(operation.value)) {
      throw new FloorStateError(
        'REPLAY_FAILED',
        `Legacy replacement at floor ${operation.floor}, seq ${operation.seq} is malformed`,
        operation.floor
      )
    }
    variables.stat_data = cloneJson(operation.value)
    return
  }
  validateOperation(
    operation as FloorStateOperation,
    operation.source,
    operation.source === 'agent'
  )
  const target = parentAt(variables, operation.path, operation.kind !== 'delete')
  if (!target) return
  if (operation.kind === 'delete') {
    delete target.parent[target.key]
  } else if (operation.kind === 'increment') {
    const current = target.parent[target.key]
    if (current !== undefined && (typeof current !== 'number' || !Number.isFinite(current))) {
      throw new FloorStateError(
        'REPLAY_FAILED',
        `Cannot increment non-number at ${operation.path}`,
        operation.floor
      )
    }
    target.parent[target.key] = (current ?? 0) + (operation.value as number)
  } else {
    target.parent[target.key] = cloneJson(operation.value)
  }
}

const applyModelFold = (variables: Record<string, unknown>, floor: ReplayFloor): void => {
  for (const event of floor.events) {
    if (event.type !== 'state' || !event.path) continue
    const rootedPath = event.path.startsWith('variables.') ? event.path : `variables.${event.path}`
    if (!isWritableVariablesPath(rootedPath)) continue
    const target = parentAt(variables, rootedPath, true)!
    const current = target.parent[target.key]
    if (event.action === 'add') {
      target.parent[target.key] = (typeof current === 'number' ? current : 0) + Number(event.value)
    } else if (event.action === 'remove') {
      target.parent[target.key] = (typeof current === 'number' ? current : 0) - Number(event.value)
    } else {
      target.parent[target.key] = cloneJson(event.value)
    }
  }
  const mvu = parseMvuCommands(stripThinking(floor.response))
  if (!mvu.commands.length && !mvu.patches.length) return
  const stat =
    variables.stat_data && typeof variables.stat_data === 'object'
      ? (variables.stat_data as Record<string, unknown>)
      : {}
  variables.stat_data = stat
  variables.delta_data = [
    ...(mvu.commands.length ? applyMvuCommands(stat, mvu.commands) : []),
    ...(mvu.patches.length ? applyJsonPatch(stat, mvu.patches) : [])
  ]
}

/** Pure suffix calculator. It mutates neither its floor nor operation inputs. */
export const computeFloorSuffix = (
  floors: readonly ReplayFloor[],
  operations: readonly StoredOperation[],
  seed: Record<string, unknown>
): ReplaySnapshot[] => {
  const state = cloneJson(seed)
  const byFloor = new Map<number, StoredOperation[]>()
  for (const operation of operations) {
    const list = byFloor.get(operation.floor)
    if (list) list.push(operation)
    else byFloor.set(operation.floor, [operation])
  }
  return floors.map((floor) => {
    applyModelFold(state, floor)
    for (const operation of byFloor.get(floor.floor) ?? []) applyStoredOperation(state, operation)
    return { floor: floor.floor, variables: cloneJson(state) }
  })
}

export const FLOOR_OPERATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS floor_state_baselines (
  chat_id TEXT PRIMARY KEY,
  variables TEXT NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS floor_operations (
  chat_id TEXT NOT NULL,
  floor INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('model','card','user','agent')),
  kind TEXT NOT NULL CHECK(kind IN ('set','delete','increment','patch','legacy-patch','legacy-replace')),
  path TEXT NOT NULL,
  value TEXT,
  created_at TEXT,
  legacy_ref TEXT UNIQUE,
  PRIMARY KEY (chat_id, floor, seq)
);
CREATE INDEX IF NOT EXISTS idx_floor_operations_chat_floor
  ON floor_operations(chat_id, floor, seq);`

interface FloorRow {
  floor: number
  response_content: string
  events: string
  variables: string
}

export interface FloorTranscriptUpdate {
  floor: number
  userContent?: string
  responseContent?: string
  swipes?: string[] | null
  swipeId?: number | null
}

export const createFloorState = (dependencies: FloorStateDependencies) => {
  const { db } = dependencies
  db.exec(FLOOR_OPERATIONS_SCHEMA)

  const readFloors = (chatId: string): ReplayFloor[] =>
    (
      db
        .prepare(
          'SELECT floor, response_content, events, variables FROM floors WHERE chat_id = ? ORDER BY floor'
        )
        .all(chatId) as FloorRow[]
    ).map((row) => ({
      floor: row.floor,
      response: row.response_content,
      events: parseJournalJson(row.events, row.floor, 'Floor events') as ReplayFloor['events'],
      variables: parseJournalJson(row.variables, row.floor, 'Floor variables') as Record<
        string,
        unknown
      >
    }))

  const readStored = (chatId: string): StoredOperation[] =>
    (
      db
        .prepare(
          `SELECT floor, seq, source, kind, path, value, legacy_ref
           FROM floor_operations WHERE chat_id = ? ORDER BY floor, seq`
        )
        .all(chatId) as Array<{
        floor: number
        seq: number
        source: FloorOperationSource
        kind: StoredOperation['kind']
        path: string
        value: string | null
        legacy_ref: string | null
      }>
    ).map((row) => ({
      floor: row.floor,
      seq: row.seq,
      source: row.source,
      kind: row.kind,
      path: row.path,
      ...(row.value === null
        ? {}
        : { value: parseJournalJson(row.value, row.floor, 'Floor operation value') }),
      ...(row.legacy_ref ? { legacyRef: row.legacy_ref } : {})
    }))

  const pendingLegacy = (chatId: string, stored: StoredOperation[]): StoredOperation[] => {
    const imported = new Set(stored.flatMap((operation) => operation.legacyRef ?? []))
    const maxSeq = new Map<number, number>()
    for (const operation of stored)
      maxSeq.set(operation.floor, Math.max(maxSeq.get(operation.floor) ?? -1, operation.seq))
    const rows = db
      .prepare(
        'SELECT floor, seq, kind, payload FROM vars_ops WHERE chat_id = ? ORDER BY floor, seq'
      )
      .all(chatId) as Array<{
      floor: number
      seq: number
      kind: 'patch' | 'replace'
      payload: string
    }>
    const pending: StoredOperation[] = []
    for (const row of rows) {
      const legacyRef = `${chatId}:${row.floor}:${row.seq}`
      if (imported.has(legacyRef)) continue
      const seq = (maxSeq.get(row.floor) ?? -1) + 1
      maxSeq.set(row.floor, seq)
      pending.push({
        floor: row.floor,
        seq,
        source: 'card',
        kind: row.kind === 'patch' ? 'legacy-patch' : 'legacy-replace',
        path: 'variables.stat_data',
        value: parseJournalJson(row.payload, row.floor, 'Legacy vars operation'),
        legacyRef
      })
    }
    return pending
  }

  const fingerprint = (floors: readonly ReplayFloor[]): string =>
    JSON.stringify(
      floors.map(({ floor, response, events }) => ({
        floor,
        response,
        events
      }))
    )

  const publish = (
    chatId: string,
    fromFloor: number,
    additions: StoredOperation[],
    transcriptUpdates: readonly FloorTranscriptUpdate[] = []
  ): ReplaySnapshot[] => {
    const allFloors = readFloors(chatId)
    const expectedTranscript = fingerprint(allFloors)
    const updatesByFloor = new Map(transcriptUpdates.map((update) => [update.floor, update]))
    for (const replayFloor of allFloors) {
      const update = updatesByFloor.get(replayFloor.floor)
      if (update?.responseContent !== undefined) replayFloor.response = update.responseContent
    }
    const startIndex = allFloors.findIndex((floor) => floor.floor === fromFloor)
    if (startIndex < 0)
      throw new FloorStateError(
        'FLOOR_NOT_FOUND',
        `Cannot refresh missing floor ${fromFloor}`,
        fromFloor
      )
    const existing = readStored(chatId)
    const legacy = pendingLegacy(chatId, existing)
    const operations = [...existing, ...legacy, ...additions].sort(
      (a, b) => a.floor - b.floor || a.seq - b.seq
    )
    let seed: Record<string, unknown>
    if (startIndex > 0) {
      seed = allFloors[startIndex - 1].variables
    } else {
      const baseline = db
        .prepare('SELECT variables FROM floor_state_baselines WHERE chat_id = ?')
        .get(chatId) as { variables: string } | undefined
      const first = allFloors[0]
      if (baseline) {
        seed = parseJournalJson(baseline.variables, first.floor, 'Floor-state baseline') as Record<
          string,
          unknown
        >
      } else {
        const modelFold = first.events.some((event) => event.type === 'state' && event.path)
        const mvu = parseMvuCommands(stripThinking(first.response))
        const previouslyAppliedOperation = [...existing, ...legacy].some(
          (operation) => operation.floor === first.floor
        )
        if (modelFold || mvu.commands.length || mvu.patches.length || previouslyAppliedOperation) {
          throw new FloorStateError(
            'BASELINE_NOT_FOUND',
            `Cannot replay floor ${first.floor} without its persisted pre-floor baseline`,
            first.floor
          )
        }
        // A floor with no model changes is itself evidence of the pre-floor state. Persist it now so
        // subsequent full replays never infer a baseline from a later, operation-folded snapshot.
        seed = first.variables
      }
    }
    const suffix = computeFloorSuffix(allFloors.slice(startIndex), operations, seed)
    for (const snapshot of suffix) {
      const warning = dependencies.validateSnapshot?.(snapshot)
      if (warning)
        throw new FloorStateError(
          'REPLAY_FAILED',
          `Forward Replay rejected floor ${snapshot.floor}: ${warning}`,
          snapshot.floor
        )
    }
    dependencies.beforeCommit?.()
    db.transaction(() => {
      if (fingerprint(readFloors(chatId)) !== expectedTranscript) {
        throw new FloorStateError(
          'TRANSCRIPT_CHANGED',
          'Transcript changed while Forward Replay was being calculated',
          fromFloor
        )
      }
      const updateTranscript = db.prepare(
        `UPDATE floors SET
           user_content = COALESCE(?, user_content),
           response_content = COALESCE(?, response_content),
           swipes = CASE WHEN ? THEN ? ELSE swipes END,
           swipe_id = CASE WHEN ? THEN ? ELSE swipe_id END
         WHERE chat_id = ? AND floor = ?`
      )
      for (const update of transcriptUpdates)
        updateTranscript.run(
          update.userContent ?? null,
          update.responseContent ?? null,
          Object.prototype.hasOwnProperty.call(update, 'swipes') ? 1 : 0,
          update.swipes ? JSON.stringify(update.swipes) : null,
          Object.prototype.hasOwnProperty.call(update, 'swipeId') ? 1 : 0,
          update.swipeId ?? null,
          chatId,
          update.floor
        )
      const insert = db.prepare(
        `INSERT INTO floor_operations
          (chat_id, floor, seq, source, kind, path, value, created_at, legacy_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const operation of [...legacy, ...additions]) {
        insert.run(
          chatId,
          operation.floor,
          operation.seq,
          operation.source,
          operation.kind,
          operation.path,
          operation.value === undefined ? null : JSON.stringify(operation.value),
          new Date().toISOString(),
          operation.legacyRef ?? null
        )
      }
      if (startIndex === 0)
        db.prepare(
          `INSERT OR IGNORE INTO floor_state_baselines (chat_id, variables, created_at)
           VALUES (?, ?, ?)`
        ).run(chatId, JSON.stringify(seed), new Date().toISOString())
      const update = db.prepare('UPDATE floors SET variables = ? WHERE chat_id = ? AND floor = ?')
      for (const snapshot of suffix)
        update.run(JSON.stringify(snapshot.variables), chatId, snapshot.floor)
    })()
    dependencies.onStateRefresh?.({
      chatId,
      fromFloor,
      throughFloor: suffix[suffix.length - 1].floor
    })
    return suffix
  }

  return {
    setBaseline(chatId: string, variables: Record<string, unknown>): void {
      if (!isJsonValue(variables))
        throw new FloorStateError(
          'INVALID_OPERATION',
          'Floor-state baseline must be JSON-compatible'
        )
      db.prepare(
        `INSERT INTO floor_state_baselines (chat_id, variables, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO NOTHING`
      ).run(chatId, JSON.stringify(cloneJson(variables)), new Date().toISOString())
    },

    append(
      chatId: string,
      floor: number,
      source: FloorOperationSource,
      operations: FloorStateOperation[]
    ): ReplaySnapshot[] {
      if (!Array.isArray(operations) || operations.length === 0)
        throw new FloorStateError('INVALID_OPERATION', 'At least one floor operation is required')
      for (const operation of operations) validateOperation(operation, source)
      const stored = readStored(chatId)
      const legacy = pendingLegacy(chatId, stored)
      const maxSeq = [...stored, ...legacy]
        .filter((operation) => operation.floor === floor)
        .reduce((max, operation) => Math.max(max, operation.seq), -1)
      const additions = operations.map(
        (operation, index): StoredOperation => ({
          floor,
          seq: maxSeq + index + 1,
          source,
          kind: operation.kind,
          path: operation.path,
          ...('value' in operation ? { value: cloneJson(operation.value) } : {})
        })
      )
      return publish(chatId, floor, additions)
    },

    appendPatch(
      chatId: string,
      floor: number,
      source: 'card' | 'user',
      patch: unknown[]
    ): ReplaySnapshot[] {
      if (!Array.isArray(patch) || patch.length === 0)
        throw new FloorStateError(
          'INVALID_OPERATION',
          'At least one JSON Patch operation is required'
        )
      if (!isJsonValue(patch))
        throw new FloorStateError('INVALID_OPERATION', 'JSON Patch must be JSON-compatible')
      const stored = readStored(chatId)
      const legacy = pendingLegacy(chatId, stored)
      const maxSeq = [...stored, ...legacy]
        .filter((operation) => operation.floor === floor)
        .reduce((max, operation) => Math.max(max, operation.seq), -1)
      return publish(chatId, floor, [
        {
          floor,
          seq: maxSeq + 1,
          source,
          kind: 'patch',
          path: 'variables.stat_data',
          value: cloneJson(patch)
        }
      ])
    },

    incorporateAgent(
      chatId: string,
      floor: number,
      operations: FloorStateOperation[]
    ): ReplaySnapshot[] {
      if (!Array.isArray(operations) || operations.length === 0)
        throw new FloorStateError('INVALID_OPERATION', 'At least one floor operation is required')
      for (const operation of operations) validateOperation(operation, 'agent', true)
      const stored = readStored(chatId)
      const legacy = pendingLegacy(chatId, stored)
      const maxSeq = [...stored, ...legacy]
        .filter((operation) => operation.floor === floor)
        .reduce((max, operation) => Math.max(max, operation.seq), -1)
      return publish(
        chatId,
        floor,
        operations.map(
          (operation, index): StoredOperation => ({
            floor,
            seq: maxSeq + index + 1,
            source: 'agent',
            kind: operation.kind,
            path: operation.path,
            ...('value' in operation ? { value: cloneJson(operation.value) } : {})
          })
        )
      )
    },

    replay(chatId: string, fromFloor: number): ReplaySnapshot[] {
      return publish(chatId, fromFloor, [])
    },

    updateTranscript(chatId: string, updates: readonly FloorTranscriptUpdate[]): ReplaySnapshot[] {
      if (!updates.length)
        throw new FloorStateError('INVALID_OPERATION', 'At least one transcript update is required')
      const fromFloor = Math.min(...updates.map((update) => update.floor))
      return publish(chatId, fromFloor, [], updates)
    },

    deleteFromFloor(chatId: string, fromFloor: number): number {
      return db.transaction(() => {
        const operationChanges = db
          .prepare('DELETE FROM floor_operations WHERE chat_id = ? AND floor >= ?')
          .run(chatId, fromFloor).changes
        db.prepare('DELETE FROM vars_ops WHERE chat_id = ? AND floor >= ?').run(chatId, fromFloor)
        db.prepare('DELETE FROM floors WHERE chat_id = ? AND floor >= ?').run(chatId, fromFloor)
        if (fromFloor <= 0)
          db.prepare('DELETE FROM floor_state_baselines WHERE chat_id = ?').run(chatId)
        return operationChanges
      })()
    },

    list(chatId: string): StoredOperation[] {
      const existing = readStored(chatId)
      const legacy = pendingLegacy(chatId, existing)
      if (!legacy.length) return existing.map(cloneJson)
      db.transaction(() => {
        const insert = db.prepare(
          `INSERT INTO floor_operations
            (chat_id, floor, seq, source, kind, path, value, created_at, legacy_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        for (const operation of legacy)
          insert.run(
            chatId,
            operation.floor,
            operation.seq,
            operation.source,
            operation.kind,
            operation.path,
            JSON.stringify(operation.value),
            new Date().toISOString(),
            operation.legacyRef
          )
      })()
      return [...existing, ...legacy].map(cloneJson)
    }
  }
}
