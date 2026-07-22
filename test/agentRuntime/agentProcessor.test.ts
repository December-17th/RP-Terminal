import { describe, expect, it } from 'vitest'

import { runPostprocessor, runPreprocessor } from '../../src/main/services/agentRuntime/processing'
import { parseAgentDefinition, type AgentDefinition } from '../../src/shared/agentRuntime'
import { validateHarnessResult } from '../../src/main/services/agentRuntime/harness/resultValidation'

const definition = (processing: AgentDefinition['processing']): AgentDefinition => {
  const parsed = parseAgentDefinition({
    format: 'rpt-agent',
    formatVersion: 2,
    name: 'Processor fixture',
    prompt: [{ role: 'system', content: 'Process.' }],
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    },
    result: { mode: 'text' },
    processing
  })
  if (!parsed.ok) throw new Error(parsed.errors.map((error) => error.message).join('; '))
  return parsed.value
}

describe('AgentProcessor', () => {
  it('runs the real Yuzu Director preprocess, model contract, and postprocess end to end', async () => {
    const parsed = parseAgentDefinition({
      format: 'rpt-agent',
      formatVersion: 2,
      name: 'Yuzu Director fixture',
      prompt: [{ role: 'system', content: 'Direct only the supplied game text.' }],
      inputSchema: {
        type: 'object',
        properties: { gameText: { type: 'string' }, assetVocabulary: { type: 'object' } },
        required: ['gameText', 'assetVocabulary'],
        additionalProperties: false
      },
      result: { mode: 'text', validator: 'yuzu-annotated-floor' },
      processing: {
        runtime: 'rpt-processor-v1',
        preprocess: {
          code: "const match=/<gametxt>([\\s\\S]*?)<\\/gametxt>/.exec(input.value.rawResponse); if(!match) throw new Error('missing'); return {gameText:match[1],assetVocabulary:input.value.assetVocabulary};"
        },
        postprocess: {
          code: "return input.rawInput.rawResponse.replace(/<gametxt>[\\s\\S]*?<\\/gametxt>/, '<gametxt>'+input.value+'</gametxt>');",
          output: { mode: 'text' }
        }
      }
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const rawResponse =
      '<aside>outside before</aside>\n<gametxt>Only this story.</gametxt>\n<UpdateVariable>keep()</UpdateVariable>'
    const rawInput = { rawResponse, assetVocabulary: { locations: ['room'], actors: {} } }

    const preprocessing = await runPreprocessor(parsed.value, rawInput)
    expect(preprocessing.value).toEqual({
      gameText: 'Only this story.',
      assetVocabulary: rawInput.assetVocabulary
    })

    const modelResult = '<| block |>\n<| bg room |>\nOnly this story.\n<| end |>'
    const validated = validateHarnessResult(
      { definition: parsed.value, input: preprocessing.value, profileId: 'p' },
      modelResult,
      0
    )
    expect(validated).toMatchObject({ ok: true, value: modelResult })
    if (!validated.ok) return

    const postprocessing = await runPostprocessor(
      parsed.value,
      validated.value,
      rawInput,
      preprocessing.value
    )
    expect(postprocessing.warning).toBeUndefined()
    expect(postprocessing.value).toBe(
      '<aside>outside before</aside>\n<gametxt>' + modelResult +
        '</gametxt>\n<UpdateVariable>keep()</UpdateVariable>'
    )
  })

  it('runs deterministic capability-free preprocessing against a fresh JSON copy', async () => {
    const agent = definition({
      runtime: 'rpt-processor-v1',
      preprocess: { code: 'log("picked"); return { text: input.value.raw + ":" + Math.random() }' }
    })
    const first = await runPreprocessor(agent, { raw: 'game' })
    const second = await runPreprocessor(agent, { raw: 'game' })

    expect(first.warning).toBeUndefined()
    expect(first.value).toEqual(second.value)
    expect(first.logs).toEqual(['picked'])
  })

  it('passes raw input through when authored preprocess output violates inputSchema', async () => {
    const agent = definition({
      runtime: 'rpt-processor-v1',
      preprocess: { code: 'return { wrong: true }' }
    })
    const result = await runPreprocessor(agent, { raw: 'unvalidated fallback' })

    expect(result.value).toEqual({ raw: 'unvalidated fallback' })
    expect(result.warning).toMatchObject({ phase: 'preprocess', code: 'OUTPUT_INVALID' })
  })

  it('validates postprocessor output and falls back to the model result', async () => {
    const agent = definition({
      runtime: 'rpt-processor-v1',
      postprocess: {
        code: 'return { wrong: input.value }',
        output: {
          mode: 'json',
          schema: { type: 'object', required: ['final'], properties: { final: { type: 'string' } } }
        }
      }
    })
    const result = await runPostprocessor(agent, 'model', { text: 'raw' }, { text: 'processed' })

    expect(result.value).toBe('model')
    expect(result.warning).toMatchObject({ phase: 'postprocess', code: 'OUTPUT_INVALID' })
  })
})
