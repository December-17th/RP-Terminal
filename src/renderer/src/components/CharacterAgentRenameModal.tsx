import React from 'react'
import { Modal } from './Modal'
import { useCharacterStore } from '../stores/characterStore'
import { useT } from '../i18n'
import type { CharacterAgentResolutions } from '../../../shared/characterImport'

type Action = 'rename' | 'skip' | 'replace'
interface DraftResolution {
  action: Action
  newName: string
}

const DEFAULT: DraftResolution = { action: 'rename', newName: '' }

export function CharacterAgentRenameModal(): React.ReactElement | null {
  const t = useT()
  const pending = useCharacterStore((state) => state.pendingAgentImport)
  const confirm = useCharacterStore((state) => state.confirmAgentImport)
  const cancel = useCharacterStore((state) => state.cancelAgentImport)
  const [drafts, setDrafts] = React.useState<Record<string, DraftResolution>>({})
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => setDrafts({}), [pending?.token])
  if (!pending) return null

  const draftFor = (name: string): DraftResolution => drafts[name] ?? DEFAULT
  const update = (name: string, patch: Partial<DraftResolution>): void =>
    setDrafts((current) => ({ ...current, [name]: { ...draftFor(name), ...patch } }))

  const complete = pending.requiredRenames.every((name) => {
    const draft = draftFor(name)
    return draft.action !== 'rename' || !!draft.newName.trim()
  })

  const submit = async (): Promise<void> => {
    if (!complete || busy) return
    const resolutions: CharacterAgentResolutions = {}
    for (const name of pending.requiredRenames) {
      const draft = draftFor(name)
      resolutions[name] =
        draft.action === 'rename'
          ? { action: 'rename', newName: draft.newName.trim() }
          : { action: draft.action }
    }
    setBusy(true)
    try {
      await confirm(resolutions)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('characterImport.agentRenameTitle')} onClose={() => void cancel()}>
      <p>{t('characterImport.agentRenameDetail')}</p>
      {pending.requiredRenames.map((name) => {
        const conflict = pending.conflicts.find((item) => item.incomingName === name)
        const existingName = conflict?.existing.name ?? name
        const builtin = conflict?.existing.builtin ?? false
        const draft = draftFor(name)
        const radioName = `agent-resolution-${name}`
        return (
          <div
            key={name}
            style={{
              display: 'grid',
              gap: 8,
              marginBottom: 16,
              paddingBottom: 12,
              borderBottom: '1px solid var(--rpt-border, rgba(128,128,128,0.25))'
            }}
          >
            <span>
              {t('characterImport.agentRenameLabel', {
                incoming: name,
                existing: existingName
              })}
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="radio"
                  name={radioName}
                  checked={draft.action === 'rename'}
                  onChange={() => update(name, { action: 'rename' })}
                />
                {t('characterImport.agentActionRename')}
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="radio"
                  name={radioName}
                  checked={draft.action === 'skip'}
                  onChange={() => update(name, { action: 'skip' })}
                />
                {t('characterImport.agentActionSkip')}
              </label>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  opacity: builtin ? 0.5 : 1
                }}
                title={builtin ? t('characterImport.agentReplaceBuiltinDisabled') : undefined}
              >
                <input
                  type="radio"
                  name={radioName}
                  disabled={builtin}
                  checked={draft.action === 'replace'}
                  onChange={() => update(name, { action: 'replace' })}
                />
                {t('characterImport.agentActionReplace')}
              </label>
            </div>
            {draft.action === 'rename' && (
              <input
                value={draft.newName}
                placeholder={t('characterImport.agentRenamePlaceholder')}
                onChange={(event) => update(name, { newName: event.target.value })}
                autoFocus={name === pending.requiredRenames[0]}
              />
            )}
            {draft.action === 'skip' && (
              <span style={{ fontSize: 13, opacity: 0.8 }}>
                {t('characterImport.agentSkipHint')}
              </span>
            )}
            {draft.action === 'replace' && (
              <span style={{ fontSize: 13, color: 'var(--rpt-warn, #d08a2b)' }}>
                {t('characterImport.agentReplaceWarning', { existing: existingName })}
              </span>
            )}
          </div>
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
