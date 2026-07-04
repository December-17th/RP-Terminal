// Pure display-derivation for the Agents workspace pack card (agent-packs plan WP3.1). Everything
// here is side-effect-free and React-free so it is unit-testable directly (test/agentPackDisplay.
// test.ts) under Node — the renderer's Agents view (AgentsView.tsx) renders these shapes, adding
// only the localized labels + the DOM.
//
// What lives here (the three pieces the WP asks be extracted + tested):
//   · attachment → BADGE derivation (the read-only "before reply / after reply / headless" row).
//   · run history → HEALTH-DOT state (ok / failed / never), from listAgentPackRuns records.
//   · attachments → CASCADE detection (does disabling this pack transform the main reply path?).
//
// The localized COPY for each shape is in the view (routed through t()); this module produces only
// the structural decision + the data the label needs. Grounding: shared/workflow/attachments.ts
// (AttachmentDecl shapes), shared/workflow/trace.ts (StoredRunRecord + describeTrigger), ADR 0002
// (the cascade warning is derived from structure, never creator-declared).

import { AttachmentDecl, CheckpointId } from '../../../../shared/workflow/attachments'
import { describeTrigger } from '../../../../shared/workflow/trace'
import type { StoredRunRecord } from '../../../../shared/workflow/trace'

// ── Attachment badges ────────────────────────────────────────────────────────────────────────────
//
// A pack card shows a read-only badge per attachment describing WHERE it joins the turn — structure,
// not a setting (rev-3 §Settings: where a pack attaches is shown read-only, changed only by forking).
// The plain-language phase wording is mapped from the checkpoint:
//   context-ready + prompt-assembly → "before reply"  (they shape the prompt that produces the reply)
//   reply-parsed  + turn-committed  → "after reply"    (they run on the produced/committed reply)
//   a trigger                       → "headless · <describeTrigger>" (runs by itself off the turn)

/** One badge to render on the card. `phase` picks the plain-language bucket + the accent; `mode`
 *  (entry only) lets the view mark an INLINE entry (it transforms the main flow) distinctly from a
 *  branch; `detail` is the trigger description for headless badges (already human-readable). */
export interface AttachmentBadge {
  /** `before` / `after` for checkpoint attachments; `headless` for triggers. Drives label + accent. */
  phase: 'before' | 'after' | 'headless'
  /** The attachment kind, so the view can word entry vs rejoin and flag inline entries. */
  kind: 'entry' | 'rejoin' | 'trigger'
  /** Entry only: 'inline' (transforms the main flow) or 'branch'. Absent for rejoin/trigger. */
  mode?: 'inline' | 'branch'
  /** Headless only: the human-readable trigger description (from shared describeTrigger). */
  detail?: string
}

/** Which plain-language phase a checkpoint belongs to. `context-ready`/`prompt-assembly` happen
 *  BEFORE the reply exists (they shape the prompt); `reply-parsed`/`turn-committed` happen AFTER. */
export function checkpointPhase(checkpoint: CheckpointId): 'before' | 'after' {
  return checkpoint === 'context-ready' || checkpoint === 'prompt-assembly' ? 'before' : 'after'
}

/** Derive the badge row for a fragment's attachments. Order: attachments are shown in declaration
 *  order (the fragment's own ordering, which the composition treats as chain order — WP1.2). Trigger
 *  badges carry the describeTrigger caption so the card can say "headless · every 3 floors". */
export function attachmentBadges(attachments: readonly AttachmentDecl[]): AttachmentBadge[] {
  return attachments.map((att): AttachmentBadge => {
    if (att.kind === 'trigger') {
      return { phase: 'headless', kind: 'trigger', detail: describeTrigger(att) }
    }
    if (att.kind === 'entry') {
      return { phase: checkpointPhase(att.checkpoint), kind: 'entry', mode: att.mode }
    }
    // rejoin
    return { phase: checkpointPhase(att.checkpoint), kind: 'rejoin' }
  })
}

// ── Cascade detection (ADR 0002) ──────────────────────────────────────────────────────────────────
//
// Disabling a pack whose fragment has any INLINE entry transforms the main reply PATH (the main flow
// is wired THROUGH an inline fragment — ADR 0002 / glossary: Inline Fragment). The card must warn
// before disabling such a pack (a confirm popover). But — grounded against the flagship — the
// narrator's anchors run UNWIRED-TOLERANT: the trimmer is inline at context-ready, and if it is
// removed the anchor value simply flows straight through (the trimmer only TRIMS history; the reply
// still generates on the full history). So the warning wording is "changes how prompts are built",
// NOT "the reply breaks". This function reports only the STRUCTURAL fact (has-inline); the view owns
// the (correctly-hedged) copy.

/** Whether disabling this pack should raise the cascade confirm: true iff any attachment is an inline
 *  entry (the pack transforms the main reply path). Enabling never confirms — this is a disable-only
 *  gate. Derived purely from structure (ADR 0002 — never creator-declared). */
export function transformsMainReply(attachments: readonly AttachmentDecl[]): boolean {
  return attachments.some((a) => a.kind === 'entry' && a.mode === 'inline')
}

// ── Fork affordance visibility (agent-packs plan WP4.5) ──────────────────────────────────────────
//
// The owner report: "I can't find the fork button." The explicit fork action previously lived ONLY
// inside Workflow Studio's Effective mode. WP4.5 surfaces it in the Agents view where users look. A
// fork repoints THIS world's activation to a private copy (forkPack — agentPackService), so it needs a
// world context; without one the affordance is shown-but-disabled with a tooltip (mirrors the gate
// toggle, which is inert without a world).
//
// The card FOOTER shows a compact "Fork" button on packs the user would fork to tweak: built-ins and
// non-fork upstream installs. A card that is ALREADY a fork (manifest.fork) shows its Edit + Export
// affordances instead — the fork is the tweak-then-share unit, so its next step is editing, not
// re-forking (fork-a-fork stays reachable from the DETAIL panel, where all packs can fork).

/** Whether the pack CARD should show the compact "Fork" affordance in its footer. True for a built-in
 *  or a plain (non-fork) upstream install — the packs a user forks to get an editable copy. A card
 *  that is already a fork shows Edit/Export instead (it forks-a-fork only from the detail panel). Pure
 *  over the summary shape (builtin flag + manifest.fork presence). */
export function showsForkOnCard(pack: { builtin: boolean; manifest: { fork?: unknown } }): boolean {
  return pack.builtin || !pack.manifest.fork
}

/** Whether a fork action is actionable given the current world context. A fork repoints a world's
 *  activation, so it is disabled without a world (same rule the gate toggle uses — no world, no scope
 *  to write). Pure: the view pairs `false` with the "select a world first" tooltip. */
export function canForkNow(worldId: string | null): boolean {
  return !!worldId
}

// ── Version coexistence (agent-packs plan WP4.7; ADR 0008) ────────────────────────────────────────
//
// listAgentPacks returns ONE row per (id, version) — coexisting versions are distinct library rows
// (agentPackService.list; WP4.6). The library card is per-ID, so the renderer groups those rows
// client-side into one card per id. The card shows the ACTIVE version prominently and a popover to
// switch it; the pin (activeVersion) decides which version RUNS, while the gate decides whether the
// pack runs at all. Everything here is pure so it is unit-testable directly (test/agentPackDisplay).
//
// grouping key = the pack id (`upstreamId` is NOT the grouping key — a fork has its own id and is its
// OWN card, per WP4.5/WP4.6; coexisting versions share an id). Each same-id row already carries the
// grouped `versions` set + the resolved gate/activeVersion (stamped onto every same-id summary by
// agentPackService.withVersions), so the representative row alone drives the whole card.

/** The minimal version-carrying summary shape these helpers read. Kept structural (not tied to the
 *  view's full PackSummary) so the pure module stays view-independent + easy to test. */
export interface VersionedPackLike {
  id: string
  version: number
  /** Every installed version of this id, ascending (agentPackService fills this; may be absent on a
   *  legacy/partial payload — then it degrades to just this row's own version). */
  versions?: number[]
  /** The pinned version to run in the active world — present only with a world + an open gate. */
  activeVersion?: number
}

/** The version shown PROMINENTLY on the card / detail header. Prefers the pinned active version (the
 *  one that actually runs); with no pin (gate closed / no world) falls back to the HIGHEST installed
 *  version — mirroring agentPackService.pickPinnedRecord's own fallback, so the label names the version
 *  that WOULD compose. Degrades to the row's own version if the grouped set is missing. */
export function displayActiveVersion(pack: VersionedPackLike): number {
  if (pack.activeVersion != null) return pack.activeVersion
  const all = installedVersions(pack)
  return all.length > 0 ? all[all.length - 1] : pack.version
}

/** The installed-version set for a pack's id, ascending, de-duplicated. Falls back to the row's own
 *  version when the grouped `versions` is absent (legacy payload). */
export function installedVersions(pack: VersionedPackLike): number[] {
  const set = pack.versions && pack.versions.length > 0 ? pack.versions : [pack.version]
  return Array.from(new Set(set)).sort((a, b) => a - b)
}

/** Whether more than one version of this id is installed (drives the version affordance + the multi-
 *  version note — a single-version pack shows neither). */
export function hasMultipleVersions(pack: VersionedPackLike): boolean {
  return installedVersions(pack).length > 1
}

/** One row in the version-switcher popover: the installed version + whether it is the one shown as
 *  active. Descending (newest first — the natural "latest at top" reading order for a picker). */
export interface VersionMenuItem {
  version: number
  active: boolean
}

/** The popover's version list for a pack, newest-first, each marked active iff it is the shown active
 *  version. Pure over the grouped set. */
export function versionMenuItems(pack: VersionedPackLike): VersionMenuItem[] {
  const active = displayActiveVersion(pack)
  return installedVersions(pack)
    .slice()
    .sort((a, b) => b - a)
    .map((version) => ({ version, active: version === active }))
}

/** Collapse the per-(id, version) library rows into ONE representative row per id (the library card is
 *  per-ID). The representative is the row whose `version` equals the id's shown active version
 *  (displayActiveVersion) — so the card's name/description/attachments/capabilities reflect the version
 *  that runs — falling back to the highest-version row if no row matches (defensive). Input order is
 *  preserved by first-seen id (the service already sorts by name then version). Generic over any row
 *  carrying the versioned shape so the view passes its full PackSummary through unchanged. */
export function groupPacksByLineage<T extends VersionedPackLike>(packs: readonly T[]): T[] {
  const byId = new Map<string, T[]>()
  const order: string[] = []
  for (const p of packs) {
    if (!byId.has(p.id)) {
      byId.set(p.id, [])
      order.push(p.id)
    }
    byId.get(p.id)!.push(p)
  }
  return order.map((id) => {
    const rows = byId.get(id)!
    const wantVersion = displayActiveVersion(rows[0])
    return (
      rows.find((r) => r.version === wantVersion) ??
      rows.slice().sort((a, b) => b.version - a.version)[0]
    )
  })
}

// ── Health dot (from persisted run history) ────────────────────────────────────────────────────────
//
// The card's health dot reflects the pack's LAST run for the active chat: ok (success), failed
// (danger), or never-ran (tertiary). Runs come from listAgentPackRuns (newest-first, StoredRunRecord)
// filtered to this pack via record.packIds (derivePackIds already attributed each run to the packs
// that contributed nodes — trace.ts). Color pairs with a text label (no color-only signaling —
// UX brief accessibility rule).

/** The three health states, paired with the token the view colors the dot with. `never` is the
 *  first-run common case (a freshly enabled or never-enabled pack). */
export type PackHealth = 'ok' | 'failed' | 'never'

/** The most recent run record attributed to `packId`, or undefined if none. Assumes `records` is
 *  newest-first (the listAgentPackRuns contract) and returns the FIRST match — the last run. */
export function latestRunForPack(
  records: readonly StoredRunRecord[],
  packId: string
): StoredRunRecord | undefined {
  return records.find((r) => r.packIds.includes(packId))
}

/** Derive the health-dot state for a pack from its run history. No attributed run → 'never'; else the
 *  latest run's trace `ok` flag maps to 'ok' / 'failed'. (A run's `ok` is the whole-run success flag
 *  — WorkflowRunTrace.ok — which is what "did this pack's last run succeed" means at card altitude.) */
export function packHealth(records: readonly StoredRunRecord[], packId: string): PackHealth {
  const last = latestRunForPack(records, packId)
  if (!last) return 'never'
  return last.trace.ok ? 'ok' : 'failed'
}
