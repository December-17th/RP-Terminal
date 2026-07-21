import { createHash } from 'node:crypto'
import type { ApiPreset, MemoryRetrievalSettings } from '../../types/models'
import { isOpenAiCompatibleProvider, rpmEndpointKey } from '../apiService'
import { log } from '../logService'
import { acquireConcurrencySlot, acquireRpmSlot } from '../rpmLimiter'
import { getSessionDb } from '../sessionDbService'
import type { RecallDocument } from '../tableExportService'

const BM25_K1 = 1.5
const BM25_B = 0.75
const BM25_CANDIDATES = 1000
const RRF_K = 60
const MIN_DENSE_SCORE = 0.45
const EMBEDDING_BATCH_SIZE = 64
/** Dense retrieval participates over at most this many documents (the newest, by original table/row
 * order): it bounds the per-turn synchronous cost of parsing + cosine-scoring cached vectors. Older
 * rows beyond the window still participate via BM25. */
const DENSE_DOC_LIMIT = 2048
/** At most this many NEW vectors are fetched per turn. The cache fills incrementally across turns
 * instead of stalling the first eligible turn behind an unbounded run of /embeddings batches. */
const EMBED_BUDGET_PER_TURN = 256

export interface RecallCandidateSelection {
  documents: RecallDocument[]
  mode: 'full' | 'sparse' | 'hybrid'
  sparseMatches: number
  denseMatches: number
}

interface SelectOptions {
  documents: RecallDocument[]
  queryText: string
  settings: MemoryRetrievalSettings
  denseScores?: ReadonlyMap<string, number>
}

interface RetrieveOptions extends Omit<SelectOptions, 'denseScores'> {
  profileId: string
  chatId: string
  apiPresets: ApiPreset[]
  signal?: AbortSignal
}

const integer = (value: number, fallback: number, minimum: number): number =>
  Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback

const cjk = (character: string): boolean =>
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)

/** CJK unigrams+bigrams plus intact Latin/code terms. This avoids a tokenizer dependency while
 * preserving identifiers such as MT0001 as one high-signal BM25 term. */
export const tokenizeRecallText = (value: string): string[] => {
  const tokens: string[] = []
  let word = ''
  let cjkRun: string[] = []
  const flushWord = (): void => {
    if (word) tokens.push(word)
    word = ''
  }
  const flushCjk = (): void => {
    tokens.push(...cjkRun)
    for (let index = 0; index + 1 < cjkRun.length; index++) {
      tokens.push(cjkRun[index] + cjkRun[index + 1])
    }
    cjkRun = []
  }

  for (const character of value.normalize('NFKC').toLocaleLowerCase()) {
    if (cjk(character)) {
      flushWord()
      cjkRun.push(character)
    } else if (/\p{L}|\p{N}|[_-]/u.test(character)) {
      flushCjk()
      word += character
    } else {
      flushWord()
      flushCjk()
    }
  }
  flushWord()
  flushCjk()
  return tokens
}

/** Rank only documents sharing at least one query term. Scores use Shujuku's k1/b values. */
export const rankRecallBm25 = (
  documents: RecallDocument[],
  queryText: string
): Array<{ id: string; score: number }> => {
  const queryTerms = [...new Set(tokenizeRecallText(queryText))]
  if (!documents.length || !queryTerms.length) return []
  const tokenized = documents.map((document) => tokenizeRecallText(document.searchText))
  const averageLength = tokenized.reduce((sum, terms) => sum + terms.length, 0) / documents.length || 1
  const documentFrequency = new Map<string, number>()
  for (const terms of tokenized) {
    for (const term of new Set(terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
  }

  return documents
    .map((document, index) => {
      const terms = tokenized[index]
      const frequencies = new Map<string, number>()
      for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
      let score = 0
      for (const term of queryTerms) {
        const frequency = frequencies.get(term) ?? 0
        if (!frequency) continue
        const df = documentFrequency.get(term) ?? 0
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))
        const denominator =
          frequency + BM25_K1 * (1 - BM25_B + BM25_B * (terms.length / averageLength))
        score += idf * ((frequency * (BM25_K1 + 1)) / denominator)
      }
      return { id: document.id, score }
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
}

const originalOrder = (left: RecallDocument, right: RecallDocument): number =>
  left.tableOrder - right.tableOrder || left.rowOrder - right.rowOrder || left.id.localeCompare(right.id)

/** Pure candidate selection: per-table recent rows are fixed, older sparse+dense ranks are fused by
 * reciprocal rank, then the final catalogue returns to its original chronological/table order. */
export const selectRecallCandidates = (options: SelectOptions): RecallCandidateSelection => {
  const { documents, queryText, settings, denseScores } = options
  const threshold = integer(settings.activation_threshold, 200, 0)
  if (!settings.enabled || documents.length < threshold) {
    return {
      documents: [...documents].sort(originalOrder),
      mode: 'full',
      sparseMatches: 0,
      denseMatches: 0
    }
  }

  const recentCount = integer(settings.recent_fixed_count, 50, 0)
  const candidateLimit = integer(settings.candidate_limit, 200, 1)
  const byTable = new Map<string, RecallDocument[]>()
  for (const document of documents) {
    const group = byTable.get(document.tableId) ?? []
    group.push(document)
    byTable.set(document.tableId, group)
  }
  const recentIds = new Set<string>()
  for (const group of byTable.values()) {
    for (const document of recentCount ? [...group].sort(originalOrder).slice(-recentCount) : []) {
      recentIds.add(document.id)
    }
  }
  const older = documents.filter((document) => !recentIds.has(document.id))
  const olderIds = new Set(older.map((document) => document.id))
  const sparse = rankRecallBm25(older, queryText).slice(0, BM25_CANDIDATES)
  const dense = [...(denseScores?.entries() ?? [])]
    .filter(([id, score]) => olderIds.has(id) && score >= MIN_DENSE_SCORE)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  const fused = new Map<string, number>()
  for (const [index, match] of sparse.entries()) {
    fused.set(match.id, (fused.get(match.id) ?? 0) + 1 / (RRF_K + index + 1))
  }
  for (const [index, [id]] of dense.entries()) {
    fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + index + 1))
  }
  const selectedOlder = [...fused.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, candidateLimit)
    .map(([id]) => id)
  const selectedIds = new Set([...recentIds, ...selectedOlder])
  return {
    documents: documents.filter((document) => selectedIds.has(document.id)).sort(originalOrder),
    mode: denseScores ? 'hybrid' : 'sparse',
    sparseMatches: sparse.length,
    denseMatches: dense.length
  }
}

export const embeddingEndpoint = (endpoint: string): string => {
  const base = (endpoint.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '')
  if (/\/embeddings$/i.test(base)) return base
  if (/\/chat\/completions$/i.test(base)) return base.replace(/\/chat\/completions$/i, '/embeddings')
  return `${base}/embeddings`
}

const fingerprint = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

const modelKey = (preset: ApiPreset): string =>
  fingerprint(`${preset.provider}\u0000${embeddingEndpoint(preset.endpoint)}\u0000${preset.model}`)

const embeddingBatch = async (
  preset: ApiPreset,
  input: string[],
  signal?: AbortSignal
): Promise<number[][]> => {
  await acquireRpmSlot(rpmEndpointKey(preset), preset.rpm_limit ?? 0, signal)
  const release = await acquireConcurrencySlot(
    rpmEndpointKey(preset),
    preset.max_concurrent ?? 0,
    signal
  )
  try {
    const response = await fetch(embeddingEndpoint(preset.endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(preset.api_key ? { Authorization: `Bearer ${preset.api_key}` } : {})
      },
      body: JSON.stringify({ model: preset.model, input }),
      signal
    })
    if (!response.ok) {
      throw new Error(`embeddings ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }
    const body = (await response.json()) as {
      data?: Array<{ index?: number; embedding?: unknown }>
    }
    const ordered = [...(body.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    const vectors = ordered.map((row) => row.embedding)
    if (
      vectors.length !== input.length ||
      vectors.some(
        (vector) =>
          !Array.isArray(vector) ||
          !vector.length ||
          vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
      )
    ) {
      throw new Error('embeddings response did not contain one numeric vector per input')
    }
    return vectors as number[][]
  } finally {
    release()
  }
}

const cosine = (left: number[], right: number[]): number => {
  if (!left.length || left.length !== right.length) return -1
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : -1
}

const denseScores = async (
  options: RetrieveOptions,
  preset: ApiPreset
): Promise<Map<string, number>> => {
  const db = getSessionDb(options.profileId, options.chatId)
  const key = modelKey(preset)
  const cachedRows = db
    .prepare(
      `SELECT document_id, fingerprint, model_key, vector_json
       FROM memory_retrieval_embeddings WHERE chat_id = ?`
    )
    .all(options.chatId) as Array<{
    document_id: string
    fingerprint: string
    model_key: string
    vector_json: string
  }>
  const cached = new Map(cachedRows.map((row) => [row.document_id, row]))
  const denseDocs =
    options.documents.length > DENSE_DOC_LIMIT
      ? [...options.documents].sort(originalOrder).slice(-DENSE_DOC_LIMIT)
      : options.documents
  const vectors = new Map<string, number[]>()
  const missing: RecallDocument[] = []
  for (const document of denseDocs) {
    const row = cached.get(document.id)
    const documentFingerprint = fingerprint(document.searchText)
    if (row?.fingerprint === documentFingerprint && row.model_key === key) {
      try {
        const vector = JSON.parse(row.vector_json) as unknown
        if (Array.isArray(vector) && vector.every((value) => typeof value === 'number')) {
          vectors.set(document.id, vector)
          continue
        }
      } catch {
        // A malformed derived cache row is simply rebuilt below.
      }
    }
    missing.push(document)
  }

  const upsert = db.prepare(
    `INSERT INTO memory_retrieval_embeddings
       (chat_id, document_id, fingerprint, model_key, dimensions, vector_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, document_id) DO UPDATE SET
       fingerprint = excluded.fingerprint,
       model_key = excluded.model_key,
       dimensions = excluded.dimensions,
       vector_json = excluded.vector_json,
       updated_at = excluded.updated_at`
  )
  const toEmbed = missing.slice(0, EMBED_BUDGET_PER_TURN)
  if (toEmbed.length < missing.length) {
    log(
      'info',
      `Memory retrieval embedded ${toEmbed.length} of ${missing.length} new vectors for chat ` +
        `${options.chatId}; the rest fill on later turns (BM25 covers them meanwhile)`
    )
  }
  for (let offset = 0; offset < toEmbed.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = toEmbed.slice(offset, offset + EMBEDDING_BATCH_SIZE)
    const embedded = await embeddingBatch(
      preset,
      batch.map((document) => document.searchText),
      options.signal
    )
    const now = new Date().toISOString()
    for (let index = 0; index < batch.length; index++) {
      const document = batch[index]
      const vector = embedded[index]
      vectors.set(document.id, vector)
      upsert.run(
        options.chatId,
        document.id,
        fingerprint(document.searchText),
        key,
        vector.length,
        JSON.stringify(vector),
        now
      )
    }
  }

  const liveIds = new Set(options.documents.map((document) => document.id))
  const remove = db.prepare(
    'DELETE FROM memory_retrieval_embeddings WHERE chat_id = ? AND document_id = ?'
  )
  for (const row of cachedRows) {
    if (!liveIds.has(row.document_id)) remove.run(options.chatId, row.document_id)
  }

  const [queryVector] = await embeddingBatch(preset, [options.queryText], options.signal)
  return new Map(
    [...vectors.entries()].map(([id, vector]) => [id, cosine(queryVector, vector)] as const)
  )
}

/** The single production seam. Dense retrieval is opportunistic: unsupported/misconfigured/failed
 * embedding providers log once and leave the deterministic SQL/BM25 path intact. */
export const retrieveRecallCandidates = async (
  options: RetrieveOptions
): Promise<RecallCandidateSelection> => {
  const threshold = integer(options.settings.activation_threshold, 200, 0)
  if (!options.settings.enabled || options.documents.length < threshold) {
    return selectRecallCandidates(options)
  }
  const presetId = options.settings.embedding_api_preset_id.trim()
  const preset = presetId
    ? options.apiPresets.find((candidate) => candidate.id === presetId)
    : undefined
  if (!preset || !preset.model.trim() || !isOpenAiCompatibleProvider(preset.provider)) {
    return selectRecallCandidates(options)
  }
  try {
    const scores = await denseScores(options, preset)
    return selectRecallCandidates({ ...options, denseScores: scores })
  } catch (error) {
    if (options.signal?.aborted) throw error
    log(
      'error',
      `Memory retrieval embeddings failed; using BM25 only for chat ${options.chatId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return selectRecallCandidates(options)
  }
}
