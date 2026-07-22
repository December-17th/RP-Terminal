// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { applyRegexRules } from '../../src/shared/regexTransform'

vi.mock('../../src/renderer/src/components/workspace/WcvPanel', () => ({
  WcvPanel: ({ slotId, url }: { slotId: string; url: string }) =>
    createElement('div', { 'data-testid': 'wcv', 'data-slot': slotId, 'data-url': url })
}))

let resolveVnMode: (() => void) | undefined
let root: Root | undefined
let container: HTMLDivElement | undefined
const setVnMode = vi.fn(
  () =>
    new Promise<void>((resolve) => {
      resolveVnMode = resolve
    })
)

beforeEach(() => {
  setVnMode.mockClear()
  resolveVnMode = undefined
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  ;(window as unknown as { api: unknown }).api = { setVnMode }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  delete (window as any).YuzuFixturePlayer
  delete (window as any).getChatMessages
  delete (window as any).formatAsTavernRegexedString
  delete (window as any).assetUrl
})

describe('Yuzu full-card surface MVP', () => {
  it.each([
    ['classic generation', false],
    ['Yuzu generation', true]
  ])('selects %s before mounting the unrestricted WCV', async (_label, enableVnMode) => {
    const { YuzuCardSurface } =
      await import('../../src/renderer/src/components/yuzu/YuzuCardSurface')
    await act(async () => {
      root?.render(
        createElement(YuzuCardSurface, {
          profileId: 'p1',
          chatId: 'c1',
          entry: 'card-code:yuzu/index.html',
          enableVnMode
        })
      )
    })

    expect(container?.querySelector('[data-testid="wcv"]')).toBeNull()
    expect(container?.querySelector('.yuzu-surface__bar')).toBeNull()
    expect(setVnMode).toHaveBeenCalledWith('p1', 'c1', enableVnMode)

    await act(async () => resolveVnMode?.())
    const wcv = container?.querySelector('[data-testid="wcv"]')
    expect(wcv?.getAttribute('data-slot')).toBe('yuzu:c1')
    expect(wcv?.getAttribute('data-url')).toBe('card-code:yuzu/index.html')
  })
})

const playerSource = fs.readFileSync(
  path.join(__dirname, 'fixture-card', 'code', 'yuzu', 'player.js'),
  'utf8'
)

const mountPlayerFixture = async (raw: string): Promise<void> => {
  act(() => root?.unmount())
  root = undefined
  container?.remove()
  container = undefined
  document.body.innerHTML = `
    <main class="stage" data-state="loading">
      <img class="stage__backdrop" alt="">
      <div class="stage__actors">
        <div class="actor" data-position="left"></div>
        <div class="actor" data-position="center"></div>
        <div class="actor" data-position="right"></div>
      </div>
      <div class="script__content"></div>
      <button class="script__advance" type="button"></button>
    </main>`
  ;(window as any).getChatMessages = () => [{ role: 'assistant', message: raw }]
  ;(window as any).assetUrl = vi.fn(
    async (name: string, type: string, mood?: string) => `asset:${name}:${type}:${mood ?? 'base'}`
  )
  ;(window as any).formatAsTavernRegexedString = (text: string) =>
    applyRegexRules(text, [
      {
        source: '<gametxt>([\\s\\S]*?)</gametxt>',
        flags: 'g',
        replace: '<article class="pod-beautification">$1</article>',
        placement: [2],
        trimStrings: []
      }
    ])
  Function('window', 'document', playerSource)(window, document)
  document.dispatchEvent(new Event('DOMContentLoaded'))
  await vi.waitFor(() =>
    expect(document.querySelector('.stage')?.getAttribute('data-state')).toBe('ready')
  )
}

describe('fixture-only restricted block player', () => {
  it('formats a PoD beautification inside a block and replaces it on explicit advance', async () => {
    const raw =
      '<| block |>\n<| bg 教室 |>\n<| 柚子 微笑 left |>\n<gametxt>第一幕</gametxt>\n' +
      '<| block |>\n<| 柚子 exit |>\n<gametxt>第二幕</gametxt>\n<| end |>'
    await mountPlayerFixture(raw)

    expect(document.querySelector('.pod-beautification')?.textContent).toBe('第一幕')
    expect(document.querySelector('.actor[data-position="left"] .actor__name')?.textContent).toBe(
      '柚子'
    )
    expect((document.querySelector('.stage__backdrop') as HTMLImageElement).src).toContain(
      'asset:%E6%95%99%E5%AE%A4:%E8%83%8C%E6%99%AF:base'
    )
    ;(document.querySelector('.script__advance') as HTMLButtonElement).click()
    await vi.waitFor(() =>
      expect(document.querySelector('.pod-beautification')?.textContent).toBe('第二幕')
    )
    expect(document.querySelector('.actor[data-position="left"]')?.childElementCount).toBe(0)
  })

  it('shows an invalid response as one readable block', async () => {
    const raw = '<| music invented |>\n<gametxt>完整原文</gametxt>'
    await mountPlayerFixture(raw)
    expect(document.querySelector('.pod-beautification')?.textContent).toBe('完整原文')
    expect(document.querySelector('.script__content')?.textContent).toContain(
      '<| music invented |>'
    )
    expect((document.querySelector('.script__advance') as HTMLButtonElement).disabled).toBe(true)
  })
})
