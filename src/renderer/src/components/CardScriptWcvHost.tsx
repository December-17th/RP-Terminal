import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { useCardScriptsStore } from '../stores/cardScriptsStore'

/**
 * Card-script runtime (Phase 2) — the WCV transport. Runs the card's merged runtime scripts
 * (`get-runtime-scripts`: card-embedded World scope + active store scopes) in a process-isolated
 * `WebContentsView`, where the `wcvPreload` shim provides the canonical `thRuntime` surface
 * (window.TavernHelper/Mvu/SillyTavern/$/_/…). Unlike the legacy inline `CardScriptHost` iframe, this is a
 * real Chromium page: remote `import 'https://…'` modules load natively, `window.open`/`fetch` work, and a
 * full-page app (the 创意工坊 workshop) runs as written. The view paints over this host div at its window rect.
 *
 * Phase 2 mounts it in the Card-Scripts panel (visible) so we can confirm the scripts execute; Phase 3 turns
 * the button-launched workshop into a hidden full-window modal.
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
    // Surface script errors/rejections to the WCV console (visible in its devtools in dev).
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
}

export function CardScriptWcvHost({
  profileId,
  chatId,
  cardId,
  cardName
}: Props): React.ReactElement | null {
  const hostRef = useRef<HTMLDivElement>(null)
  const slotId = `card-scripts:${cardId}:${chatId}`
  const layouts = useWorkspaceStore((s) => s.layouts) // re-measure when the workspace layout changes
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

  const doc = useMemo(
    () => (scripts && scripts.length ? buildScriptDoc(scripts) : ''),
    [scripts]
  )
  const dataUrl = useMemo(
    () => (doc ? 'data:text/html;charset=utf-8,' + encodeURIComponent(doc) : ''),
    [doc]
  )

  // Mount the WCV over this host div and keep it positioned to our window rect.
  useEffect(() => {
    const el = hostRef.current
    if (!el || !dataUrl || needsConsent) return
    const rect = (): { x: number; y: number; width: number; height: number } => {
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    window.api.wcvEnsure(slotId, rect(), dataUrl, { profileId, chatId, characterId: cardId })
    const onChange = (): void => window.api.wcvSetBounds(slotId, rect())
    const ro = new ResizeObserver(onChange)
    ro.observe(el)
    window.addEventListener('resize', onChange)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onChange)
      window.api.wcvDestroy(slotId)
    }
  }, [slotId, dataUrl, needsConsent, profileId, chatId, cardId])

  // Re-measure on a workspace layout change (a splitter drag / view switch can move us w/o resizing).
  useEffect(() => {
    const el = hostRef.current
    if (!el || needsConsent) return
    const r = el.getBoundingClientRect()
    window.api.wcvSetBounds(slotId, { x: r.left, y: r.top, width: r.width, height: r.height })
  }, [layouts, slotId, needsConsent])

  if (!enabled || !grantsLoaded) return null
  if (scripts && scripts.length === 0) return null

  if (needsConsent) {
    return (
      <div style={{ padding: 20, maxWidth: 480 }}>
        <h3 style={{ marginTop: 0 }}>{cardName} — Card scripts</h3>
        <p style={{ opacity: 0.8, fontSize: 13, lineHeight: 1.6 }}>
          Runs this world&apos;s scripts (including code loaded from the internet) in an isolated process
          with access to this session. Only run worlds you trust.
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

  return <div ref={hostRef} style={{ width: '100%', height: '100%', minHeight: 60 }} />
}
