import { describe, it, expect } from 'vitest'
import { applyEdit, toPointer } from '../src/renderer/src/components/workspace/jsonTreeEdit'

describe('toPointer', () => {
  it('builds a JSON pointer and escapes ~ and /', () => {
    expect(toPointer(['a', 'b/c', 'd~e'])).toBe('/a/b~1c/d~0e')
    expect(toPointer([])).toBe('')
  })
})

describe('applyEdit', () => {
  it('replace a scalar → replace op + updated value', () => {
    const { next, op } = applyEdit({ 主角: { hp: 100 } }, ['主角', 'hp'], 'replace', { value: 120 })
    expect(next).toEqual({ 主角: { hp: 120 } })
    expect(op).toEqual({ op: 'replace', path: '/主角/hp', value: 120 })
  })
  it('insertKey into an object → add op at /obj/key', () => {
    const { next, op } = applyEdit({ a: {} }, ['a'], 'insertKey', { key: 'k', value: 1 })
    expect(next).toEqual({ a: { k: 1 } })
    expect(op).toEqual({ op: 'add', path: '/a/k', value: 1 })
  })
  it('insertKey at root (empty segs)', () => {
    const { next, op } = applyEdit({}, [], 'insertKey', { key: 'x', value: true })
    expect(next).toEqual({ x: true })
    expect(op).toEqual({ op: 'add', path: '/x', value: true })
  })
  it('appendItem to an array → add op with the /- token', () => {
    const { next, op } = applyEdit({ list: [1] }, ['list'], 'appendItem', { value: 2 })
    expect(next).toEqual({ list: [1, 2] })
    expect(op).toEqual({ op: 'add', path: '/list/-', value: 2 })
  })
  it('delete an object key → remove op', () => {
    const { next, op } = applyEdit({ a: 1, b: 2 }, ['b'], 'delete')
    expect(next).toEqual({ a: 1 })
    expect(op).toEqual({ op: 'remove', path: '/b' })
  })
  it('delete an array index → splice + remove op', () => {
    const { next, op } = applyEdit({ list: [1, 2, 3] }, ['list', 1], 'delete')
    expect(next).toEqual({ list: [1, 3] })
    expect(op).toEqual({ op: 'remove', path: '/list/1' })
  })
  it('does not mutate the input root', () => {
    const root = { a: 1 }
    applyEdit(root, ['a'], 'replace', { value: 2 })
    expect(root).toEqual({ a: 1 })
  })
})
