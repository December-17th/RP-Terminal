// The Agents workspace (agent-packs plan WP3.1) — the design keystone of the Agent Packs feature.
//
// A left rail (Overview / Installed / Runs / Preview) + a content area (NOT tabs-in-tabs, per the UX
// brief IA). Overview / Runs / Preview are DESIGNED-EMPTY placeholders in this WP (they are built in
// WP3.3–3.5); Installed is the real deliverable: the pack list with the full pack-card treatment —
// gate toggle (optimistic flip + rollback + cascade confirm), attachment badges, capability chips,
// and a health dot from run history.
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
import { useT } from '../../i18n'
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
          />
        ) : (
          <PlaceholderPane rail={rail} />
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

// ── Placeholder panes (Overview / Runs / Preview) — designed empty states, NOT blank divs. Each
//    says what will appear there (they are WP3.3–3.5). Overview additionally carries the "what packs
//    are + point at the built-ins" framing the brief asks for on first run. ─────────────────────────
const PlaceholderPane: React.FC<{ rail: RailItem }> = ({ rail }) => {
  const t = useT()
  return (
    <div className="rpt-agents-placeholder">
      <div className="rpt-agents-placeholder-icon" aria-hidden>
        {rail === 'overview' ? '◎' : rail === 'runs' ? '↻' : '⌦'}
      </div>
      <h2 className="rpt-agents-placeholder-title">{t(`agents.${rail}.title`)}</h2>
      <p className="rpt-agents-placeholder-body">{t(`agents.${rail}.placeholder`)}</p>
      {rail === 'overview' && (
        <p className="rpt-agents-placeholder-hint">{t('agents.overview.packsExplainer')}</p>
      )}
    </div>
  )
}

// ── Installed pane ─────────────────────────────────────────────────────────────────────────────────
const InstalledPane: React.FC<{
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
}> = ({
  packs,
  runs,
  gates,
  worldId,
  loading,
  error,
  onRetry,
  onFlipGate,
  selectedPackId,
  onOpenDetail
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
          pack={pack}
          open={gates[pack.id] ?? false}
          health={packHealth(runs, pack.id)}
          onFlipGate={(next) => onFlipGate(pack, next)}
          selected={selectedPackId === pack.id}
          onOpenDetail={() => onOpenDetail(pack.id)}
        />
      ))}
    </div>
  )
}

// ── The pack card (the core visual unit) ─────────────────────────────────────────────────────────
const PackCard: React.FC<{
  pack: PackSummary
  open: boolean
  health: PackHealth
  onFlipGate: (next: boolean) => void
  selected: boolean
  onOpenDetail: () => void
}> = ({ pack, open, health, onFlipGate, selected, onOpenDetail }) => {
  const t = useT()
  const badges = attachmentBadges(pack.attachments)
  const needsCascade = transformsMainReply(pack.attachments)
  const [confirming, setConfirming] = React.useState(false)

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
            <span className="rpt-agents-badge-builtin" title={t('workflowEffective.forkLineageTitle')}>
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
        <div className="rpt-agents-popover" role="dialog" aria-modal="false">
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
