import fs from 'fs'

export interface StRegexRule {
  id: string
  regex: RegExp
  replaceString: string
  placement: string[]
  disabled: boolean
  markdownOnly: boolean
  promptOnly: boolean
  runOnEdit: boolean
}

export const loadRegexRules = (filePath: string): StRegexRule[] => {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const rulesArray = Array.isArray(data) ? data : Object.values(data)

    return rulesArray
      .map((rule: any) => {
        const regexPattern = rule.regex || rule.findRegex || ''
        const flags = rule.flags || 'g'

        try {
          return {
            id: rule.id || rule.name,
            regex: new RegExp(regexPattern, flags),
            replaceString: rule.replaceString !== undefined ? rule.replaceString : '',
            placement: rule.placement
              ? Array.isArray(rule.placement)
                ? rule.placement
                : [rule.placement]
              : ['text'],
            disabled: rule.disabled === true,
            markdownOnly: rule.markdownOnly === true,
            promptOnly: rule.promptOnly === true,
            runOnEdit: rule.runOnEdit === true
          }
        } catch (e) {
          console.warn(`Failed to compile regex rule ${rule.name}:`, e)
          return null
        }
      })
      .filter((r) => r !== null) as StRegexRule[]
  } catch (error) {
    console.error('Failed to load ST Regex rules:', error)
    return []
  }
}

export const applyRegexRules = (
  text: string,
  rules: StRegexRule[],
  targetPlacement: string = 'text'
): string => {
  let result = text

  for (const rule of rules) {
    if (rule.disabled) continue
    if (!rule.placement.includes(targetPlacement)) continue

    // Convert ST specific replacement syntax like {{\n}} to real newlines if needed
    const replaceStr = rule.replaceString.replace(/\\n/g, '\n')

    result = result.replace(rule.regex, replaceStr)
  }

  return result
}
