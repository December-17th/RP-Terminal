import { describe, it, expect } from 'vitest'
import { extractCardUiUrl } from '../src/main/services/regexService'

describe('extractCardUiUrl', () => {
  it('extracts the $(...).load(URL) page url a frontend-card loader regex injects', () => {
    const repl = `<body><script>$('body').load('https://cdn.example/gh/x@1/dist/status/index.html')</script></body>`
    expect(extractCardUiUrl(repl)).toBe('https://cdn.example/gh/x@1/dist/status/index.html')
  })

  it('handles double quotes + extra whitespace', () => {
    expect(extractCardUiUrl(`$("body").load(  "https://x/home/index.html" )`)).toBe(
      'https://x/home/index.html'
    )
  })

  it('returns null for non-loaders: bare CDN imports, plain text, non-strings', () => {
    // a beautification regex importing a LIB is not a page loader
    expect(extractCardUiUrl(`import 'https://cdn/npm/pinia/+esm'`)).toBeNull()
    expect(extractCardUiUrl('just a plain replacement')).toBeNull()
    expect(extractCardUiUrl(123 as any)).toBeNull()
    expect(extractCardUiUrl('')).toBeNull()
  })
})
