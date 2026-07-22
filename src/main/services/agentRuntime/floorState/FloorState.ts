import type Database from 'better-sqlite3'
import { applyJsonPatch, parseMvuCommands } from '../../../parsers/mvuParser'
import { stripThinking, type RPEvent } from '../../../parsers/contentParser'
import { foldModelTurn, variablesParentAt } from '../../floorFold'
import {
  isFullVariablesPath,
  isResultSlotPath,
  isWritableVariablesPath
} from '../../../../shared/agentRuntime/paths'

/**
 * Who wrote a journaled operation.
 *
 * `'template'` is the ONE pre-fold source: build-time `{{setvar}}` / EJS `setvar()` mutate
 * `ctx.workingVars` WHILE the prompt for this floor is being assembled — i.e. strictly BEFORE the
 * model turn is folded on top. Every other source writes after the fold (a card panel, a user edit,
 * an Agent result all land on a floor that already exists). `computeFloorSuffix` honours that split.
 */
export type FloorOperationSource = 'model' | 'card' | 'user' | 'agent' | 'template'

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
  events: RPEvent[]
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

/** Resolves which combat system a chat's card opens on an `<rpt-combat-start>` cue. */
export type CombatModeResolver = (chatId: string) => 'grid' | 'duel'

/**
 * Process-wide combat-mode resolver — a plain module-level variable ON PURPOSE (no import): every
 * `createFloorState` caller inherits it, so the mode cannot be lost by a construction site that
 * forgot to inject one. Production wiring lives in `src/main/index.ts`.
 *
 * Forward Replay re-derives `combat_cue` from a floor's response text, and `mode` is a property of
 * the card's `combat` bundle — which this module cannot see. A registration SETTER rather than an
 * import for the reason `floorService.onTranscriptCut` / `onTranscriptEdited` use one: resolving a
 * chat's card means `chatService` + `characterService`, and both of them already reach this module,
 * so importing them here would close a dependency cycle. Unregistered (tests, a headless harness),
 * replay falls back to 'grid' exactly as before.
 */
let combatModeResolver: CombatModeResolver | null = null

/** Register (or clear, with `null`) the process-wide resolver. See {@link combatModeResolver}. */
export const setCombatModeResolver = (resolve: CombatModeResolver | null): void => {
  combatModeResolver = resolve
}

export interface FloorStateDependencies {
  db: Database.Database
  onStateRefresh?: (refresh: FloorStateRefresh) => void
  validateSnapshot?: (snapshot: ReplaySnapshot) => string | undefined
  beforeCommit?: () => void
  /** Which combat system a replayed `<rpt-combat-start>` cue opens — a property of the chat's card
   *  bundle, which this module cannot see. Overrides the registered process-wide resolver; with
   *  neither, replay defaults to 'grid'. */
  resolveCombatMode?: CombatModeResolver
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
  const target = variablesParentAt(variables, operation.path, operation.kind !== 'delete')
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

/**
 * Was this operation ALREADY folded into the floor's stored `variables` column by the live path that
 * wrote it?
 *
 * Exactly the two kinds `pendingLegacy` synthesises from the legacy `vars_ops` table: those rows were
 * applied to the floor snapshot as they happened, by the (now deleted) `varsOpsService`, and are
 * imported into the journal only as evidence. Every other kind — `set`/`delete`/`increment`/`patch`,
 * whatever the source — is journaled BEFORE it reaches storage, because FloorState owns that column
 * now; replay is what applies them. `applyStoredOperation` is the mirror of this split: it is the one
 * place that understands `legacy-patch` / `legacy-replace`.
 */
const isAlreadyStoredKind = (kind: StoredOperation['kind']): boolean =>
  kind === 'legacy-patch' || kind === 'legacy-replace'

/**
 * Pure suffix calculator. It mutates neither its floor nor operation inputs. The model fold is
 * `foldModelTurn` (services/floorFold.ts) — the same function the live turn path folds with.
 *
 * TWO operation phases per floor, mirroring the live turn's write order:
 *  1. `source: 'template'` — build-time `setvar` writes, applied BEFORE the fold because live they
 *     happened while the prompt was still being assembled (see `FloorOperationSource`).
 *  2. everything else — applied AFTER the fold (a card/user/Agent write onto a finished floor).
 * Within each phase, seq order is preserved.
 */
export const computeFloorSuffix = (
  floors: readonly ReplayFloor[],
  operations: readonly StoredOperation[],
  seed: Record<string, unknown>,
  combatMode: 'grid' | 'duel' = 'grid'
): ReplaySnapshot[] => {
  const state = cloneJson(seed)
  const byFloor = new Map<number, StoredOperation[]>()
  for (const operation of operations) {
    const list = byFloor.get(operation.floor)
    if (list) list.push(operation)
    else byFloor.set(operation.floor, [operation])
  }
  return floors.map((floor) => {
    const floorOperations = byFloor.get(floor.floor) ?? []
    for (const operation of floorOperations)
      if (operation.source === 'template') applyStoredOperation(state, operation)
    foldModelTurn(state, { response: floor.response, events: floor.events, combatMode })
    for (const operation of floorOperations)
      if (operation.source !== 'template') applyStoredOperation(state, operation)
    return { floor: floor.floor, variables: cloneJson(state) }
  })
}

/** The `floor_operations` column list — shared by the schema below and the CHECK-constraint rebuild
 *  in `migrateFloorOperationsSource`, so the two can never disagree about the allowed sources. */
const FLOOR_OPERATIONS_COLUMNS = `
  chat_id TEXT NOT NULL,
  floor INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('model','card','user','agent','template')),
  kind TEXT NOT NULL CHECK(kind IN ('set','delete','increment','patch','legacy-patch','legacy-replace')),
  path TEXT NOT NULL,
  value TEXT,
  created_at TEXT,
  legacy_ref TEXT UNIQUE,
  PRIMARY KEY (chat_id, floor, seq)`

export const FLOOR_OPERATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS floor_state_baselines (
  chat_id TEXT PRIMARY KEY,
  variables TEXT NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS floor_operations (${FLOOR_OPERATIONS_COLUMNS}
);
CREATE INDEX IF NOT EXISTS idx_floor_operations_chat_floor
  ON floor_operations(chat_id, floor, seq);`

/**
 * Forward migration for session DBs created before `'template'` was an allowed operation source.
 *
 * SQLite cannot ALTER a CHECK constraint and `CREATE TABLE IF NOT EXISTS` leaves an existing table
 * alone, so the only faithful path is create-new / copy / drop / rename — inside ONE transaction
 * (all-or-nothing), the same idiom `db.ts`'s `migrateAgentPacksToVersioned` uses.
 *
 * Guarded twice, so it runs at most once per DB and is a no-op on a fresh one:
 *  · no `floor_operations` row in `sqlite_master` → the table doesn't exist yet; the schema exec
 *    right after this creates the CURRENT shape.
 *  · the stored DDL already mentions `'template'` → already the current shape.
 * After the rename SQLite rewrites only the table NAME in the stored DDL, so the CHECK (and hence
 * the second guard) survives — a second call is a no-op.
 */
export const migrateFloorOperationsSource = (database: Database.Database): void => {
  const row = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'floor_operations'`)
    .get() as { sql: string | null } | undefined
  const ddl = row?.sql
  if (!ddl) return // no table yet — the schema exec creates the current shape
  if (ddl.includes(`'template'`)) return // already migrated
  database.transaction(() => {
    database.exec(`
      CREATE TABLE floor_operations_new (${FLOOR_OPERATIONS_COLUMNS}
      );
      INSERT INTO floor_operations_new
        (chat_id, floor, seq, source, kind, path, value, created_at, legacy_ref)
        SELECT chat_id, floor, seq, source, kind, path, value, created_at, legacy_ref
          FROM floor_operations;
      DROP TABLE floor_operations;
      ALTER TABLE floor_operations_new RENAME TO floor_operations;
      CREATE INDEX IF NOT EXISTS idx_floor_operations_chat_floor
        ON floor_operations(chat_id, floor, seq);
    `)
  })()
}

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
  // BEFORE the schema exec: CREATE TABLE IF NOT EXISTS cannot widen an existing CHECK constraint.
  migrateFloorOperationsSource(db)
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

  /**
   * The next free `seq` for one (chat, floor) — where the journal appends.
   *
   * Counts the rows already in `floor_operations` AND the legacy `vars_ops` rows that the very same
   * call is about to import (`pendingLegacy` numbers those from the same high-water mark), so an
   * addition can never collide with a legacy row on the (chat_id, floor, seq) primary key. Every
   * writer — `append`, `appendPatch`, `incorporateAgent`, `journal` — allocates through here so the
   * four can never disagree about what "next" means.
   */
  const nextSeq = (chatId: string, floor: number): number => {
    const stored = readStored(chatId)
    return (
      [...stored, ...pendingLegacy(chatId, stored)]
        .filter((operation) => operation.floor === floor)
        .reduce((max, operation) => Math.max(max, operation.seq), -1) + 1
    )
  }

  /**
   * Write the transcript COLUMNS for the given floors (user text / response text / swipes). Shared by
   * `publish` (called inside its replay transaction) and by the no-refold `updateTranscript` path, so
   * the two can never disagree about which columns a transcript update touches. The caller supplies
   * the transaction.
   */
  const applyTranscriptUpdates = (
    chatId: string,
    updates: readonly FloorTranscriptUpdate[]
  ): void => {
    const statement = db.prepare(
      `UPDATE floors SET
         user_content = COALESCE(?, user_content),
         response_content = COALESCE(?, response_content),
         swipes = CASE WHEN ? THEN ? ELSE swipes END,
         swipe_id = CASE WHEN ? THEN ? ELSE swipe_id END
       WHERE chat_id = ? AND floor = ?`
    )
    for (const update of updates)
      statement.run(
        update.userContent ?? null,
        update.responseContent ?? null,
        Object.prototype.hasOwnProperty.call(update, 'swipes') ? 1 : 0,
        update.swipes ? JSON.stringify(update.swipes) : null,
        Object.prototype.hasOwnProperty.call(update, 'swipeId') ? 1 : 0,
        update.swipeId ?? null,
        chatId,
        update.floor
      )
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
    // The index replay actually starts at. Normally `startIndex`; the legacy-save fallback below is
    // the ONE case that moves it forward, past a floor 0 whose model fold cannot be re-derived.
    let replayIndex = startIndex
    // Floor 0's snapshot on that fallback, computed here instead of by `computeFloorSuffix` because
    // it is the one floor that must NOT be re-folded. Prepended to the suffix so floor 0 is
    // republished, validated and announced exactly like every other floor.
    let unfoldableFirst: ReplaySnapshot | undefined
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
        // A floor with no model changes is itself evidence of the pre-floor state, so it seeds the
        // replay directly (and, below, gets persisted as the baseline).
        seed = first.variables
        if (modelFold || mvu.commands.length || mvu.patches.length || previouslyAppliedOperation) {
          // LEGACY-SAVE FALLBACK — a save written before floor-state baselines existed has no
          // pre-floor-0 snapshot, and floor 0's STORED variables already contain that floor's model
          // fold (and any `vars_ops` applied live), so re-FOLDING floor 0 would apply the same
          // changes a SECOND time. Instead of refusing the whole replay (which would break the
          // renderer's Re-evaluate button and every card write on such a save), skip floor 0's MODEL
          // FOLD — and only that. Its stored variables ARE the true post-fold state, so they seed
          // floor 0's own operation phase; floors 1..N then replay normally from the result.
          //
          // The operations still have to be applied, or a journaled write to floor 0 of such a save
          // is recorded and silently lost (on a one-floor save, lost with no snapshot written at
          // all). Only the kinds that were already folded into storage live are held back — see
          // `isAlreadyStoredKind`. Phase order (`template` before the fold, the rest after) is moot
          // here because there is no fold to sit between them; seq order is what remains.
          //
          // NO baseline row is written: this seed is the state AFTER floor 0, not before it.
          //
          // RESIDUAL, and the price of having no pre-floor-0 snapshot to replay FROM: this seed is
          // re-read from the column each publish, so it comes back carrying the operations the LAST
          // publish applied. Every kind that can reach a floor-0 replay is idempotent against that
          // — `set`/`delete`, and `patch`, whose ops all resolve to set-or-remove-at-path — EXCEPT
          // `increment` (a card `inc`/`dec`), which would advance again on a SECOND floor-0-rooted
          // publish of the same save. Fixing that needs a stable pre-operation seed, i.e. widening
          // the baseline row to record that floor 0's fold is already included.
          replayIndex = 1
          const first0 = cloneJson(first.variables)
          for (const operation of operations)
            if (operation.floor === first.floor && !isAlreadyStoredKind(operation.kind))
              applyStoredOperation(first0, operation)
          seed = first0
          unfoldableFirst = { floor: first.floor, variables: cloneJson(first0) }
        }
      }
    }
    const suffix = [
      ...(unfoldableFirst ? [unfoldableFirst] : []),
      ...computeFloorSuffix(
        allFloors.slice(replayIndex),
        operations,
        seed,
        dependencies.resolveCombatMode?.(chatId) ?? combatModeResolver?.(chatId) ?? 'grid'
      )
    ]
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
      applyTranscriptUpdates(chatId, transcriptUpdates)
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
      if (replayIndex === 0)
        db.prepare(
          `INSERT OR IGNORE INTO floor_state_baselines (chat_id, variables, created_at)
           VALUES (?, ?, ?)`
        ).run(chatId, JSON.stringify(seed), new Date().toISOString())
      const update = db.prepare('UPDATE floors SET variables = ? WHERE chat_id = ? AND floor = ?')
      for (const snapshot of suffix)
        update.run(JSON.stringify(snapshot.variables), chatId, snapshot.floor)
    })()
    // Defensive: `fromFloor` was found in `allFloors`, and the legacy-save fallback contributes its
    // own floor-0 snapshot, so every path above yields at least one republished floor.
    if (suffix.length)
      dependencies.onStateRefresh?.({
        chatId,
        fromFloor: suffix[0].floor,
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
      const seq = nextSeq(chatId, floor)
      const additions = operations.map(
        (operation, index): StoredOperation => ({
          floor,
          seq: seq + index,
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
      return publish(chatId, floor, [
        {
          floor,
          seq: nextSeq(chatId, floor),
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
      const seq = nextSeq(chatId, floor)
      return publish(
        chatId,
        floor,
        operations.map(
          (operation, index): StoredOperation => ({
            floor,
            seq: seq + index,
            source: 'agent',
            kind: operation.kind,
            path: operation.path,
            ...('value' in operation ? { value: cloneJson(operation.value) } : {})
          })
        )
      )
    },

    /**
     * Record operations for a floor WITHOUT replaying anything — the commit-time journal write.
     *
     * `append` / `appendPatch` / `incorporateAgent` all republish the suffix because they mutate a
     * floor that already exists. This one is for the floor being COMMITTED right now: its variables
     * were just produced by the live path, so re-deriving them here would be pure risk — a
     * mid-commit republish would fight the write that is still in flight. All we owe the journal is
     * the evidence that lets a LATER replay reproduce what the live path already did.
     *
     * Operations are validated the same way and appended after any existing seq for that floor.
     */
    journal(
      chatId: string,
      floor: number,
      source: FloorOperationSource,
      operations: readonly FloorStateOperation[]
    ): void {
      if (!Array.isArray(operations) || operations.length === 0) return
      for (const operation of operations) validateOperation(operation, source)
      const seq = nextSeq(chatId, floor)
      db.transaction(() => {
        const insert = db.prepare(
          `INSERT INTO floor_operations
            (chat_id, floor, seq, source, kind, path, value, created_at, legacy_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        )
        operations.forEach((operation, index) =>
          insert.run(
            chatId,
            floor,
            seq + index,
            source,
            operation.kind,
            operation.path,
            'value' in operation ? JSON.stringify(operation.value) : null,
            new Date().toISOString()
          )
        )
      })()
    },

    replay(chatId: string, fromFloor: number): ReplaySnapshot[] {
      return publish(chatId, fromFloor, [])
    },

    /**
     * Write floor transcript text (and swipes), then re-fold the suffix from that floor.
     *
     * `refold: false` writes the columns ONLY — no replay, no snapshot. That is for the one edit
     * whose text carries no state: Yuzu's Scene Director annotates a response that was ALREADY
     * folded at commit time, so re-folding it would re-derive the same variables from a
     * presentation-only rewrite. Every other edit path (UI edit, swipe switch/append, a card's
     * `setMessage`) must re-fold, because its new text can carry different MVU/rpt-event content.
     * Returns `[]` on the no-refold path — nothing was republished.
     */
    updateTranscript(
      chatId: string,
      updates: readonly FloorTranscriptUpdate[],
      options?: { refold?: boolean }
    ): ReplaySnapshot[] {
      if (!updates.length)
        throw new FloorStateError('INVALID_OPERATION', 'At least one transcript update is required')
      if (options?.refold === false) {
        db.transaction(() => applyTranscriptUpdates(chatId, updates))()
        return []
      }
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
