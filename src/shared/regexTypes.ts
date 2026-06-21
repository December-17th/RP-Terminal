/**
 * Regex types shared by the main regex service and the renderer regex store/panel, so the
 * two processes can't drift. The replacement transform itself lives in `regexTransform.ts`.
 */
import type { RegexLikeRule } from './regexTransform'
import type { ArtifactScope } from './artifactScope'

/** A regex rule flattened to the form the renderer can compile + apply. */
export interface RenderRegexRule extends RegexLikeRule {
  id: string
  scriptName: string
  disabled: boolean
  markdownOnly: boolean
  promptOnly: boolean
}

/** A regex "script" file (one or more rules), with its scope metadata. */
export interface RegexScriptInfo {
  file: string
  scriptName: string
  ruleCount: number
  scope: ArtifactScope
  owner?: string
  disabled: boolean
}

/** A single rule tagged with its file + index, for editing. */
export interface RegexRuleDetail extends RenderRegexRule {
  file: string
  index: number
}

export interface RegexRulePatch {
  source?: string
  flags?: string
  replace?: string
  disabled?: boolean
  markdownOnly?: boolean
  promptOnly?: boolean
  trimStrings?: string[]
}
