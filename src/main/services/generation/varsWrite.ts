import { getFloor, saveFloor } from '../floorService'
import { applyJsonPatch, JsonPatchOp } from '../../parsers/mvuParser'
import { log } from '../logService'
import { FloorFile } from '../../types/chat'

// Runaway write-back loop breaker (TIMING-INDEPENDENT). NOTE (2026-07-02): this is now a BACKSTOP, not the
// primary defense. The self-feedback loop is fixed at the source — the card runtime (shared/thRuntime
// `onVarsChanged`) no longer fires `mag_variable_update_*` for `card-write`-origin changes, so a card's own
// write no longer re-triggers its own update handler (the WS-3 origin-tag fix). This guard is retained to
// cap any residual/untagged runaway. A card that writes a constantly-CHANGING value on
// its own update event (e.g. a `date` clock) re-triggers itself forever — every write is a real change, so
// the no-op guard can't catch it. We detect the runaway *signature*: the SAME set of changed paths written
// CONSECUTIVELY many times. A legitimate init chain touches DISTINCT paths (the signature changes each
// write, so the streak resets), and per-turn updates are spread across model folds — so only a true
// self-feedback loop accumulates a long streak. The streak is reset on every model fold
// (`generate()` → `resetWriteLoopGuard`), so a path legitimately re-written once per turn never accumulates
// a false streak across turns; a loop accumulates only WITHIN one inter-fold window (no AI turn to break it).
//
// WS-3 (2026-06-26): the previous guard was TIME-WINDOWED (≤400 ms between same-sig writes) and so MISSED a
// loop whose IPC round-trip is slower than the window — exactly the reported `date` clock. Removing the
// time dependence (count consecutive same-sig writes, reset per turn) catches the slow loop without
// false-positiving on legit per-turn updates. This is still a band-aid for the architectural divergence the
// WS-3 SPIKE found (RPT fires MVU `mag_variable_update_*` on the card's own write echoes; real MVU fires
// them only on the AI fold — MagVarUpdate source). The proper fix (tag change origin; fire events only on
// model-fold; delete this guard) remains DEFERRED pending in-app verify against 命定之诗 (whose live
// automation is loaded remotely, so the self-chain assumption can't be checked from the card files). See
// docs/structural-cleanup-log-2026-06-26.md Stage 13/15 + the note in shared/thRuntime/index.ts.
const writeLoopGuard = new Map<string, { sig: string; count: number }>()
const LOOP_MAX = 40 // consecutive same-signature writes (no model fold between) before we treat it as runaway

/** Reset the runaway-loop streak for a chat. Called at the start of each model turn (`generate`) so a path
 *  legitimately re-written once per turn never builds a false streak across turns — a real self-feedback
 *  loop (many consecutive same-sig writes with no AI turn between) still trips the guard within one turn. */
export const resetWriteLoopGuard = (chatId: string): void => {
  writeLoopGuard.delete(chatId)
}

/**
 * Register a write's changed-path signature against the per-chat runaway streak and report whether this
 * write should be DROPPED as a self-feedback loop. Drops once the SAME signature has been written more than
 * `LOOP_MAX` times CONSECUTIVELY (a different signature resets the streak; `resetWriteLoopGuard` clears it
 * each model turn). Pure w.r.t. the module's streak map — exported so the loop logic is unit-testable
 * without the DB. Returns `{ drop, count }` (count = the post-increment streak length).
 */
export const registerWriteSignature = (
  chatId: string,
  sig: string
): { drop: boolean; count: number } => {
  const g = writeLoopGuard.get(chatId)
  if (g && g.sig === sig) {
    g.count++
    return { drop: g.count > LOOP_MAX, count: g.count }
  }
  writeLoopGuard.set(chatId, { sig, count: 1 })
  return { drop: false, count: 1 }
}

/**
 * Variable WRITE-BACK bridge: apply JSONPatch ops to ONE floor's stat_data (the message
 * variables) and persist. This is the path by which native/script panel UI MODIFIES state
 * instead of only displaying it (a button, checkbox, or manual edit). Reuses the same
 * `applyJsonPatch` engine as the model's `<UpdateVariable>`, so author/user writes fold in
 * identically. NOTE these writes are not re-derivable from response text, so an MVU
 * re-evaluate (`reevaluateVariables`, which replays model `<UpdateVariable>` blocks only)
 * DISCARDS them. Returns the updated floor (or null if the floor is gone / there are no
 * ops / the write was a no-op or a suppressed runaway loop). Targets a specific floor —
 * the caller passes the latest.
 */
export const applyVariableOps = (
  profileId: string,
  chatId: string,
  floor: number,
  ops: JsonPatchOp[]
): FloorFile | null => {
  if (!Array.isArray(ops) || ops.length === 0) return null
  const f = getFloor(profileId, chatId, floor)
  if (!f) return null
  const sd: Record<string, unknown> =
    f.variables.stat_data && typeof f.variables.stat_data === 'object'
      ? (f.variables.stat_data as Record<string, unknown>)
      : {}
  const deltas = applyJsonPatch(sd, ops)
  // No-op guard: drop the write entirely when nothing actually changed (a card re-writing identical
  // values). Checked at the source (same object shapes) rather than relying on the event-side diff guard
  // surviving the multi-hop IPC round-trip.
  const changed = deltas.filter((d) => JSON.stringify(d.old) !== JSON.stringify(d.new))
  if (changed.length === 0) return null
  // Runaway-loop guard: a constantly-changing value hammered on the card's own event signature. Counts
  // CONSECUTIVE writes of the same changed-path signature (timing-independent); reset each model turn.
  const sig = changed
    .map((d) => d.path)
    .sort()
    .join('|')
  const loop = registerWriteSignature(chatId, sig)
  if (loop.drop) {
    if (loop.count === LOOP_MAX + 1)
      log(
        'info',
        `variable write-back — runaway loop on [${sig}] (floor ${floor}); suppressing the self-feedback ` +
          `write so it can't spin (${LOOP_MAX}+ consecutive same-path writes with no AI turn between — ` +
          `a card writing a changing value on its own update event)`
      )
    return null
  }
  f.variables = { ...f.variables, stat_data: sd, delta_data: deltas }
  saveFloor(profileId, chatId, f)
  log(
    'info',
    `variable write-back — floor ${floor}: ${changed.map((d) => d.path).join(', ')}` +
      (changed.length < ops.length ? ` (${ops.length - changed.length} no-op)` : '')
  )
  return f
}
