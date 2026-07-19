import type { NormalizedProviderRequest, ProviderAdapter, ProviderAdapterEvent } from './types'

export type ScriptedProviderStep = { events: ProviderAdapterEvent[] } | { error: Error }

export interface ScriptedProviderAdapter extends ProviderAdapter {
  readonly requests: NormalizedProviderRequest[]
}

export const createScriptedProviderAdapter = (
  steps: ScriptedProviderStep[]
): ScriptedProviderAdapter => {
  const queue = [...steps]
  const requests: NormalizedProviderRequest[] = []
  return {
    requests,
    async dispatch(request, emit): Promise<void> {
      requests.push(request)
      const step = queue.shift()
      if (!step) throw new Error('scripted provider exhausted')
      if ('error' in step) throw step.error
      for (const event of step.events) emit(event)
    }
  }
}
