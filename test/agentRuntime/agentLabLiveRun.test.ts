import { describe, expect, it } from 'vitest'

import {
  createAgentLabLiveRun,
  type AgentLabLiveRunDeps
} from '../../src/main/services/agentRuntime/lab/liveRun'
import type { InvocationRuntime } from '../../src/main/services/agentRuntime/invocation'
import type { AgentLabCase } from '../../src/shared/agentRuntime'

/**
 * Agent Lab LIVE run must invoke by AGENT ID, not by the captured (possibly stale) name. Production
 * `InvocationRuntime.run` resolves `request.agent` through `AgentCatalog.get`, which matches id OR
 * name; passing the id makes a live run survive a rename of the underlying Agent.
 */

const caseFixture = (): AgentLabCase =>
  ({
    id: 'case-1',
    agentId: 'agent-id-stable',
    agentName: 'Old Display Name',
    name: 'fixture',
    createdAt: '',
    hasSource: false,
    runs: [],
    input: { q: 'hello' }
  }) as AgentLabCase

describe('Agent Lab live run', () => {
  it('invokes the runtime by the case agentId, not the stale agentName', async () => {
    let seenAgent: string | undefined
    const runtime = {
      run(request: { agent: string }) {
        seenAgent = request.agent
        const promise = Promise.resolve({
          invocationId: 'live-inv-1',
          status: 'succeeded'
        }) as unknown as ReturnType<InvocationRuntime['run']>
        return promise
      }
    } as unknown as InvocationRuntime

    const deps: AgentLabLiveRunDeps = {
      runtime: () => runtime,
      resolveApiPresetId: () => undefined
    }

    const liveRun = createAgentLabLiveRun(deps)
    const result = await liveRun({ profileId: 'p', chatId: 'c', floor: 1, case: caseFixture() })

    expect(seenAgent).toBe('agent-id-stable')
    expect(seenAgent).not.toBe('Old Display Name')
    expect(result).toEqual({ ok: true, invocationId: 'live-inv-1', status: 'succeeded' })
  })
})
