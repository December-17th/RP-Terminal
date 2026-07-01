import { describe, it, expect } from 'vitest'
import { foldNarrationMvu } from '../../src/main/services/narrationService'

describe('foldNarrationMvu', () => {
  it('applies a <JSONPatch> insert into stat_data', () => {
    const vars: Record<string, any> = {}
    foldNarrationMvu(
      vars,
      '战后。<UpdateVariable><JSONPatch>[{"op":"insert","path":"/主角/技能/剑气斩","value":{"类型":"主动"}}]</JSONPatch></UpdateVariable>'
    )
    expect(vars.stat_data.主角.技能.剑气斩).toEqual({ 类型: '主动' })
  })
  it('is a no-op when there is no UpdateVariable block', () => {
    const vars: Record<string, any> = { stat_data: { 主角: {} } }
    foldNarrationMvu(vars, 'just prose, no ops')
    expect(vars.stat_data).toEqual({ 主角: {} })
  })
})
