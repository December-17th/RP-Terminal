import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

import {
  AGENT_LAB_RUN_REF_CAP,
  type AgentLabCase,
  type AgentLabCaseSummary,
  type AgentLabRunRef,
  type AgentRunRecord,
  type JsonObject
} from '../../../../shared/agentRuntime'
import {
  ensureDir,
  getAppDir,
  listFilesSync,
  readJsonSync,
  writeJsonSyncAtomic
} from '../../storageService'

/**
 * File-per-case Agent Lab store (plan §Storage).
 *
 * One JSON file per case at `<profileDir>/agent-lab/<caseId>.json` — the same per-profile
 * subdirectory pattern as `template-globals`/`regex`, atomic (temp + rename) via
 * {@link writeJsonSyncAtomic}. Cases are agent-scoped (`agentId` + `agentName`) and survive chat
 * deletion because they live outside the session DB.
 *
 * Deliberately a thin CRUD seam: it validates nothing about run records (they are captured verbatim)
 * and holds no replay/dispatch logic. `run` references are appended with a rolling cap so a case's
 * history stays bounded (oldest dropped).
 */

export interface AgentLabCaptureInput {
  agentId: string
  agentName: string
  name: string
  sourceRecord: AgentRunRecord
}

export interface AgentLabAuthorInput {
  agentId: string
  agentName: string
  name: string
  input: JsonObject
}

export interface AgentLabStore {
  list(profileId: string, agentId: string): AgentLabCaseSummary[]
  get(profileId: string, caseId: string): AgentLabCase | null
  captureFromRun(profileId: string, input: AgentLabCaptureInput): AgentLabCaseSummary
  createFromInput(profileId: string, input: AgentLabAuthorInput): AgentLabCaseSummary
  rename(profileId: string, caseId: string, name: string): AgentLabCaseSummary | null
  remove(profileId: string, caseId: string): boolean
  appendRun(profileId: string, caseId: string, ref: AgentLabRunRef): AgentLabCaseSummary | null
}

interface Dependencies {
  /** Data root override (tests). Defaults to the app data dir. */
  baseDir?: () => string
  now?: () => string
  createId?: () => string
}

const toSummary = (record: AgentLabCase): AgentLabCaseSummary => ({
  id: record.id,
  agentId: record.agentId,
  agentName: record.agentName,
  name: record.name,
  createdAt: record.createdAt,
  ...(record.agentHash ? { agentHash: record.agentHash } : {}),
  ...(record.sourceInvocationId ? { sourceInvocationId: record.sourceInvocationId } : {}),
  hasSource: record.hasSource,
  runs: record.runs.map((ref) => ({ ...ref }))
})

/** Only accept a plausible caseId so a caller can never traverse out of the agent-lab directory. */
const safeCaseId = (caseId: string): boolean => /^[A-Za-z0-9_-]+$/.test(caseId)

export const createAgentLabStore = (dependencies: Dependencies = {}): AgentLabStore => {
  const baseDir = dependencies.baseDir ?? getAppDir
  const now = dependencies.now ?? (() => new Date().toISOString())
  const createId = dependencies.createId ?? (() => crypto.randomUUID())

  const dirFor = (profileId: string): string =>
    path.join(baseDir(), 'profiles', profileId, 'agent-lab')
  const fileFor = (profileId: string, caseId: string): string =>
    path.join(dirFor(profileId), `${caseId}.json`)

  const readCase = (profileId: string, caseId: string): AgentLabCase | null => {
    if (!safeCaseId(caseId)) return null
    return readJsonSync<AgentLabCase>(fileFor(profileId, caseId))
  }

  const writeCase = (profileId: string, record: AgentLabCase): void => {
    writeJsonSyncAtomic(fileFor(profileId, record.id), record)
  }

  const readAll = (profileId: string): AgentLabCase[] => {
    ensureDir(dirFor(profileId))
    return listFilesSync(dirFor(profileId))
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) => {
        const record = readJsonSync<AgentLabCase>(path.join(dirFor(profileId), file))
        return record ? [record] : []
      })
  }

  const persistNew = (
    profileId: string,
    base: Omit<AgentLabCase, 'id' | 'createdAt' | 'runs' | 'hasSource'> & { hasSource: boolean }
  ): AgentLabCaseSummary => {
    const record: AgentLabCase = {
      id: createId(),
      createdAt: now(),
      runs: [],
      ...base
    }
    writeCase(profileId, record)
    return toSummary(record)
  }

  return {
    list(profileId, agentId) {
      return readAll(profileId)
        .filter((record) => record.agentId === agentId)
        .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
        .map(toSummary)
    },
    get(profileId, caseId) {
      return readCase(profileId, caseId)
    },
    captureFromRun(profileId, input) {
      return persistNew(profileId, {
        agentId: input.agentId,
        agentName: input.agentName,
        name: input.name,
        hasSource: true,
        agentHash: input.sourceRecord.agentHash,
        sourceInvocationId: input.sourceRecord.invocationId,
        input: input.sourceRecord.input,
        sourceRecord: input.sourceRecord
      })
    },
    createFromInput(profileId, input) {
      return persistNew(profileId, {
        agentId: input.agentId,
        agentName: input.agentName,
        name: input.name,
        hasSource: false,
        input: input.input
      })
    },
    rename(profileId, caseId, name) {
      const record = readCase(profileId, caseId)
      if (!record) return null
      const updated: AgentLabCase = { ...record, name }
      writeCase(profileId, updated)
      return toSummary(updated)
    },
    remove(profileId, caseId) {
      if (!safeCaseId(caseId)) return false
      const file = fileFor(profileId, caseId)
      if (!fs.existsSync(file)) return false
      fs.rmSync(file)
      return true
    },
    appendRun(profileId, caseId, ref) {
      const record = readCase(profileId, caseId)
      if (!record) return null
      // Rolling cap: keep the most-recent AGENT_LAB_RUN_REF_CAP refs (oldest dropped, newest last).
      const runs = [...record.runs, ref].slice(-AGENT_LAB_RUN_REF_CAP)
      const updated: AgentLabCase = { ...record, runs }
      writeCase(profileId, updated)
      return toSummary(updated)
    }
  }
}

export const agentLabStore = createAgentLabStore()
