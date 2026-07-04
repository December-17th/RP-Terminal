import React, { useState } from 'react'
import { Modal } from './Modal'
import { useChatStore } from '../stores/chatStore'
import { stripThinking, stripRptEvents } from '../../../shared/responseView'
import { useT } from '../i18n'

/**
 * View + delete floors. Deletion is a CONSECUTIVE TAIL from the latest floor (pick a floor → it and
 * everything below it are removed), mirroring SillyTavern's "delete messages" mode. The heavy lifting
 * (removing the floors' memory-table ops + journaled variable writes, rebuilding the SQL sandbox from
 * the survivors) is main-side truncateFloors, reached via chatStore.deleteFloorsFrom.
 */
const preview = (s: string, n: number): string => {
  const clean = stripRptEvents(stripThinking(s || ''))
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > n ? `${clean.slice(0, n)}…` : clean
}

export const FloorManagerModal: React.FC<{ profileId: string; onClose: () => void }> = ({
  profileId,
  onClose
}) => {
  const t = useT()
  const floors = useChatStore((s) => s.floors)
  const deleteFloorsFrom = useChatStore((s) => s.deleteFloorsFrom)
  const [cut, setCut] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const latest = floors.length ? floors[floors.length - 1].floor : -1
  const count = cut == null ? 0 : floors.filter((f) => f.floor >= cut).length

  const onDelete = async (): Promise<void> => {
    if (cut == null) return
    setBusy(true)
    try {
      await deleteFloorsFrom(profileId, cut)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('floors.title')} onClose={onClose}>
      <div className="rpt-floors">
        {floors.length === 0 ? (
          <div style={{ opacity: 0.6 }}>{t('floors.empty')}</div>
        ) : (
          <>
            <p className="rpt-floors-hint">{t('floors.hint')}</p>
            <div className="rpt-floors-list">
              {floors.map((f) => {
                const marked = cut != null && f.floor >= cut
                return (
                  <button
                    key={f.floor}
                    type="button"
                    className={`rpt-floors-row${marked ? ' marked' : ''}${cut === f.floor ? ' cut' : ''}`}
                    title={t('floors.selectTip')}
                    onClick={() => {
                      setCut(f.floor)
                      setConfirming(false)
                    }}
                  >
                    <span className="rpt-floors-idx">#{f.floor}</span>
                    <span className="rpt-floors-prev">
                      {f.user_message.content ? (
                        <span className="rpt-floors-you">
                          <b>{t('floors.you')}:</b> {preview(f.user_message.content, 40)}
                        </span>
                      ) : null}
                      <span className="rpt-floors-ai">
                        <b>{t('floors.ai')}:</b> {preview(f.response.content, 70)}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="rpt-floors-actions">
              <span className="rpt-floors-summary">
                {cut == null
                  ? t('floors.pickPrompt')
                  : t('floors.willDelete', { from: cut, to: latest, count })}
              </span>
              {!confirming ? (
                <button
                  type="button"
                  className="rpt-floors-del"
                  disabled={cut == null || busy}
                  onClick={() => setConfirming(true)}
                >
                  {t('floors.delete')}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="rpt-duel-secondary"
                    disabled={busy}
                    onClick={() => setConfirming(false)}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    className="rpt-floors-del"
                    disabled={busy}
                    onClick={() => void onDelete()}
                  >
                    {t('floors.confirmDelete', { count })}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
