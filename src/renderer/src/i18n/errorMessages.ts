type Translate = (key: string, vars?: Record<string, string | number>) => string

const translatedCode = (
  t: Translate,
  prefix: string,
  code: string | undefined,
  fallbackKey: string
): string => {
  if (code) {
    const key = `${prefix}.${code}`
    const translated = t(key)
    if (translated !== key) return translated
  }
  return t(fallbackKey)
}

export const characterImportErrorMessage = (t: Translate, code: string): string =>
  translatedCode(t, 'characterImport.error', code, 'characterImport.error.UNKNOWN')

export const agentErrorMessage = (t: Translate, code?: string): string =>
  translatedCode(t, 'agents.error', code, 'agents.actionFailed')

export const agentImportErrorMessage = (t: Translate, code?: string): string => {
  if (code) {
    const importKey = `agents.importError.${code}`
    const importMessage = t(importKey)
    if (importMessage !== importKey) return importMessage
  }
  return agentErrorMessage(t, code)
}
