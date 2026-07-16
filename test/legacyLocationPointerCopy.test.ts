import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyLegacyLocationPointerIfNeeded } from '../src/main/services/locationPointer'

let root: string
let legacy: string
let portable: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-location-pointer-'))
  legacy = path.join(root, 'legacy')
  portable = path.join(root, 'portable')
  fs.mkdirSync(legacy)
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('copyLegacyLocationPointerIfNeeded', () => {
  it('copies a valid custom-location pointer and leaves the source intact', () => {
    const source = path.join(legacy, 'rpt-location.json')
    fs.writeFileSync(source, JSON.stringify({ dataDir: 'D:/RP Terminal Data' }))

    expect(
      copyLegacyLocationPointerIfNeeded({
        legacyUserDataDir: legacy,
        portableUserDataDir: portable
      })
    ).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(portable, 'rpt-location.json'), 'utf-8'))).toEqual({
      dataDir: 'D:/RP Terminal Data'
    })
    expect(fs.existsSync(source)).toBe(true)
  })

  it('does not override existing portable data or an existing portable pointer', () => {
    fs.writeFileSync(path.join(legacy, 'rpt-location.json'), JSON.stringify({ dataDir: 'D:/old' }))
    fs.mkdirSync(portable)
    fs.writeFileSync(path.join(portable, 'rpterminal.db'), 'db')
    expect(
      copyLegacyLocationPointerIfNeeded({
        legacyUserDataDir: legacy,
        portableUserDataDir: portable
      })
    ).toBe(false)

    fs.rmSync(path.join(portable, 'rpterminal.db'))
    fs.writeFileSync(
      path.join(portable, 'rpt-location.json'),
      JSON.stringify({ dataDir: 'D:/new' })
    )
    expect(
      copyLegacyLocationPointerIfNeeded({
        legacyUserDataDir: legacy,
        portableUserDataDir: portable
      })
    ).toBe(false)
  })

  it('ignores a missing or malformed legacy pointer', () => {
    expect(
      copyLegacyLocationPointerIfNeeded({
        legacyUserDataDir: legacy,
        portableUserDataDir: portable
      })
    ).toBe(false)
    fs.writeFileSync(path.join(legacy, 'rpt-location.json'), 'not json')
    expect(
      copyLegacyLocationPointerIfNeeded({
        legacyUserDataDir: legacy,
        portableUserDataDir: portable
      })
    ).toBe(false)
  })
})
