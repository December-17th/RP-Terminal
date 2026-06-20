import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { getAppDir, ensureDir, readJsonSync, listFilesSync } from './storageService'

/** A regex rule flattened to a form the renderer can compile and apply. */
export interface RenderRegexRule {
  id: string
  scriptName: string
  source: string
  flags: string
  replace: string
  placement: number[]
  disabled: boolean
  markdownOnly: boolean
  promptOnly: boolean
}

export interface RegexScriptInfo {
  file: string
  scriptName: string
  ruleCount: number
}

const regexDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'regex')

/** SillyTavern stores findRegex as `/pattern/flags`; split it (default flag g). */
const parseFind = (raw: string): { source: string; flags: string } => {
  if (typeof raw === 'string' && raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
    const last = raw.lastIndexOf('/')
    return { source: raw.slice(1, last), flags: raw.slice(last + 1) || 'g' }
  }
  return { source: raw || '', flags: 'g' }
}

const normalizeRule = (r: any): RenderRegexRule => {
  const { source, flags } = parseFind(r.findRegex ?? r.regex ?? '')
  const placement = Array.isArray(r.placement)
    ? r.placement.map((p: any) => Number(p)).filter((n: number) => !Number.isNaN(n))
    : []
  return {
    id: r.id || randomUUID(),
    scriptName: r.scriptName || r.name || 'Unnamed script',
    source,
    flags,
    replace: r.replaceString ?? '',
    placement,
    disabled: r.disabled === true,
    markdownOnly: r.markdownOnly === true,
    promptOnly: r.promptOnly === true
  }
}

const rulesInFile = (filePath: string): any[] => {
  const data = readJsonSync<any>(filePath)
  if (!data) return []
  return Array.isArray(data) ? data : [data]
}

/** All normalized rules across every regex file in the profile. */
export const getAllRules = (profileId: string): RenderRegexRule[] => {
  const dir = regexDir(profileId)
  if (!fs.existsSync(dir)) return []
  const out: RenderRegexRule[] = []
  for (const file of listFilesSync(dir)) {
    if (!file.endsWith('.json')) continue
    for (const raw of rulesInFile(path.join(dir, file))) out.push(normalizeRule(raw))
  }
  return out
}

/** Rules that transform the AI response for *display* (placement 2, not prompt-only). */
export const getRenderRules = (profileId: string): RenderRegexRule[] =>
  getAllRules(profileId).filter(
    (r) => !r.disabled && !r.promptOnly && (r.placement.length === 0 || r.placement.includes(2))
  )

export const listScripts = (profileId: string): RegexScriptInfo[] => {
  const dir = regexDir(profileId)
  if (!fs.existsSync(dir)) return []
  return listFilesSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const rules = rulesInFile(path.join(dir, file))
      return {
        file,
        scriptName: rules[0]?.scriptName || rules[0]?.name || file.replace(/\.json$/, ''),
        ruleCount: rules.length
      }
    })
}

/** Copy an imported ST regex file into the profile's regex dir. Returns its name. */
export const importRegexFromFile = (profileId: string, filePath: string): string | null => {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const rules = Array.isArray(data) ? data : [data]
    if (rules.length === 0) return null
    ensureDir(regexDir(profileId))
    const dest = path.join(regexDir(profileId), `${randomUUID()}.json`)
    fs.writeFileSync(dest, JSON.stringify(data, null, 2), 'utf-8')
    return rules[0]?.scriptName || rules[0]?.name || path.basename(filePath)
  } catch (error) {
    console.error('Failed to import regex:', error)
    return null
  }
}

export const deleteScript = (profileId: string, file: string): void => {
  // Guard against path traversal — only delete a plain filename in the regex dir.
  if (file.includes('/') || file.includes('\\') || file.includes('..')) return
  const p = path.join(regexDir(profileId), file)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}
