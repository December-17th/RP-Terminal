import { buildVocabulary, NARRATION_SPEAKER, type P0Context } from './fixtureContext'
import type { ChatMessage } from './schemaPrompt'
import type { FailureShape } from './validate'
import { appendRepairTurn, buildSceneUserContent, buildVocabularyBlock } from './promptShared'

/**
 * Project Yuzu WP-P0 — prompt for the SECOND wire format, "Yuzu Scene Script" (YSS v0). Teaches the
 * model to emit the scene as LINES (command / dialogue / narration) instead of one JSON object, so we
 * can A/B the two formats' reliability through the identical pipeline + identical validator. The user
 * message mirrors schemaPrompt.ts exactly (premise + seed action) so only the FORMAT differs.
 */

const formatBlock = (): string =>
  [
    'Emit the scene as a Yuzu Scene Script (YSS): a sequence of LINES, one instruction per line.',
    'Every line is EXACTLY one of these three kinds:',
    '',
    '1. COMMAND — a line wrapped in <| … |>. The first word inside is the verb:',
    '   <| bg <location> |>            set the background; the FIRST bg is the scene location',
    '   <| mood <word...> |>           set the scene mood (last one wins)',
    '   <| <actor> [tokens...] |>      show/animate an actor sprite. Extra tokens, in ANY order, are',
    '                                  an expression, a position (left|center|right), and/or an',
    '                                  action (enter|exit|move). e.g. <| kaede worried center enter |>',
    '   <| music <id> |>               play music (or <| music stop |>)',
    '   <| ambience <id> |>            play an ambience loop',
    '   <| sfx <id> |>                 play a one-shot sound',
    '   <| cg <id> |>                  show a CG (or <| cg clear |> to hide it)',
    '   <| effect <type> <args...> |>  attach a mechanic effect to the current beat',
    '   <| choice <text> :: <intent> |>  offer a player choice; " :: " separates the shown text from',
    '                                  its intent tag (omit " :: <intent>" to reuse the text as intent)',
    '   <| end |>                      REQUIRED: the final line of every scene, marking that it is complete',
    '',
    `2. DIALOGUE — "speaker: text", where speaker is an actor id or "${NARRATION_SPEAKER}".`,
    '   e.g.  yuzu: Kaede, wait — can we talk?',
    '',
    '3. NARRATION — ANY other non-empty line is narration (spoken by nobody). Plain prose is fine.',
    '',
    'End the scene with one or more <| choice … |> lines to offer choices, OR with no choice lines at',
    'all — in which case the player types their own next action. Always finish with a <| end |> line.'
  ].join('\n')

const vocabBlock = (ctx: P0Context): string => {
  const vocab = buildVocabulary(ctx)
  return [
    buildVocabularyBlock(ctx, {
      actors: 'actors (dialogue speaker / sprite / who is present)',
      expressions: 'expressions (sprite token)',
      locations: 'locations (bg)',
      cgs: 'cgs (cg)',
      audio: 'audio (music / ambience / sfx)',
      narration: 'is also a legal dialogue speaker.'
    }),
    `Effects: <| effect … |> may only use these effect types: ${[...vocab.effects].join(', ')}. No others.`,
    'Choices carry TEXT + INTENT only — never mechanics (affinity, flags, items). Mechanics go in an effect.',
    'Output: reply with the YSS lines and NOTHING else. No JSON, no markdown fence, no <think> block. One scene, then stop.'
  ].join('\n')
}

/**
 * Render the YSS messages: a system message teaching the line format + the asset vocabulary + the
 * effect allow-list + a strict "lines only" instruction; a user message with the premise + seed action
 * (identical to schemaPrompt.ts). `lastError` appends a short reminder, mirroring schemaPrompt.
 */
export const buildSceneMessagesInline = (ctx: P0Context, lastError?: string): ChatMessage[] => {
  const system = [
    'You are the scene director for a visual-novel engine. You emit ONE scene at a time as a line script.',
    '',
    formatBlock(),
    '',
    vocabBlock(ctx)
  ].join('\n')

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: buildSceneUserContent(ctx, lastError, 'Fix it and reply with YSS lines only.')
    }
  ]
}

/**
 * The single bounded corrective re-ask for the YSS path — mirrors repair.ts: re-send the instruction,
 * echo the failed reply as the assistant turn, then a terse user turn quoting what was wrong.
 */
export const buildRepairMessagesInline = (
  ctx: P0Context,
  priorRaw: string,
  failures: FailureShape[],
  detail: string
): ChatMessage[] => {
  return appendRepairTurn(
    buildSceneMessagesInline(ctx),
    priorRaw,
    failures,
    detail,
    'Reply again as YSS lines only — no JSON, no markdown fence, no <think> — fixing the above and using only the allowed asset ids. Remember to emit a <| bg <location> |> line and to finish with <| end |>.'
  )
}
