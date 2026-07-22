import type { JsonValue } from '../../../../shared/agentRuntime'
import type { SceneVocabulary } from '../../../../shared/yuzu/sceneSchema'
import { parseScene } from '../../../../shared/yuzu/sceneValidate'
import { parseAnnotatedFloor } from '../../../../shared/yuzu/annotatedFloor'
import { closeTruncatedJson } from './repair'
import { compileJsonSchema } from './schemaValidation'
import type { HarnessExecuteRequest, HarnessFailure } from './types'

const EMPTY_YSS_VOCABULARY: SceneVocabulary = {
  actors: new Set(),
  expressions: new Set(),
  locations: new Set(),
  cgs: new Set(),
  audio: new Set()
}

export const validateHarnessResult = (
  request: HarnessExecuteRequest,
  text: string,
  toolCount: number,
  allowTruncatedJsonRepair = true
):
  | { ok: true; value: JsonValue | undefined; repaired: boolean }
  | { ok: false; failure: HarnessFailure } => {
  const contract = request.definition.result
  if (contract.mode === 'tools-only') {
    return toolCount
      ? { ok: true, value: undefined, repaired: false }
      : {
          ok: false,
          failure: {
            code: 'TOOLS_ONLY_NO_EFFECT',
            message: 'tools-only result completed without executing a tool',
            retryable: true
          }
        }
  }
  if (contract.mode === 'text') {
    if (contract.validator === 'yss') {
      const parsed = parseScene(text, request.yssVocabulary ?? EMPTY_YSS_VOCABULARY)
      if (!parsed.ok) {
        return {
          ok: false,
          failure: { code: 'INVALID_YSS_RESULT', message: parsed.detail, retryable: true }
        }
      }
    }
    if (contract.validator === 'yuzu-annotated-floor' && !parseAnnotatedFloor(text)) {
      return {
        ok: false,
        failure: {
          code: 'INVALID_YUZU_ANNOTATED_FLOOR',
          message: 'Result is not a valid restricted Yuzu annotated floor',
          retryable: true
        }
      }
    }
    return { ok: true, value: text, repaired: false }
  }
  const parsedJson = allowTruncatedJsonRepair
    ? closeTruncatedJson(text)
    : (() => {
        try {
          return { ok: true as const, value: JSON.parse(text), repaired: false }
        } catch {
          return { ok: false as const }
        }
      })()
  if (!parsedJson.ok) {
    return {
      ok: false,
      failure: {
        code: 'INVALID_JSON_RESULT',
        message: 'Result is not valid JSON',
        retryable: true
      }
    }
  }
  const schema = compileJsonSchema(contract.schema)
  if (!schema.ok) {
    return {
      ok: false,
      failure: {
        code: 'INVALID_RESULT_SCHEMA',
        message: schema.message,
        retryable: false
      }
    }
  }
  const validated = schema.validate.safeParse(parsedJson.value)
  return validated.success
    ? {
        ok: true,
        value: validated.data as JsonValue,
        repaired: parsedJson.repaired
      }
    : {
        ok: false,
        failure: {
          code: 'INVALID_JSON_RESULT',
          message: validated.error.issues
            .map((issue) => `${issue.path.join('.') || 'result'}: ${issue.message}`)
            .join('; '),
          retryable: true
        }
      }
}
