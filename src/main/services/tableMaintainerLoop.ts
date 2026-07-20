import type { GenContext } from './generation/types'
import type { ChatMessage } from './promptBuilder'
import { callModelResilient } from './generation/resilientCall'
import { extractTagAll } from '../../shared/memory/tagExtract'
import { TableSqlError } from './tableSql'

/**
 * The shared "one maintainer batch" loop for SQL-table memory — factored out of `tableBackfillService`
 * so the manual BACKFILL and the REFILL engine call the SAME model-call + SQL-error corrective-retry
 * machinery and can never drift (the memoryCore no-drift discipline). The only thing that differs
 * between the two is the APPLY step (backfill writes the live sandbox + advances progress; refill
 * applies to a temp shadow, filtered to the selected tables) — so that step is a callback.
 */

/** The corrective user message fed back on an SQL error, so the model can fix its output. */
export const correctiveMessage = (error: string): ChatMessage => ({
  role: 'user',
  content: `你上次输出的 SQL 执行失败：${error}。请修正后重新只输出一个 <TableEdit> 块，不要包含任何解释。`
})

/**
 * Run ONE maintainer LLM pass and return the raw reply, or throw (an API give-up bubbles as a
 * NodeRunFailure from callModelResilient). The API retry budget rides `callModelResilient` (retries +
 * a fixed 2s delay).
 */
export const callMaintainer = async (
  gen: GenContext,
  messages: ChatMessage[],
  retries: number,
  signal: AbortSignal
): Promise<string> => {
  const params = { ...gen.preset.parameters }
  const r = await callModelResilient(gen, messages, params, () => {}, signal, {
    retries,
    retry_delay_s: 2
  })
  return r?.raw ?? ''
}

/**
 * Drive one batch: call the model with `baseMessages`, extract its `<TableEdit>` SQL, and run `apply`.
 * `apply` throws a `TableSqlError` to trigger a corrective re-call (the failed reply + the error fed
 * back), up to `retries` attempts; exhausting the budget rethrows so the caller marks the batch failed
 * (fail-open). Returns true when the batch APPLIED, false only on a mid-batch cancel (the caller must
 * not report a cancelled batch as ok). `apply` receives the (possibly empty) extracted SQL.
 */
export const runMaintainerBatch = async (
  gen: GenContext,
  baseMessages: ChatMessage[],
  retries: number,
  signal: AbortSignal,
  apply: (sql: string) => void
): Promise<boolean> => {
  let raw = await callMaintainer(gen, baseMessages, retries, signal)
  let sql = extractTagAll(raw, 'TableEdit').join('\n').trim()

  let attempt = 0
  for (;;) {
    if (signal.aborted) return false // cancel: leave this batch unapplied
    try {
      apply(sql)
      return true
    } catch (error) {
      const reason = error instanceof TableSqlError ? error.message : String(error)
      if (attempt >= retries) throw new TableSqlError(reason)
      attempt++
      const corrective: ChatMessage[] = [
        ...baseMessages,
        { role: 'assistant', content: raw },
        correctiveMessage(reason)
      ]
      raw = await callMaintainer(gen, corrective, retries, signal)
      sql = extractTagAll(raw, 'TableEdit').join('\n').trim()
    }
  }
}
