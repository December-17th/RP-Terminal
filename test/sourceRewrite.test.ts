import { describe, it, expect } from 'vitest'
import { stripParentRefs } from '../src/renderer/src/plugin/sourceRewrite'

describe('stripParentRefs (frontend-card source rewrite)', () => {
  it('redirects window.top / window.parent reaches to the frame-local window', () => {
    // The reference card's env-check: window.top?.SillyTavern.getContext() must reach our shim.
    expect(stripParentRefs('const c = window.top?.SillyTavern.getContext()')).toBe(
      'const c = window?.SillyTavern.getContext()'
    )
    expect(stripParentRefs('window.parent.SillyTavern.getContext()')).toBe(
      'window.SillyTavern.getContext()'
    )
    expect(stripParentRefs('let w = window.top')).toBe('let w = window')
    expect(stripParentRefs("window.top['Mvu']")).toBe("window['Mvu']")
    expect(stripParentRefs('window . parent . foo')).toBe('window . foo') // tolerant of spacing
  })

  it('leaves unrelated identifiers and members intact', () => {
    expect(stripParentRefs('window.parentNode')).toBe('window.parentNode')
    expect(stripParentRefs('window.parentElement')).toBe('window.parentElement')
    expect(stripParentRefs('windows.top')).toBe('windows.top')
    expect(stripParentRefs('window.document.title')).toBe('window.document.title')
    expect(stripParentRefs('')).toBe('')
  })
})
