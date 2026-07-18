import { buildVocabulary, type P0Context } from './fixtureContext'
import { buildSceneUserContent, buildVocabularyBlock, type ChatMessage } from './promptShared'

export type { ChatMessage } from './promptShared'

/**
 * Provider-neutral chat message. Structurally identical to the app's
 * `ChatMessage` (src/main/services/promptBuilder.ts) — mirrored locally rather than imported so this
 * pure `src/shared/**` library never reaches into `src/main` (the module-boundary rule). Because the
 * shape matches exactly, the harness can hand these straight to the real `streamProvider`.
 */
const schemaBlock = (): string =>
  [
    'Reply with a SINGLE JSON object matching this exact schema (TypeScript for reference):',
    '',
    'Scene {',
    '  scene_id: string',
    '  header: { location: string; present: string[]; mood?: string }',
    '  beats: Beat[]   // at least one',
    '  next: Interaction',
    '}',
    'Beat {',
    '  bg?: string                 // a location id, used as the background',
    '  sprites?: { actor: string; expression?: string; position?: "left"|"center"|"right"; action?: "enter"|"exit"|"move" }[]',
    '  cg?: string | null          // a CG id, or null',
    '  audio?: { music?: string; ambience?: string; sfx?: string }',
    '  speaker?: string            // an actor id, or "narration"',
    '  line?: string',
    '  effects?: { type: string; args?: object }[]',
    '}',
    'Interaction {',
    '  choices?: { text: string; intent: string }[]  // player choices; an empty list or omitted ⇒ the player types their own next action',
    '}'
  ].join('\n')

const vocabBlock = (ctx: P0Context): string => {
  return buildVocabularyBlock(ctx, {
    actors: 'actors (speaker / sprite.actor / header.present)',
    expressions: 'expressions (sprite.expression)',
    locations: 'locations (header.location / bg)',
    cgs: 'cgs (cg)',
    audio: 'audio (audio.music / ambience / sfx)',
    narration: 'is also a legal speaker.'
  })
}

const rulesBlock = (ctx: P0Context): string => {
  const vocab = buildVocabulary(ctx)
  return [
    `Effects: a beat may only use these effect types: ${[...vocab.effects].join(', ')}. No others.`,
    'End the scene with a list of choices, or with none (empty or omitted `next.choices`) — in which case the player types their own next action.',
    'Choices: each choice is { text, intent } ONLY. Never attach mechanics (affinity, flags, items) to a choice — mechanics belong in a beat effect.',
    'Output: reply with ONE JSON object and nothing else. No prose, no explanation, no markdown code fence, no <think> block. The very first character must be "{" and the last "}".'
  ].join('\n')
}

/**
 * Render the schema-in-prompt messages: a system message describing the exact JSON schema + the asset
 * vocabulary (by category) + the effect allow-list + the choice model + a strict "one JSON object"
 * instruction; a user message with the premise + seed action. `lastError`, when given, appends a short
 * reminder of what went wrong last time (the repair path in repair.ts builds a richer corrective).
 */
export const buildSceneMessages = (ctx: P0Context, lastError?: string): ChatMessage[] => {
  const system = [
    'You are the scene director for a visual-novel engine. You emit ONE scene at a time as structured JSON.',
    '',
    schemaBlock(),
    '',
    vocabBlock(ctx),
    '',
    rulesBlock(ctx)
  ].join('\n')

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: buildSceneUserContent(ctx, lastError, 'Fix it and reply with ONE JSON object.')
    }
  ]
}
