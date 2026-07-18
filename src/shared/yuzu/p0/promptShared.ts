import { buildVocabulary, NARRATION_SPEAKER, type P0Context } from './fixtureContext'
import type { FailureShape } from './validate'

/** Provider-neutral shape mirrored from the main-process prompt builder. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface VocabularyLabels {
  actors: string
  expressions: string
  locations: string
  cgs: string
  audio: string
  narration: string
}

export const buildVocabularyBlock = (ctx: P0Context, labels: VocabularyLabels): string => {
  const vocab = buildVocabulary(ctx)
  const line = (label: string, ids: Set<string>): string => `- ${label}: ${[...ids].join(', ')}`
  return [
    'Use ONLY these asset ids, each in its correct category:',
    line(labels.actors, vocab.actors),
    line(labels.expressions, vocab.expressions),
    line(labels.locations, vocab.locations),
    line(labels.cgs, vocab.cgs),
    line(labels.audio, vocab.audio),
    `- "${NARRATION_SPEAKER}" ${labels.narration}`
  ].join('\n')
}

export const buildSceneUserContent = (
  ctx: P0Context,
  lastError: string | undefined,
  retryInstruction: string
): string => {
  const lines = [
    `Premise:\n${ctx.premise}`,
    '',
    `Player action to dramatize as the next scene:\n${ctx.seedAction}`
  ]
  if (lastError) {
    lines.push('', `Note — your previous attempt failed: ${lastError}. ${retryInstruction}`)
  }
  return lines.join('\n')
}

export const appendRepairTurn = (
  base: ChatMessage[],
  priorRaw: string,
  failures: FailureShape[],
  detail: string,
  instruction: string
): ChatMessage[] => {
  const shapes = failures.length ? failures.join(', ') : 'unspecified'
  const corrective = [
    `Your previous reply was rejected. Problem type(s): ${shapes}.`,
    detail ? `Details: ${detail}.` : '',
    instruction
  ]
    .filter(Boolean)
    .join('\n')
  return [...base, { role: 'assistant', content: priorRaw }, { role: 'user', content: corrective }]
}
