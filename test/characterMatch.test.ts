import { describe, it, expect } from 'vitest'
import { cardIdentity, identityMatches } from '../src/main/services/characterService'

// Pure identity helpers for Feature 1 dedupe/update matching (plan review C7). findMatchingCharacter
// itself hits getDb() (stubbed to empty under the sqlite mock), so only the pure predicates are tested.

const card = (name?: string, creator?: string, version?: string): any => ({
  data: { name, creator, character_version: version }
})

describe('cardIdentity', () => {
  it('normalizes name+creator (trim + lowercase) and EXCLUDES version', () => {
    expect(cardIdentity(card('  Aria  ', 'CreatorX', '2.0'))).toEqual({
      name: 'aria',
      creator: 'creatorx'
    })
  })

  it('treats missing name/creator as empty strings', () => {
    expect(cardIdentity(card('Aria', undefined))).toEqual({ name: 'aria', creator: '' })
    expect(cardIdentity(card(undefined, undefined))).toEqual({ name: '', creator: '' })
  })
})

describe('identityMatches', () => {
  it('matches equal name+creator regardless of version/case/whitespace', () => {
    expect(
      identityMatches(
        cardIdentity(card('Aria', 'X', '1.0')),
        cardIdentity(card('aria', ' X ', '9.9'))
      )
    ).toBe(true)
  })

  it('empty creator matches empty creator (name-only match — C7)', () => {
    expect(
      identityMatches(cardIdentity(card('Aria', '')), cardIdentity(card('aria', undefined)))
    ).toBe(true)
  })

  it('different creator does NOT match (guards a name collision)', () => {
    expect(identityMatches(cardIdentity(card('Aria', 'X')), cardIdentity(card('Aria', 'Y')))).toBe(
      false
    )
  })

  it('different name does NOT match', () => {
    expect(identityMatches(cardIdentity(card('Aria', 'X')), cardIdentity(card('Bern', 'X')))).toBe(
      false
    )
  })
})
