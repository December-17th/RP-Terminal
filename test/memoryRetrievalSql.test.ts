import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecallDocument } from '../src/main/services/tableExportService'

const rows = vi.hoisted(
  () =>
    new Map<
      string,
      { document_id: string; fingerprint: string; model_key: string; vector_json: string }
    >()
)

const fakeDb = vi.hoisted(() => ({
  prepare: vi.fn((sql: string) => {
    if (sql.includes('SELECT document_id')) {
      return { all: vi.fn(() => [...rows.values()]) }
    }
    if (sql.includes('INSERT INTO memory_retrieval_embeddings')) {
      return {
        run: vi.fn(
          (
            _chatId: string,
            documentId: string,
            fingerprint: string,
            modelKey: string,
            _dimensions: number,
            vectorJson: string
          ) => {
            rows.set(documentId, {
              document_id: documentId,
              fingerprint,
              model_key: modelKey,
              vector_json: vectorJson
            })
          }
        )
      }
    }
    return {
      run: vi.fn((_chatId: string, documentId: string) => rows.delete(documentId))
    }
  })
}))

vi.mock('../src/main/services/sessionDbService', () => ({ getSessionDb: () => fakeDb }))
const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../src/main/services/logService', () => mockLog)

import { retrieveRecallCandidates } from '../src/main/services/memory/memoryRetrieval'

const document = (id: string, searchText: string, rowOrder: number): RecallDocument =>
  ({
    id,
    tableId: 'chronicle',
    tableOrder: 0,
    rowOrder,
    keys: [id],
    catalogueLine: `${id}: ${searchText}`,
    catalogueWrapper: '$1',
    searchText,
    entry: { content: searchText }
  }) as RecallDocument

beforeEach(() => {
  rows.clear()
  vi.clearAllMocks()
})

afterEach(() => vi.unstubAllGlobals())

describe('SQL-owned dense recall cache', () => {
  it('writes document vectors to session SQL, reuses them, and embeds the query each run', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const input = (JSON.parse(String(init.body)) as { input: string[] }).input
      return {
        ok: true,
        json: async () => ({
          data: input.map((value, index) => ({
            index,
            embedding:
              value === 'vehicle' || value.includes('scarlet automobile') ? [1, 0] : [0, 1]
          }))
        })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const options = {
      profileId: 'profile',
      chatId: 'chat',
      documents: [
        document('semantic', 'a scarlet automobile waited outside', 0),
        document('decoy', 'the moon rose above the harbor', 1)
      ],
      queryText: 'vehicle',
      settings: {
        enabled: true,
        embedding_api_preset_id: 'embedding',
        activation_threshold: 1,
        recent_fixed_count: 0,
        candidate_limit: 1
      },
      apiPresets: [
        {
          id: 'embedding',
          name: 'Embedding',
          provider: 'openai',
          endpoint: 'https://api.example/v1',
          api_key: 'secret',
          model: 'embed-model'
        }
      ]
    }

    const first = await retrieveRecallCandidates(options)
    const second = await retrieveRecallCandidates(options)

    expect(first.mode).toBe('hybrid')
    expect(first.documents.map((row) => row.id)).toEqual(['semantic'])
    expect(second.documents.map((row) => row.id)).toEqual(['semantic'])
    expect(rows.size).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).input).toEqual(['vehicle'])
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body)).input).toEqual(['vehicle'])
  })

  it('fails soft to BM25 when the embedding endpoint is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, text: async () => 'unavailable' }) as Response)
    )
    const result = await retrieveRecallCandidates({
      profileId: 'profile',
      chatId: 'chat',
      documents: [
        document('key', 'the archive key was hidden', 0),
        document('decoy', 'the train left the station', 1)
      ],
      queryText: 'archive key',
      settings: {
        enabled: true,
        embedding_api_preset_id: 'embedding',
        activation_threshold: 1,
        recent_fixed_count: 0,
        candidate_limit: 1
      },
      apiPresets: [
        {
          id: 'embedding',
          name: 'Embedding',
          provider: 'openai',
          endpoint: 'https://api.example/v1',
          api_key: '',
          model: 'embed-model'
        }
      ]
    })

    expect(result.mode).toBe('sparse')
    expect(result.documents.map((row) => row.id)).toEqual(['key'])
    expect(mockLog.log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('using BM25 only')
    )
  })
})
