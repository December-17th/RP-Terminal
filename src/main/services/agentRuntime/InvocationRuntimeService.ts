import crypto from 'crypto'

import {
  type InputBinding,
  type JsonObject,
  type JsonValue,
  type ResultSlotPath
} from '../../../shared/agentRuntime'
import { onTranscriptCut, onTranscriptEdited } from '../floorService'
import { getSessionDbByChat, resolveProfileId } from '../sessionDbService'
import { AgentCatalog } from './catalog'
import { createFloorState, FloorStateError, type FloorStateOperation } from './floorState'
import {
  createInvocationRuntime,
  type InvocationFloorPort,
  type InvocationRuntime,
  type InvocationSourceSnapshot,
  type NextTurnBarrierState
} from './invocation'
import { log } from '../logService'
import { withMemoryMaintenanceApply } from './memoryMaintenanceApply'
import { memoryMaintenanceBridge } from './memoryMaintenanceSlot'
import { createAgentPromptPlanner } from './prompt'
import { createProviderDispatch } from './provider'
import { agentRunStore } from './runs/AgentRunStore'
import { createHarnessRunAdapter } from './runs/HarnessRunAdapter'
import {
  createCardToolRegistry,
  createCompositeToolRegistry,
  createToolRegistry
} from './tools'

interface PersistedSource extends InvocationSourceSnapshot {
  chatId: string
  floor: number
  variablesHash: string
}

const hash = (value: unknown): string =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

const readPath = (variables: Record<string, unknown>, path: string): JsonValue | undefined => {
  let value: unknown = { variables }
  for (const segment of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !(segment in value)) {
      return undefined
    }
    value = (value as Record<string, unknown>)[segment]
  }
  return value as JsonValue
}

const resolveBinding = (
  binding: InputBinding,
  variables: Record<string, unknown>,
  invocationInput: JsonObject | undefined
): JsonValue => {
  let value: JsonValue | undefined
  switch (binding.source.type) {
    case 'literal':
      value = binding.source.value
      break
    case 'input':
      value = invocationInput
      break
    case 'variables':
    case 'result':
      value = readPath(variables, binding.source.path)
      break
  }
  if (value === undefined) value = binding.default
  if (value === undefined) throw new Error('Input Binding source is unavailable')
  return structuredClone(value)
}

const stagedFloorOperation = (operation: {
  type: string
  payload: JsonObject
}): FloorStateOperation => {
  const kind = operation.type
  const path = operation.payload.path
  if ((kind !== 'set' && kind !== 'delete' && kind !== 'increment') || typeof path !== 'string') {
    throw new Error(`Unsupported staged Agent operation "${operation.type}"`)
  }
  if (kind === 'delete') return { kind, path }
  if (kind === 'increment') {
    if (typeof operation.payload.value !== 'number') {
      throw new Error('Agent increment operation requires a numeric value')
    }
    return { kind, path, value: operation.payload.value }
  }
  return { kind, path, value: operation.payload.value }
}

interface FloorPortDependencies {
  getDb(chatId: string): ReturnType<typeof getSessionDbByChat>
  profileForChat(chatId: string): string | null
}

const defaultFloorDependencies: FloorPortDependencies = {
  getDb: getSessionDbByChat,
  profileForChat: resolveProfileId
}

const sourceCurrent = (
  source: InvocationSourceSnapshot,
  dependencies: FloorPortDependencies
): boolean => {
  const persisted = source as PersistedSource
  const row = dependencies
    .getDb(persisted.chatId)
    ?.prepare('SELECT variables FROM floors WHERE chat_id = ? AND floor = ?')
    .get(persisted.chatId, persisted.floor) as { variables: string } | undefined
  if (!row) return false
  try {
    return hash(JSON.parse(row.variables)) === persisted.variablesHash
  } catch {
    return false
  }
}

export const createSessionInvocationFloorPort = (
  dependencies: FloorPortDependencies = defaultFloorDependencies
): InvocationFloorPort => ({
  async resolveSource(request) {
    if (dependencies.profileForChat(request.chatId) !== request.profileId) {
      throw new Error(`Invocation Floor ${request.floor} is unavailable`)
    }
    const db = dependencies.getDb(request.chatId)
    const row = db
      ?.prepare('SELECT variables FROM floors WHERE chat_id = ? AND floor = ?')
      .get(request.chatId, request.floor) as { variables: string } | undefined
    if (!row) throw new Error(`Invocation Floor ${request.floor} does not exist`)
    const variables = JSON.parse(row.variables) as Record<string, unknown>
    const input = request.options?.inputBindings
      ? Object.fromEntries(
          Object.entries(request.options.inputBindings).map(([key, binding]) => [
            key,
            resolveBinding(binding, variables, request.options?.input)
          ])
        )
      : structuredClone(request.options?.input ?? {})
    const promptValues: Record<string, JsonValue> = {}
    for (const message of request.agent.effective.prompt) {
      for (const segment of message.content) {
        if (
          segment.type !== 'binding' ||
          (segment.source.type !== 'variables' && segment.source.type !== 'result')
        ) {
          continue
        }
        const value = readPath(variables, segment.source.path) ?? segment.default
        if (value !== undefined) promptValues[segment.source.path] = structuredClone(value)
      }
    }
    const variablesHash = hash(variables)
    return {
      token: `${request.chatId}:${request.floor}:${variablesHash}`,
      chatId: request.chatId,
      floor: request.floor,
      variablesHash,
      input,
      promptValues,
      history: null
    } satisfies PersistedSource
  },
  isSourceCurrent(source) {
    return sourceCurrent(source, dependencies)
  },
  async incorporate(request) {
    const db = dependencies.getDb(request.chatId)
    if (!db) return { status: 'deleted' }
    const exists = db
      .prepare('SELECT 1 FROM floors WHERE chat_id = ? AND floor = ?')
      .get(request.chatId, request.floor)
    if (!exists) return { status: 'deleted' }
    if (!sourceCurrent(request.source, dependencies)) return { status: 'stale' }
    const saveAs =
      request.saveAs ??
      (request.agent.effective.result.mode === 'tools-only'
        ? undefined
        : request.agent.effective.result.saveAs)
    const operations = request.execution.stagedOperations.map(stagedFloorOperation)
    if (saveAs) {
      operations.push({
        kind: 'set',
        path: saveAs as ResultSlotPath,
        value: request.execution.result
      })
    }
    try {
      db.transaction(() => {
        if (operations.length) {
          createFloorState({ db }).incorporateAgent(request.chatId, request.floor, operations)
        }
        request.commitRun()
      })()
      return { status: 'committed' }
    } catch (cause) {
      if (cause instanceof FloorStateError && cause.code === 'FLOOR_NOT_FOUND') {
        return { status: 'deleted' }
      }
      if (cause instanceof FloorStateError && cause.code === 'TRANSCRIPT_CHANGED') {
        return { status: 'stale' }
      }
      return {
        status: 'failed',
        failure: {
          code: 'RESULT_INCORPORATION_FAILED',
          message: cause instanceof Error ? cause.message : 'Result incorporation failed',
          retryable: true
        }
      }
    }
  }
})

const cardToolRegistry = createCardToolRegistry()

export const liveCardToolRegistry = () => cardToolRegistry

let runtime: InvocationRuntime | null = null
let disposeBeforeDelete: (() => void) | null = null

export const initializeInvocationRuntime = (): InvocationRuntime => {
  if (runtime) return runtime
  const catalogs = new Map<string, AgentCatalog>()
  const harness = createHarnessRunAdapter({
    runStore: agentRunStore,
    providerDispatch: createProviderDispatch(),
    toolRegistry: createCompositeToolRegistry(createToolRegistry(), cardToolRegistry)
  })
  const base = createInvocationRuntime({
    catalog: {
      get(profileId, name) {
        let catalog = catalogs.get(profileId)
        if (!catalog) {
          catalog = new AgentCatalog(profileId)
          catalogs.set(profileId, catalog)
        }
        return catalog.get(name)
      }
    },
    harness,
    floor: createSessionInvocationFloorPort(),
    runStore: agentRunStore,
    // ADR 0021: prompt policy is wired HERE, at the composition root, and injected downward — a
    // renderer for a messages Agent, assembled messages for a preset Agent. Neither the Invocation
    // Runtime nor the Harness imports the engine or the assembler.
    promptRenderer: createAgentPromptPlanner()
  })
  // Final-review Finding 1: the built-in Memory Maintenance Agent's durable `<TableEdit>` apply is
  // hooked HERE, at the single point every entry path (floor-commit trigger, manual Workspace run,
  // card transport) funnels through, so a successful run applies exactly once regardless of caller.
  runtime = withMemoryMaintenanceApply(base, {
    bridge: () => memoryMaintenanceBridge(),
    warn: (message) => log('error', message)
  })
  const active = runtime
  disposeBeforeDelete = agentRunStore.onBeforeDeleteFromFloor((chatId, fromFloor) => {
    active.cancelFloors(chatId, fromFloor)
  })
  onTranscriptCut((_profileId, chatId, fromFloor) => active.cancelFloors(chatId, fromFloor))
  onTranscriptEdited((_profileId, chatId, floor) => active.invalidateSources(chatId, floor))
  return active
}

export const invocationRuntime = (): InvocationRuntime => initializeInvocationRuntime()

/** READ-ONLY: is any Agent invocation queued/running (or a plan stepping)? Deliberately does NOT
 *  construct the runtime — asking whether work exists must never be the thing that creates it. */
export const hasActiveAgentWork = (): boolean => runtime?.hasActiveWork() ?? false

/**
 * Await this chat's `blocksNextTurn` barriers (execution-plan M3). Like {@link hasActiveAgentWork},
 * this deliberately does NOT construct the runtime: when nothing has ever run in the process (e.g. a
 * mocked generation test that never called `initializeInvocationRuntime`) there is nothing to gate, so
 * it resolves `clear` immediately without touching the DB-backed service graph. In production the
 * runtime is initialized at startup, so this returns the live barrier state.
 */
export const waitForNextTurnBarriers = (chatId: string): Promise<NextTurnBarrierState> =>
  runtime?.waitForNextTurnBarriers(chatId) ??
  Promise.resolve({ status: 'clear', pending: 0, failures: [] })

export const shutdownInvocationRuntime = (): void => {
  runtime?.shutdown()
  disposeBeforeDelete?.()
  disposeBeforeDelete = null
}
