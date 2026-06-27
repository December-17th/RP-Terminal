import { describe, it, expect, beforeAll } from 'vitest'
import { initTemplates, evalTemplate, TemplateContext } from '../src/main/services/templateService'

// WS-4 — direct coverage for the clean-room lodash (`_`) + faker subset injected into the EJS sandbox
// (templateEngine boot). The subset was previously exercised only incidentally; these tests pin the
// methods a card's status panel actually uses, so a drift from the documented lodash contract fails loudly.
// (Exercised through the engine because the subset only exists inside the quickjs VM.)

const ctx = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  vars: {},
  globals: {},
  constants: {},
  ...over
})

const out = (tmpl: string): string => evalTemplate(tmpl, ctx())

describe('sandbox lodash/faker subset (WS-4)', () => {
  beforeAll(async () => {
    await initTemplates()
  })

  it('_.get / _.set (dot-path)', () => {
    expect(out("<%= _.get({a:{b:7}}, 'a.b') %>")).toBe('7')
    expect(out("<%= _.get({a:{b:7}}, 'a.x', 'def') %>")).toBe('def')
    expect(out("<% var o={}; _.set(o,'a.b',5) %><%= o.a.b %>")).toBe('5')
  })

  it('_.cloneDeep is a deep copy', () => {
    expect(out('<% var a={x:{y:1}}; var b=_.cloneDeep(a); b.x.y=9 %><%= a.x.y %>')).toBe('1')
  })

  it('collection helpers: map / filter / find / sumBy', () => {
    expect(out('<%= _.map([1,2,3], function(n){return n*2}).join(",") %>')).toBe('2,4,6')
    expect(out('<%= _.filter([1,2,3,4], function(n){return n%2===0}).join(",") %>')).toBe('2,4')
    expect(out('<%= _.find([{id:1},{id:2}], function(x){return x.id===2}).id %>')).toBe('2')
    expect(out('<%= _.sumBy([{n:2},{n:3}], "n") %>')).toBe('5')
  })

  it('groupBy / keyBy / mapValues / sortBy / orderBy', () => {
    // NB: JSON.stringify orders integer-like keys ascending, regardless of insertion order.
    expect(out('<%= JSON.stringify(_.groupBy([1,2,3,4], function(n){return n%2})) %>')).toBe(
      '{"0":[2,4],"1":[1,3]}'
    )
    expect(out('<%= _.keyBy([{id:"a"},{id:"b"}], "id").b.id %>')).toBe('b')
    expect(out('<%= JSON.stringify(_.mapValues({a:1,b:2}, function(v){return v*10})) %>')).toBe(
      '{"a":10,"b":20}'
    )
    expect(out('<%= _.sortBy([3,1,2], function(n){return n}).join(",") %>')).toBe('1,2,3')
    expect(out('<%= _.orderBy([3,1,2], function(n){return n}).join(",") %>')).toBe('1,2,3')
  })

  it('uniq / uniqBy / chunk / padStart / isEqual', () => {
    expect(out('<%= _.uniq([1,1,2,3,3]).join(",") %>')).toBe('1,2,3')
    expect(out('<%= _.uniqBy([{k:1},{k:1},{k:2}], "k").length %>')).toBe('2')
    expect(out('<%= JSON.stringify(_.chunk([1,2,3,4,5], 2)) %>')).toBe('[[1,2],[3,4],[5]]')
    expect(out('<%= _.padStart("7", 3, "0") %>')).toBe('007')
    expect(out('<%= _.isEqual({a:1},{a:1}) %>')).toBe('true')
    expect(out('<%= _.isEqual({a:1},{a:2}) %>')).toBe('false')
  })

  it('faker is present and bounded', () => {
    expect(out('<%= faker.number(5,5) %>')).toBe('5')
    expect(out('<%= faker.uuid().length %>')).toBe('36')
    expect(out('<%= typeof faker.name() %>')).toBe('string')
  })

  it('console is a no-op (present, does not throw)', () => {
    expect(out('<% console.log("x"); console.warn("y") %>ok')).toBe('ok')
  })
})
