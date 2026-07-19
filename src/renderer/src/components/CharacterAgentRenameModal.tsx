import React from 'react'
import { Modal } from './Modal'
import { useCharacterStore } from '../stores/characterStore'
import { useT } from '../i18n'

export function CharacterAgentRenameModal(): React.ReactElement | null {
  const t = useT()
  const pending = useCharacterStore((state) => state.pendingAgentImport)
  const confirm = useCharacterStore((state) => state.confirmAgentImport)
  const cancel = useCharacterStore((state) => state.cancelAgentImport)
  const [renames, setRenames] = React.useState<Record<string, string>>({})
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => setRenames({}), [pending?.token])
  if (!pending) return null
  const complete = pending.requiredRenames.every((name) => renames[name]?.trim())

  const submit = async (): Promise<void> => {
    if (!complete || busy) return
    setBusy(true)
    try {
      await confirm(renames)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('characterImport.agentRenameTitle')} onClose={() => void cancel()}>
      <p>{t('characterImport.agentRenameDetail')}</p>
      {pending.requiredRenames.map((name) => {
        const conflict = pending.conflicts.find((item) => item.incomingName === name)
        return (
          <label key={name} style={{ display: 'grid', gap: 6, marginBottom: 14 }}>
            <span>
              {t('characterImport.agentRenameLabel', {
                incoming: name,
                existing: conflict?.existing.name ?? name
              })}
            </span>
            <input
              value={renames[name] ?? ''}
              onChange={(event) =>
                setRenames((current) => ({ ...current, [name]: event.target.value }))
              }
              autoFocus={name === pending.requiredRenames[0]}
            />
          </label>
        )
      })}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={() => void cancel()}>{t('common.cancel')}</button>
        <button className="btn-primary" disabled={!complete || busy} onClick={() => void submit()}>
          {t('characterImport.agentRenameConfirm')}
        </button>
      </div>
    </Modal>
  )
}
