import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { parseAgentDefinition } from '../../src/shared/agentRuntime'

/**
 * The shipped test-consumer Agents under test-agents/ are hand-editable JSON. This pins them to the
 * real contract parser, so a bad edit fails here rather than at import time in the app.
 */
const dir = path.join(process.cwd(), 'test-agents')
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.rptagent'))

describe('test-agents fixtures', () => {
  it('ships the two converted shujuku consumers', () => {
    expect(files.sort()).toEqual(['character-progression.rptagent', 'world-progression.rptagent'])
  })

  it.each(files)('%s parses as a valid Agent Definition', (file) => {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    const result = parseAgentDefinition(raw)

    expect(result.ok ? [] : result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('character progression gates the next turn; world progression does not', () => {
    const read = (file: string): ReturnType<typeof parseAgentDefinition> =>
      parseAgentDefinition(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')))

    const character = read('character-progression.rptagent')
    const world = read('world-progression.rptagent')
    if (!character.ok || !world.ok) throw new Error('fixtures must parse')

    expect(character.value.defaults.blocksNextTurn).toBe(true)
    expect(character.value.result).toMatchObject({
      saveAs: 'variables.__rpt.agent_results.character_progression'
    })
    expect(world.value.defaults.blocksNextTurn).toBe(false)
    expect(world.value.result).toMatchObject({
      saveAs: 'variables.__rpt.agent_results.world_progression'
    })
  })
})
