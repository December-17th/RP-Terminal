import { useEffect, useMemo, useRef, useState } from 'react'
import { useCardScriptsStore } from '../stores/cardScriptsStore'
import { useToolbarStore } from '../stores/toolbarStore'

/**
 * The card **script engine** (Phase 2–4) — a single, invisible, process-isolated `WebContentsView` that runs
 * the active card's merged runtime scripts (`get-runtime-scripts`: card-embedded World scope + active store
 * scopes). It is mounted ONCE per session at the app level (`App.tsx`), NOT inside a panel: card scripts are
 * background logic (MVU/automation) plus button-launched tools (the 创意工坊 workshop), so the engine itself
 * shows nothing. It's parked OFF-SCREEN; when a script opens a full-screen overlay (the workshop modal) the
 * host slides it on-screen (`wcvManager.setModal`) and back off when the overlay closes.
 *
 * Because it's session-level, the scripts run — and the workshop button registers — in ANY layout (the
 * resizable workspace OR a card-declared static `panel_ui`). Visible game UI lives in panels, not here.
 *
 * Unlike the legacy inline `CardScriptHost` iframe, this is a real Chromium page: remote `import 'https://…'`
 * modules load natively, `window.open`/`fetch` work, and a full-page card app runs as written. The
 * `wcvPreload` shim provides the canonical `thRuntime` surface (window.TavernHelper/Mvu/SillyTavern/$/_/…).
 */

// Mirrors wcvManager.CARD_CSP (can't import a main module here). Trusted-card policy: https code/styles/
// media + the eval the card libs need; process isolation is the real boundary.
const CSP =
  "default-src 'self' https: 'unsafe-inline' 'unsafe-eval' data: blob:; " +
  'img-src * data: blob:; media-src * data: blob:; connect-src * data: blob:'

// A script uses ES-module syntax (static import/export) ⇒ run it as <script type="module"> so its imports
// resolve. (Mirrors thRuntime/bridgeShim's MODULE_SYNTAX, inlined to avoid the legacy-stack dependency.)
const isModuleScript = (code: string): boolean =>
  /^[ \t]*(?:import[\s{*'"]|export[\s{*])/m.test(code || '')

interface RuntimeScript {
  name: string
  code: string
}

const buildScriptDoc = (scripts: RuntimeScript[]): string => {
  const tags = scripts
    .map((s) => {
      const code = s.code || ''
      if (!code.trim()) return ''
      return isModuleScript(code)
        ? `<script type="module">\n${code}\n</script>`
        : `<script>\ntry {\n${code}\n} catch (e) { console.error('[card-script ${s.name}]', e) }\n</script>`
    })
    .join('\n')
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<style>html,body{margin:0;background:transparent;color:#d8d8e0;font-family:system-ui,sans-serif}</style>` +
    // Surface script errors/rejections to the WCV console (forwarded to the main log by wcvPreload).
    `<script>window.addEventListener('error',function(e){console.error('[card-script]',e.message,e.error&&e.error.stack||'')});` +
    `window.addEventListener('unhandledrejection',function(e){console.error('[card-script] unhandled',e.reason)});</script>` +
    `</head><body>\n${tags}\n</body></html>`
  )
}

interface Props {
  profileId: string
  chatId: string
  cardId: string
  cardName: string
}

interface Grants {
  enabled?: boolean
  remoteScripts?: boolean
  trusted?: boolean
  /** The user already made an explicit trust decision (import-time modal / legacy prompt). */
  decided?: boolean
}

export function CardScriptWcvHost({
  profileId,
  chatId,
  cardId,
  cardName
}: Props): React.ReactElement | null {
  const slotId = `card-scripts:${cardId}:${chatId}`
  const enabled = useCardScriptsStore((s) => s.enabledByCard[cardId] ?? true)
  const trustedGrant = useCardScriptsStore((s) => s.trustedByCard[cardId])

  const grantsRef = useRef<Grants>({})
  const [grantsLoaded, setGrantsLoaded] = useState(false)
  const [scripts, setScripts] = useState<RuntimeScript[] | null>(null)
  const [remoteHosts, setRemoteHosts] = useState<string[]>([])

  // Load persisted grants (enabled + trusted/remoteScripts) for this card.
  useEffect(() => {
    let alive = true
    setGrantsLoaded(false)
    window.api.pluginGetGrants(profileId, cardId).then((g: Grants) => {
      if (!alive) return
      grantsRef.current = g || {}
      useCardScriptsStore.getState().seed(cardId, g?.enabled !== false)
      useCardScriptsStore.getState().seedTrust(cardId, g?.trusted === true)
      setGrantsLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [profileId, cardId])

  // Fetch the merged runtime script set (card-embedded + active store scopes) + the remote hosts it imports.
  useEffect(() => {
    if (!enabled || !grantsLoaded) return
    let alive = true
    window.api.getRuntimeScripts(profileId, cardId, chatId).then((res: any) => {
      if (!alive) return
      setScripts(res?.scripts || [])
      setRemoteHosts(res?.remoteHosts || [])
    })
    return () => {
      alive = false
    }
  }, [profileId, cardId, chatId, enabled, grantsLoaded, trustedGrant])

  const trusted = trustedGrant === true || grantsRef.current.trusted === true
  // Scripts that pull remote code need the per-world trust grant before we run them in a real page.
  const needsConsent = (remoteHosts.length > 0 || (scripts?.length ?? 0) > 0) && !trusted

  const doc = useMemo(() => (scripts && scripts.length ? buildScriptDoc(scripts) : ''), [scripts])
  const dataUrl = useMemo(
    () => (doc ? 'data:text/html;charset=utf-8,' + encodeURIComponent(doc) : ''),
    [doc]
  )

  // Mount the engine WCV OFF-SCREEN at full-window size so the scripts run invisibly. It's never positioned
  // to a panel; `wcvManager.setModal` slides it on-screen for the workshop modal and back off on close.
  // `enabled` is a dep so toggling card scripts OFF tears the WCV down (its cleanup runs) — otherwise it
  // would keep running the card's scripts despite the off switch.
  useEffect(() => {
    if (!enabled || !dataUrl || needsConsent) return
    const off = {
      x: -100000,
      y: 0,
      width: window.innerWidth || 1280,
      height: window.innerHeight || 800
    }
    window.api.wcvEnsure(slotId, off, dataUrl, { profileId, chatId, characterId: cardId })
    return () => window.api.wcvDestroy(slotId)
  }, [slotId, dataUrl, needsConsent, enabled, profileId, chatId, cardId])

  // Card scripts (replaceScriptButtons) → the menu above the input. Each button posts back to the engine on
  // click (the script's eventOn(getButtonEvent(name)) fires). Scoped to OUR slot; cleared on unmount.
  useEffect(() => {
    const btnKeys = new Set<string>()
    const off = window.api.onWcvCardButtons((p) => {
      if (p.slotId !== slotId) return
      const next = new Set<string>()
      for (const b of p.buttons || []) {
        if (!b || !b.name) continue
        const key = `card:${cardId}::${b.name}`
        next.add(key)
        btnKeys.add(key)
        useToolbarStore.getState().add({
          key,
          label: b.name,
          onClick: () => window.api.wcvButtonClick(chatId, b.name)
        })
      }
      for (const key of [...btnKeys]) {
        if (!next.has(key)) {
          useToolbarStore.getState().remove(key)
          btnKeys.delete(key)
        }
      }
    })
    return () => {
      off()
      for (const key of btnKeys) useToolbarStore.getState().remove(key)
      btnKeys.clear()
    }
  }, [slotId, cardId, chatId])

  if (!enabled || !grantsLoaded) return null
  if (scripts && scripts.length === 0) return null

  // Untrusted world that ships scripts → a small consent prompt (the engine is otherwise invisible).
  if (needsConsent) {
    // The trust decision is now made at IMPORT time (CardTrustPrompt), and persists. If the user
    // already decided (grant or deny), never re-prompt here — a denial keeps the scripts off silently.
    // The inline prompt below only survives as a fallback for legacy cards imported before that flow.
    if (grantsRef.current.decided) return null
    return (
      <div
        style={{
          position: 'fixed',
          bottom: 16,
          left: 16,
          // Top z-index band (matches .modal-overlay / .rpt-toast-stack in index.css): this is app
          // chrome that MUST sit above untrusted card UI, which uses position:fixed + a high z-index
          // in its own CSS. A small value here let the card's inline UI paint over the prompt, making
          // it look blank with an unclickable button.
          zIndex: 2147482000,
          maxWidth: 360,
          padding: 14,
          borderRadius: 10,
          background: 'var(--rpt-surface, #1b1b26)',
          border: '1px solid var(--rpt-border, #34344a)',
          color: 'var(--rpt-text-primary, #d8d8e0)',
          boxShadow: '0 6px 24px rgba(0,0,0,.4)'
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{cardName} — card scripts</div>
        <p style={{ opacity: 0.8, fontSize: 12.5, lineHeight: 1.55, margin: '0 0 10px' }}>
          This world&apos;s scripts (including code loaded from the internet) run in an isolated
          process with access to this session. Only run worlds you trust.
        </p>
        <button
          className="btn-accent"
          onClick={async () => {
            grantsRef.current = await window.api.pluginSetGrants(profileId, cardId, {
              trusted: true,
              remoteScripts: true
            })
            useCardScriptsStore.getState().seedTrust(cardId, true)
          }}
        >
          Run card scripts
        </button>
      </div>
    )
  }

  // Running: the engine WCV is off-screen, so there is nothing to render in the DOM.
  return null
}
