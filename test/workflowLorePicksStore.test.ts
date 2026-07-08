import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { getLorePicks, setLorePicks } from '../src/main/services/workflowLorePicksStore'
import { getAppDir } from '../src/main/services/storageService'

// Per-world lore picks sidecar (agent-memory-ux WP-H; plan §0.4): real fs against a throwaway
// profile (the workflowService.test idiom). Keyed (worldId, docId, nodeId); identity (book, comment).

const profileId = `lore-picks-test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

describe('workflowLorePicksStore', () => {
  it('round-trips picks and isolates per WORLD (same doc/node, different worlds)', () => {
    setLorePicks(profileId, 'world-A', 'doc-1', 'agent-1', [{ book: 'b1', comment: 'Alpha' }])
    setLorePicks(profileId, 'world-B', 'doc-1', 'agent-1', [
      { book: 'b1', comment: 'Beta' },
      { book: 'b2', comment: 'Gamma' }
    ])

    expect(getLorePicks(profileId, 'world-A', 'doc-1', 'agent-1')).toEqual([
      { book: 'b1', comment: 'Alpha' }
    ])
    expect(getLorePicks(profileId, 'world-B', 'doc-1', 'agent-1')).toEqual([
      { book: 'b1', comment: 'Beta' },
      { book: 'b2', comment: 'Gamma' }
    ])
    // Unset coordinates are empty, not errors.
    expect(getLorePicks(profileId, 'world-A', 'doc-1', 'other-node')).toEqual([])
    expect(getLorePicks(profileId, 'world-C', 'doc-1', 'agent-1')).toEqual([])
  })

  it('an empty write CLEARS the key (and prunes empty parents)', () => {
    setLorePicks(profileId, 'world-A', 'doc-1', 'agent-1', [])
    expect(getLorePicks(profileId, 'world-A', 'doc-1', 'agent-1')).toEqual([])
    // world-B untouched.
    expect(getLorePicks(profileId, 'world-B', 'doc-1', 'agent-1')).toHaveLength(2)
  })

  it('sanitizes malformed rows on read and write (user-editable file)', () => {
    setLorePicks(profileId, 'world-D', 'doc-1', 'n1', [
      { book: 'b1', comment: 'ok' },
      { book: 42, comment: 'bad' } as never,
      null as never
    ])
    expect(getLorePicks(profileId, 'world-D', 'doc-1', 'n1')).toEqual([
      { book: 'b1', comment: 'ok' }
    ])
  })

  it('the sidecar lives at workflows/_lore-picks.json (invisible to the doc scan)', () => {
    expect(fs.existsSync(path.join(profileDir, 'workflows', '_lore-picks.json'))).toBe(true)
  })
})
