// src/shared/thRuntime/tavernRegex.ts
//
// Pure bidirectional mapping between our regex-store rule shape and the TavernHelper `TavernRegex`
// shape that cards read via `getTavernRegexes` and write via `updateTavernRegexesWith` /
// `replaceTavernRegexes`. Realm-agnostic (no node/electron/DOM) so it lives in shared/thRuntime and is
// unit-testable. The WCV/inline hosts back the store side with `regexService`; this module only converts.
import type { RenderRegexRule } from '../regexTypes'
import { appliesToDisplay, appliesToPrompt } from '../regexTypes'

/** The TavernHelper regex shape (subset we map). See JSR `@types/function/tavern_regex.d.ts`. */
export type TavernRegex = {
  id: string
  script_name: string
  enabled: boolean
  find_regex: string
  replace_string: string
  trim_strings: string[]
  source: { user_input: boolean; ai_output: boolean; slash_command: boolean; world_info: boolean }
  destination: { display: boolean; prompt: boolean }
  run_on_edit: boolean
  min_depth: number | null
  max_depth: number | null
}

/** SillyTavern stores the pattern as `/source/flags`; build it (mirrors `regexService.parseFind`). */
export const buildFindRegex = (source: string, flags: string): string =>
  `/${source ?? ''}/${flags ?? ''}`

/** Split `/source/flags` back to its parts (mirrors `regexService.parseFind`; default flag `g`). */
export const parseFindRegex = (raw: string): { source: string; flags: string } => {
  if (typeof raw === 'string' && raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
    const last = raw.lastIndexOf('/')
    return { source: raw.slice(1, last), flags: raw.slice(last + 1) || 'g' }
  }
  return { source: raw || '', flags: 'g' }
}

/**
 * A normalized store rule → `TavernRegex` (for `getTavernRegexes`). Our `placement` (1 = user input,
 * 2 = AI output; empty = everywhere) maps to `source`; `markdownOnly`/`promptOnly` map to `destination`.
 * Fields we don't model (slash_command/world_info, run_on_edit, depths) take faithful defaults.
 */
export const storeRuleToTavernRegex = (r: RenderRegexRule): TavernRegex => {
  const everywhere = !r.placement || r.placement.length === 0
  return {
    id: r.id,
    script_name: r.scriptName,
    enabled: !r.disabled,
    find_regex: buildFindRegex(r.source, r.flags),
    replace_string: r.replace ?? '',
    trim_strings: Array.isArray(r.trimStrings) ? r.trimStrings : [],
    source: {
      user_input: everywhere || r.placement.includes(1),
      ai_output: everywhere || r.placement.includes(2),
      slash_command: false,
      world_info: false
    },
    destination: { display: appliesToDisplay(r), prompt: appliesToPrompt(r) },
    run_on_edit: false,
    min_depth: null,
    max_depth: null
  }
}

/**
 * A `TavernRegex` (from a card's `updateTavernRegexesWith`/`replaceTavernRegexes`) → the raw ST-format
 * regex object that `regexService` persists (and `normalizeRule` reads back): `findRegex` / `replaceString`
 * / `scriptName` / `placement` / `disabled` / `markdownOnly` / `promptOnly` / `trimStrings`. Loose input
 * (cards send `any`); unknown fields are ignored, missing ones defaulted.
 */
export const tavernRegexToStoreObject = (tr: any): Record<string, any> => {
  const src = (tr && typeof tr === 'object' ? tr : {}) as Partial<TavernRegex>
  const s = src.source || ({} as TavernRegex['source'])
  const d = src.destination || ({} as TavernRegex['destination'])
  const placement: number[] = []
  if (s.user_input) placement.push(1)
  if (s.ai_output) placement.push(2)
  const find =
    typeof src.find_regex === 'string' && src.find_regex
      ? src.find_regex
      : buildFindRegex((src as any).source_regex ?? '', 'g')
  return {
    id: src.id || undefined,
    scriptName: src.script_name || 'Imported regex',
    findRegex: find,
    replaceString: src.replace_string ?? '',
    trimStrings: Array.isArray(src.trim_strings) ? src.trim_strings : [],
    disabled: src.enabled === false,
    placement: placement.length ? placement : [1, 2],
    // display-only ⇒ markdownOnly; prompt-only ⇒ promptOnly; both/neither ⇒ applies to both.
    markdownOnly: d.display === true && d.prompt === false,
    promptOnly: d.prompt === true && d.display === false
  }
}
