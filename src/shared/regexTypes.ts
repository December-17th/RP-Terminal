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

/**
 * ST placement enum (regex/engine.js:281-292 `regex_placement`). A rule's `placement` list is a subset
 * of these. 0 (MD_DISPLAY) is deprecated; 4 (sendAs) is legacy/unused. Placements 1/2 are RPT's live
 * user/AI destinations; 3/5/6 were added for ST parity (slash command / world info / reasoning).
 */
export const REGEX_PLACEMENT = {
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6
} as const

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

type PhaseFlags = Pick<RenderRegexRule, 'markdownOnly' | 'promptOnly'>

/** A regex-application CALL's ST phase flags (getRegexedString params — engine.js:334). */
export interface RegexPhase {
  isMarkdown?: boolean
  isPrompt?: boolean
}

/**
 * ST's EXACT per-call phase test (getRegexedString, engine.js:348-355). A script fires on a call with
 * flags {isMarkdown, isPrompt} iff:
 *   (markdownOnly && isMarkdown) || (promptOnly && isPrompt) || (!markdownOnly && !promptOnly && !isMarkdown && !isPrompt)
 * So: markdownOnly → the DISPLAY (isMarkdown) call; promptOnly → the PROMPT (isPrompt) call; both-true →
 * both; and — the divergence this fixes — **both-false fires ONLY on a call that is NEITHER display nor
 * prompt** (in ST that's the commit/slash/reasoning-commit/edit call). This is the authoritative test;
 * the destination helpers below are derived from it.
 */
export const scriptRunsInPhase = (r: PhaseFlags, { isMarkdown, isPrompt }: RegexPhase = {}): boolean =>
  (r.markdownOnly && !!isMarkdown) ||
  (r.promptOnly && !!isPrompt) ||
  (!r.markdownOnly && !r.promptOnly && !isMarkdown && !isPrompt)

/**
 * RPT has no destructive COMMIT pass. ST runs both-false scripts once when a message is committed to
 * chat (engine.js:353 "the source (chat history) should already be changed beforehand"), then the
 * display (isMarkdown) and prompt (isPrompt) calls read the already-transformed stored message. RPT
 * instead stores raw and transforms non-destructively at display AND prompt, so for COMMITTED content
 * (chat messages placement 1/2 and reasoning placement 6) it FOLDS ST's commit call into both passes:
 *   • display  = runs on an isMarkdown call OR a neither(commit) call  ⇒ markdownOnly ∪ both-false ∪ both-true
 *   • prompt   = runs on an isPrompt   call OR a neither(commit) call  ⇒ promptOnly   ∪ both-false ∪ both-true
 * — i.e. exactly ST's observable result for a stored message (behaviorally identical to the previous
 * `!promptOnly||markdownOnly` / `!markdownOnly||promptOnly`, but now derived from the real per-call test).
 *
 * Content ST NEVER commits — World Info (placement 5) and Slash Command (placement 3) — has no commit
 * to fold. Those paths must call `scriptRunsInPhase` STRICTLY (WI = {isPrompt:true}; slash = {} neither)
 * so a both-false rule follows real ST semantics instead of the commit fold — see regexService.
 */
export const appliesToDisplay = (r: PhaseFlags): boolean =>
  scriptRunsInPhase(r, { isMarkdown: true }) || scriptRunsInPhase(r, {})

export const appliesToPrompt = (r: PhaseFlags): boolean =>
  scriptRunsInPhase(r, { isPrompt: true }) || scriptRunsInPhase(r, {})
