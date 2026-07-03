// The Agents workspace (agent-packs plan WP3.1–3.5) — the design keystone of the Agent Packs feature.
//
// A left rail (Overview / Installed / Runs / Preview) + a content area (NOT tabs-in-tabs, per the UX
// brief IA). All four panes are now built:
//   · Overview (WP3.5, the landing view): active packs at a glance + setup checklist + recent problems
//     + quick links — "is everything working?" in one glance (OverviewPane).
//   · Installed (WP3.1/3.2): the pack list with the full pack-card treatment — gate toggle (optimistic
//     flip + rollback + cascade confirm), attachment badges, capability chips, a health dot, a "Why?"
//     popover (WP3.5 — plain-language answer assembled from live state + history), and the detail panel.
//   · Runs (WP3.3): the attributed activity timeline. · Preview (WP3.4): the next-prompt dry run.
//
// Grounding: UX brief in docs/superpowers/plans/2026-07-03-agent-packs-master-plan.md; the pack data
// model in src/main/services/nodes/builtin/{tableMemoryPack,asyncMemoryPack}.ts; the pure display
// derivations in ./agentPackDisplay.ts (badges / cascade / health) + shared/workflow/capabilities.ts
// (chips); the IPC surface in src/preload/index.d.ts (listAgentPacks + setAgentPackGate +
// listAgentPackRuns). Styling: CSS classes in assets/index.css (.rpt-agents-*), all colors via
// --rpt-* / --rpt-agent-* tokens (theme.ts, all three themes). i18n: every string via t(). World
// scope: the gate is written at WORLD scope for the active chat's world (its character_id), matching
// how the composition provider resolves it (agentPackService.worldOfChat).

import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useT, useOptionalT } from '../../i18n'
import { formatTraceSeconds } from '../../../../shared/workflow/trace'
import type { StoredRunRecord } from '../../../../shared/workflow/trace'
import type { CapabilityId } from '../../../../shared/workflow/capabilities'
import { isWriteCapability } from '../../../../shared/workflow/capabilities'
import type { AttachmentDecl } from '../../../../shared/workflow/attachments'
import {
  attachmentBadges,
  transformsMainReply,
  packHealth,
  type AttachmentBadge,
  type PackHealth
} from './agentPackDisplay'
import {
  detailGroups,
  runFacts,
  outcomeSentence,
  packsWithRuns,
  filterRuns,
  nextBeforeSeq,
  type DetailGroup
} from './runTimeline'
import {
  tokenTotal,
  sectionLabelKey,
  sourceChip,
  omittedReasonKey,
  type NextPromptPreviewData,
  type PreviewSectionData,
  type PreviewOmittedData
} from './previewDisplay'
import {
  explainHeadline,
  triggerLine,
  setupChecklist,
  recentErrors,
  activePackRow,
  type TriggerExplain,
  type ExplainHeadline
} from './agentExplain'
import { useUiStore } from '../../stores/uiStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { AgentPackDetail } from './AgentPackDetail'

// The list-payload shape from listAgentPacks (preload index.d.ts — WP3.1-extended with attachments +
// capabilities). Mirrored here so the view is typed against the IPC contract.
interface PackSummary {
  id: string
  version: number
  upstreamId: string | null
  builtin: boolean
  manifest: {
    name: string
    description?: string
    creator?: string
    /** Fork provenance (ADR 0006) — present on fork entries so the card localizes "fork". */
    fork?: { base: string; n: number }
  }
  attachments: AttachmentDecl[]
  capabilities: CapabilityId[]
  gateOpen?: boolean
}

type RailItem = 'overview' | 'installed' | 'runs' | 'preview'

const api = (): any => (window as unknown as { api: any }).api

export const AgentsView: React.FC<{ profileId: string }> = ({ profileId }) => {
  const t = useT()
  const activeChatId = useChatStore((s) => s.activeChatId)
  // The world = the active chat's world card (its character_id) — the scope the gate is written at,
  // matching the composition provider (agentPackService.worldOfChat). No chat → no world → the
  // Installed list shows the "select a world first" designed state.
  const chats = useChatStore((s) => s.chats)
  const worldId = React.useMemo(
    () => chats.find((c) => c.id === activeChatId)?.character_id ?? null,
    [chats, activeChatId]
  )

  const [rail, setRail] = React.useState<RailItem>('overview')
  // The pack whose detail panel is open (agent-packs plan WP3.2), or null. Cleared when the world
  // changes (the settings are world/chat-scoped, so a stale detail would show the wrong scope).
  const [detailPackId, setDetailPackId] = React.useState<string | null>(null)
  const [packs, setPacks] = React.useState<PackSummary[] | null>(null)
  const [runs, setRuns] = React.useState<StoredRunRecord[]>([])
  const [error, setError] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  // Per-pack open gate state for the active world (id → open). Seeded on load from each summary's
  // resolved `gateOpen` (the list IPC returns the persisted gate for the world/chat passed in), then
  // flipped OPTIMISTICALLY on toggle with rollback on IPC failure (packs are opt-in — default false).
  const [gates, setGates] = React.useState<Record<string, boolean>>({})

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const list = (await api().listAgentPacks(profileId, worldId, activeChatId)) as PackSummary[]
      setPacks(list ?? [])
      // Seed the toggle state from the resolved gate the payload carries (undefined when no world).
      setGates(Object.fromEntries((list ?? []).map((p) => [p.id, p.gateOpen ?? false])))
      if (activeChatId) {
        const history = (await api().listAgentPackRuns(
          profileId,
          activeChatId
        )) as StoredRunRecord[]
        setRuns(history ?? [])
      } else {
        setRuns([])
      }
    } catch {
      setError(true)
      setPacks(null)
    } finally {
      setLoading(false)
    }
  }, [profileId, activeChatId, worldId])

  React.useEffect(() => {
    void load()
  }, [load])

  // Close the detail panel on world change (its settings are world/chat-scoped).
  React.useEffect(() => {
    setDetailPackId(null)
  }, [worldId])

  const detailPack = React.useMemo(
    () => (packs ?? []).find((p) => p.id === detailPackId) ?? null,
    [packs, detailPackId]
  )

  // packId → display name, for Runs-timeline attribution (a run's packIds are opaque ids). A fork
  // shows "<base> (fork N)"; a plain pack shows its manifest name. Ids not in the installed list
  // (e.g. an uninstalled pack that still has runs) fall back to the raw id.
  const packNames = React.useMemo(() => {
    const m: Record<string, string> = {}
    for (const p of packs ?? []) {
      m[p.id] = p.manifest.fork
        ? `${p.manifest.fork.base} (${t('workflowEffective.fork')} ${p.manifest.fork.n})`
        : p.manifest.name
    }
    return m
  }, [packs, t])

  // Optimistic gate flip with rollback on IPC failure. Writes the WORLD scope (chatId null) for the
  // active chat's world. Enabling never confirms; disabling a main-reply-transforming pack is guarded
  // by the cascade popover (handled by the caller before invoking this).
  const flipGate = React.useCallback(
    async (pack: PackSummary, next: boolean) => {
      if (!worldId) return
      const prev = gates[pack.id] ?? false
      setGates((g) => ({ ...g, [pack.id]: next }))
      try {
        await api().setAgentPackGate(pack.id, worldId, null, next)
      } catch {
        setGates((g) => ({ ...g, [pack.id]: prev })) // rollback
      }
    },
    [worldId, gates]
  )

  return (
    <div className="rpt-agents">
      <nav className="rpt-agents-rail" aria-label={t('agents.title')}>
        {(['overview', 'installed', 'runs', 'preview'] as RailItem[]).map((item) => (
          <button
            key={item}
            className={`rpt-agents-rail-item${rail === item ? ' active' : ''}`}
            aria-current={rail === item ? 'page' : undefined}
            onClick={() => setRail(item)}
          >
            {t(`agents.rail.${item}`)}
          </button>
        ))}
      </nav>

      <div className="rpt-agents-content">
        {rail === 'installed' ? (
          <InstalledPane
            profileId={profileId}
            chatId={activeChatId}
            packs={packs}
            runs={runs}
            gates={gates}
            worldId={worldId}
            loading={loading}
            error={error}
            onRetry={() => void load()}
            onFlipGate={flipGate}
            selectedPackId={detailPackId}
            onOpenDetail={setDetailPackId}
            onNavigate={setRail}
          />
        ) : rail === 'runs' ? (
          <RunsPane
            profileId={profileId}
            chatId={activeChatId}
            packNames={packNames}
            initialRuns={runs}
            initialLoading={loading}
          />
        ) : rail === 'preview' ? (
          <PreviewPane profileId={profileId} chatId={activeChatId} />
        ) : (
          <OverviewPane
            profileId={profileId}
            chatId={activeChatId}
            worldId={worldId}
            packs={packs}
            gates={gates}
            runs={runs}
            packNames={packNames}
            loading={loading}
            error={error}
            onRetry={() => void load()}
            onNavigate={setRail}
            onOpenDetail={(id) => {
              setRail('installed')
              setDetailPackId(id)
            }}
          />
        )}
      </div>

      {/* The detail panel (agent-packs plan WP3.2) — a side panel next to the list. Requires a world
          (its settings are world/chat-scoped); it stays closed otherwise. */}
      {rail === 'installed' && detailPack && worldId && (
        <AgentPackDetail
          profileId={profileId}
          packId={detailPack.id}
          packName={
            detailPack.manifest.fork
              ? `${detailPack.manifest.fork.base} (${t('workflowEffective.fork')} ${detailPack.manifest.fork.n})`
              : detailPack.manifest.name
          }
          worldId={worldId}
          chatId={activeChatId}
          onClose={() => setDetailPackId(null)}
        />
      )}
    </div>
  )
}

// Absolute HH:mm for an epoch — the app's absolute-time convention (shared by Runs / Preview / Why /
// Overview so every clock reads the same). One place to change the format.
const formatClockTime = (epochMs: number): string => {
  const d = new Date(epochMs)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

// ── Installed pane ─────────────────────────────────────────────────────────────────────────────────
const InstalledPane: React.FC<{
  profileId: string
  chatId: string | null
  packs: PackSummary[] | null
  runs: StoredRunRecord[]
  gates: Record<string, boolean>
  worldId: string | null
  loading: boolean
  error: boolean
  onRetry: () => void
  onFlipGate: (pack: PackSummary, next: boolean) => void
  selectedPackId: string | null
  onOpenDetail: (packId: string) => void
  onNavigate: (rail: RailItem) => void
}> = ({
  profileId,
  chatId,
  packs,
  runs,
  gates,
  worldId,
  loading,
  error,
  onRetry,
  onFlipGate,
  selectedPackId,
  onOpenDetail,
  onNavigate
}) => {
  const t = useT()

  if (loading && packs === null) {
    // Loading = skeleton rows, not spinners (UX brief).
    return (
      <div className="rpt-agents-list">
        {[0, 1].map((i) => (
          <div key={i} className="rpt-agents-card rpt-agents-skeleton" aria-hidden>
            <div className="rpt-agents-skel-toggle" />
            <div className="rpt-agents-skel-lines">
              <div className="rpt-agents-skel-line" />
              <div className="rpt-agents-skel-line short" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rpt-agents-empty">
        <p>{t('agents.installed.loadError')}</p>
        <button className="btn-accent" onClick={onRetry}>
          {t('agents.retry')}
        </button>
      </div>
    )
  }

  if (!worldId) {
    // No active chat/world — the gate has no world to write to. Designed state (brief: legible +
    // inviting), not a blank div.
    return (
      <div className="rpt-agents-empty">
        <div className="rpt-agents-placeholder-icon" aria-hidden>
          🌍
        </div>
        <h2 className="rpt-agents-placeholder-title">{t('agents.installed.noWorldTitle')}</h2>
        <p className="rpt-agents-placeholder-body">{t('agents.installed.noWorld')}</p>
      </div>
    )
  }

  const list = packs ?? []
  const anyOpen = list.some((p) => gates[p.id])

  return (
    <div className="rpt-agents-list">
      {/* First-run framing: when every gate is closed (the common first-run state), explain what
          packs are and point at the built-ins. Cards themselves still render below. */}
      {!anyOpen && (
        <div className="rpt-agents-intro">
          <strong>{t('agents.installed.introTitle')}</strong>
          <span>{t('agents.installed.introBody')}</span>
        </div>
      )}
      {list.map((pack) => (
        <PackCard
          key={pack.id}
          profileId={profileId}
          chatId={chatId}
          pack={pack}
          open={gates[pack.id] ?? false}
          runs={runs}
          health={packHealth(runs, pack.id)}
          onFlipGate={(next) => onFlipGate(pack, next)}
          selected={selectedPackId === pack.id}
          onOpenDetail={() => onOpenDetail(pack.id)}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  )
}

// ── The pack card (the core visual unit) ─────────────────────────────────────────────────────────
const PackCard: React.FC<{
  profileId: string
  chatId: string | null
  pack: PackSummary
  open: boolean
  runs: StoredRunRecord[]
  health: PackHealth
  onFlipGate: (next: boolean) => void
  selected: boolean
  onOpenDetail: () => void
  onNavigate: (rail: RailItem) => void
}> = ({
  profileId,
  chatId,
  pack,
  open,
  runs,
  health,
  onFlipGate,
  selected,
  onOpenDetail,
  onNavigate
}) => {
  const t = useT()
  const badges = attachmentBadges(pack.attachments)
  const needsCascade = transformsMainReply(pack.attachments)
  const [confirming, setConfirming] = React.useState(false)
  const [whyOpen, setWhyOpen] = React.useState(false)
  // The "Why?" opener — focus returns here when the popover closes (Escape / × / action), so keyboard
  // focus is never lost into a removed subtree.
  const whyBtnRef = React.useRef<HTMLButtonElement>(null)
  const closeWhy = (): void => {
    setWhyOpen(false)
    whyBtnRef.current?.focus()
  }

  // Toggle intent: enabling never confirms; disabling a main-reply-transforming pack opens the
  // cascade popover first. Space/Enter on the toggle triggers the same path (native button).
  const requestFlip = (): void => {
    if (open && needsCascade) {
      setConfirming(true)
      return
    }
    onFlipGate(!open)
  }

  return (
    <div className={`rpt-agents-card${selected ? ' selected' : ''}`}>
      <button
        role="switch"
        aria-checked={open}
        aria-label={t(open ? 'agents.gate.disable' : 'agents.gate.enable', {
          name: pack.manifest.name
        })}
        className={`rpt-agents-gate${open ? ' on' : ''}`}
        onClick={requestFlip}
      >
        <span className="rpt-agents-gate-knob" aria-hidden />
      </button>

      <div className="rpt-agents-card-body">
        <div className="rpt-agents-card-head">
          <span className="rpt-agents-card-name">
            {pack.manifest.fork
              ? `${pack.manifest.fork.base} (${t('workflowEffective.fork')} ${pack.manifest.fork.n})`
              : pack.manifest.name}
          </span>
          {pack.builtin && <span className="rpt-agents-badge-builtin">{t('agents.builtin')}</span>}
          {pack.manifest.fork && (
            <span
              className="rpt-agents-badge-builtin"
              title={t('workflowEffective.forkLineageTitle')}
            >
              {t('workflowEffective.forkFrom', { base: pack.manifest.fork.base })}
            </span>
          )}
          <span className="rpt-agents-card-meta">
            {pack.manifest.creator ? `${pack.manifest.creator} · ` : ''}
            {t('agents.version', { v: pack.version })}
          </span>
        </div>

        {pack.manifest.description && (
          <p className="rpt-agents-card-desc">{pack.manifest.description}</p>
        )}

        {/* Attachment badges — read-only structure. */}
        {badges.length > 0 && (
          <div className="rpt-agents-badges">
            {badges.map((b, i) => (
              <Badge key={i} badge={b} />
            ))}
          </div>
        )}

        {/* Capability chips — write capabilities danger-tinted. */}
        {pack.capabilities.length > 0 && (
          <div className="rpt-agents-chips">
            {pack.capabilities.map((cap) => (
              <span
                key={cap}
                className={`rpt-agents-chip${isWriteCapability(cap) ? ' write' : ''}`}
              >
                {t(`agents.cap.${cap}`)}
              </span>
            ))}
          </div>
        )}

        {/* Health dot + text (dot carries color ≥3:1; label is text-secondary ≥4.5:1 — no
            color-only signaling) + the Settings button (opens the detail panel — WP3.2). */}
        <div className="rpt-agents-cardfoot">
          <div className="rpt-agents-health">
            <span className={`rpt-agents-dot ${health}`} aria-hidden />
            <span className="rpt-agents-health-text">{t(`agents.health.${health}`)}</span>
            {/* "Why?" affordance sits next to the health dot — it answers the question the dot raises. */}
            <div className="rpt-agents-why-wrap">
              <button
                ref={whyBtnRef}
                type="button"
                className="rpt-agents-whybtn"
                aria-expanded={whyOpen}
                aria-haspopup="dialog"
                onClick={() => setWhyOpen((v) => !v)}
              >
                {t('agents.why.open')}
              </button>
              {whyOpen && (
                <WhyPopover
                  profileId={profileId}
                  chatId={chatId}
                  pack={pack}
                  open={open}
                  runs={runs}
                  onClose={closeWhy}
                  onEnable={() => {
                    setWhyOpen(false)
                    onFlipGate(true)
                  }}
                  onViewRun={() => {
                    setWhyOpen(false)
                    onNavigate('runs')
                  }}
                />
              )}
            </div>
          </div>
          <button
            type="button"
            className="rpt-agents-settingsbtn"
            aria-expanded={selected}
            onClick={onOpenDetail}
          >
            {t('agents.settings.open')}
          </button>
        </div>
      </div>

      {confirming && (
        <div
          className="rpt-agents-popover"
          role="dialog"
          aria-modal="false"
          aria-label={t('agents.gate.disable', { name: pack.manifest.name })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setConfirming(false)
            }
          }}
        >
          <p className="rpt-agents-popover-body">{t('agents.cascade.body')}</p>
          <div className="rpt-agents-popover-actions">
            <button className="rpt-duel-secondary" onClick={() => setConfirming(false)} autoFocus>
              {t('agents.cascade.cancel')}
            </button>
            <button
              className="rpt-agents-popover-confirm"
              onClick={() => {
                setConfirming(false)
                onFlipGate(false)
              }}
            >
              {t('agents.cascade.confirm')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// One attachment badge. Plain-language wording driven by phase; headless badges append the trigger
// caption; inline entries are flagged (they transform the main flow).
const Badge: React.FC<{ badge: AttachmentBadge }> = ({ badge }) => {
  const t = useT()
  if (badge.phase === 'headless') {
    return (
      <span className="rpt-agents-badge headless" title={badge.detail}>
        {t('agents.badge.headless')}
        {badge.detail ? ` · ${badge.detail}` : ''}
      </span>
    )
  }
  const phaseLabel = badge.phase === 'before' ? t('agents.badge.before') : t('agents.badge.after')
  const inline = badge.mode === 'inline'
  return (
    <span className={`rpt-agents-badge${inline ? ' inline' : ''}`}>
      {phaseLabel}
      {inline ? ` · ${t('agents.badge.inline')}` : ''}
    </span>
  )
}

// ── "Why?" popover (agent-packs plan WP3.5) ──────────────────────────────────────────────────────
//
// Answers the right question for the pack's current state, in plain language — assembled from LIVE
// state + history (the controller decision: no stored skip-reason). Gate CLOSED → answered instantly
// from the gate flag (no IPC). Gate OPEN with triggers → fetches the read-only explainAgentPackTriggers
// (materialized fragments) to show current-vs-required per trigger; otherwise answers from run history.
// Keyboard: Escape closes + returns focus to the opener; not modal (a lightweight popover), so a click
// elsewhere leaves it (the parent controls open state via the toggle). AA + no color-only signals.
const WhyPopover: React.FC<{
  profileId: string
  chatId: string | null
  pack: PackSummary
  open: boolean
  runs: StoredRunRecord[]
  onClose: () => void
  onEnable: () => void
  onViewRun: () => void
}> = ({ profileId, chatId, pack, open, runs, onClose, onEnable, onViewRun }) => {
  const t = useT()
  const ref = React.useRef<HTMLDivElement>(null)
  const [explains, setExplains] = React.useState<TriggerExplain[]>([])
  const [triggerError, setTriggerError] = React.useState(false)
  const hasTriggers = pack.attachments.some((a) => a.kind === 'trigger')

  // Fetch the read-only trigger explanation only when it can matter (gate open, has triggers, a chat to
  // evaluate against). Never mutates state (WP3.5 IPC is read-only).
  React.useEffect(() => {
    let alive = true
    if (open && hasTriggers && chatId) {
      setTriggerError(false)
      void (async () => {
        try {
          const res = (await api().explainAgentPackTriggers(
            profileId,
            chatId,
            pack.id
          )) as TriggerExplain[]
          if (alive) setExplains(res ?? [])
        } catch {
          if (alive) setTriggerError(true)
        }
      })()
    } else {
      setExplains([])
    }
    return () => {
      alive = false
    }
  }, [open, hasTriggers, chatId, profileId, pack.id])

  // Focus the popover on mount so Escape + Tab are captured; Escape closes and the parent restores
  // focus to the toggle (the button re-renders in place, so focus naturally returns on close).
  React.useEffect(() => {
    ref.current?.focus()
  }, [])

  const headline: ExplainHeadline = React.useMemo(
    () =>
      explainHeadline({
        open,
        attachments: pack.attachments,
        records: runs,
        packId: pack.id,
        triggerExplains: explains
      }),
    [open, pack.attachments, pack.id, runs, explains]
  )

  const lines = React.useMemo(() => explains.map((e) => triggerLine(e)), [explains])
  const addsToPrompt = pack.attachments.some((a) => a.kind === 'rejoin')

  return (
    <div
      ref={ref}
      className="rpt-agents-why"
      role="dialog"
      aria-modal="false"
      aria-label={t('agents.why.title')}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="rpt-agents-why-head">
        <span className="rpt-agents-why-title">{t('agents.why.title')}</span>
        <button
          type="button"
          className="rpt-agents-why-close"
          aria-label={t('agents.why.close')}
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <p className="rpt-agents-why-headline">
        {headline.kind === 'disabled'
          ? t('agents.why.disabled')
          : headline.kind === 'failed'
            ? t('agents.why.failed')
            : headline.kind === 'waiting'
              ? t('agents.why.waiting')
              : headline.kind === 'ranOk'
                ? t('agents.why.ranOk', { time: formatClockTime(headline.ranAt) })
                : headline.kind === 'background'
                  ? t('agents.why.background')
                  : t('agents.why.ready')}
      </p>

      {/* Per-trigger lines (the scannable numbers) — only in the waiting case. */}
      {headline.kind === 'waiting' && (
        <ul className="rpt-agents-why-triggers">
          {lines.map((l, i) => (
            <li key={i} className="rpt-agents-why-trigger">
              {t(l.key, l.vars)}
            </li>
          ))}
        </ul>
      )}

      {triggerError && hasTriggers && (
        <p className="rpt-agents-why-note">{t('agents.why.loadError')}</p>
      )}

      {/* "Doesn't add to prompts" note — relevant when the pack is on, working, and injects nothing. */}
      {open && !addsToPrompt && headline.kind !== 'background' && headline.kind !== 'waiting' && (
        <p className="rpt-agents-why-note">{t('agents.why.noPrompt')}</p>
      )}

      {/* State-specific action: enable shortcut when off; "View run" when the last run failed. */}
      {headline.kind === 'disabled' && (
        <button type="button" className="rpt-agents-why-action" onClick={onEnable}>
          {t('agents.why.enable')}
        </button>
      )}
      {headline.kind === 'failed' && (
        <button type="button" className="rpt-agents-why-action" onClick={onViewRun}>
          {t('agents.why.viewRun')}
        </button>
      )}
    </div>
  )
}

// ── Runs timeline (agent-packs plan WP3.3) ─────────────────────────────────────────────────────────
//
// The reverse-chronological activity feed. Entries interleave turns / headless / manual runs (they
// arrive newest-first by seq). Each entry: origin badge, pack attribution, a one-sentence plain-
// language outcome (runTimeline.outcomeSentence), duration (formatTraceSeconds), start time (HH:mm),
// a trigger caption for headless/manual, and an expandable per-node detail (synthetic __headless_seed_*
// nodes filtered). Filter chips (All + one per pack with runs) filter the LOADED window client-side.
// Paging: "load older" honors the beforeSeq cursor (strictly-less-than; empty page = end). Live-ness:
// refetch page 1 on mount (the pane mounts when the Runs rail is selected) + a manual Refresh button.
// Renderer-only, reuses the WP2.3 listAgentPackRuns IPC + trace data as-is.

const PAGE_LIMIT = 50

const RunsPane: React.FC<{
  profileId: string
  chatId: string | null
  packNames: Record<string, string>
  initialRuns: StoredRunRecord[]
  initialLoading: boolean
}> = ({ profileId, chatId, packNames, initialRuns, initialLoading }) => {
  const t = useT()
  const [records, setRecords] = React.useState<StoredRunRecord[]>(initialRuns)
  const [loading, setLoading] = React.useState(initialLoading)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState(false)
  // null = All; else the packId whose runs are shown (client-side filter over the loaded window).
  const [filter, setFilter] = React.useState<string | null>(null)
  // true once a page came back shorter than the limit (or empty) — no more to request.
  const [atEnd, setAtEnd] = React.useState(false)

  // Fetch page 1 (newest). Called on mount (= pane becomes visible) and by manual Refresh.
  const refresh = React.useCallback(async () => {
    if (!chatId) {
      setRecords([])
      setAtEnd(true)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(false)
    try {
      const page = (await api().listAgentPackRuns(
        profileId,
        chatId,
        undefined,
        PAGE_LIMIT
      )) as StoredRunRecord[]
      setRecords(page ?? [])
      setAtEnd((page ?? []).length < PAGE_LIMIT)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [profileId, chatId])

  // Refresh when the pane mounts (the content area only renders RunsPane while the Runs rail is
  // active, so mount === becoming visible) or the chat changes.
  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const loadMore = React.useCallback(async () => {
    if (!chatId || atEnd || loadingMore) return
    const cursor = nextBeforeSeq(records)
    if (cursor === undefined) {
      setAtEnd(true)
      return
    }
    setLoadingMore(true)
    try {
      const page = (await api().listAgentPackRuns(
        profileId,
        chatId,
        cursor,
        PAGE_LIMIT
      )) as StoredRunRecord[]
      const next = page ?? []
      setRecords((prev) => [...prev, ...next])
      if (next.length < PAGE_LIMIT) setAtEnd(true)
    } catch {
      setError(true)
    } finally {
      setLoadingMore(false)
    }
  }, [profileId, chatId, records, atEnd, loadingMore])

  const chips = React.useMemo(() => packsWithRuns(records), [records])
  const shown = React.useMemo(() => filterRuns(records, filter), [records, filter])

  if (!chatId) {
    return (
      <div className="rpt-agents-empty">
        <div className="rpt-agents-placeholder-icon" aria-hidden>
          💬
        </div>
        <h2 className="rpt-agents-placeholder-title">{t('runs.noWorldTitle')}</h2>
        <p className="rpt-agents-placeholder-body">{t('runs.noWorldBody')}</p>
      </div>
    )
  }

  if (loading && records.length === 0) {
    return (
      <div className="rpt-runs">
        <div className="rpt-runs-list">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rpt-runs-entry rpt-agents-skeleton" aria-hidden>
              <div className="rpt-runs-skel-badge" />
              <div className="rpt-agents-skel-lines">
                <div className="rpt-agents-skel-line" />
                <div className="rpt-agents-skel-line short" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error && records.length === 0) {
    return (
      <div className="rpt-agents-empty">
        <p>{t('runs.loadError')}</p>
        <button className="btn-accent" onClick={() => void refresh()}>
          {t('agents.retry')}
        </button>
      </div>
    )
  }

  return (
    <div className="rpt-runs">
      <div className="rpt-runs-toolbar">
        <div className="rpt-runs-chips" role="group" aria-label={t('agents.rail.runs')}>
          <button
            className={`rpt-runs-chip${filter === null ? ' active' : ''}`}
            aria-pressed={filter === null}
            onClick={() => setFilter(null)}
          >
            {t('runs.filter.all')}
          </button>
          {chips.map((packId) => (
            <button
              key={packId}
              className={`rpt-runs-chip${filter === packId ? ' active' : ''}`}
              aria-pressed={filter === packId}
              onClick={() => setFilter(packId)}
            >
              {packNames[packId] ?? packId}
            </button>
          ))}
        </div>
        <button
          className="rpt-agents-settingsbtn"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {t('runs.refresh')}
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="rpt-agents-empty">
          <div className="rpt-agents-placeholder-icon" aria-hidden>
            ↻
          </div>
          <h2 className="rpt-agents-placeholder-title">{t('runs.emptyTitle')}</h2>
          <p className="rpt-agents-placeholder-body">{t('runs.emptyBody')}</p>
        </div>
      ) : (
        <>
          <ol className="rpt-runs-list">
            {shown.map((r) => (
              <RunEntry key={r.runId} record={r} packNames={packNames} />
            ))}
          </ol>
          {/* Load-more honors the beforeSeq cursor. The chip filter narrows only the loaded window,
              so paging always fetches from the FULL feed (filtering happens after). Hidden at end. */}
          {filter === null && !atEnd && (
            <div className="rpt-runs-more">
              <button
                className="rpt-agents-settingsbtn"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? t('runs.loadingMore') : t('runs.loadMore')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// One timeline entry. Origin badge + attribution + outcome + meta (duration/time), an optional
// trigger caption (headless/manual), and an expandable node detail. Failed/aborted runs get the
// danger accent; a failed-branch-in-ok-run is a softer warning accent (the reply was unaffected).
const RunEntry: React.FC<{ record: StoredRunRecord; packNames: Record<string, string> }> = ({
  record,
  packNames
}) => {
  const t = useT()
  const tOpt = useOptionalT()
  const [open, setOpen] = React.useState(false)

  const facts = React.useMemo(() => runFacts(record.trace), [record.trace])
  const sentence = React.useMemo(() => outcomeSentence(facts), [facts])
  const groups = React.useMemo(() => detailGroups(record.trace), [record.trace])

  // Localize a node TYPE to its title (reuses the editor's nodeTitle keys; raw type as fallback —
  // same pattern as WorkflowView's trace panel).
  const nodeTitle = (type: string): string => tOpt(`workflowEditor.nodeTitle.${type}`) || type

  // The outcome sentence: resolve failedNodeType → localized title, pass as {{node}}, then translate.
  const outcome = translateOutcome(t, nodeTitle, sentence)

  const tone = facts.runFailed ? 'failed' : facts.branchFailedInOkRun ? 'branch-failed' : 'ok'
  const attribution =
    record.packIds.length === 0
      ? t('runs.narratorTurn')
      : record.packIds.map((id) => packNames[id] ?? id).join(t('runs.packSep'))
  const originGlyph = record.origin === 'turn' ? '💬' : record.origin === 'headless' ? '◷' : '▶'

  return (
    <li className={`rpt-runs-entry tone-${tone}`}>
      <button
        className="rpt-runs-entry-main"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={`rpt-runs-origin ${record.origin}`}
          title={t(`runs.origin.${record.origin}Title`)}
          aria-label={t(`runs.origin.${record.origin}`)}
        >
          <span aria-hidden>{originGlyph}</span>
        </span>
        <span className="rpt-runs-entry-body">
          <span className="rpt-runs-entry-head">
            <span className="rpt-runs-attr">{attribution}</span>
            <span className="rpt-runs-meta">
              {formatTraceSeconds(record.trace.durationMs)} ·{' '}
              {formatClockTime(record.trace.startedAt)}
            </span>
          </span>
          <span className="rpt-runs-outcome">{outcome}</span>
          {record.trigger && (
            <span className="rpt-runs-trigger">
              {t('runs.triggerCaption', { trigger: record.trigger })}
            </span>
          )}
          {/* The fatal error surfaced on the entry (WorkflowRunTrace.error), for failed/aborted runs. */}
          {record.trace.error && (
            <span className="rpt-runs-error">{record.trace.error.message}</span>
          )}
        </span>
        <span className="rpt-runs-caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && <RunDetail groups={groups} nodeTitle={nodeTitle} packNames={packNames} />}
    </li>
  )
}

// The expanded per-node detail: narrator group + one group per contributing pack (headless-seed nodes
// already filtered by detailGroups). Each node shows its localized title, status, per-node ms, and the
// error message when failed.
const RunDetail: React.FC<{
  groups: DetailGroup[]
  nodeTitle: (type: string) => string
  packNames: Record<string, string>
}> = ({ groups, nodeTitle, packNames }) => {
  const t = useT()
  return (
    <div className="rpt-runs-detail">
      {groups.map((g, gi) => (
        <div key={gi} className="rpt-runs-group">
          <div className="rpt-runs-group-head">
            {g.packId === null ? t('runs.detail.narratorGroup') : (packNames[g.packId] ?? g.packId)}
          </div>
          {g.nodes.map((n, ni) => (
            <div key={ni} className={`rpt-runs-node status-${n.status}`}>
              <span className={`rpt-runs-node-status ${n.status}`}>
                {t(`runs.detail.status.${n.status}`)}
              </span>
              <span className="rpt-runs-node-title">{nodeTitle(n.nodeType)}</span>
              {n.ms !== undefined && (
                <span className="rpt-runs-node-ms">{formatTraceSeconds(n.ms)}</span>
              )}
              {n.error && <span className="rpt-runs-node-error">{n.error.message}</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// ── Injection preview pane (agent-packs plan WP3.4) ──────────────────────────────────────────────────
//
// The trust surface: exactly what will enter the next prompt, section by section, attributed per source
// (ADR 0002). Fetches on mount (the pane mounts when the Preview rail is selected) + on the Refresh
// button — NEVER auto-polls (the preview builds a GenContext that reads all floors — WP2.2 note). A total-
// tokens summary at top (estimated — the app has no real tokenizer), each section with a source chip
// (pack chips reuse the WP3.1 pack-chip look) + right-aligned token count + per-section expand to full
// text, and a muted "omitted" group with reasons. Skeleton loading, designed no-chat/empty/error states.

const PreviewPane: React.FC<{ profileId: string; chatId: string | null }> = ({
  profileId,
  chatId
}) => {
  const t = useT()
  const [preview, setPreview] = React.useState<NextPromptPreviewData | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)

  const load = React.useCallback(async () => {
    if (!chatId) {
      setPreview(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(false)
    try {
      const p = (await api().previewNextPrompt(profileId, chatId, '')) as NextPromptPreviewData
      setPreview(p ?? null)
    } catch {
      setError(true)
      setPreview(null)
    } finally {
      setLoading(false)
    }
  }, [profileId, chatId])

  // Fetch on mount (the content area only renders PreviewPane while the Preview rail is active, so mount
  // === becoming visible) or when the chat changes. On demand only — never a poll.
  React.useEffect(() => {
    void load()
  }, [load])

  if (!chatId) {
    return (
      <div className="rpt-agents-empty">
        <div className="rpt-agents-placeholder-icon" aria-hidden>
          ⌦
        </div>
        <h2 className="rpt-agents-placeholder-title">{t('preview.noChatTitle')}</h2>
        <p className="rpt-agents-placeholder-body">{t('preview.noChatBody')}</p>
      </div>
    )
  }

  if (loading && preview === null) {
    return (
      <div className="rpt-preview">
        <div className="rpt-preview-list">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rpt-preview-section rpt-agents-skeleton" aria-hidden>
              <div className="rpt-agents-skel-lines">
                <div className="rpt-agents-skel-line" />
                <div className="rpt-agents-skel-line short" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error || (preview && preview.error === 'failed')) {
    return (
      <div className="rpt-agents-empty">
        <p>{t('preview.errorTitle')}</p>
        <p className="rpt-agents-placeholder-body">{t('preview.errorBody')}</p>
        <button className="btn-accent" onClick={() => void load()}>
          {t('agents.retry')}
        </button>
      </div>
    )
  }

  if (preview && preview.error === 'no-chat') {
    return (
      <div className="rpt-agents-empty">
        <div className="rpt-agents-placeholder-icon" aria-hidden>
          ⌦
        </div>
        <h2 className="rpt-agents-placeholder-title">{t('preview.noChatTitle')}</h2>
        <p className="rpt-agents-placeholder-body">{t('preview.noChatBody')}</p>
      </div>
    )
  }

  const sections = preview?.sections ?? []
  const omitted = preview?.omitted ?? []
  const total = tokenTotal(sections)

  return (
    <div className="rpt-preview">
      <div className="rpt-preview-header">
        <div className="rpt-preview-heading">
          <h2 className="rpt-preview-title">{t('preview.title')}</h2>
          <p className="rpt-preview-subtitle">{t('preview.subtitle')}</p>
        </div>
        <div className="rpt-preview-toolbar">
          <span className="rpt-preview-total">
            {total.estimated
              ? t('preview.totalTokensEst', { n: total.total })
              : t('preview.totalTokens', { n: total.total })}
          </span>
          {preview && (
            <span className="rpt-preview-time">
              {t('preview.generatedAt', { time: formatClockTime(preview.generatedAt) })}
            </span>
          )}
          <button className="rpt-agents-settingsbtn" onClick={() => void load()} disabled={loading}>
            {t('preview.refresh')}
          </button>
        </div>
      </div>

      {sections.length === 0 ? (
        <div className="rpt-agents-empty">
          <div className="rpt-agents-placeholder-icon" aria-hidden>
            ⌦
          </div>
          <h2 className="rpt-agents-placeholder-title">{t('preview.emptyTitle')}</h2>
          <p className="rpt-agents-placeholder-body">{t('preview.emptyBody')}</p>
        </div>
      ) : (
        <ol className="rpt-preview-list">
          {sections.map((s, i) => (
            <PreviewSectionRow key={i} section={s} />
          ))}
        </ol>
      )}

      {omitted.length > 0 && (
        <div className="rpt-preview-omitted">
          <div className="rpt-preview-omitted-head">{t('preview.omittedTitle')}</div>
          <ul className="rpt-preview-omitted-list">
            {omitted.map((o, i) => (
              <PreviewOmittedRow key={i} item={o} />
            ))}
          </ul>
          <p className="rpt-preview-omitted-note">{t('preview.omittedNote')}</p>
        </div>
      )}
    </div>
  )
}

// One preview source chip — a pack chip (reuses the WP3.1 pack-chip look) or a plain kind chip.
const PreviewSourceChip: React.FC<{ source: PreviewSectionData['source'] }> = ({ source }) => {
  const t = useT()
  const chip = sourceChip(source)
  if (chip.isPack) {
    return <span className="rpt-agents-chip rpt-preview-chip-pack">{chip.name}</span>
  }
  return <span className="rpt-preview-chip">{t(chip.labelKey)}</span>
}

// One section row: label + source chip on the left, right-aligned token count (with an 'est.' marker),
// and a per-section expand to the full text (a monospace-ish, height-capped scroll block).
const PreviewSectionRow: React.FC<{ section: PreviewSectionData }> = ({ section }) => {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  return (
    <li className={`rpt-preview-section${open ? ' open' : ''}`}>
      <button
        className="rpt-preview-section-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="rpt-preview-section-label">{t(sectionLabelKey(section.id))}</span>
        <PreviewSourceChip source={section.source} />
        <span className="rpt-preview-section-tokens">
          {section.tokens}
          {section.estimated && <span className="rpt-preview-est"> {t('preview.est')}</span>}
        </span>
        <span className="rpt-preview-caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <pre className="rpt-preview-section-text" aria-label={t('preview.expand')}>
          {section.text}
        </pre>
      )}
    </li>
  )
}

// One omitted-group row: a muted chip/label + the reason. A pack source shows the pack name.
const PreviewOmittedRow: React.FC<{ item: PreviewOmittedData }> = ({ item }) => {
  const t = useT()
  return (
    <li className="rpt-preview-omitted-item">
      <span className="rpt-preview-omitted-label">{item.label}</span>
      <span className="rpt-preview-omitted-reason">{t(omittedReasonKey(item.reason))}</span>
    </li>
  )
}

// ── Overview pane (agent-packs plan WP3.5) — the landing view ─────────────────────────────────────
//
// "Is everything working?" in one glance. Four blocks (UX brief §Overview): (1) at-a-glance ACTIVE
// packs (compact rows — name, on/off, health dot, one-line last outcome via the shared sentence
// builder; click → Installed detail), (2) a SETUP CHECKLIST grounded in real, cheaply-knowable state
// (has a world? any pack on? memory template assigned when a memory pack is on?), (3) a RECENT ERRORS
// strip (failed runs, newest few, jump to Runs), (4) QUICK LINKS (Preview, Workflow Studio Effective).
// All derivations are pure (./agentExplain.ts); this component only fetches the memory-template flag
// (cheap) + renders. Designed no-chat / all-clear states. Renderer-only.
const OverviewPane: React.FC<{
  profileId: string
  chatId: string | null
  worldId: string | null
  packs: PackSummary[] | null
  gates: Record<string, boolean>
  runs: StoredRunRecord[]
  packNames: Record<string, string>
  loading: boolean
  error: boolean
  onRetry: () => void
  onNavigate: (rail: RailItem) => void
  onOpenDetail: (packId: string) => void
}> = ({
  profileId,
  chatId,
  worldId,
  packs,
  gates,
  runs,
  packNames,
  loading,
  error,
  onRetry,
  onNavigate,
  onOpenDetail
}) => {
  const t = useT()
  const tOpt = useOptionalT()
  const openWorkflowEditor = useUiStore((s) => s.openWorkflowEditor)
  const nodeTitle = (type: string): string => tOpt(`workflowEditor.nodeTitle.${type}`) || type

  const list = packs ?? []
  const enabled = React.useMemo(() => list.filter((p) => gates[p.id]), [list, gates])
  // A "memory pack" writes tables — the one whose usefulness depends on a table template being assigned.
  const memoryPackEnabled = React.useMemo(
    () => enabled.some((p) => p.capabilities.includes('writes-tables')),
    [enabled]
  )

  // The one piece of state not already in hand: is a table template assigned to this chat (only matters
  // when a memory pack is on). Cheap read; fetched on mount / when the memory-pack condition changes.
  const [memoryTemplateAssigned, setMemoryTemplateAssigned] = React.useState(false)
  React.useEffect(() => {
    let alive = true
    if (memoryPackEnabled && chatId) {
      void (async () => {
        try {
          const tmpl = (await api().getChatTableTemplate(profileId, chatId)) as string | null
          if (alive) setMemoryTemplateAssigned(!!tmpl)
        } catch {
          if (alive) setMemoryTemplateAssigned(false)
        }
      })()
    } else {
      setMemoryTemplateAssigned(false)
    }
    return () => {
      alive = false
    }
  }, [memoryPackEnabled, chatId, profileId])

  if (!worldId) {
    return (
      <div className="rpt-agents-empty">
        <div className="rpt-agents-placeholder-icon" aria-hidden>
          ◎
        </div>
        <h2 className="rpt-agents-placeholder-title">{t('agents.overview.noWorldTitle')}</h2>
        <p className="rpt-agents-placeholder-body">{t('agents.overview.noWorldBody')}</p>
        <p className="rpt-agents-placeholder-hint">{t('agents.overview.packsExplainer')}</p>
      </div>
    )
  }

  if (loading && packs === null) {
    return (
      <div className="rpt-overview">
        {[0, 1].map((i) => (
          <div key={i} className="rpt-overview-card rpt-agents-skeleton" aria-hidden>
            <div className="rpt-agents-skel-lines">
              <div className="rpt-agents-skel-line" />
              <div className="rpt-agents-skel-line short" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rpt-agents-empty">
        <p>{t('agents.overview.loadError')}</p>
        <button className="btn-accent" onClick={onRetry}>
          {t('agents.retry')}
        </button>
      </div>
    )
  }

  const checklist = setupChecklist({
    hasWorld: !!worldId,
    anyEnabled: enabled.length > 0,
    memoryPackEnabled,
    memoryTemplateAssigned
  })
  const errors = recentErrors(runs, 3)

  const checkFix: Record<string, { label: string; go: () => void }> = {
    'has-world': {
      label: t('agents.overview.check.hasWorldFix'),
      go: () => onNavigate('installed')
    },
    'any-enabled': {
      label: t('agents.overview.check.anyEnabledFix'),
      go: () => onNavigate('installed')
    },
    'memory-template': {
      label: t('agents.overview.check.memoryTemplateFix'),
      // Make the Tables view available (its assignment control lives there). ensureLeftPanel is the
      // documented "surface this view" op — the Agents view can't switch the fill panel from here.
      go: () => useWorkspaceStore.getState().ensureLeftPanel('tables')
    }
  }

  return (
    <div className="rpt-overview">
      <header className="rpt-overview-header">
        <h2 className="rpt-overview-heading">{t('agents.overview.heading')}</h2>
        <p className="rpt-overview-subtitle">{t('agents.overview.subtitle')}</p>
      </header>

      {/* (1) Active packs — compact rows. */}
      <section className="rpt-overview-section" aria-labelledby="ov-active">
        <h3 id="ov-active" className="rpt-overview-sectiontitle">
          {t('agents.overview.activeTitle')}
        </h3>
        {enabled.length === 0 ? (
          <p className="rpt-overview-empty">{t('agents.overview.activeEmpty')}</p>
        ) : (
          <ul className="rpt-overview-active">
            {enabled.map((pack) => {
              const row = activePackRow(runs, pack.id)
              const health = packHealth(runs, pack.id)
              const name = packNames[pack.id] ?? pack.manifest.name
              const outcome = row.sentence
                ? translateOutcome(t, nodeTitle, row.sentence)
                : t('agents.overview.neverRan')
              return (
                <li key={pack.id}>
                  <button
                    type="button"
                    className="rpt-overview-activerow"
                    onClick={() => onOpenDetail(pack.id)}
                  >
                    <span className={`rpt-agents-dot ${health}`} aria-hidden />
                    <span className="rpt-overview-activename">{name}</span>
                    <span className="rpt-overview-activeoutcome">{outcome}</span>
                    <span className="rpt-overview-activehealth">
                      {t(`agents.health.${health}`)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* (2) Setup checklist — real state; unchecked items are actions. */}
      <section className="rpt-overview-section" aria-labelledby="ov-check">
        <h3 id="ov-check" className="rpt-overview-sectiontitle">
          {t('agents.overview.checklistTitle')}
        </h3>
        <ul className="rpt-overview-checklist">
          {checklist.map((item) => (
            <li key={item.id} className={`rpt-overview-checkitem${item.done ? ' done' : ''}`}>
              <span className={`rpt-overview-checkmark ${item.done ? 'done' : 'todo'}`} aria-hidden>
                {item.done ? '✓' : '○'}
              </span>
              <span className="rpt-overview-checklabel">
                {t(`agents.overview.check.${camel(item.id)}`)}
              </span>
              {item.done ? (
                <span className="rpt-overview-checkstatus">{t('agents.overview.checkDone')}</span>
              ) : (
                <button
                  type="button"
                  className="rpt-overview-checkfix"
                  onClick={checkFix[item.id].go}
                >
                  {checkFix[item.id].label}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* (3) Recent problems strip. */}
      <section className="rpt-overview-section" aria-labelledby="ov-errors">
        <h3 id="ov-errors" className="rpt-overview-sectiontitle">
          {t('agents.overview.errorsTitle')}
        </h3>
        {errors.length === 0 ? (
          <p className="rpt-overview-empty">{t('agents.overview.errorsAllGood')}</p>
        ) : (
          <ul className="rpt-overview-errors">
            {errors.map((r) => {
              const attribution =
                r.packIds.length === 0
                  ? t('runs.narratorTurn')
                  : r.packIds.map((id) => packNames[id] ?? id).join(t('runs.packSep'))
              const sentence = translateOutcome(t, nodeTitle, outcomeSentence(runFacts(r.trace)))
              return (
                <li key={r.runId} className="rpt-overview-erroritem">
                  <span className="rpt-agents-dot failed" aria-hidden />
                  <span className="rpt-overview-errorattr">{attribution}</span>
                  <span className="rpt-overview-erroroutcome">
                    {r.trace.error?.message ?? sentence}
                  </span>
                  <button
                    type="button"
                    className="rpt-overview-errorview"
                    onClick={() => onNavigate('runs')}
                  >
                    {t('agents.overview.errorsView')}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* (4) Quick links. */}
      <section className="rpt-overview-section" aria-labelledby="ov-links">
        <h3 id="ov-links" className="rpt-overview-sectiontitle">
          {t('agents.overview.linksTitle')}
        </h3>
        <div className="rpt-overview-links">
          <button type="button" className="rpt-overview-link" onClick={() => onNavigate('preview')}>
            {t('agents.overview.linkPreview')}
          </button>
          <button
            type="button"
            className="rpt-overview-link"
            onClick={() => openWorkflowEditor({ initialMode: 'effective' })}
          >
            {t('agents.overview.linkStudio')}
          </button>
        </div>
      </section>
    </div>
  )
}

/** ChecklistItem ids are kebab (has-world); the i18n keys are camel (hasWorld). One tiny mapper keeps
 *  the pure module's ids stable while the locale keys stay readable. */
const camel = (id: string): string => id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

// Render an OutcomeSentence: when it names a failed node TYPE, localize it to a title and pass it as
// the {{node}} var, then translate the sentence key. (Kept out of the pure module — it needs t().)
function translateOutcome(
  t: (key: string, vars?: Record<string, string | number>) => string,
  nodeTitle: (type: string) => string,
  sentence: ReturnType<typeof outcomeSentence>
): string {
  const vars = { ...sentence.vars }
  if (sentence.failedNodeType) vars.node = nodeTitle(sentence.failedNodeType)
  return t(sentence.key, vars)
}
