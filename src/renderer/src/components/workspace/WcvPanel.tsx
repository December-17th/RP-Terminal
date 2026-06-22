import { useEffect, useRef } from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useWorkspaceContext } from './context'
import { useChatStore } from '../../stores/chatStore'

/**
 * SPIKE — renderer host for an out-of-process `WebContentsView` card-UI panel. The native view
 * (in main) is positioned to match THIS element's window-relative rect; we report the rect on
 * mount, on size change (ResizeObserver), on window resize, and whenever the workspace layout
 * changes (a splitter drag / mode switch can move us without resizing). The WebContentsView
 * paints OVER this div, so the placeholder is only visible while it loads or if unsupported.
 *
 * The loaded page talks to the host via the wcvPreload shim (`window.rptHost` + the ST/Mvu globals).
 * Two views are registered: a self-contained round-trip test page, and the real 命定之诗 status UI.
 */

// Round-trip test page (no bundled assets): reads + writes the host's stat_data via the bridge.
const TEST_URL =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;height:100vh;box-sizing:border-box;padding:16px;font-family:system-ui,sans-serif;background:#0f1420;color:#9fe1cb">
<div style="font-weight:600;font-size:15px;margin-bottom:8px">WebContentsView &harr; host bridge</div>
<pre id="v" style="font-size:12px;white-space:pre-wrap;color:#cfe;max-height:52vh;overflow:auto;background:#0a0e16;padding:8px;border-radius:6px;margin:0">…</pre>
<button id="b" style="margin-top:10px;padding:6px 12px;border-radius:6px;border:1px solid #2a3450;background:#16203a;color:#9fe1cb;cursor:pointer">+1 spikeCounter (write + persist)</button>
<div id="s" style="margin-top:8px;font-size:11px;opacity:.6"></div>
<script>
const pre=document.getElementById('v'),s=document.getElementById('s');
async function refresh(){try{pre.textContent=JSON.stringify(await window.rptHost.getVariables(),null,2)}catch(e){pre.textContent='no rptHost: '+e}}
document.getElementById('b').onclick=async()=>{try{const v=await window.rptHost.getVariables();const n=((v&&v.spikeCounter)||0)+1;await window.rptHost.applyVariableOps([{op:'add',path:'/spikeCounter',value:n}]);s.textContent='wrote spikeCounter='+n;await refresh()}catch(e){s.textContent='write failed: '+e}};
if(window.rptHost&&window.rptHost.onVarsChanged)window.rptHost.onVarsChanged(refresh);
refresh();
</script></body></html>`
  )

// 命定之诗's real status UI (React ESM app; imports its deps from jsDelivr at runtime). Loaded with
// the wcvPreload shim providing window.Mvu / SillyTavern / the TavernHelper globals (+ a logger).
const STATUS_URL =
  'https://testingcf.jsdelivr.net/gh/The-poem-of-destiny/FrontEnd-for-destined-journey@1.8.2/dist/status/index.html'

function WcvPanel({ slotId, url }: { slotId: string; url: string }): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const layouts = useWorkspaceStore((s) => s.layouts) // re-measure when the layout changes
  const { profileId } = useWorkspaceContext()
  const chatId = useChatStore((s) => s.activeChatId)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const rect = (): { x: number; y: number; width: number; height: number } => {
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    window.api.wcvEnsure(slotId, rect(), url, { profileId, chatId: chatId || '' })
    const onChange = (): void => window.api.wcvSetBounds(slotId, rect())
    const ro = new ResizeObserver(onChange)
    ro.observe(el)
    window.addEventListener('resize', onChange)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onChange)
      window.api.wcvDestroy(slotId)
    }
  }, [slotId, url, profileId, chatId])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    window.api.wcvSetBounds(slotId, { x: r.left, y: r.top, width: r.width, height: r.height })
  }, [layouts, slotId])

  return (
    <div ref={hostRef} style={{ width: '100%', height: '100%', minHeight: 80 }}>
      <div style={{ opacity: 0.5, padding: 12, fontSize: 13 }}>Loading WebContentsView…</div>
    </div>
  )
}

// Stable wrapper components so the workspace view-picker can mount each without remount churn.
export function WcvTestView(): React.ReactElement {
  return <WcvPanel slotId="wcv-test" url={TEST_URL} />
}
export function WcvCardView(): React.ReactElement {
  return <WcvPanel slotId="wcv-card" url={STATUS_URL} />
}
