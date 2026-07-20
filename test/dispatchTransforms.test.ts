// test/dispatchTransforms.test.ts
//
// Issue 19 item 4: the pre-dispatch mutation seam. A high-trust late hook (the CHAT_COMPLETION_PROMPT_READY
// analogue) gets the FINAL message array and may rewrite it — but every real mutation is DELTA-RECORDED as
// an `opaque` execution-record entry (script id, hook, before/after hashes), never a raw untracked swap.
import { describe, it, expect } from 'vitest'
import {
  applyDispatchTransforms,
  appendDispatchEntries,
  assembledArtifact,
  type DispatchTransform
} from '../src/main/services/generation/promptArtifact'
import type { ChatMessage } from '../src/main/services/promptBuilder'
import { createRecordBuilder } from '../src/main/services/generation/executionRecord'

const msgs = (): ChatMessage[] => [
  { role: 'system', content: 'you are a bot' },
  { role: 'user', content: 'hi' }
]

describe('applyDispatchTransforms — delta-recorded pre-dispatch mutation', () => {
  it('records ONE opaque entry per hook that changes the array (id + hook + before/after hashes)', () => {
    const t: DispatchTransform = {
      scriptId: 'th-42',
      hook: 'CHAT_COMPLETION_PROMPT_READY',
      apply: (m) => [...m, { role: 'system', content: 'INJECTED' }]
    }
    const { messages, entries } = applyDispatchTransforms(msgs(), [t])
    expect(messages).toHaveLength(3)
    expect(messages[2].content).toBe('INJECTED')
    expect(entries).toHaveLength(1)
    const e = entries[0]
    expect(e.stage).toBe('opaque')
    expect(e.source.id).toBe('th-42') // attributed to the script
    expect(e.source.label).toBe('CHAT_COMPLETION_PROMPT_READY') // the hook
    // before/after are HASH refs (never the copied text)
    expect(e.before?.kind).toBe('ref')
    expect(e.after?.kind).toBe('ref')
    expect((e.before as any).hash).not.toBe((e.after as any).hash)
  })

  it('a no-op hook records nothing and leaves the array byte-identical (behavior-neutral)', () => {
    const noop: DispatchTransform = { scriptId: 's', hook: 'h', apply: (m) => m.map((x) => ({ ...x })) }
    const input = msgs()
    const { messages, entries } = applyDispatchTransforms(input, [noop])
    expect(entries).toEqual([])
    expect(messages).toEqual(input)
  })

  it('zero hooks pass the array through unchanged (the default generation path)', () => {
    const input = msgs()
    const { messages, entries } = applyDispatchTransforms(input, [])
    expect(messages).toBe(input)
    expect(entries).toEqual([])
  })

  it('a throwing hook is a no-op (its wreckage stays in the isolated realm)', () => {
    const boom: DispatchTransform = {
      scriptId: 's',
      hook: 'h',
      apply: () => {
        throw new Error('remote code blew up')
      }
    }
    const { messages, entries } = applyDispatchTransforms(msgs(), [boom])
    expect(entries).toEqual([])
    expect(messages).toHaveLength(2)
  })

  it('a non-array return is ignored', () => {
    const bad = { scriptId: 's', hook: 'h', apply: (() => 'nope') as any } as DispatchTransform
    const { messages, entries } = applyDispatchTransforms(msgs(), [bad])
    expect(entries).toEqual([])
    expect(messages).toHaveLength(2)
  })
})

describe('appendDispatchEntries — lands the deltas on the artifact record', () => {
  it('re-indexes seq and appends onto the execution record', () => {
    const record = createRecordBuilder().finish(msgs(), 1)
    const baseLen = record.entries.length
    const artifact = assembledArtifact(msgs(), { temperature: 0.9, max_tokens: 100 }, record)
    const { entries } = applyDispatchTransforms(msgs(), [
      { scriptId: 'th-1', hook: 'ready', apply: (m) => [...m, { role: 'user', content: 'X' }] }
    ])
    const next = appendDispatchEntries(artifact, entries)
    expect(next).not.toBe(artifact) // pure — new artifact
    expect(next.record!.entries.length).toBe(baseLen + 1)
    const appended = next.record!.entries[baseLen]
    expect(appended.stage).toBe('opaque')
    expect(appended.seq).toBe(baseLen) // re-indexed
    // original artifact untouched
    expect(artifact.record!.entries.length).toBe(baseLen)
  })

  it('no record or no entries → returns the same artifact', () => {
    const artifact = assembledArtifact(msgs(), { temperature: 0.9, max_tokens: 100 })
    expect(appendDispatchEntries(artifact, [])).toBe(artifact)
  })
})
