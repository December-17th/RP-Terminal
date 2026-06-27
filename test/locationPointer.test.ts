import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import {
  pointerPath,
  readLocationPointer,
  writeLocationPointer
} from '../src/main/services/locationPointer'

beforeEach(() => writeLocationPointer(null))
afterEach(() => writeLocationPointer(null))

describe('locationPointer', () => {
  it('returns null when no pointer file exists', () => {
    expect(readLocationPointer()).toBeNull()
  })
  it('round-trips a dataDir', () => {
    writeLocationPointer('/some/dir')
    expect(readLocationPointer()).toEqual({ dataDir: '/some/dir' })
  })
  it('clears the pointer when written null', () => {
    writeLocationPointer('/x')
    writeLocationPointer(null)
    expect(readLocationPointer()).toBeNull()
  })
  it('tolerates a corrupt file → null', () => {
    fs.writeFileSync(pointerPath(), 'not json')
    expect(readLocationPointer()).toBeNull()
  })
  it('ignores a file missing dataDir → null', () => {
    fs.writeFileSync(pointerPath(), JSON.stringify({ other: 1 }))
    expect(readLocationPointer()).toBeNull()
  })
})
