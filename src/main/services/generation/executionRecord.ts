import { createHash } from 'node:crypto'
import {
  AssemblyJournal,
  ExecutionRecord,
  EXECUTION_RECORD_VERSION,
  RecordContent,
  RecordEntry,
  RecordMessage,
  RecordRole,
  RecordSource
} from '../../../shared/executionRecord'
import { ChatMessage } from '../promptBuilder'

/**
 * Builder for the forensic Execution Record (issue 07 / WP-1.1). It is the concrete
 * implementation of the `AssemblyJournal` `buildPrompt` receives PLUS the array-level stage
 * recorders `assemblePrompt` calls directly (trim / system→user / role-merge / provider-shape).
 *
 * Every recording method is a PURE side-effect on the builder's own entry list — it reads values
 * already computed by the assembler and appends an entry. It NEVER touches the message arrays or
 * changes control flow, so producing the record is behavior-neutral (pinned by the parity
 * snapshot + the journal-neutrality characterization test).
 *
 * Inline-vs-hash rule (perf, PLAN risk 5): small controlled transforms keep their exact text
 * (span lineage, legible); content at/above `INLINE_LIMIT` bytes — and every opaque script
 * mutation — is referenced by SHA-256 hash + byte count, never copied. The single authoritative
 * copy of the wire lives once in `record.wire`.
 */

/** Above this UTF-8 byte size, before/after payloads are hash-referenced, not inlined. */
const INLINE_LIMIT = 512
/** Preview prefix kept on a `ref` payload so a reader has a human anchor without the full text. */
const PREVIEW_CHARS = 80

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/** Choose inline text vs a hash reference by size. */
const content = (s: string): RecordContent => {
  const bytes = byteLen(s)
  if (bytes < INLINE_LIMIT) return { kind: 'text', text: s }
  return { kind: 'ref', hash: sha256(s), bytes, preview: s.slice(0, PREVIEW_CHARS) }
}

/** Always reference by hash (opaque mutations / bulk spans — "hashes, not copies"). */
const ref = (s: string): RecordContent => ({
  kind: 'ref',
  hash: sha256(s),
  bytes: byteLen(s),
  preview: s.slice(0, PREVIEW_CHARS)
})

export interface RecordBuilder extends AssemblyJournal {
  /** Record an array→array stage (trim / system→user / role-merge / provider-shape). Only call
   *  when the stage actually ran / changed something — `note` summarizes the effect. */
  arrayStage(
    stage: 'trim' | 'system-as-user' | 'role-merge' | 'provider-shape',
    beforeCount: number,
    afterCount: number,
    note: string
  ): void
  /** Finalize: attach the exact wire + timing, compute the serialized byte size. */
  finish(wire: ChatMessage[], buildMs: number): ExecutionRecord
}

/** Create a fresh record builder for one generation. */
export const createRecordBuilder = (): RecordBuilder => {
  const entries: RecordEntry[] = []
  let seq = 0
  const push = (e: Omit<RecordEntry, 'seq'>): void => {
    entries.push({ seq: seq++, ...e })
  }

  return {
    marker(source: RecordSource, role: RecordRole, after: string): void {
      push({ stage: 'marker-expand', source, role, after: content(after) })
    },
    literal(source: RecordSource, before: string, after: string): void {
      // One entry for the combined macro→EJS pass over a literal preset block (raw authored text →
      // evaluated result). When the block is a plain string with no macros/EJS, before === after and
      // it reads as an identity transform.
      push({ stage: 'macro', source, before: content(before), after: content(after) })
    },
    regex(source: RecordSource, depth: number, before: string, after: string): void {
      push({ stage: 'regex', source, at: depth, before: content(before), after: content(after) })
    },
    depthInject(
      source: RecordSource,
      depth: number,
      at: number,
      role: RecordRole,
      contentText: string
    ): void {
      push({
        stage: 'depth-inject',
        source,
        at,
        role,
        after: content(contentText),
        note: `depth ${depth}`
      })
    },
    markerInject(source: RecordSource, at: number, role: RecordRole, contentText: string): void {
      push({ stage: 'marker-inject', source, at, role, after: content(contentText) })
    },
    safetyNet(source: RecordSource, at: number, role: RecordRole, contentText: string): void {
      push({ stage: 'safety-net', source, at, role, after: content(contentText) })
    },
    history(source: RecordSource, turnCount: number, joined: string): void {
      push({ stage: 'marker-expand', source, after: ref(joined), note: `${turnCount} turn(s)` })
    },
    opaque(source: RecordSource, before: string, after: string): void {
      // Arbitrary script mutation: NEVER copy — before/after as hashes only.
      push({ stage: 'opaque', source, before: ref(before), after: ref(after) })
    },
    arrayStage(stage, beforeCount, afterCount, note): void {
      // Array→array pipeline stage: counts live in `note` (both explicit args are captured there by
      // the caller); no positional `at` since it reshapes the whole list, not one index.
      void beforeCount
      void afterCount
      push({ stage, note, source: { kind: 'pipeline', id: stage } })
    },
    finish(wire: ChatMessage[], buildMs: number): ExecutionRecord {
      const wireMsgs: RecordMessage[] = wire.map((m) => ({ role: m.role, content: m.content }))
      const record: ExecutionRecord = {
        version: EXECUTION_RECORD_VERSION,
        createdAt: new Date().toISOString(),
        entries,
        wire: wireMsgs,
        stats: { entries: entries.length, bytes: 0, buildMs }
      }
      // bytes = serialized size of the whole record (self-referential, so measure with bytes:0
      // then the true figure is that length; close enough for a size budget — the delta from the
      // final digits is a handful of bytes).
      record.stats.bytes = byteLen(JSON.stringify(record))
      return record
    }
  }
}
