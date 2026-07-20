import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { parseAgentDefinition } from '../../src/shared/agentRuntime'

/**
 * test-agents/ is a LOCAL, untracked playground of hand-editable Agent files (the folder the
 * scan-folder import reads by default). When it exists on this machine, pin every file in it to the
 * real contract parser so a bad local edit fails here rather than at import time in the app. On
 * machines without the folder (fresh clones, CI) there is nothing to validate and the suite skips.
 */
const dir = path.join(process.cwd(), 'test-agents')
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.rptagent'))
  : []

describe.skipIf(files.length === 0)('local test-agents files', () => {
  it.each(files)('%s parses as a valid Agent Definition', (file) => {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    const result = parseAgentDefinition(raw)

    expect(result.ok ? [] : result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })
})
