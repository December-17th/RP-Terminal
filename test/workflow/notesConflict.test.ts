import { describe, it, expect } from 'vitest'
import { notesSaveDecision } from '../../src/renderer/src/components/memory/MemoryManagerView'

// B2: the Notes tab must not blind-overwrite a concurrent notes.maintain write. notesSaveDecision is
// the pure guard the Save path runs after re-reading disk.
describe('notesSaveDecision (Notes tab conflict guard)', () => {
  it('warns when the file changed on disk AND the draft has local edits', () => {
    // baseline = what we loaded; disk = a concurrent maintenance write; draft = the user's edits.
    expect(notesSaveDecision('base', 'maintenance wrote this', 'user edited this')).toBe('conflict')
  })

  it('saves normally when disk still matches the baseline (no concurrent change)', () => {
    expect(notesSaveDecision('base', 'base', 'user edited this')).toBe('save')
  })

  it('saves when the draft never diverged from the baseline (nothing to clobber)', () => {
    // Disk changed but the user made no edits — adopting their (unchanged) draft loses nothing.
    expect(notesSaveDecision('base', 'maintenance wrote this', 'base')).toBe('save')
  })

  it('saves when disk is unchanged and draft is unchanged (trivial no-op save)', () => {
    expect(notesSaveDecision('base', 'base', 'base')).toBe('save')
  })
})
