/**
 * Race a promise against an AbortSignal (final-review Finding 3).
 *
 * Resolves with the work promise's value, or the `ABORTED_BY_SIGNAL` sentinel if the signal fires
 * first (or was already aborted when called). Used so the turn's `blocksNextTurn` barrier wait is
 * linked to the turn's own Stop: a hung/never-settling barrier must not pin every next turn with no
 * escape but the Workspace Runs stop — the turn can bail down its normal abort path instead.
 *
 * The work promise is not cancelled (there is nothing to cancel — it is a barrier wait); it is simply
 * no longer awaited past the abort. A work rejection also resolves to the sentinel, since the caller
 * treats "could not wait" the same as "stopped".
 */
export const ABORTED_BY_SIGNAL = Symbol('aborted-by-signal')

export const raceAbortSignal = <T>(
  work: Promise<T>,
  signal: AbortSignal
): Promise<T | typeof ABORTED_BY_SIGNAL> => {
  if (signal.aborted) return Promise.resolve(ABORTED_BY_SIGNAL)
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(ABORTED_BY_SIGNAL)
    signal.addEventListener('abort', onAbort, { once: true })
    void work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve(ABORTED_BY_SIGNAL)
      }
    )
  })
}
