import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readScopeMeta, setRenderMode, setScope } from '../src/main/services/scopeMeta'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-scope-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('setRenderMode', () => {
  it('stores a renderMode override', () => {
    setRenderMode(dir, 'a.json', 'isolated')
    expect(readScopeMeta(dir)['a.json']).toMatchObject({ renderMode: 'isolated' })
  })
  it('clears the override with null (and prunes a now-empty entry)', () => {
    setRenderMode(dir, 'a.json', 'isolated')
    setRenderMode(dir, 'a.json', null)
    expect(readScopeMeta(dir)['a.json']).toBeUndefined()
  })
  it('preserves scope/owner when set, and keeps the entry while a renderMode is present', () => {
    setScope(dir, 'a.json', 'world', 'card-1')
    setRenderMode(dir, 'a.json', 'inline')
    expect(readScopeMeta(dir)['a.json']).toMatchObject({
      scope: 'world',
      owner: 'card-1',
      renderMode: 'inline'
    })
  })
  it('does not prune a global+enabled entry that still carries a renderMode', () => {
    setRenderMode(dir, 'a.json', 'inline')
    expect(readScopeMeta(dir)['a.json']).toMatchObject({ renderMode: 'inline' })
  })
})
