import { describe, expect, it } from 'vitest'
import type { RecallDocument } from '../src/main/services/tableExportService'
import type { MemoryRetrievalSettings } from '../src/main/types/models'
import {
  embeddingEndpoint,
  rankRecallBm25,
  selectRecallCandidates,
  tokenizeRecallText
} from '../src/main/services/memory/memoryRetrieval'

const settings = (patch: Partial<MemoryRetrievalSettings> = {}): MemoryRetrievalSettings => ({
  enabled: true,
  embedding_api_preset_id: '',
  activation_threshold: 1,
  recent_fixed_count: 0,
  candidate_limit: 2,
  ...patch
})

const document = (
  id: string,
  searchText: string,
  rowOrder: number,
  tableId = 'chronicle',
  tableOrder = 0
): RecallDocument =>
  ({
    id,
    tableId,
    tableOrder,
    rowOrder,
    keys: [id],
    catalogueLine: `${id}: ${searchText}`,
    catalogueWrapper: '<catalogue>$1</catalogue>',
    searchText,
    entry: { content: searchText }
  }) as RecallDocument

describe('memory retrieval ranking', () => {
  it('tokenizes CJK as unigrams+bigrams while preserving Latin memory codes', () => {
    const tokens = tokenizeRecallText('MT0001 月光钥匙')
    expect(tokens).toContain('mt0001')
    expect(tokens).toContain('月光')
    expect(tokens).toContain('钥匙')
  })

  it('BM25 ranks the matching CJK memory above an unrelated row', () => {
    const rows = [
      document('old', '敌人乘坐北行列车离开', 0),
      document('key', '月光钥匙藏在礼拜堂地板下面', 1)
    ]
    expect(rankRecallBm25(rows, '寻找礼拜堂的钥匙')[0]?.id).toBe('key')
  })

  it('keeps the full catalogue below the activation threshold', () => {
    const rows = [document('b', 'second', 1), document('a', 'first', 0)]
    const result = selectRecallCandidates({
      documents: rows,
      queryText: 'missing',
      settings: settings({ activation_threshold: 3 })
    })
    expect(result.mode).toBe('full')
    expect(result.documents.map((row) => row.id)).toEqual(['a', 'b'])
  })

  it('unions per-table recent rows with BM25 candidates and restores original order', () => {
    const rows = [
      document('old-key', 'the brass key opens the archive', 0),
      document('old-decoy', 'the train left the station', 1),
      document('recent', 'the weather changed', 2),
      document('other-old', 'a distant harbor', 0, 'people', 1),
      document('other-recent', 'a new companion arrived', 1, 'people', 1)
    ]
    const result = selectRecallCandidates({
      documents: rows,
      queryText: 'archive key',
      settings: settings({ recent_fixed_count: 1, candidate_limit: 1 })
    })
    expect(result.mode).toBe('sparse')
    expect(result.documents.map((row) => row.id)).toEqual([
      'old-key',
      'recent',
      'other-recent'
    ])
  })

  it('lets dense similarity recover a lexical miss through reciprocal-rank fusion', () => {
    const rows = [
      document('semantic', 'a scarlet automobile waited outside', 0),
      document('lexical', 'the car was mentioned in passing', 1)
    ]
    const result = selectRecallCandidates({
      documents: rows,
      queryText: 'vehicle',
      settings: settings({ candidate_limit: 1 }),
      denseScores: new Map([
        ['semantic', 0.9],
        ['lexical', 0.2]
      ])
    })
    expect(result.mode).toBe('hybrid')
    expect(result.documents.map((row) => row.id)).toEqual(['semantic'])
  })
})

describe('embedding endpoint normalization', () => {
  it('accepts API roots and chat-completions URLs without adding a second path', () => {
    expect(embeddingEndpoint('https://api.example/v1')).toBe('https://api.example/v1/embeddings')
    expect(embeddingEndpoint('https://api.example/v1/chat/completions')).toBe(
      'https://api.example/v1/embeddings'
    )
    expect(embeddingEndpoint('https://api.example/v1/embeddings')).toBe(
      'https://api.example/v1/embeddings'
    )
  })
})
