import { useEffect, useState } from 'react'
import { useCharacterStore, CharacterCard } from '../stores/characterStore'
import { useChatStore } from '../stores/chatStore'
import { useUiStore } from '../stores/uiStore'
import { useToastStore } from '../stores/toastStore'
import { useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * The entry launcher: choose a world (character card) → choose a session → play. Shown by App
 * whenever there's no open session (`activeChatId == null`). Picking/creating a session sets
 * `activeChatId`, which flips App over to the play workspace.
 */
export function Launcher({ profileId }: { profileId: string }): React.ReactElement {
  const characters = useCharacterStore((s) => s.characters)
  const setActiveCharacter = useCharacterStore((s) => s.setActiveCharacter)
  const importCharacter = useCharacterStore((s) => s.importCharacter)
  const deleteCharacter = useCharacterStore((s) => s.deleteCharacter)
  const chats = useChatStore((s) => s.chats)
  const createChat = useChatStore((s) => s.createChat)
  const setActiveChat = useChatStore((s) => s.setActiveChat)
  const deleteChat = useChatStore((s) => s.deleteChat)
  const exportSave = useChatStore((s) => s.exportSave)
  const importSave = useChatStore((s) => s.importSave)
  const launcherWorldId = useUiStore((s) => s.launcherWorldId)
  const setLauncherWorldId = useUiStore((s) => s.setLauncherWorldId)
  const t = useT()

  // null = the world chooser; a card = that world's session list.
  const [selected, setSelected] = useState<CharacterCard | null>(null)
  const [avatars, setAvatars] = useState<Record<string, string | null>>({})
  // Pending deletion awaiting in-app confirm; null = no dialog.
  const [confirming, setConfirming] = useState<{
    kind: 'world' | 'chat'
    id: string
    name: string
  } | null>(null)

  // Resolve each world's PNG avatar to a data URL once the list is known.
  useEffect(() => {
    let alive = true
    void (async () => {
      const entries = await Promise.all(
        characters.map(async (c) => {
          try {
            return [c.id, (await window.api?.getCharacterAvatar?.(c.id)) ?? null] as const
          } catch {
            return [c.id, null] as const
          }
        })
      )
      if (alive) setAvatars(Object.fromEntries(entries))
    })()
    return () => {
      alive = false
    }
  }, [characters])

  // Breadcrumb deep-link: if the session switcher set a world id, open straight to its session list.
  useEffect(() => {
    if (!launcherWorldId) return
    const w = characters.find((c) => c.id === launcherWorldId)
    if (w) {
      setActiveCharacter(w)
      setSelected(w)
    }
    setLauncherWorldId(null)
  }, [launcherWorldId, characters])

  const openWorld = (c: CharacterCard): void => {
    setActiveCharacter(c)
    setSelected(c)
  }

  const toast = (m: string): void => useToastStore.getState().push(m)

  // Feature 2 — export one session to a `.rpsave`; import one into a new session (world must be
  // installed). Both surface success/failure as a toast; a cancelled native dialog returns null.
  const onExportSave = async (chatId: string): Promise<void> => {
    const res = await exportSave(profileId, chatId)
    if (!res) return
    if ('error' in res)
      toast(
        res.error === 'save.memoryBusy' ? t('sessions.saveMemoryBusy') : t('sessions.saveFailed')
      )
    else toast(t('sessions.saveExported', { name: res.name }))
  }
  const onImportSave = async (): Promise<void> => {
    const res = await importSave(profileId)
    if (!res) return
    if ('error' in res) {
      if (res.error === 'save.worldMissing')
        toast(t('sessions.saveWorldMissing', { name: res.worldName || '?' }))
      else if (res.error === 'save.badArchive') toast(t('sessions.saveBadArchive'))
      else toast(t('sessions.saveFailed'))
    } else toast(t('sessions.saveImported'))
  }

  // Shared across both launcher branches (world list AND session list).
  const confirmDialog = confirming && (
    <ConfirmDialog
      title={confirming.kind === 'world' ? t('world.deleteTitle') : t('sessions.deleteTitle')}
      body={
        confirming.kind === 'world'
          ? t('world.confirmDelete', { name: confirming.name })
          : t('sessions.confirmDelete')
      }
      confirmLabel={t('common.delete')}
      danger
      onConfirm={() => {
        if (confirming.kind === 'world') deleteCharacter(profileId, confirming.id)
        else deleteChat(profileId, confirming.id)
        setConfirming(null)
      }}
      onCancel={() => setConfirming(null)}
    />
  )

  if (selected) {
    const worldName = selected.card?.data?.name || t('launcher.untitled')
    const worldChats = chats.filter((c) => c.character_id === selected.id)
    return (
      <>
        <div className="launcher">
          <div className="lc-bar">
            <span className="lc-brand">
              <span className="lc-brand-dot" aria-hidden="true">
                ▮
              </span>{' '}
              RP Terminal
            </span>
            <button className="lc-crumb" onClick={() => setSelected(null)}>
              ← {t('launcher.worlds')}
            </button>
            <span className="lc-sep">/</span>
            <span className="lc-crumb-cur">{worldName}</span>
            <span className="lc-spacer" />
            <button className="lc-crumb" onClick={onImportSave} title={t('sessions.importSave')}>
              ⭳ {t('sessions.importSave')}
            </button>
            <button
              className="lc-crumb"
              onClick={() => useUiStore.getState().openSettings()}
              title={t('nav.settings')}
            >
              ⚙
            </button>
          </div>
          <div className="lc-scroll">
            <div className="lc-hero">
              <div className="lc-eyebrow">{t('launcher.eyebrowSessions')}</div>
              <div className="lc-h">
                {t('launcher.sessionsTitle', { name: worldName })}
                <span className="lc-caret" aria-hidden="true" />
              </div>
              <div className="lc-sub">{t('launcher.sessionsSub')}</div>
            </div>
            <div className="lc-slist">
              <button className="lc-new" onClick={() => createChat(profileId, selected.id)}>
                {t('launcher.newSession')}
              </button>
              {worldChats.length === 0 && (
                <div className="lc-empty">{t('launcher.noSessions')}</div>
              )}
              {worldChats.map((c) => {
                const last = c.floor_index?.[c.floor_index.length - 1]
                // Show the latest turn: the player's action (up to 2 lines) then the response (up to 3,
                // reasoning + state tags already stripped main-side). The greeting floor has no user
                // action, so that line is omitted. CSS clamps the line counts.
                const userPrev = last?.user_preview?.trim()
                const respPrev = last?.response_preview?.trim() || t('launcher.emptySession')
                return (
                  <div key={c.id} className="lc-srow-wrap">
                    <button className="lc-srow" onClick={() => setActiveChat(profileId, c.id)}>
                      {userPrev && <span className="lc-sprev-user">▸ {userPrev}</span>}
                      <span className="lc-sprev-resp">{respPrev}</span>
                      <span className="lc-smeta">
                        {new Date(c.updated_at).toLocaleString()} · {c.floor_count ?? 0} ✦
                      </span>
                    </button>
                    <button
                      className="btn-ghost lc-sexport"
                      title={t('sessions.exportSave')}
                      onClick={() => onExportSave(c.id)}
                    >
                      ⭳
                    </button>
                    <button
                      className="btn-ghost danger lc-sdel"
                      title={t('sessions.deleteTitle')}
                      onClick={() => setConfirming({ kind: 'chat', id: c.id, name: '' })}
                    >
                      🗑
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
        {confirmDialog}
      </>
    )
  }

  return (
    <>
      <div className="launcher">
        <div className="lc-bar">
          <span className="lc-brand">RP Terminal</span>
          <span className="lc-crumb-cur">{t('launcher.worlds')}</span>
          <span className="lc-spacer" />
          <button className="lc-import" onClick={() => importCharacter(profileId)}>
            {t('launcher.importCard')}
          </button>
          <button
            className="lc-crumb"
            onClick={() => useUiStore.getState().openSettings()}
            title={t('nav.settings')}
          >
            ⚙
          </button>
        </div>
        <div className="lc-scroll">
          <div className="lc-hero">
            <div className="lc-eyebrow">{t('launcher.eyebrowWorlds')}</div>
            <div className="lc-h">
              {t('launcher.chooseWorld')}
              <span className="lc-caret" aria-hidden="true" />
            </div>
            <div className="lc-sub">{t('launcher.chooseWorldSub')}</div>
          </div>
          {characters.length === 0 ? (
            <div className="lc-empty">{t('launcher.noWorlds')}</div>
          ) : (
            <div className="lc-wlist">
              {characters.map((c) => {
                const d = c.card?.data ?? {}
                const desc = String(d.creator_notes || d.description || '').trim()
                const count = chats.filter((ch) => ch.character_id === c.id).length
                const url = avatars[c.id]
                const name = d.name || t('launcher.untitled')
                return (
                  <div key={c.id} className="lc-wrow-wrap">
                    <button className="lc-wrow" onClick={() => openWorld(c)}>
                      {url ? (
                        <img className="lc-av" src={url} alt="" />
                      ) : (
                        <span className="lc-av lc-av-ph">{String(d.name || '?').slice(0, 1)}</span>
                      )}
                      <span className="lc-wtext">
                        <span className="lc-wname">{name}</span>
                        {desc && <span className="lc-wdesc">{desc}</span>}
                        <span className="lc-wmeta">
                          {count === 1
                            ? t('launcher.sessionOne', { count })
                            : t('launcher.sessionMany', { count })}
                        </span>
                      </span>
                      <span className="lc-enter" aria-hidden="true">
                        {t('launcher.enter')} ▶
                      </span>
                    </button>
                    <button
                      className="btn-ghost danger lc-wdel"
                      title={t('world.deleteTitle')}
                      onClick={() => setConfirming({ kind: 'world', id: c.id, name })}
                    >
                      🗑
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
      {confirmDialog}
    </>
  )
}
