import { describe, it, expect, beforeAll } from 'vitest'
import {
  initTemplates,
  evalTemplate,
  evalTemplateDetailed,
  buildTemplateContext,
  TemplateContext
} from '../src/main/services/templateService'

/**
 * WP-2.7 conformance: RPT's EJS engine reproduces the pinned ST-Prompt-Template profile (its bundled
 * EJS 3.1.9 + wrapper options), per docs/research/sillytavern-prompt-compatibility.md §6:
 *   async templates / top-level await · print() output fn · bare-identifier (_with:true) context ·
 *   IDENTITY escaper for generation (<%= == <%-) vs a real HTML escaper for render · include = no-op ·
 *   <thinking>/<think>/<reasoning>/<escape-ejs> protected regions · null-fallback vs rethrow failure
 *   split · <%_ / _%> / -%> whitespace-slurp exactness.
 * Fixtures are RPT-authored scrambled prose (clean-room — no ST / third-party preset strings).
 */

// A generation-phase context (default escaper = identity).
const gen = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  vars: { stat_data: { 灯塔: { 潮位: 3 } }, 队伍: [{ 名: '苔' }, { 名: '雾' }] },
  globals: {},
  constants: { userName: '旅人', charName: '守灯人', lastMessageId: 4 },
  data: { messages: [{ user: '你好', assistant: '嗯' }] },
  ...over
})

describe('EJS profile (ST-Prompt-Template) — WP-2.7', () => {
  beforeAll(async () => {
    await initTemplates()
  })

  describe('async templates / top-level await', () => {
    it('resolves a top-level await against an already-available value', () => {
      expect(evalTemplate('潮汐记得<%= await Promise.resolve(7) %>个名字', gen())).toBe('潮汐记得7个名字')
    })
    it('awaits inside a scriptlet block', () => {
      expect(evalTemplate('<% const n = await Promise.resolve(2 + 3) %>灯火数：<%= n %>', gen())).toBe(
        '灯火数：5'
      )
    })
    it('awaits an async arrow immediately invoked', () => {
      expect(evalTemplate('<%= await (async () => variables.灯塔.潮位 * 2)() %>', gen())).toBe('6')
    })
  })

  describe('print() as the output function', () => {
    it('print appends to the template output like a raw write', () => {
      expect(evalTemplate('<% print("锚:" + variables.灯塔.潮位) %>', gen())).toBe('锚:3')
    })
    it('print inside a loop concatenates in order', () => {
      expect(evalTemplate('<% for (const m of variables.队伍) { print(m.名) } %>', gen())).toBe('苔雾')
    })
  })

  describe('bare-identifier context (_with:true / localsName)', () => {
    it('context constants resolve as bare identifiers', () => {
      expect(evalTemplate('<%= userName %>对<%= charName %>说', gen())).toBe('旅人对守灯人说')
    })
    it('the hoisted `variables` object exposes chat vars', () => {
      expect(evalTemplate('<%= variables.灯塔.潮位 %>', gen())).toBe('3')
    })
  })

  describe('generation escaper is IDENTITY (<%= == <%-)', () => {
    const markup = '<渡口 attr="盐&沙">'
    it('<%= emits raw (unescaped) prompt text in generation', () => {
      expect(evalTemplate(`<%= ${JSON.stringify(markup)} %>`, gen())).toBe(markup)
    })
    it('<%- emits the same raw text — no difference in generation', () => {
      const a = evalTemplate(`<%= ${JSON.stringify(markup)} %>`, gen())
      const b = evalTemplate(`<%- ${JSON.stringify(markup)} %>`, gen())
      expect(a).toBe(b)
    })
  })

  describe('render escaper is HTML (distinct from generation)', () => {
    const markup = '<渡口 attr="盐&沙">'
    const render = buildTemplateContext(gen().vars, { escape: 'html' })
    it('<%= HTML-escapes on the render/display path', () => {
      expect(evalTemplate(`<%= ${JSON.stringify(markup)} %>`, render)).toBe(
        '&lt;渡口 attr=&quot;盐&amp;沙&quot;&gt;'
      )
    })
    it('<%- still emits raw HTML on the render path', () => {
      expect(evalTemplate(`<%- ${JSON.stringify(markup)} %>`, render)).toBe(markup)
    })
  })

  describe('include = no-op empty template (no server-side filesystem)', () => {
    it('include(...) resolves to an empty string, never throws', () => {
      expect(evalTemplate('潮汐[<%- include("不存在的片段") %>]退去', gen())).toBe('潮汐[]退去')
    })
  })

  describe('protected regions — EJS inside is NOT evaluated', () => {
    it('<thinking> keeps its wrapper and does not evaluate inner EJS', () => {
      expect(evalTemplate('<thinking>盘算 <%= 1 + 1 %></thinking>灯亮<%= 1 + 1 %>', gen())).toBe(
        '<thinking>盘算 <%= 1 + 1 %></thinking>灯亮2'
      )
    })
    it('<think> is protected', () => {
      expect(evalTemplate('<think><%= 崩坏 %></think>', gen())).toBe('<think><%= 崩坏 %></think>')
    })
    it('<reasoning> is protected', () => {
      expect(evalTemplate('<reasoning><% while(true){} %></reasoning>', gen())).toBe(
        '<reasoning><% while(true){} %></reasoning>'
      )
    })
    it('<escape-ejs> drops the wrapper and passes the inner text through literally', () => {
      expect(evalTemplate('前<escape-ejs>字面 <%= 崩坏 %></escape-ejs>后', gen())).toBe(
        '前字面 <%= 崩坏 %>后'
      )
    })
  })

  describe('failure split — inner diagnostic → handler null → outer rethrow', () => {
    it('a SYNTAX error is reported with a compiled-line diagnostic (inner logs+rethrows)', () => {
      const r = evalTemplateDetailed('<% if (潮 { %>断裂', gen())
      expect(r.output).toBe('')
      expect(r.error).toBeTruthy()
      expect(r.error).toMatch(/compiled L\d+:/)
    })
    it('a RUNTIME error: evalTemplateDetailed returns error + empty (handler "returns null" tier)', () => {
      const r = evalTemplateDetailed('<%= 未定义的灯() %>', gen())
      expect(r.output).toBe('')
      expect(r.error).toMatch(/not a function|is not defined/)
    })
    it('evalTemplate swallows the error to "" (caller keeps/skips its content)', () => {
      expect(evalTemplate('<%= 未定义的灯() %>', gen())).toBe('')
    })
    it('an outer handler that rethrows on the reported error fails loud (preset tier)', () => {
      // Mirrors promptBuilder.ejsStrict: the final-prompt caller turns a reported error into a throw.
      const strict = (tmpl: string): string => {
        const r = evalTemplateDetailed(tmpl, gen())
        if (r.error) throw new Error(`template: ${r.error}`)
        return r.output
      }
      expect(() => strict('<% 从未定义 %>灯')).toThrow(/从未定义|template/)
      expect(strict('<%= 1 + 1 %>')).toBe('2')
    })
  })

  describe('whitespace-slurp exactness (EJS 3.1.9)', () => {
    it('<%_ strips same-line spaces/tabs before it', () => {
      expect(evalTemplate('灯\n   <%_ const a = 1 %>塔<%= a %>', gen())).toBe('灯\n塔1')
    })
    it('_%> strips same-line spaces/tabs after it AND the single following newline', () => {
      expect(evalTemplate('岸<% const b = 2 _%>   \n屿<%= b %>', gen())).toBe('岸屿2')
    })
    it('-%> trims a single following newline only (no space slurp)', () => {
      expect(evalTemplate('雾<% ; -%>\n港', gen())).toBe('雾港')
    })
    it('a slurped conditional renders exactly one branch, no whitespace leak', () => {
      const tmpl =
        '<%_ if (lastMessageId > 0) { _%>\n  开场\n<%_ } else { _%>\n  之后\n<%_ } _%>'
      // Each `_%>` truncates a single following newline; the two leading spaces before 开场 survive
      // (they follow a newline, not the tag). The `else` branch never leaks.
      expect(evalTemplate(tmpl, gen())).toBe('  开场\n')
    })
  })

  describe('<%% / %%> literal delimiters', () => {
    it('<%% renders a literal <% and %%> a literal %>', () => {
      expect(evalTemplate('写作 <%% 标签 %%> 不求值', gen())).toBe('写作 <% 标签 %> 不求值')
    })
  })
})
