import { useEffect, useMemo, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useToastStore } from '../stores/toastStore'
import { usePluginsStore, InstalledPlugin } from '../stores/pluginsStore'
import { buildScriptSrcDoc } from '../plugin/bridgeShim'
import { dispatchRpc } from '../plugin/dispatch'

/**
 * Standalone-plugin runtime (P2). Mounted once at the app root, it runs every
 * enabled plugin in its own sandboxed (`allow-scripts`, opaque-origin) iframe —
 * headless in P2 (no UI surface until P3 contribution points). Each plugin's
 * `rpt` calls are enforced against its manifest-granted permission set, and act
 * on the currently active session. Shares the bridge shim + RPC dispatcher with
 * card scripts.
 */
export const PluginHost: React.FC<{ profileId: string }> = ({ profileId }) => {
  const plugins = usePluginsStore((s) => s.plugins)
  const running = plugins.filter((p) => p.enabled && !p.error && p.code)
  return (
    <>
      {running.map((p) => (
        <PluginFrame key={p.id} profileId={profileId} plugin={p} />
      ))}
    </>
  )
}

const PluginFrame: React.FC<{ profileId: string; plugin: InstalledPlugin }> = ({
  profileId,
  plugin
}) => {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const srcDoc = useMemo(
    () => buildScriptSrcDoc([{ name: plugin.id, code: plugin.code }]),
    [plugin.code]
  )
  const grantsSet = useMemo(() => new Set(plugin.grants), [plugin.grants])

  const post = (msg: any): void => frameRef.current?.contentWindow?.postMessage(msg, '*')
  const emit = (name: string, payload: any): void => post({ __rptevent: 1, name, payload })

  // Plugins are gated purely by their granted (manifest-approved) permissions.
  const ensure = async (perm: string): Promise<boolean> => grantsSet.has(perm)

  const handleRpc = (method: string, args: any[]): Promise<any> =>
    dispatchRpc(method, args, {
      profileId,
      getChatId: () => useChatStore.getState().activeChatId,
      ensure,
      toast: (m) => useToastStore.getState().push(m),
      syncLocalVars: (store) => useChatStore.getState().setLatestFloorVariables(store),
      triggerGenerate: (text) => useChatStore.getState().sendAction(profileId, text),
      isGenerating: () => useChatStore.getState().isGenerating
    })

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frameRef.current?.contentWindow) return
      const d = e.data
      if (!d || typeof d !== 'object') return
      if (d.__rptlog) {
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
      // __rptresize ignored — plugin frames are headless in P2.
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

  return (
    <iframe
      ref={frameRef}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      title={`plugin ${plugin.id}`}
      style={{ position: 'absolute', width: 0, height: 0, border: 0, visibility: 'hidden' }}
    />
  )
}
