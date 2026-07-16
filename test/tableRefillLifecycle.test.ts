import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

const DATA_DIR = path.join(
  process.cwd(),
  '.scratch',
  'test-runtime',
  `refill-lifecycle-${randomUUID()}`
)

vi.mock('better-sqlite3', () => import('./mocks/betterSqlite3Node'))
vi.mock('../src/main/services/storageService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/storageService')>()
  return { ...actual, getAppDir: () => DATA_DIR }
})

import { createProfile } from '../src/main/services/profileService'
import { saveCharacter } from '../src/main/services/characterService'
import {
  appendFloor,
  createChat,
  editFloorContent,
  setChatTableTemplateId
} from '../src/main/services/chatService'
import { closeDb } from '../src/main/services/db'
import { closeAll } from '../src/main/services/sessionDbService'
import { TableTemplateSchema } from '../src/main/types/tableTemplate'
import { saveTableTemplate } from '../src/main/services/tableTemplateService'
import { readAllTables } from '../src/main/services/tableDbService'
import { getProgress } from '../src/main/services/tableProgressService'
import { listOps, listOpsForDisplay } from '../src/main/services/tableOpsService'
import {
  createTableRefillLifecycle,
  type TableRefillLifecycleAdapters
} from '../src/main/services/tableRefillService'
import type { BackfillProgress } from '../src/main/services/tableBackfillEvents'
import type { FloorFile } from '../src/main/types/chat'

const template = TableTemplateSchema.parse({
  name: 'Lifecycle memory',
  tables: [
    {
      uid: 'chronicle-table',
      displayName: 'Chronicle',
      sqlName: 'chronicle',
      ddl: 'CREATE TABLE chronicle (row_id INTEGER PRIMARY KEY, summary TEXT NOT NULL)',
      headers: ['row_id', 'summary'],
      initialRows: [],
      note: 'Record one summary per refill batch.',
      insertNode: 'INSERT INTO chronicle (summary) VALUES (...)',
      updateFrequency: 2
    }
  ]
})

const floor = (chatId: string, index: number): FloorFile => ({
  floor: index,
  chat_id: chatId,
  timestamp: `2026-07-15T12:00:0${index}.000Z`,
  user_message: {
    content: `user ${index}`,
    timestamp: `2026-07-15T12:00:0${index}.000Z`
  },
  response: { content: `response ${index}`, model: 'fixture', provider: 'fixture' },
  events: [],
  variables: {}
})

afterAll(() => {
  closeAll()
  closeDb()
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

describe('table refill lifecycle', () => {
  it('publishes a successful two-batch refill and finalizes its durable state', async () => {
    const profile = createProfile('Refill lifecycle')
    const characterId = `character-${randomUUID()}`
    saveCharacter(profile.id, characterId, {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'Refill fixture',
        description: '',
        personality: '',
        scenario: '',
        first_mes: 'opening',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: {}
      }
    })
    const chat = await createChat(profile.id, characterId)
    appendFloor(profile.id, chat.id, floor(chat.id, 1))
    appendFloor(profile.id, chat.id, floor(chat.id, 2))
    appendFloor(profile.id, chat.id, floor(chat.id, 3))

    const templateId = saveTableTemplate(profile.id, template)
    setChatTableTemplateId(profile.id, chat.id, templateId)

    const sql = [
      "INSERT INTO chronicle (summary) VALUES ('floors 0-1')",
      "INSERT INTO chronicle (summary) VALUES ('floors 2-3')"
    ]
    const events: BackfillProgress[] = []
    const adapters: TableRefillLifecycleAdapters = {
      runMaintainerBatch: async (_gen, _messages, _retries, _signal, apply) => {
        const next = sql.shift()
        if (!next) throw new Error('unexpected maintainer batch')
        apply(next)
        return true
      },
      notifyProgress: (event) => events.push(event)
    }
    const lifecycle = createTableRefillLifecycle(adapters)

    const handle = await lifecycle.start(profile.id, chat.id, { fromFloor: 0, batchSize: 2 })
    await expect(handle.completion).resolves.toEqual({ status: 'done', finalize: true })

    expect(readAllTables(profile.id, chat.id, template)[0].rows).toEqual([
      [1, 'floors 0-1'],
      [2, 'floors 2-3']
    ])
    expect(listOps(profile.id, chat.id)).toEqual([
      {
        floor: 1,
        seq: 0,
        sql: "INSERT INTO chronicle (summary) VALUES ('floors 0-1')"
      },
      {
        floor: 3,
        seq: 0,
        sql: "INSERT INTO chronicle (summary) VALUES ('floors 2-3')"
      }
    ])
    expect(
      listOpsForDisplay(profile.id, chat.id).map(({ floor, source }) => ({ floor, source }))
    ).toEqual([
      { floor: 3, source: 'refill' },
      { floor: 1, source: 'refill' }
    ])
    expect(getProgress(profile.id, chat.id)).toEqual({ chronicle: 3 })
    expect(lifecycle.state(chat.id).persisted).toBeNull()
    expect(events.at(-1)).toMatchObject({
      kind: 'refill',
      chatId: chat.id,
      status: 'done',
      completedUntil: 3
    })
  })

  it('keeps a completed chunk durable after failure and resumes only the missing tail', async () => {
    const profile = createProfile('Refill resume lifecycle')
    const characterId = `character-${randomUUID()}`
    saveCharacter(profile.id, characterId, {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'Refill resume fixture',
        description: '',
        personality: '',
        scenario: '',
        first_mes: 'opening',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: {}
      }
    })
    const chat = await createChat(profile.id, characterId)
    appendFloor(profile.id, chat.id, floor(chat.id, 1))
    appendFloor(profile.id, chat.id, floor(chat.id, 2))
    appendFloor(profile.id, chat.id, floor(chat.id, 3))

    const templateId = saveTableTemplate(profile.id, template)
    setChatTableTemplateId(profile.id, chat.id, templateId)

    const outcomes: Array<string | Error> = [
      "INSERT INTO chronicle (summary) VALUES ('durable floors 0-1')",
      new Error('scripted maintainer failure'),
      "INSERT INTO chronicle (summary) VALUES ('resumed floors 2-3')"
    ]
    const events: BackfillProgress[] = []
    const adapters: TableRefillLifecycleAdapters = {
      runMaintainerBatch: async (_gen, _messages, _retries, _signal, apply) => {
        const next = outcomes.shift()
        if (!next) throw new Error('unexpected maintainer batch')
        if (next instanceof Error) throw next
        apply(next)
        return true
      },
      notifyProgress: (event) => events.push(event)
    }
    const lifecycle = createTableRefillLifecycle(adapters)

    const failedHandle = await lifecycle.start(profile.id, chat.id, {
      fromFloor: 0,
      batchSize: 2,
      retries: 0
    })
    await expect(failedHandle.completion).resolves.toEqual({
      status: 'error',
      finalize: false,
      message: 'scripted maintainer failure'
    })

    expect(readAllTables(profile.id, chat.id, template)[0].rows).toEqual([
      [1, 'durable floors 0-1']
    ])
    expect(listOps(profile.id, chat.id)).toEqual([
      {
        floor: 1,
        seq: 0,
        sql: "INSERT INTO chronicle (summary) VALUES ('durable floors 0-1')"
      }
    ])
    expect(lifecycle.state(chat.id).persisted).toEqual({
      selected: ['chronicle'],
      fromFloor: 0,
      completedUntil: 1,
      status: 'in_progress'
    })
    expect(getProgress(profile.id, chat.id)).toEqual({})
    expect(events.at(-1)).toMatchObject({
      kind: 'refill',
      chatId: chat.id,
      status: 'error',
      message: 'scripted maintainer failure',
      completedUntil: 1
    })

    const resumedHandle = await lifecycle.resume(profile.id, chat.id, {
      batchSize: 2,
      retries: 0
    })
    await expect(resumedHandle.completion).resolves.toEqual({ status: 'done', finalize: true })

    expect(readAllTables(profile.id, chat.id, template)[0].rows).toEqual([
      [1, 'durable floors 0-1'],
      [2, 'resumed floors 2-3']
    ])
    expect(listOps(profile.id, chat.id)).toEqual([
      {
        floor: 1,
        seq: 0,
        sql: "INSERT INTO chronicle (summary) VALUES ('durable floors 0-1')"
      },
      {
        floor: 3,
        seq: 0,
        sql: "INSERT INTO chronicle (summary) VALUES ('resumed floors 2-3')"
      }
    ])
    expect(getProgress(profile.id, chat.id)).toEqual({ chronicle: 3 })
    expect(lifecycle.state(chat.id).persisted).toBeNull()
    expect(outcomes).toEqual([])
    expect(events.at(-1)).toMatchObject({
      kind: 'refill',
      chatId: chat.id,
      status: 'done',
      completedUntil: 3
    })
  })

  it('cancels an active chunk without publishing it and later resumes cleanly', async () => {
    const profile = createProfile('Refill cancellation lifecycle')
    const characterId = `character-${randomUUID()}`
    saveCharacter(profile.id, characterId, {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'Refill cancellation fixture',
        description: '',
        personality: '',
        scenario: '',
        first_mes: 'opening',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: {}
      }
    })
    const chat = await createChat(profile.id, characterId)
    appendFloor(profile.id, chat.id, floor(chat.id, 1))
    appendFloor(profile.id, chat.id, floor(chat.id, 2))
    appendFloor(profile.id, chat.id, floor(chat.id, 3))

    const templateId = saveTableTemplate(profile.id, template)
    setChatTableTemplateId(profile.id, chat.id, templateId)

    let activeBatchStarted!: () => void
    const activeBatch = new Promise<void>((resolve) => {
      activeBatchStarted = resolve
    })
    let batch = 0
    const events: BackfillProgress[] = []
    const adapters: TableRefillLifecycleAdapters = {
      runMaintainerBatch: async (_gen, _messages, _retries, signal, apply) => {
        batch++
        if (batch === 1) {
          apply("INSERT INTO chronicle (summary) VALUES ('durable before cancel')")
          return true
        }
        if (batch === 2) {
          apply("INSERT INTO chronicle (summary) VALUES ('cancelled uncommitted chunk')")
          activeBatchStarted()
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return true
        }
        if (batch === 3) {
          apply("INSERT INTO chronicle (summary) VALUES ('resumed after cancel')")
          return true
        }
        throw new Error('unexpected maintainer batch')
      },
      notifyProgress: (event) => events.push(event)
    }
    const lifecycle = createTableRefillLifecycle(adapters)

    const cancelledHandle = await lifecycle.start(profile.id, chat.id, {
      fromFloor: 0,
      batchSize: 2,
      retries: 0
    })
    await activeBatch
    lifecycle.cancel(chat.id)
    await expect(cancelledHandle.completion).resolves.toEqual({
      status: 'cancelled',
      finalize: false
    })

    expect(readAllTables(profile.id, chat.id, template)[0].rows).toEqual([
      [1, 'durable before cancel']
    ])
    expect(listOps(profile.id, chat.id)).toEqual([
      {
        floor: 1,
        seq: 0,
        sql: "INSERT INTO chronicle (summary) VALUES ('durable before cancel')"
      }
    ])
    expect(lifecycle.state(chat.id).persisted).toEqual({
      selected: ['chronicle'],
      fromFloor: 0,
      completedUntil: 1,
      status: 'in_progress'
    })
    expect(getProgress(profile.id, chat.id)).toEqual({})
    expect(events.at(-1)).toMatchObject({
      kind: 'refill',
      chatId: chat.id,
      status: 'cancelled',
      completedUntil: 1
    })

    const resumedHandle = await lifecycle.resume(profile.id, chat.id, {
      batchSize: 2,
      retries: 0
    })
    await expect(resumedHandle.completion).resolves.toEqual({ status: 'done', finalize: true })

    expect(readAllTables(profile.id, chat.id, template)[0].rows).toEqual([
      [1, 'durable before cancel'],
      [2, 'resumed after cancel']
    ])
    expect(listOps(profile.id, chat.id)).toEqual([
      {
        floor: 1,
        seq: 0,
        sql: "INSERT INTO chronicle (summary) VALUES ('durable before cancel')"
      },
      {
        floor: 3,
        seq: 0,
        sql: "INSERT INTO chronicle (summary) VALUES ('resumed after cancel')"
      }
    ])
    expect(getProgress(profile.id, chat.id)).toEqual({ chronicle: 3 })
    expect(lifecycle.state(chat.id).persisted).toBeNull()
    expect(events.at(-1)).toMatchObject({
      kind: 'refill',
      chatId: chat.id,
      status: 'done',
      completedUntil: 3
    })
  })

  it('discards resumable state without removing an already committed chunk', async () => {
    const profile = createProfile('Refill discard lifecycle')
    const characterId = `character-${randomUUID()}`
    saveCharacter(profile.id, characterId, {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'Refill discard fixture',
        description: '',
        personality: '',
        scenario: '',
        first_mes: 'opening',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: {}
      }
    })
    const chat = await createChat(profile.id, characterId)
    appendFloor(profile.id, chat.id, floor(chat.id, 1))
    appendFloor(profile.id, chat.id, floor(chat.id, 2))
    appendFloor(profile.id, chat.id, floor(chat.id, 3))

    const templateId = saveTableTemplate(profile.id, template)
    setChatTableTemplateId(profile.id, chat.id, templateId)

    const outcomes: Array<string | Error> = [
      "INSERT INTO chronicle (summary) VALUES ('kept after discard')",
      new Error('discard fixture failure')
    ]
    const lifecycle = createTableRefillLifecycle({
      runMaintainerBatch: async (_gen, _messages, _retries, _signal, apply) => {
        const next = outcomes.shift()
        if (!next) throw new Error('unexpected maintainer batch')
        if (next instanceof Error) throw next
        apply(next)
        return true
      },
      notifyProgress: () => {}
    })

    const failedHandle = await lifecycle.start(profile.id, chat.id, {
      fromFloor: 0,
      batchSize: 2,
      retries: 0
    })
    await expect(failedHandle.completion).resolves.toEqual({
      status: 'error',
      finalize: false,
      message: 'discard fixture failure'
    })
    expect(lifecycle.state(chat.id).persisted).toEqual({
      selected: ['chronicle'],
      fromFloor: 0,
      completedUntil: 1,
      status: 'in_progress'
    })

    lifecycle.discard(profile.id, chat.id)

    expect(lifecycle.state(chat.id).persisted).toBeNull()
    expect(readAllTables(profile.id, chat.id, template)[0].rows).toEqual([
      [1, 'kept after discard']
    ])
    expect(listOps(profile.id, chat.id)).toEqual([
      {
        floor: 1,
        seq: 0,
        sql: "INSERT INTO chronicle (summary) VALUES ('kept after discard')"
      }
    ])
    await expect(lifecycle.resume(profile.id, chat.id)).rejects.toThrow(
      'tables.refillNothingToResume'
    )
  })

  it('drops a pending stale chunk and regenerates the edited tail on resume', async () => {
    const profile = createProfile('Refill transcript edit lifecycle')
    const characterId = `character-${randomUUID()}`
    saveCharacter(profile.id, characterId, {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'Refill transcript edit fixture',
        description: '',
        personality: '',
        scenario: '',
        first_mes: 'opening',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: {}
      }
    })
    const chat = await createChat(profile.id, characterId)
    appendFloor(profile.id, chat.id, floor(chat.id, 1))
    appendFloor(profile.id, chat.id, floor(chat.id, 2))
    appendFloor(profile.id, chat.id, floor(chat.id, 3))

    const templateId = saveTableTemplate(profile.id, template)
    setChatTableTemplateId(profile.id, chat.id, templateId)

    let pendingBatchStarted!: () => void
    const pendingBatch = new Promise<void>((resolve) => {
      pendingBatchStarted = resolve
    })
    let releasePendingBatch!: () => void
    const releasePending = new Promise<void>((resolve) => {
      releasePendingBatch = resolve
    })
    let pendingSignal: AbortSignal | null = null
    const outcomes = [
      "INSERT INTO chronicle (summary) VALUES ('stale original floors 0-1')",
      "INSERT INTO chronicle (summary) VALUES ('stale pending floors 2-3')",
      "INSERT INTO chronicle (summary) VALUES ('edited floors 0-1')",
      "INSERT INTO chronicle (summary) VALUES ('fresh floors 2-3')"
    ]
    let batch = 0
    const events: BackfillProgress[] = []
    const adapters: TableRefillLifecycleAdapters = {
      runMaintainerBatch: async (_gen, _messages, _retries, signal, apply) => {
        const sql = outcomes[batch++]
        if (!sql) throw new Error('unexpected maintainer batch')
        apply(sql)
        if (batch === 2) {
          pendingSignal = signal
          pendingBatchStarted()
          await releasePending
        }
        return true
      },
      notifyProgress: (event) => events.push(event)
    }
    const lifecycle = createTableRefillLifecycle(adapters)

    const staleHandle = await lifecycle.start(profile.id, chat.id, {
      fromFloor: 0,
      batchSize: 2,
      retries: 0
    })
    await pendingBatch
    editFloorContent(profile.id, chat.id, 1, 'edited user 1', null)
    const editAbortedPendingBatch = pendingSignal?.aborted
    releasePendingBatch()

    await expect(staleHandle.completion).resolves.toEqual({
      status: 'error',
      finalize: false,
      message: 'tables.refillTranscriptChanged'
    })
    expect(editAbortedPendingBatch).toBe(true)
    expect(readAllTables(profile.id, chat.id, template)[0].rows).toEqual([
      [1, 'stale original floors 0-1']
    ])
    expect(listOps(profile.id, chat.id)).toEqual([
      {
        floor: 1,
        seq: 0,
        sql: "INSERT INTO chronicle (summary) VALUES ('stale original floors 0-1')"
      }
    ])
    expect(lifecycle.state(chat.id).persisted).toEqual({
      selected: ['chronicle'],
      fromFloor: 0,
      completedUntil: 0,
      status: 'in_progress'
    })
    expect(getProgress(profile.id, chat.id)).toEqual({})
    expect(events.at(-1)).toMatchObject({
      kind: 'refill',
      chatId: chat.id,
      status: 'error',
      message: 'tables.refillTranscriptChanged',
      completedUntil: 1
    })

    const resumedHandle = await lifecycle.resume(profile.id, chat.id, {
      batchSize: 2,
      retries: 0
    })
    await expect(resumedHandle.completion).resolves.toEqual({ status: 'done', finalize: true })

    expect(readAllTables(profile.id, chat.id, template)[0].rows).toEqual([
      [1, 'edited floors 0-1'],
      [2, 'fresh floors 2-3']
    ])
    expect(listOps(profile.id, chat.id)).toEqual([
      {
        floor: 1,
        seq: 0,
        sql: "INSERT INTO chronicle (summary) VALUES ('edited floors 0-1')"
      },
      {
        floor: 3,
        seq: 0,
        sql: "INSERT INTO chronicle (summary) VALUES ('fresh floors 2-3')"
      }
    ])
    expect(getProgress(profile.id, chat.id)).toEqual({ chronicle: 3 })
    expect(lifecycle.state(chat.id).persisted).toBeNull()
    expect(outcomes.slice(batch)).toEqual([])
    expect(events.at(-1)).toMatchObject({
      kind: 'refill',
      chatId: chat.id,
      status: 'done',
      completedUntil: 3
    })
  })
})
