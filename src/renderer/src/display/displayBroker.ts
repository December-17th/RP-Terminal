// src/renderer/src/display/displayBroker.ts
//
// Renderer-side half of the DisplayHost render broker (ADR 0023, docs/display-host-design.md §3.5).
//
// The display transform is renderer-only (regex/settings/character stores + the quickjs EJS engine), so
// a WCV card that owns the chat rect cannot be served from main. This module runs independent of which
// workspace surface is mounted (registered at app start, alongside initCardEventBridge) and owns three
// jobs:
//   (a) answer `display-render-request` from main — render the requested floor window through the
//       headless pipeline, mapped to RenderedFloorView, LRU-cached by (chatId, floorIndex, swipeId,
//       revision);
//   (b) the display REVISION counter — bump on regex / settings-flag / character / persona change, push
//       it to main (so the sync getter can answer), and broadcast `display_invalidated` to watched chats;
//   (c) the streaming feed — at the native rateChars checkpoint cadence, broadcast `display_stream_frame`
//       for chats with ≥1 opted-in panel.
//
// The pure helpers (revisionReason / frameCheckpoint / shouldEmitFrame / toRenderedFloorView) are
// exported so the bump matrix + checkpoint cadence + mapping unit-test without stores or IPC.
import { messagesToFloors } from '../../../shared/thRuntime/shapes'
import { splitReasoning } from '../../../shared/responseView'
import type {
  RenderedFloorView,
  DisplayStreamFrame,
  DisplayInvalidateReason
} from '../../../shared/thRuntime/displayView'
import {
  currentDisplayCtx,
  renderFloorView,
  renderStreamingFrame,
  type DisplayCtx,
  type FloorLike,
  type RenderMarkers
} from './displayPipeline'
import type { RenderedFloor } from '../components/FloorBlock'
import { broadcastHostEvent } from '../cardBridge/hostBroadcast'
import { useChatStore } from '../stores/chatStore'
import { useRegexStore } from '../stores/regexStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useCharacterStore } from '../stores/characterStore'

// --- pure helpers (unit-tested) ------------------------------------------------------------------

/** The store-derived inputs the display pipeline reads, snapshotted for revision-change detection. */
export interface RevisionSnapshot {
  rules: unknown
  plotRules: unknown
  reasoningRules: unknown
  templatesOn: boolean
  renderEnabled: boolean
  finalPassOn: boolean
  liveOn: boolean
  rateChars: number
  characterId: string | null
  charName: string
  reasoningTemplate: string | null
  persona: string
}

/**
 * Why the display revision should bump between two snapshots, or `null` if nothing the pipeline reads
 * changed. Regex identity first, then the settings flags, then character, then persona — so a single
 * store transition maps to exactly ONE reason (and an unrelated change → identical snapshot → null).
 * The 'character' reason covers an active-card EDIT as well as a switch: the pipeline reads the card's
 * name for {{char}} and the broker embeds its reasoning_template into cached views, so a same-id change
 * to either (name / reasoning_template) must bump the revision too, not just a characterId change.
 */
export function revisionReason(
  prev: RevisionSnapshot,
  next: RevisionSnapshot
): DisplayInvalidateReason | null {
  if (
    prev.rules !== next.rules ||
    prev.plotRules !== next.plotRules ||
    prev.reasoningRules !== next.reasoningRules
  )
    return 'regex'
  if (
    prev.templatesOn !== next.templatesOn ||
    prev.renderEnabled !== next.renderEnabled ||
    prev.finalPassOn !== next.finalPassOn ||
    prev.liveOn !== next.liveOn ||
    prev.rateChars !== next.rateChars
  )
    return 'settings'
  if (
    prev.characterId !== next.characterId ||
    prev.charName !== next.charName ||
    prev.reasoningTemplate !== next.reasoningTemplate
  )
    return 'character'
  if (prev.persona !== next.persona) return 'persona'
  return null
}

/** The streaming checkpoint index for a body length — `floor(len / rateChars)` (native cadence). */
export function frameCheckpoint(bodyLen: number, rateChars: number): number {
  return Math.floor(bodyLen / Math.max(1, rateChars))
}

/**
 * Whether a new streaming frame should be emitted: only at a fresh checkpoint boundary (≥1, i.e. the
 * body has crossed `rateChars`), and never twice within the same checkpoint. Below rateChars → no frame.
 */
export function shouldEmitFrame(prevCheckpoint: number, bodyLen: number, rateChars: number): boolean {
  const cp = frameCheckpoint(bodyLen, rateChars)
  return cp >= 1 && cp !== prevCheckpoint
}

/**
 * Map a pipeline `RenderedFloor` to the card-facing `RenderedFloorView`. `plotHtml` is the caller-applied
 * placement-1⊕2 pass over the raw plot_block (PlotPanel's own transform); `userText` is the raw
 * user_message (native parity); `hasReasoning` derives from the post-placement-6 thinking text.
 */
export function toRenderedFloorView(
  rendered: RenderedFloor,
  opts: { floorIndex: number; revision: number; reasoningTemplate: string | null; plotHtml: string }
): RenderedFloorView {
  return {
    floorIndex: opts.floorIndex,
    revision: opts.revision,
    userText: rendered.user,
    html: rendered.html,
    thinking: rendered.thinking,
    hasReasoning: rendered.thinking !== '',
    reasoningTemplate: opts.reasoningTemplate,
    plotHtml: opts.plotHtml,
    swipeId: rendered.swipeId,
    swipeCount: rendered.swipeCount
  }
}

/** Render ONE floor to a RenderedFloorView through the pipeline + the plot pass. */
export function renderFloorToView(
  floor: FloorLike,
  floorIndex: number,
  ctx: DisplayCtx,
  revision: number,
  reasoningTemplate: string | null
): RenderedFloorView {
  const rendered = renderFloorView(floor, ctx)
  const plotHtml = rendered.plotBlock
    ? ctx.applyPlot(rendered.plotBlock, { user: ctx.user, char: ctx.char })
    : ''
  return toRenderedFloorView(rendered, { floorIndex, revision, reasoningTemplate, plotHtml })
}

/**
 * A cheap 32-bit djb2 hash (hex) over a floor's content-bearing fields — response body, MVU variables,
 * and plot_block. Folded into the render-cache key so an edited message, a deleted floor (index shift),
 * or a variables write can never serve stale rendered html: the swipe_id + revision alone don't move when
 * only floor CONTENT changes. Pure + exported so it unit-tests directly.
 */
export function floorContentStamp(f: FloorLike): string {
  const s = `${f.response.content} ${JSON.stringify(f.variables ?? {})} ${f.plot_block ?? ''}`
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

/** A tiny insertion-ordered LRU (get promotes; set evicts the oldest past `cap`). */
class Lru<V> {
  private readonly m = new Map<string, V>()
  constructor(private readonly cap: number) {}
  get(k: string): V | undefined {
    const v = this.m.get(k)
    if (v !== undefined) {
      this.m.delete(k)
      this.m.set(k, v)
    }
    return v
  }
  set(k: string, v: V): void {
    if (this.m.has(k)) this.m.delete(k)
    this.m.set(k, v)
    if (this.m.size > this.cap) {
      const oldest = this.m.keys().next().value
      if (oldest !== undefined) this.m.delete(oldest)
    }
  }
}

// --- store snapshot + floor resolution -----------------------------------------------------------

function revisionSnapshot(): RevisionSnapshot {
  const settings = useSettingsStore.getState().settings
  const templates = settings?.templates
  const rx = useRegexStore.getState()
  const activeCharacter = useCharacterStore.getState().activeCharacter
  const templatesOn = templates?.enabled !== false
  const renderEnabled = templates?.render?.enabled !== false
  return {
    rules: rx.rules,
    plotRules: rx.plotRules,
    reasoningRules: rx.reasoningRules,
    templatesOn,
    renderEnabled,
    finalPassOn: templates?.render?.final_pass !== false,
    liveOn: templatesOn && renderEnabled && templates?.render?.live !== false,
    rateChars: Math.max(1, (templates?.render?.rate_tokens || 500) * 4),
    characterId: activeCharacter?.id ?? null,
    charName: activeCharacter?.card.data.name || 'Character',
    reasoningTemplate:
      (activeCharacter?.card?.data?.extensions?.rp_terminal?.reasoning_template as
        | string
        | undefined) ?? null,
    persona: settings?.persona?.name || 'User'
  }
}

/** Normalize a chatScope synthetic floor (user_message/response only) into a full pipeline FloorLike. */
function normalizeScopeFloor(
  m: { user_message?: { content?: string }; response?: { content?: string } },
  i: number
): FloorLike {
  return {
    floor: i,
    response: { content: m.response?.content ?? '' },
    user_message: { content: m.user_message?.content ?? '' },
    variables: {}
  }
}

/**
 * The floors the request should index into — chatScope-consistent with the panel's `floors()` view:
 *   - scope present → the panel's synthetic floors (messagesToFloors), so indices match the card's view;
 *   - the requested chat is active → the live chatStore floors;
 *   - otherwise → fetch them (a background chat a card is paging).
 */
async function resolveFloors(req: {
  profileId: string
  chatId: string
  scope?: unknown
}): Promise<FloorLike[]> {
  const scope = req.scope as { messages?: Array<{ role: 'user' | 'assistant'; content: string }> } | undefined
  if (scope?.messages?.length) return messagesToFloors(scope.messages).map(normalizeScopeFloor)
  const cs = useChatStore.getState()
  if (cs.activeChatId === req.chatId) return cs.floors as unknown as FloorLike[]
  const fetched = await window.api.getFloors(req.profileId, req.chatId)
  return Array.isArray(fetched) ? (fetched as FloorLike[]) : []
}

/** The active character card's reasoning_template — only when the request targets the active chat. */
function reasoningTemplateFor(chatId: string): string | null {
  if (useChatStore.getState().activeChatId !== chatId) return null
  const ac = useCharacterStore.getState().activeCharacter
  return (ac?.card?.data?.extensions?.rp_terminal?.reasoning_template as string | undefined) ?? null
}

/**
 * The [RENDER:*] marker templates for a chat — the SAME `window.api.getRenderMarkers(profileId, chatId)`
 * source ChatView reads (ChatView.tsx:104), so a card's floor html gets the identical marker wrapping.
 * ChatView refetches only on chat/profile change; the broker refetches per render request (a superset of
 * that) and folds the markers into the LRU key (below) so a marker change never serves stale output.
 */
async function fetchRenderMarkers(profileId: string, chatId: string): Promise<RenderMarkers> {
  try {
    const m = await window.api.getRenderMarkers(profileId, chatId)
    return { before: Array.isArray(m?.before) ? m.before : [], after: Array.isArray(m?.after) ? m.after : [] }
  } catch {
    return { before: [], after: [] }
  }
}

/** A stable fingerprint of the render markers, for the render-cache key. */
function markersFingerprint(m: RenderMarkers): string {
  return `${m.before.length}${m.after.length}${m.before.join('')}${m.after.join('')}`
}

// --- app-start registration ----------------------------------------------------------------------

/**
 * Register the DisplayHost broker (render-request answering + revision counter + streaming feed).
 * Returns a disposer. Call once at app start, alongside `initCardEventBridge`.
 */
export function initDisplayBroker(): () => void {
  let revision = 0
  let enabledChats = new Set<string>()
  const lru = new Lru<RenderedFloorView>(64)
  const lastCheckpoint = new Map<string, number>() // chatId → last emitted streaming checkpoint

  // (a) Answer render requests from main.
  const answer = async (req: {
    reqId: number
    profileId: string
    chatId: string
    from: number
    to: number
    scope?: unknown
  }): Promise<RenderedFloorView[]> => {
    try {
      const [floors, markers] = await Promise.all([
        resolveFloors(req),
        fetchRenderMarkers(req.profileId, req.chatId)
      ])
      // Feed the [RENDER:*] markers into the ctx so a card floor's html gets the SAME marker wrapping the
      // native ChatView applies (ChatView passes its fetched markers into currentDisplayCtx).
      const ctx = currentDisplayCtx(markers)
      const markerFp = markersFingerprint(markers)
      const reasoningTemplate = reasoningTemplateFor(req.chatId)
      const out: RenderedFloorView[] = []
      for (let i = req.from; i <= req.to; i++) {
        const f = floors[i]
        if (!f) continue // missing indices are skipped (design §3.2)
        const key = `${req.chatId}|${i}|${f.swipe_id ?? 0}|${revision}|${markerFp}|${floorContentStamp(f)}`
        const cached = lru.get(key)
        if (cached) {
          out.push(cached)
          continue
        }
        const view = renderFloorToView(f, i, ctx, revision, reasoningTemplate)
        lru.set(key, view)
        out.push(view)
      }
      return out
    } catch {
      return []
    }
  }
  const unsubRender = window.api.onDisplayRenderRequest((req) => {
    void answer(req).then((views) =>
      window.api.sendDisplayRenderResponse({ reqId: req.reqId, views })
    )
  })

  // (b) Revision counter: any change to the pipeline's store inputs bumps once + invalidates.
  let lastSnapshot = revisionSnapshot()
  const onStoreChange = (): void => {
    const next = revisionSnapshot()
    const reason = revisionReason(lastSnapshot, next)
    if (!reason) return
    lastSnapshot = next
    revision++
    window.api.sendDisplayRevisionChanged(revision)
    for (const chatId of enabledChats)
      broadcastHostEvent(chatId, 'display_invalidated', { revision, reason })
  }
  const unsubRegex = useRegexStore.subscribe(onStoreChange)
  const unsubSettings = useSettingsStore.subscribe(onStoreChange)
  const unsubCharacter = useCharacterStore.subscribe(onStoreChange)

  // Track which chats have ≥1 opted-in panel (main is the authority; it relays the set here).
  const unsubEnabled = window.api.onDisplayStreamEnabledChats((chatIds) => {
    enabledChats = new Set(chatIds)
  })

  // Renderer-reload handshake: a fresh main-window renderer restarts `revision` at 0 and `enabledChats`
  // empty; main re-seeds both once we signal readiness (below). Take the MAX so a seed never rewinds a
  // bump that already landed between registration and the seed arriving.
  const unsubRevisionSeed = window.api.onDisplayRevisionSeed((seed) => {
    revision = Math.max(revision, Number(seed) || 0)
  })

  // (c) Streaming feed: emit a transformed frame at each rateChars checkpoint, for watched chats only.
  const unsubStream = useChatStore.subscribe((state, prev) => {
    const chatId = state.activeChatId
    if (!chatId || state.streamingText === prev.streamingText) return
    // Stream ended / reset → clear the checkpoint so the next stream starts fresh.
    if (!state.streamingText) {
      lastCheckpoint.delete(chatId)
      return
    }
    if (!enabledChats.has(chatId)) return
    const { reasoning, body, state: rstate } = splitReasoning(state.streamingText)
    const ctx = currentDisplayCtx()
    const prevCp = lastCheckpoint.get(chatId) ?? 0
    if (!shouldEmitFrame(prevCp, body.length, ctx.rateChars)) return
    lastCheckpoint.set(chatId, frameCheckpoint(body.length, ctx.rateChars))
    const vars = (state.floors[state.floors.length - 1]?.variables ?? {}) as Record<string, unknown>
    const head = renderStreamingFrame(body, vars, ctx)
    const frame: DisplayStreamFrame = {
      chatId,
      revision,
      html: head.html,
      atLen: head.atLen,
      rawTail: body.slice(head.atLen),
      reasoning: { text: reasoning, state: rstate }
    }
    broadcastHostEvent(chatId, 'display_stream_frame', frame)
  })

  // All listeners are attached — tell main we're ready so it re-seeds the revision + enabled-chat set
  // (covers a main-window reload, where the new renderer would otherwise start from a blank slate).
  window.api.sendDisplayBrokerReady()

  return () => {
    unsubRender()
    unsubRegex()
    unsubSettings()
    unsubCharacter()
    unsubEnabled()
    unsubRevisionSeed()
    unsubStream()
  }
}
