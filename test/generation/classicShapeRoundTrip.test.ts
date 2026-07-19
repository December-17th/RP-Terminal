// Classic Narrator first execution plan — Milestone 3: the predicate against the REAL production input.
//
// classicShape.test.ts feeds the predicate in-memory doc objects. That is not what production hands it.
// Any profile that has opened the workflows UI resolves a doc that was serialized to JSON, read back,
// and normalized by `parseWorkflowDoc` — the common case, and the one where a future normalization
// change (key ordering, a dropped optional field, a coerced default) could silently flip every user
// onto the fallback path with nothing failing. This file closes that loop: it seeds through the real
// seeding path, resolves through the real resolver, and asserts the predicate still routes direct.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

const mockChatService = vi.hoisted(() => ({
  getChatWorkflowId: vi.fn<(profileId: string, chatId: string) => string | null>(() => null),
  getChat: vi.fn<(profileId: string, chatId: string) => { character_id: string } | null>(
    () => null
  ),
  setChatWorkflowId: vi.fn(),
  removeWorkflowIdFromChats: vi.fn()
}))
vi.mock('../../src/main/services/chatService', () => mockChatService)

import {
  listWorkflows,
  getWorkflowById,
  saveWorkflow,
  resolveWorkflowDoc,
  resolveEffectiveDoc,
  setMemorySeedingEnabled,
  BUILTIN_WORKFLOW_ID
} from '../../src/main/services/workflowService'
import { getAppDir } from '../../src/main/services/storageService'
import { isClassicDirectShape } from '../../src/main/services/generation/classicShape'
import { DEFAULT_MEMORY_SEED_MARKER_V2 } from '../../src/main/services/nodes/builtin/defaultMemoryTemplate'

// The seeded profile copy IS the subject here, so seeding stays ON (unlike workflowService.test.ts,
// which characterizes the pre-seed mechanics and disables it).
setMemorySeedingEnabled(true)

const profiles: string[] = []
/** A fresh on-disk profile per case — seeding is memoized per process, so cases cannot share one. */
const freshProfile = (): string => {
  const id = `classic-shape-${randomUUID()}`
  profiles.push(id)
  return id
}
afterAll(() => {
  for (const id of profiles)
    fs.rmSync(path.join(getAppDir(), 'profiles', id), { recursive: true, force: true })
})

beforeEach(() => {
  mockChatService.getChatWorkflowId.mockReturnValue(null)
  mockChatService.getChat.mockReturnValue(null)
})

describe('the direct-path predicate — against the doc production actually resolves', () => {
  it('routes a SEEDED, JSON-round-tripped, normalized profile doc to the direct path', () => {
    const profileId = freshProfile()

    // The real seeding path: listWorkflows lazily writes the profile copy through
    // createWorkflowFromDoc → validateWorkflowDoc → parseWorkflowDoc → writeJsonSyncAtomic.
    listWorkflows(profileId)
    const resolved = resolveWorkflowDoc(profileId, 'chat1')

    // Not the builtin: this really is the saved file, read off disk and re-normalized on the way out.
    expect(resolved.id).not.toBe(BUILTIN_WORKFLOW_ID)
    expect(resolved.doc.meta?.seeded).toBe(DEFAULT_MEMORY_SEED_MARKER_V2)
    expect(
      fs.existsSync(
        path.join(getAppDir(), 'profiles', profileId, 'workflows', `${resolved.id}.json`)
      )
    ).toBe(true)

    expect(isClassicDirectShape(resolved.doc)).toBe(true)
  })

  it('routes it direct through resolveEffectiveDoc — the actual generate() call site', () => {
    const profileId = freshProfile()
    listWorkflows(profileId)

    const { doc } = resolveEffectiveDoc(profileId, 'chat1')

    // No packs enabled ⇒ compose is the identity ⇒ no composition meta ⇒ the direct path.
    expect(doc.meta?.composition).toBeUndefined()
    expect(isClassicDirectShape(doc)).toBe(true)
  })

  it('survives a SECOND round trip through the user save path', () => {
    // Opening the editor and pressing save rewrites the doc through the same gate. A normalization
    // that is not idempotent would show up here rather than on the seed.
    const profileId = freshProfile()
    listWorkflows(profileId)
    const first = resolveWorkflowDoc(profileId, 'chat1')

    const written = saveWorkflow(profileId, first.id, first.doc)
    expect(written.ok).toBe(true)
    const second = resolveWorkflowDoc(profileId, 'chat1')

    expect(isClassicDirectShape(second.doc)).toBe(true)
    // And the round trip really is lossless for everything the comparator reads.
    expect(second.doc.nodes).toEqual(first.doc.nodes)
    expect(second.doc.edges).toEqual(first.doc.edges)
  })

  it('a raw JSON.parse(JSON.stringify(...)) of the stored file is still admitted', () => {
    // Belt and braces: reads the bytes on disk directly, bypassing the resolver, so the assertion is
    // about the SERIALIZED form rather than anything the resolver might repair on the way out.
    const profileId = freshProfile()
    listWorkflows(profileId)
    const { id } = resolveWorkflowDoc(profileId, 'chat1')
    const file = path.join(getAppDir(), 'profiles', profileId, 'workflows', `${id}.json`)

    const fromDisk = JSON.parse(fs.readFileSync(file, 'utf-8'))

    expect(isClassicDirectShape(fromDisk)).toBe(true)
    // The stored doc is the seeded template, not a builtin reference.
    expect(getWorkflowById(profileId, id)).toBeTruthy()
  })

  it('an EDITED saved doc still falls back after the round trip', () => {
    // The negative direction matters equally: normalization must not launder a real edit away.
    const profileId = freshProfile()
    listWorkflows(profileId)
    const { id, doc } = resolveWorkflowDoc(profileId, 'chat1')

    const edited = structuredClone(doc)
    edited.nodes.find((n) => n.id === 'assemble')!.panel = { show: true, label: 'Prompt' }
    expect(saveWorkflow(profileId, id, edited).ok).toBe(true)

    expect(isClassicDirectShape(resolveWorkflowDoc(profileId, 'chat1').doc)).toBe(false)
  })
})
