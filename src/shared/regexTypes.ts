/**
 * Regex types shared by the main regex service and the renderer regex store/panel, so the
 * two processes can't drift. The replacement transform itself lives in `regexTransform.ts`.
 */
import type { RegexLikeRule } from './regexTransform'
import type { ArtifactScope } from './artifactScope'
import type { CardRenderMode } from './cardRenderMode'

/** A regex rule flattened to the form the renderer can compile + apply. */
export interface RenderRegexRule extends RegexLikeRule {
  id: string
  scriptName: string
  disabled: boolean
  markdownOnly: boolean
  promptOnly: boolean
  renderMode?: CardRenderMode
}

/** A regex "script" file (one or more rules), with its scope metadata. */
export interface RegexScriptInfo {
  file: string
  scriptName: string
  ruleCount: number
  scope: ArtifactScope
  owner?: string
  disabled: boolean
  renderMode?: CardRenderMode
  /** Present when a rule loads a card UI page (`$('body').load('https://…')`) — i.e. the script is
   * promotable to a docked WCV panel (renderMode:'panel'). The UI's page URL. */
  uiUrl?: string
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

/**
 * ST regex exports use these booleans as destination toggles in practice:
 * display-only = markdownOnly, prompt-only = promptOnly, both false = both,
 * and some cards set both true to mean both destinations.
 */
export const appliesToDisplay = (r: Pick<RenderRegexRule, 'markdownOnly' | 'promptOnly'>): boolean =>
  !r.promptOnly || r.markdownOnly

export const appliesToPrompt = (r: Pick<RenderRegexRule, 'markdownOnly' | 'promptOnly'>): boolean =>
  !r.markdownOnly || r.promptOnly
