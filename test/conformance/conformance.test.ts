// Oracle conformance runner (WP-0.4 / ADR 0016).
//
// Enumerates every scenario in tools/oracle/scenarios.json. For each:
//   - fixture ABSENT  -> it.skip (counted, never a failure) until captured.
//   - fixture PRESENT -> assert schema valid, no ST-default prose leaked, and the
//                        fixture's declared invariants hold. If the RPT assembly
//                        adapter is wired (issues 11-15), also diff RPT output
//                        against expected.chat.
//
// A summary test reports the skip count and asserts at least one fixture flowed
// through, so "one demonstrated fixture through the runner" (issue acceptance) is
// enforced, not merely hoped for.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateFixture,
  findStDefaultLeaks,
  checkInvariants,
  type Fixture
} from './fixtureSchema'
import { assembleForFixture } from './rptAdapter'

const here = path.dirname(fileURLToPath(import.meta.url))
const scenariosPath = path.resolve(here, '../../tools/oracle/scenarios.json')
const fixturesDir = path.join(here, 'fixtures')

interface Scenario {
  id: string
  wp: string
  generationType: string
  title: string
  inputs: string
}

const manifest = JSON.parse(fs.readFileSync(scenariosPath, 'utf8')) as {
  scenarios: Scenario[]
}
const scenarios = manifest.scenarios

function loadFixture(id: string): Fixture | null {
  const p = path.join(fixturesDir, `${id}.json`)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Fixture
}

// Tally used by the summary test.
const tally = { present: 0, absent: 0 }

describe('oracle conformance manifest', () => {
  it('manifest is non-empty and ids are unique', () => {
    expect(scenarios.length).toBeGreaterThan(0)
    const ids = scenarios.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('oracle conformance scenarios', () => {
  for (const s of scenarios) {
    const fixture = loadFixture(s.id)
    if (!fixture) {
      tally.absent++
      it.skip(`[${s.wp}] ${s.id} — fixture absent (capture pending)`, () => {})
      continue
    }
    tally.present++

    describe(`[${s.wp}] ${s.id}`, () => {
      it('fixture matches the schema', () => {
        const res = validateFixture(fixture)
        expect(res.errors).toEqual([])
        expect(res.ok).toBe(true)
      })

      it('carries no SillyTavern default prose (clean-room leak guard)', () => {
        expect(findStDefaultLeaks(fixture)).toEqual([])
      })

      it('is captured with the new macro engine', () => {
        expect(fixture.st.macroEngine).toBe('new')
      })

      it('satisfies its declared structural invariants', () => {
        expect(checkInvariants(fixture)).toEqual([])
      })

      it('matches RPT assembly when the adapter is wired', () => {
        const produced = assembleForFixture(fixture.input)
        if (produced == null) {
          // Adapter unwired (Phase-2 issues 11-15 / M5 issue 20). Structural-only for now.
          expect(fixture.expected.chat.length).toBeGreaterThan(0)
          return
        }
        if (fixture.knownDivergence) {
          // DOCUMENTED DIVERGENCE (KNOWN-DIVERGENCES): `expected.chat` pins ST's behavior, which RPT
          // deliberately diverges from. Don't hard-fail against ST's golden — the xfail exempts the
          // fixture from matching `expected` ONLY. RPT's OWN behavior must still be pinned so silent
          // drift fails: every knownDivergence fixture records `actualDivergent` (RPT's real assembly
          // output) and we assert the adapter still matches it. See KNOWN-DIVERGENCES.md.
          expect(fixture.knownDivergence.ref).toContain('KNOWN-DIVERGENCES')
          expect(fixture.knownDivergence.reason.length).toBeGreaterThan(0)
          expect(
            fixture.actualDivergent,
            'a knownDivergence fixture must pin RPT actual output in actualDivergent'
          ).toBeDefined()
          expect(produced.chat).toEqual(fixture.actualDivergent!.chat)
          return
        }
        expect(produced.chat).toEqual(fixture.expected.chat)
      })
    })
  }
})

describe('oracle conformance summary', () => {
  it('reports fixture coverage and proves at least one fixture flows through', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[oracle] fixtures present=${tally.present} absent=${tally.absent} of ${scenarios.length} scenarios`
    )
    expect(tally.present + tally.absent).toBe(scenarios.length)
    expect(tally.present).toBeGreaterThanOrEqual(1)
  })
})
