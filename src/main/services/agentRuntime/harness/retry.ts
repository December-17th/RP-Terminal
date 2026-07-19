import type { HarnessFailure } from './types'

export const sleepWithSignal = (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Cancelled'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('Cancelled'))
      },
      { once: true }
    )
  })
}

export const cancelledFailure = (): HarnessFailure => ({
  code: 'CANCELLED',
  message: 'Agent Invocation was cancelled',
  retryable: false
})

export const correctiveMessage = (output: string, failure: HarnessFailure): string =>
  [
    'Corrective Retry. The prior output was rejected.',
    `Rejected output: ${output}`,
    `Validation error: ${failure.message}`,
    'Return a corrected result without repeating the invalid response.'
  ].join('\n')
