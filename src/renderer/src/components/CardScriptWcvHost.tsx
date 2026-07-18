import { useEffect, useMemo, useRef, useState } from 'react'
import { useCardScriptsStore } from '../stores/cardScriptsStore'
import { useToolbarStore } from '../stores/toolbarStore'
import { CARD_CSP } from '../../../shared/cardCsp'
import { resolveCardScriptGate, GateScript } from './cardScriptGate'

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
    `<meta http-equiv="Content-Security-Policy" content="${CARD_CSP}">` +
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
  const decidedGrant = useCardScriptsStore((s) => s.decidedByCard[cardId])

  const grantsRef = useRef<Grants>({})
  const [grantsLoaded, setGrantsLoaded] = useState(false)
  const [scripts, setScripts] = useState<RuntimeScript[] | null>(null)
  // Scripts the ACTIVE preset's high-trust grant authorizes (a subset of `scripts`) — run regardless
  // of card trust (ADR 0017). Populated from get-runtime-scripts alongside the full set.
  const [presetHighTrustScripts, setPresetHighTrustScripts] = useState<GateScript[]>([])

  // Load persisted grants (enabled + trusted/remoteScripts) for this card.
  useEffect(() => {
    let alive = true
    setGrantsLoaded(false)
    window.api.pluginGetGrants(profileId, cardId).then((g: Grants) => {
      if (!alive) return
      grantsRef.current = g || {}
      useCardScriptsStore.getState().seed(cardId, g?.enabled !== false)
      useCardScriptsStore.getState().seedTrust(cardId, g?.trusted === true)
      useCardScriptsStore.getState().seedDecided(cardId, g?.decided === true)
      setGrantsLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [profileId, cardId])

  // Fetch the merged runtime script set (card-embedded + active store scopes) + the subset the active
  // preset's high-trust grant authorizes (a strict subset — runs regardless of card trust, ADR 0017).
  useEffect(() => {
    if (!enabled || !grantsLoaded) return
    let alive = true
    // isolatedRealm=true: this is the WCV transport, the only realm where high-trust remote-code
    // scripts (ADR 0017) are allowed to resolve. The inline CardScriptHost never sets this.
    window.api.getRuntimeScripts(profileId, cardId, chatId, true).then((res: any) => {
      if (!alive) return
      setScripts(res?.scripts || [])
      setPresetHighTrustScripts(res?.presetHighTrustScripts || [])
    })
    return () => {
      alive = false
    }
  }, [profileId, cardId, chatId, enabled, grantsLoaded, trustedGrant])

  const trusted = trustedGrant === true || grantsRef.current.trusted === true
  const decided = decidedGrant === true || grantsRef.current.decided === true
  // Reconcile the two INDEPENDENT trust grants (ADR 0017): a high-trusted preset's scripts run
  // regardless of card trust; the card's own scripts still wait for the card decision. `runScripts` is
  // the authorized subset the WCV doc actually runs; `needsConsent` gates only the card-trust prompt.
  const { runScripts, needsConsent } = useMemo(
    () =>
      resolveCardScriptGate({
        scripts: scripts ?? [],
        presetHighTrustScripts,
        cardTrusted: trusted,
        cardDecided: decided
      }),
    [scripts, presetHighTrustScripts, trusted, decided]
  )

  const doc = useMemo(() => (runScripts.length ? buildScriptDoc(runScripts) : ''), [runScripts])
  const dataUrl = useMemo(
    () => (doc ? 'data:text/html;charset=utf-8,' + encodeURIComponent(doc) : ''),
    [doc]
  )

  // Mount the engine WCV OFF-SCREEN at full-window size so the scripts run invisibly. It's never positioned
  // to a panel; `wcvManager.setModal` slides it on-screen for the workshop modal and back off on close.
  // `enabled` is a dep so toggling card scripts OFF tears the WCV down (its cleanup runs) — otherwise it
  // would keep running the card's scripts despite the off switch.
  useEffect(() => {
    if (!enabled || !dataUrl) return
    const off = {
      x: -100000,
      y: 0,
      width: window.innerWidth || 1280,
      height: window.innerHeight || 800
    }
    window.api.wcvEnsure(slotId, off, dataUrl, { profileId, chatId, characterId: cardId })
    return () => window.api.wcvDestroy(slotId)
  }, [slotId, dataUrl, enabled, profileId, chatId, cardId])

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

  // Untrusted card that ships its OWN scripts → a small consent prompt (the engine is otherwise
  // invisible). Any high-trust PRESET scripts already run via the effect above regardless of this gate.
  // `needsConsent` is false once the user has decided (grant or deny) — a denial keeps the card's scripts
  // off silently. The prompt survives mainly for legacy cards imported before the import-time flow.
  if (needsConsent) {
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
