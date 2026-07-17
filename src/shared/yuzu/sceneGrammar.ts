import { NARRATION_SPEAKER, type SceneVocabulary } from './sceneSchema'

/**
 * Project Yuzu — the ONE shared definition of the Yuzu Scene Script (YSS v0) grammar as prompt text
 * (ADR 0007). Both the WP-B repair-prompt builder (`sceneValidate.ts`) and the WP-C generation prompt
 * consume these, so the parser and the prompt that teaches the model stay in lock-step. Keeping the
 * grammar in one place is the ADR's explicit requirement ("one shared grammar definition feeds both").
 */

/** The YSS wire-format version tag. Additive changes (new verbs) bump this. */
export const YSS_VERSION = 'yss-v0'

/**
 * The static grammar block: the three line kinds and every v0 command verb. It is asset-agnostic — the
 * concrete legal ids come from {@link renderVocabularyBlock}. Shared verbatim by the repair builder and
 * WP-C's generation prompt so the model is taught exactly what the parser accepts.
 */
export const YSS_GRAMMAR_PROMPT = [
  'Emit the scene as a Yuzu Scene Script (YSS): a sequence of LINES, one instruction per line.',
  'Every non-blank line is EXACTLY one of these three kinds:',
  '',
  '1. COMMAND — a line wrapped in <| … |>. The first word inside is the verb:',
  '   <| bg <location> |>            set the background; the FIRST bg fixes the scene location',
  '   <| mood <word...> |>           set the scene mood (last one wins; free text)',
  '   <| <actor> [tokens...] |>      show/animate an actor sprite. Extra tokens, in ANY order, are an',
  '                                  expression, a position (left|center|right), and/or an action',
  '                                  (enter|exit|move). e.g. <| kaede worried center enter |>',
  '   <| music <id> |>               play music (or <| music stop |>)',
  '   <| ambience <id> |>            play an ambience loop',
  '   <| sfx <id> |>                 play a one-shot sound',
  '   <| cg <id> |>                  show a CG (or <| cg clear |> to hide it)',
  '   <| effect <mvu-command> |>     change a story variable on the current beat. The payload is ONE MVU',
  '                                  command in the classic call dialect — _.set / _.add / _.delta / … —',
  "                                  e.g. <| effect _.set('好感度.kaede', 4, 5) //她笑了 |>  or",
  "                                  <| effect _.add('好感度.kaede', 1) //她笑了 |>. A trailing //reason is",
  '                                  part of the command. Put the effect on the beat where the change',
  '                                  narratively happens.',
  '   <| choice <text> :: <intent> |>  offer a player choice; " :: " separates the shown text from its',
  '                                  intent tag (omit " :: <intent>" to reuse the text as intent)',
  '   <| end |>                      REQUIRED: the final line of every scene, marking it complete',
  '',
  `2. DIALOGUE — "speaker: text", where speaker is an actor id or "${NARRATION_SPEAKER}".`,
  '   e.g.  yuzu: Kaede, wait — can we talk?',
  '',
  '3. NARRATION — ANY other non-empty line is narration (spoken by nobody). Plain prose is fine.',
  '',
  'End the scene with one or more <| choice … |> lines to offer choices, OR with no choice lines at all',
  '— in which case the player types their own next action. Always finish with a <| end |> line.'
].join('\n')

/**
 * Render the legal asset ids (per category) from a {@link SceneVocabulary}, as a prompt block. Shared by
 * the repair builder and WP-C so the model is only ever shown valid ids. There is no effect allow-list:
 * effects are raw MVU commands (ADR 0008 §4–5), taught by the grammar block above.
 */
export const renderVocabularyBlock = (vocab: SceneVocabulary): string => {
  const line = (label: string, ids: ReadonlySet<string>): string =>
    `- ${label}: ${[...ids].join(', ')}`
  return [
    'Use ONLY these asset ids, each in its correct category:',
    line('actors (dialogue speaker / sprite / who is present)', vocab.actors),
    line('expressions (sprite token)', vocab.expressions),
    line('locations (bg)', vocab.locations),
    line('cgs (cg)', vocab.cgs),
    line('audio (music / ambience / sfx)', vocab.audio),
    `- "${NARRATION_SPEAKER}" is also a legal dialogue speaker.`,
    'Choices carry TEXT + INTENT only — never mechanics (affinity, flags, items). Mechanics go in an <| effect … |> MVU command.'
  ].join('\n')
}
