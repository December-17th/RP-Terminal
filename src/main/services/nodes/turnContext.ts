import { DeltaCallback } from '../apiService'
import { getNodeState, setNodeState } from '../nodeStateService'
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
 *  like the pre-workflow generate() path. Node-state persistence is now real, delegating to
 *  nodeStateService keyed by this turn's chatId (Phase 2b-2). Panel emission remains a Phase
 *  2b follow-on — a no-op stub here. */
export function buildTurnContext(args: BuildTurnContextArgs): RunContext {
  // Two-signal split: the user's Stop (`args.signal`) aborts the LLM stream only; the engine watches a
  // SEPARATE graph signal that we abort only when there's nothing to persist (abort-with-empty). This
  // keeps the "persist the partial floor on Stop-with-text" behavior of the pre-workflow generate().
  const graphController = new AbortController()
  return {
    profileId: args.profileId,
    chatId: args.chatId,
    userAction: args.userAction,
    signal: graphController.signal,
    modelSignal: args.signal,
    abortGraph: () => graphController.abort(),
    streamMain: (delta) => args.onDelta(delta),
    emitPanel: () => {},
    getNodeState: (nodeId) => getNodeState(args.chatId, nodeId),
    setNodeState: (nodeId, value) => setNodeState(args.chatId, nodeId, value)
  }
}
