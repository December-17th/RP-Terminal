import { DeltaCallback } from '../apiService'
import { RunContext } from './types'

/** Arguments to seed a per-turn RunContext (Phase 2b-1b). */
export interface BuildTurnContextArgs {
  profileId: string
  chatId: string
  userAction: string
  signal: AbortSignal
  onDelta: DeltaCallback
}

/** Build the RunContext for one turn's workflow run. `streamMain` forwards each delta to the
 *  same `onDelta` callback `generate()` passes to `callModel`/`streamProvider` today (a plain
 *  `(delta: string) => void`), so the default graph's output node streams to the chat exactly
 *  like the pre-workflow generate() path. Panel emission and node-state persistence are Phase
 *  2b follow-ons — no-op stubs here so this task stays scoped to the seed fields + streaming. */
export function buildTurnContext(args: BuildTurnContextArgs): RunContext {
  return {
    profileId: args.profileId,
    chatId: args.chatId,
    userAction: args.userAction,
    signal: args.signal,
    streamMain: (delta) => args.onDelta(delta),
    emitPanel: () => {},
    getNodeState: () => undefined,
    setNodeState: () => {}
  }
}
