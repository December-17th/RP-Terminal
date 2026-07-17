import { describe, it, expect, vi } from 'vitest'
import { providerShape } from '../../src/main/services/generation/providerShape'
import { createRecordBuilder } from '../../src/main/services/generation/executionRecord'
import {
  ChatMessage,
  squashSystemMessages,
  SquashMessage
} from '../../src/main/services/promptBuilder'
import { Settings } from '../../src/main/types/models'

// providerShape logs each journaled stage via logService; silence it so the suite stays quiet and the
// no-journal path (which must never log) is provably untouched.
vi.mock('../../src/main/services/logService', () => ({ log: () => {} }))

/** Minimal Settings fixture — providerShape only reads api.provider + generation.*. */
const makeSettings = (overrides: {
  provider: string
  system_as_user?: boolean
  merge_consecutive_roles?: boolean
}): Settings =>
  ({
    api: { provider: overrides.provider, endpoint: '', api_key: '', model: '' },
    generation: {
      system_as_user: overrides.system_as_user,
      merge_consecutive_roles: overrides.merge_consecutive_roles
    }
  }) as unknown as Settings

describe('providerShape', () => {
  it('applies system→user only when system_as_user is true AND provider is OpenAI-compatible', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' }
    ]

    const openaiShaped = providerShape(
      makeSettings({ provider: 'openai', system_as_user: true }),
      msgs
    )
    expect(openaiShaped.some((m) => m.role === 'system')).toBe(false)
    // system→user relabels 'sys' to a user turn, then merge_consecutive_roles (default on)
    // coalesces it with the adjacent 'hi' user turn into one message.
    expect(openaiShaped).toEqual([{ role: 'user', content: 'sys\nhi' }])

    const anthropicShaped = providerShape(
      makeSettings({ provider: 'anthropic', system_as_user: true }),
      msgs
    )
    expect(anthropicShaped.some((m) => m.role === 'system')).toBe(true)
  })

  it('does not apply system→user when system_as_user is false, even on an OpenAI-compatible provider', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
    const shaped = providerShape(makeSettings({ provider: 'openai', system_as_user: false }), msgs)
    expect(shaped).toEqual(msgs)
  })

  it('merges consecutive same-role messages by default', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' }
    ]
    const shaped = providerShape(makeSettings({ provider: 'anthropic' }), msgs)
    expect(shaped).toEqual([{ role: 'user', content: 'a\nb' }])
  })

  it('does not merge consecutive same-role messages when merge_consecutive_roles is false', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' }
    ]
    const shaped = providerShape(
      makeSettings({ provider: 'anthropic', merge_consecutive_roles: false }),
      msgs
    )
    expect(shaped).toEqual(msgs)
  })

  it('applies provider ordering: OpenAI-compatible provider keeps a trailing assistant prefill last', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'prefill' }
    ]
    const shaped = providerShape(makeSettings({ provider: 'openai' }), msgs)
    expect(shaped).toEqual(msgs) // orderForProvider: trailing assistant is kept last, unchanged
  })

  it('applies provider ordering: OpenAI-compatible provider moves a non-trailing last-user message to the end', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'trailing-non-user' }
    ]
    const shaped = providerShape(makeSettings({ provider: 'openai' }), msgs)
    // orderForProvider moves the last 'user' message (index 0) to the end when the array doesn't
    // already end on a user turn and doesn't end on an assistant prefill.
    expect(shaped).toEqual([
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'trailing-non-user' },
      { role: 'user', content: 'u1' }
    ])
  })

  it('anthropic/google providers are left in original order (orderForProvider is a no-op)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' }
    ]
    const shaped = providerShape(makeSettings({ provider: 'anthropic' }), msgs)
    expect(shaped).toEqual(msgs)
  })
})

/**
 * Issue 10 (WP-1.4): providerShape is now the SINGLE shaping seam — `assemblePrompt` routes through it and
 * passes a record builder so each stage that fires is journaled. These tests pin that relocated journaling
 * (the arrayStage entries that used to live inline in assemble.ts) AND prove it stays behavior-neutral: the
 * wire output is byte-identical with or without a journal, and each stage is recorded only when it actually
 * reshaped the array.
 */
describe('providerShape — journaling (the relocated arrayStage entries)', () => {
  const stagesOf = (msgs: ChatMessage[], settings: Settings): string[] => {
    const b = createRecordBuilder()
    const wire = providerShape(settings, msgs, b)
    return b
      .finish(wire, 0)
      .entries.filter((e) =>
        ['system-as-user', 'role-merge', 'provider-shape'].includes(e.stage)
      )
      .map((e) => e.stage)
  }

  it('records system-as-user then role-merge when system→user converts + coalesces', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' }
    ]
    // system→user relabels the system turn, then the two user turns coalesce → one message that already
    // ends on user, so provider ordering is a no-op (no provider-shape entry).
    expect(stagesOf(msgs, makeSettings({ provider: 'openai', system_as_user: true }))).toEqual([
      'system-as-user',
      'role-merge'
    ])
  })

  it('records only role-merge when consecutive same-role turns coalesce (no relabel, no reorder)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' }
    ]
    expect(stagesOf(msgs, makeSettings({ provider: 'anthropic' }))).toEqual(['role-merge'])
  })

  it('records only provider-shape when ordering moves the last user message to the end', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'trailing-non-user' }
    ]
    // system_as_user off + no consecutive same-role, so only provider ordering fires.
    const stages = stagesOf(msgs, makeSettings({ provider: 'openai' }))
    expect(stages).toEqual(['provider-shape'])
  })

  it('records nothing when no stage reshapes the array', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' }
    ]
    // anthropic: system→user skipped, no consecutive same-role, ordering a no-op → zero shaping entries.
    expect(stagesOf(msgs, makeSettings({ provider: 'anthropic' }))).toEqual([])
  })

  it('is behavior-neutral: the wire is byte-identical with vs without a journal', () => {
    const cases: Array<[ChatMessage[], Settings]> = [
      [
        [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' }
        ],
        makeSettings({ provider: 'openai', system_as_user: true })
      ],
      [
        [
          { role: 'user', content: 'u1' },
          { role: 'assistant', content: 'a1' },
          { role: 'system', content: 't' }
        ],
        makeSettings({ provider: 'openai' })
      ],
      [
        [
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' }
        ],
        makeSettings({ provider: 'anthropic' })
      ]
    ]
    for (const [msgs, settings] of cases) {
      const withoutJournal = providerShape(settings, msgs)
      const withJournal = providerShape(settings, msgs, createRecordBuilder())
      expect(JSON.stringify(withJournal)).toBe(JSON.stringify(withoutJournal))
    }
  })
})

/**
 * Issue 15 (WP-2.5): ST 1.18.0 `squashSystemMessages` (openai.js:3827-3866), verified against the pinned
 * checkout. These pin the pure function's ST parity — synthesized-from-source, RPT-authored prose.
 */
describe('squashSystemMessages — ST openai.js:3827 parity', () => {
  it('merges CONSECUTIVE UNNAMED system messages with a single newline', () => {
    const msgs: SquashMessage[] = [
      { role: 'system', content: 'alpha' },
      { role: 'system', content: 'beta' },
      { role: 'system', content: 'gamma' }
    ]
    expect(squashSystemMessages(msgs)).toEqual([{ role: 'system', content: 'alpha\nbeta\ngamma' }])
  })

  it('leaves user/assistant turns untouched (system-only, unlike merge-all)', () => {
    const msgs: SquashMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a1' },
      { role: 'assistant', content: 'a2' }
    ]
    expect(squashSystemMessages(msgs)).toEqual(msgs.map((m) => ({ role: m.role, content: m.content })))
  })

  it('a non-system message between systems breaks the run', () => {
    const msgs: SquashMessage[] = [
      { role: 'system', content: 'one' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'two' },
      { role: 'system', content: 'three' }
    ]
    expect(squashSystemMessages(msgs)).toEqual([
      { role: 'system', content: 'one' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'two\nthree' }
    ])
  })

  it('drops empty system messages (openai.js:3835-3837) — and a dropped empty does not break a run', () => {
    const msgs: SquashMessage[] = [
      { role: 'system', content: 'keep-a' },
      { role: 'system', content: '' }, // empty → dropped, run continues across it
      { role: 'system', content: 'keep-b' }
    ]
    expect(squashSystemMessages(msgs)).toEqual([{ role: 'system', content: 'keep-a\nkeep-b' }])
  })

  it('a NAMED system message is never squashed and breaks the run (openai.js:3841 `!message.name`)', () => {
    const msgs: SquashMessage[] = [
      { role: 'system', content: 'lead' },
      { role: 'system', content: 'named-body', name: 'Testchar' },
      { role: 'system', content: 'tail' }
    ]
    // The named message stays discrete; the systems on either side do NOT merge across it.
    expect(squashSystemMessages(msgs)).toEqual([
      { role: 'system', content: 'lead' },
      { role: 'system', content: 'named-body' },
      { role: 'system', content: 'tail' }
    ])
  })

  it('protected control identifiers survive (openai.js:3828 excludeList) and break the run', () => {
    for (const id of ['newMainChat', 'newChat', 'groupNudge']) {
      const msgs: SquashMessage[] = [
        { role: 'system', content: 'before' },
        { role: 'system', content: 'control', identifier: id },
        { role: 'system', content: 'after' }
      ]
      expect(squashSystemMessages(msgs)).toEqual([
        { role: 'system', content: 'before' },
        { role: 'system', content: 'control' },
        { role: 'system', content: 'after' }
      ])
    }
  })

  it('a non-protected identifier is still squashed (only the exact exclude list is protected)', () => {
    const msgs: SquashMessage[] = [
      { role: 'system', content: 'x', identifier: 'main' },
      { role: 'system', content: 'y', identifier: 'jailbreak' }
    ]
    expect(squashSystemMessages(msgs)).toEqual([{ role: 'system', content: 'x\ny' }])
  })

  it('does not mutate its input', () => {
    const msgs: SquashMessage[] = [
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' }
    ]
    squashSystemMessages(msgs)
    expect(msgs).toEqual([
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' }
    ])
  })
})

/**
 * Issue 15 (WP-2.5): providerShape's stage (A) selector. `squashSystemMessages: true` (an imported ST
 * preset) runs ST selective squash; absent/false (native + workflow-node callers) keeps merge-all —
 * the byte-for-byte non-regression guard for native presets.
 */
describe('providerShape — ST squash opt-in (stage A selector)', () => {
  const sysUserPair: ChatMessage[] = [
    { role: 'system', content: 'sA' },
    { role: 'system', content: 'sB' },
    { role: 'user', content: 'uA' },
    { role: 'user', content: 'uB' }
  ]

  it('squash ON uses ST semantics: merges system, LEAVES user turns discrete (not merge-all)', () => {
    const shaped = providerShape(makeSettings({ provider: 'anthropic' }), sysUserPair, undefined, {
      squashSystemMessages: true
    })
    expect(shaped).toEqual([
      { role: 'system', content: 'sA\nsB' },
      { role: 'user', content: 'uA' },
      { role: 'user', content: 'uB' }
    ])
  })

  it('squash OFF (absent opts) keeps merge-all: BOTH system and user coalesce (non-regression)', () => {
    const shaped = providerShape(makeSettings({ provider: 'anthropic' }), sysUserPair)
    expect(shaped).toEqual([
      { role: 'system', content: 'sA\nsB' },
      { role: 'user', content: 'uA\nuB' }
    ])
  })

  it('squash: false is identical to absent (merge-all)', () => {
    const off = providerShape(makeSettings({ provider: 'anthropic' }), sysUserPair, undefined, {
      squashSystemMessages: false
    })
    const absent = providerShape(makeSettings({ provider: 'anthropic' }), sysUserPair)
    expect(JSON.stringify(off)).toBe(JSON.stringify(absent))
  })

  it('squash runs independent of merge_consecutive_roles=false (ST has no such setting)', () => {
    const shaped = providerShape(
      makeSettings({ provider: 'anthropic', merge_consecutive_roles: false }),
      sysUserPair,
      undefined,
      { squashSystemMessages: true }
    )
    // merge_consecutive_roles=false would suppress merge-all, but squash still merges the systems.
    expect(shaped).toEqual([
      { role: 'system', content: 'sA\nsB' },
      { role: 'user', content: 'uA' },
      { role: 'user', content: 'uB' }
    ])
  })

  it('journals a `squash` stage (not `role-merge`) when squash reshapes the array', () => {
    const b = createRecordBuilder()
    const wire = providerShape(makeSettings({ provider: 'anthropic' }), sysUserPair, b, {
      squashSystemMessages: true
    })
    const stages = b
      .finish(wire, 0)
      .entries.filter((e) => ['role-merge', 'squash', 'provider-shape'].includes(e.stage))
      .map((e) => e.stage)
    expect(stages).toEqual(['squash'])
  })

  it('is behavior-neutral: squashed wire is byte-identical with vs without a journal', () => {
    const settings = makeSettings({ provider: 'anthropic' })
    const withoutJournal = providerShape(settings, sysUserPair, undefined, { squashSystemMessages: true })
    const withJournal = providerShape(settings, sysUserPair, createRecordBuilder(), {
      squashSystemMessages: true
    })
    expect(JSON.stringify(withJournal)).toBe(JSON.stringify(withoutJournal))
  })
})
