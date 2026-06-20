import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useToastStore } from '../stores/toastStore'
import { usePluginsStore, InstalledPlugin } from '../stores/pluginsStore'
import { buildScriptSrcDoc } from '../plugin/bridgeShim'
import { dispatchRpc } from '../plugin/dispatch'
import { registerFrameCommand } from '../plugin/slash'

/**
 * Standalone-plugin runtime (P2/P3). Mounted in the right sidebar, it runs every
 * enabled plugin in its own sandboxed (`allow-scripts`, opaque-origin) iframe.
 * A plugin that calls `rpt.ui.registerPanel(...)` (P3) gets a visible, titled,
 * auto-sizing panel here; plugins that don't stay mounted but hidden (headless).
 * Each plugin's `rpt` calls are enforced against its manifest-granted permission
 * set and act on the active session. Shares the bridge shim + RPC dispatcher with
 * card scripts. Kept in one stable mount so iframes never reparent (which would
 * reload them and wipe their state).
 */
export const PluginHost: React.FC<{ profileId: string }> = ({ profileId }) => {
  const plugins = usePluginsStore((s) => s.plugins)
  const running = plugins.filter((p) => p.enabled && !p.error && p.code)
  if (running.length === 0) return null
  return (
    <div className="rpt-plugin-dock">
      {running.map((p) => (
        <PluginFrame key={p.id} profileId={profileId} plugin={p} />
      ))}
    </div>
  )
}

const PluginFrame: React.FC<{ profileId: string; plugin: InstalledPlugin }> = ({
  profileId,
  plugin
}) => {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const cmdCleanups = useRef(new Map<string, () => void>())
  const [panel, setPanel] = useState<{ title: string } | null>(null)
  const [height, setHeight] = useState(0)
  const srcDoc = useMemo(
    () => buildScriptSrcDoc([{ name: plugin.id, code: plugin.code }]),
    [plugin.code]
  )
  const grantsSet = useMemo(() => new Set(plugin.grants), [plugin.grants])

  const post = (msg: any): void => frameRef.current?.contentWindow?.postMessage(msg, '*')
  const emit = (name: string, payload: any): void => post({ __rptevent: 1, name, payload })

  // Plugins are gated purely by their granted (manifest-approved) permissions.
  const ensure = async (perm: string): Promise<boolean> => grantsSet.has(perm)

  const registerCommand = (name: string, description?: string): void => {
    const key = name.toLowerCase()
    if (cmdCleanups.current.has(key)) return
    cmdCleanups.current.set(
      key,
      registerFrameCommand(key, (args, raw) => emit('slash:' + key, { args, raw }), description)
    )
  }

  const handleRpc = (method: string, args: any[]): Promise<any> =>
    dispatchRpc(method, args, {
      profileId,
      getChatId: () => useChatStore.getState().activeChatId,
      ensure,
      toast: (m) => useToastStore.getState().push(m),
      registerPanel: (def) => setPanel({ title: (def && def.title) || plugin.manifest.name }),
      registerCommand,
      syncLocalVars: (store) => useChatStore.getState().setLatestFloorVariables(store),
      triggerGenerate: (text) => useChatStore.getState().sendAction(profileId, text),
      isGenerating: () => useChatStore.getState().isGenerating
    })

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frameRef.current?.contentWindow) return
      const d = e.data
      if (!d || typeof d !== 'object') return
      if (d.__rptresize) {
        setHeight(Math.min(Math.max(0, Number(d.height) || 0), 1200))
      } else if (d.__rptlog) {
        window.api.pluginLog(plugin.manifest.name, String(d.msg))
      } else if (d.__rptready) {
        emit('ready', {})
      } else if (d.__rpt) {
        handleRpc(String(d.method), Array.isArray(d.args) ? d.args : [])
          .then((result) => post({ __rptres: 1, id: d.id, ok: true, result }))
          .catch((err) =>
            post({ __rptres: 1, id: d.id, ok: false, error: err?.message || String(err) })
          )
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [profileId, plugin.id, plugin.manifest.name, grantsSet])

  // Forward generation/chat lifecycle so reactive plugins can respond.
  useEffect(() => {
    return useChatStore.subscribe((state, prev) => {
      if (state.isGenerating !== prev.isGenerating) {
        emit(state.isGenerating ? 'generation:start' : 'generation:end', {})
      }
      if (state.floors.length !== prev.floors.length) {
        emit('chat:changed', { floors: state.floors.length })
      }
    })
  }, [])

  // Unregister this plugin's slash commands when it unmounts (disable/uninstall).
  useEffect(() => {
    const cleanups = cmdCleanups.current
    return () => {
      cleanups.forEach((off) => off())
      cleanups.clear()
    }
  }, [])

  // Stable structure regardless of panel state — toggling only changes styles, so
  // the iframe element is never moved in the DOM (a move would reload it).
  return (
    <div className="rpt-plugin-panel" style={{ display: panel ? 'block' : 'none' }}>
      <div className="rpt-plugin-head" style={{ display: panel ? 'flex' : 'none' }}>
        <span className="rpt-plugin-title">{panel?.title}</span>
        <span className="rpt-plugin-by">{plugin.manifest.name}</span>
      </div>
      <iframe
        ref={frameRef}
        className="rpt-plugin-frame"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        title={`plugin ${plugin.id}`}
        style={panel ? { height: height || 1 } : { width: 0, height: 0, border: 0 }}
      />
    </div>
  )
}
