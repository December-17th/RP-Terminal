// Pure display-derivation for the Agents "Why?" popover + the Overview pane (agent-packs plan WP3.5).
// Like agentPackDisplay.ts / runTimeline.ts, everything here is side-effect-free and React-free so it
// is unit-testable under Node (test/agentExplain.test.ts) — the view renders these shapes and adds the
// localized labels + DOM.
//
// The controller decision (WP3.3 friction findings — do NOT re-litigate): explain-why assembles its
// answer from LIVE state + history, NOT a stored skip-reason on the trace. The sources, in the order
// the popover asks them:
//   1. gate CLOSED           → gate state (already on the list payload).
//   2. gate open, has triggers, none met → the per-trigger explanation (explainAgentPackTriggers IPC —
//      read-only, materialized fragments).
//   3. gate open, no prompt rejoin (nothing plugs it into the prompt) → "works in the background".
//   4. last run FAILED       → the failure sentence + a jump to Runs.
//   5. ran recently, healthy → the last run's outcome sentence (reuse runTimeline's facts).
//
// Grounding: shared/workflow/attachments.ts (AttachmentDecl — rejoin detection), ./agentPackDisplay.ts
// (latestRunForPack / PackHealth), ./runTimeline.ts (runFacts + outcomeSentence — the shared sentence
// builder we REUSE, never duplicate).

import type { AttachmentDecl } from '../../../../shared/workflow/attachments'
import type { StoredRunRecord } from '../../../../shared/workflow/trace'
import { latestRunForPack } from './agentPackDisplay'
import { runFacts, outcomeSentence, type OutcomeSentence } from './runTimeline'

/** One trigger's explanation, mirroring the main-side TriggerExplanation (headlessRunService WP3.5).
 *  Kept structurally identical so the IPC payload types straight into the popover. */
export interface TriggerExplain {
  description: string
  kind: 'state' | 'cadence' | 'manual'
  met: boolean
  current?: number | string | boolean
  required?: number | string | boolean
  baseline?: number
  lastFireFloor?: number
  floorsUntilDue?: number
}

/** Does this fragment REJOIN into prompt assembly — i.e. does it add anything to the prompt? A pack with
 *  NO rejoin attachment cannot inject: it works purely in the background (a common "why isn't it in my
 *  prompt" answer). Derived purely from structure (ADR 0002) — an entry that only READS a checkpoint is
 *  not a prompt contribution; only a rejoin lands a value back. */
export function addsToPrompt(attachments: readonly AttachmentDecl[]): boolean {
  return attachments.some((a) => a.kind === 'rejoin')
}

/** Does this fragment have any TRIGGER attachment (i.e. can it run on its own)? Used to decide whether
 *  the "none of its triggers are met" branch of the popover applies at all. */
export function hasTriggers(attachments: readonly AttachmentDecl[]): boolean {
  return attachments.some((a) => a.kind === 'trigger')
}

// ── The popover's top-line answer ────────────────────────────────────────────────────────────────
//
// The popover answers ONE headline question for the pack's current state, plus supporting lines. The
// headline is a discriminated shape so the view picks the right template + affordance (enable shortcut,
// "View run" jump, etc.). The order below is the answer priority the WP pins.

/** The popover's headline answer. Each variant maps to one localized template + (optionally) an action. */
export type ExplainHeadline =
  /** Gate closed → "Turned off for this world." (+ an enable shortcut). */
  | { kind: 'disabled' }
  /** Gate open, last run FAILED → the failure sentence + a "View run" jump to the Runs pane. */
  | { kind: 'failed'; sentence: OutcomeSentence }
  /** Gate open, has triggers, NONE met → the per-trigger lines carry the detail (view renders them). */
  | { kind: 'waiting' }
  /** Gate open, ran and healthy → the last run's outcome sentence + when it ran. */
  | { kind: 'ranOk'; sentence: OutcomeSentence; ranAt: number }
  /** Gate open, never ran, no triggers, adds nothing to the prompt → "works in the background". */
  | { kind: 'background' }
  /** Gate open, never ran, has triggers but we have no live explanation (edge) → "waiting to run". */
  | { kind: 'ready' }

/** Assemble the popover's headline answer from LIVE state + history (agent-packs plan WP3.5). Priority:
 *  disabled → failed → (triggers, none met) waiting → ranOk → background → ready. `triggerExplains` is
 *  the read-only explainAgentPackTriggers payload (empty when the pack has no triggers or is not
 *  gate-open); `records` is the run history (newest-first, the listAgentPackRuns contract). Pure. */
export function explainHeadline(args: {
  open: boolean
  attachments: readonly AttachmentDecl[]
  records: readonly StoredRunRecord[]
  packId: string
  triggerExplains: readonly TriggerExplain[]
}): ExplainHeadline {
  const { open, attachments, records, packId, triggerExplains } = args
  if (!open) return { kind: 'disabled' }

  const last = latestRunForPack(records, packId)
  if (last && !last.trace.ok) {
    return { kind: 'failed', sentence: outcomeSentence(runFacts(last.trace)) }
  }

  // Has triggers and none are currently met → it is waiting for its condition. The per-trigger lines
  // (triggerExplains) carry the scannable numbers; the headline just frames it.
  if (
    hasTriggers(attachments) &&
    triggerExplains.length > 0 &&
    triggerExplains.every((t) => !t.met)
  ) {
    return { kind: 'waiting' }
  }

  if (last) {
    return {
      kind: 'ranOk',
      sentence: outcomeSentence(runFacts(last.trace)),
      ranAt: last.trace.startedAt
    }
  }

  // Never ran. If it can only ever run on its own AND adds nothing to the prompt, it is background work.
  if (!addsToPrompt(attachments) && !hasTriggers(attachments)) return { kind: 'background' }
  return { kind: 'ready' }
}

// ── A single per-trigger line's scannable copy (view interpolates via t()) ─────────────────────────
//
// Each unmet trigger becomes one plain-language line. We return a t() KEY + vars (same convention as
// runTimeline.outcomeSentence) so en/zh templates stay in the locale files. The wording is chosen to
// make the NUMBERS scannable: "backlog is 3, runs at 10" / "runs again in 2 floors" / "needs +30 from
// 120, now 135".

export interface TriggerLine {
  key: string
  vars: Record<string, string | number>
  met: boolean
}

/** Build one scannable line per trigger explanation (agent-packs plan WP3.5). Chooses the template by
 *  kind + shape; a MET trigger reads "condition met" (rare in the popover, but honest if the pack is
 *  mid-run). Pure — the view calls t(line.key, line.vars). */
export function triggerLine(e: TriggerExplain): TriggerLine {
  if (e.met) return { key: 'agents.why.trigger.met', vars: { desc: e.description }, met: true }

  if (e.kind === 'cadence') {
    const due = e.floorsUntilDue ?? 0
    return { key: 'agents.why.trigger.cadence', vars: { n: Math.max(0, due) }, met: false }
  }

  if (e.kind === 'state') {
    // changedBy carries a baseline → the delta template; otherwise the point-compare template.
    if (e.baseline !== undefined && e.required !== undefined) {
      return {
        key: 'agents.why.trigger.changedBy',
        vars: {
          delta: String(e.required),
          from: String(e.baseline),
          now: e.current !== undefined ? String(e.current) : '—'
        },
        met: false
      }
    }
    return {
      key: 'agents.why.trigger.state',
      vars: {
        current: e.current !== undefined ? String(e.current) : '—',
        required: e.required !== undefined ? String(e.required) : '—'
      },
      met: false
    }
  }

  // manual — the pack only runs when you ask it to.
  return { key: 'agents.why.trigger.manual', vars: {}, met: false }
}

// ── Overview: setup checklist (grounded in cheaply-knowable state) ─────────────────────────────────
//
// The Overview's checklist reflects REAL state (UX brief). Each item is { id, done } and the view turns
// an UNCHECKED item into a link/action to fix it. We keep ONLY what is cheaply knowable in the renderer:
//   · has-world  — an active chat's world (worldId != null).
//   · any-enabled — at least one pack's gate is open for this world.
//   · memory-template — IF a memory pack (one with table capability) is enabled, a table template is
//     assigned to the chat (memoryTemplateAssigned). Only relevant when a memory pack is on; otherwise
//     the item is omitted (it would be noise).

export interface ChecklistItem {
  id: 'has-world' | 'any-enabled' | 'memory-template'
  done: boolean
}

/** Build the Overview setup checklist from cheaply-knowable state (agent-packs plan WP3.5). The
 *  memory-template item is included ONLY when a memory pack is enabled (else it is noise). Pure. */
export function setupChecklist(args: {
  hasWorld: boolean
  anyEnabled: boolean
  memoryPackEnabled: boolean
  memoryTemplateAssigned: boolean
}): ChecklistItem[] {
  const items: ChecklistItem[] = [
    { id: 'has-world', done: args.hasWorld },
    { id: 'any-enabled', done: args.anyEnabled }
  ]
  if (args.memoryPackEnabled) {
    items.push({ id: 'memory-template', done: args.memoryTemplateAssigned })
  }
  return items
}

// ── Overview: recent errors strip ──────────────────────────────────────────────────────────────────

/** The newest failed runs from history, capped, for the Overview "recent errors" strip. A run counts as
 *  failed when its trace.ok is false (the whole-run failure flag — WorkflowRunTrace.ok). Records are
 *  newest-first (the listAgentPackRuns contract), so we take in order. Pure. */
export function recentErrors(records: readonly StoredRunRecord[], limit = 3): StoredRunRecord[] {
  const out: StoredRunRecord[] = []
  for (const r of records) {
    if (!r.trace.ok) out.push(r)
    if (out.length >= limit) break
  }
  return out
}

// ── Overview: active-pack rows (compact, one-line last outcome) ─────────────────────────────────────

/** One compact Overview row for an enabled pack: its last-outcome sentence (reuse the shared builder)
 *  + health. `sentence` is null when the pack never ran (the view shows a "hasn't run yet" line). */
export interface ActivePackRow {
  packId: string
  sentence: OutcomeSentence | null
}

/** The last-outcome sentence for an enabled pack (agent-packs plan WP3.5) — reuses runTimeline's facts +
 *  sentence builder (NOT duplicated). Null when the pack has no attributed run yet. Pure. */
export function activePackRow(records: readonly StoredRunRecord[], packId: string): ActivePackRow {
  const last = latestRunForPack(records, packId)
  return { packId, sentence: last ? outcomeSentence(runFacts(last.trace)) : null }
}
