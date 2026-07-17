// Oracle conformance fixture schema (WP-0.4 / ADR 0016).
//
// A fixture is the FROZEN golden output of SillyTavern 1.18.0's prompt assembly
// for one scenario (see tools/oracle/scenarios.md). It is either `captured` (from
// a real ST run via the capture rig) or `synthesized` (hand-built to pin a
// structure when no capture exists yet). The conformance runner loads these and,
// once RPT assembly wiring lands (issues 11-15), compares RPT's output against
// `expected.chat`.
//
// This module has NO runtime deps on src/ so it stays a stable contract.

export interface FixtureMessage {
  role: string
  content: string
}

export interface Fixture {
  schemaVersion: 1
  scenarioId: string
  source: 'captured' | 'synthesized'
  st: { version: string; commit?: string; macroEngine: 'new' | 'legacy' }
  capturedAt?: string
  generationType?: string
  /** Snapshot of the ST settings knobs that drove this assembly (prose-free). */
  settings?: Record<string, unknown>
  /** The golden assembled prompt: ST's post-extension mutable chat array. */
  expected: { chat: FixtureMessage[] }
  /**
   * Optional structural invariants the runner asserts even before RPT wiring
   * exists — lets a fixture "flow through" the runner today. All optional.
   */
  invariants?: {
    /** Exact ordered role sequence expected in expected.chat. */
    roleOrder?: string[]
    /** Substrings that MUST appear somewhere in expected.chat content. */
    mustContain?: string[]
    /** Substrings that must NOT appear anywhere in expected.chat content. */
    mustNotContain?: string[]
    /** Exact number of messages. */
    messageCount?: number
  }
}

/**
 * Distinctive short fingerprints of SillyTavern's DEFAULT utility-prompt strings
 * (public/scripts/openai.js, v1.18.0). Committed fixtures must OVERRIDE these with
 * RPT-authored prose (PLAN decision 8 / process note), so none of these may appear
 * in a fixture. Kept as minimal functional fingerprints purely as a leak detector,
 * not as reproduced content.
 */
export const ST_DEFAULT_FINGERPRINTS: readonly string[] = [
  '[Start a new Chat]',
  '[Example Chat]',
  '[Start a new group chat',
  '[Continue your last message',
  '[Write the next reply only as',
  'point of view of {{user}}, using the chat history'
]

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

export function validateFixture(obj: unknown): ValidationResult {
  const errors: string[] = []
  const f = obj as Partial<Fixture> | null

  if (!f || typeof f !== 'object') {
    return { ok: false, errors: ['fixture is not an object'] }
  }
  if (f.schemaVersion !== 1) errors.push(`schemaVersion must be 1 (got ${String(f.schemaVersion)})`)
  if (!f.scenarioId || typeof f.scenarioId !== 'string') errors.push('scenarioId missing')
  if (f.source !== 'captured' && f.source !== 'synthesized') {
    errors.push(`source must be "captured" | "synthesized" (got ${String(f.source)})`)
  }
  if (!f.st || typeof f.st !== 'object') errors.push('st block missing')
  else {
    if (f.st.version !== '1.18.0') errors.push(`st.version must be "1.18.0" (got ${String(f.st.version)})`)
    if (f.st.macroEngine !== 'new' && f.st.macroEngine !== 'legacy') {
      errors.push('st.macroEngine must be "new" | "legacy"')
    }
  }
  if (!f.expected || !Array.isArray(f.expected.chat)) {
    errors.push('expected.chat must be an array')
  } else {
    f.expected.chat.forEach((m, i) => {
      if (!m || typeof m.role !== 'string') errors.push(`expected.chat[${i}].role missing`)
      if (!m || typeof m.content !== 'string') errors.push(`expected.chat[${i}].content missing`)
    })
  }
  return { ok: errors.length === 0, errors }
}

/** Returns any ST default fingerprints that leaked into the fixture's content. */
export function findStDefaultLeaks(fixture: Fixture): string[] {
  const blob = fixture.expected.chat.map((m) => m.content).join('\n')
  return ST_DEFAULT_FINGERPRINTS.filter((fp) => blob.includes(fp))
}

/** Checks a fixture's own declared invariants against its expected.chat. */
export function checkInvariants(fixture: Fixture): string[] {
  const failures: string[] = []
  const inv = fixture.invariants
  if (!inv) return failures
  const chat = fixture.expected.chat
  if (inv.messageCount != null && chat.length !== inv.messageCount) {
    failures.push(`messageCount: expected ${inv.messageCount}, got ${chat.length}`)
  }
  if (inv.roleOrder) {
    const actual = chat.map((m) => m.role)
    if (JSON.stringify(actual) !== JSON.stringify(inv.roleOrder)) {
      failures.push(`roleOrder: expected ${JSON.stringify(inv.roleOrder)}, got ${JSON.stringify(actual)}`)
    }
  }
  const blob = chat.map((m) => m.content).join('\n')
  for (const s of inv.mustContain ?? []) {
    if (!blob.includes(s)) failures.push(`mustContain missing: ${JSON.stringify(s)}`)
  }
  for (const s of inv.mustNotContain ?? []) {
    if (blob.includes(s)) failures.push(`mustNotContain present: ${JSON.stringify(s)}`)
  }
  return failures
}
