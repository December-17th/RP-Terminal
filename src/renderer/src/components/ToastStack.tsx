import { useToastStore } from '../stores/toastStore'

/** Single shared toast surface for the sandboxed runtime (card scripts + plugins). */
export function ToastStack(): React.ReactNode {
  const toasts = useToastStore((s) => s.toasts)
  if (!toasts.length) return null
  return (
    <div className="rpt-toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className="rpt-toast">
          {t.msg}
        </div>
      ))}
    </div>
  )
}
