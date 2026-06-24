import { useEffect, useState } from 'react'
import { useCharacterStore, CharacterCard } from '../stores/characterStore'
import { useChatStore } from '../stores/chatStore'

/**
 * The entry launcher: choose a world (character card) → choose a session → play. Shown by App
 * whenever there's no open session (`activeChatId == null`). Picking/creating a session sets
 * `activeChatId`, which flips App over to the play workspace.
 */
export function Launcher({ profileId }: { profileId: string }): React.ReactElement {
  const characters = useCharacterStore((s) => s.characters)
  const setActiveCharacter = useCharacterStore((s) => s.setActiveCharacter)
  const importCharacter = useCharacterStore((s) => s.importCharacter)
  const chats = useChatStore((s) => s.chats)
  const createChat = useChatStore((s) => s.createChat)
  const setActiveChat = useChatStore((s) => s.setActiveChat)

  // null = the world chooser; a card = that world's session list.
  const [selected, setSelected] = useState<CharacterCard | null>(null)
  const [avatars, setAvatars] = useState<Record<string, string | null>>({})

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

  const openWorld = (c: CharacterCard): void => {
    setActiveCharacter(c)
    setSelected(c)
  }

  if (selected) {
    const worldChats = chats.filter((c) => c.character_id === selected.id)
    return (
      <div className="launcher">
        <div className="lc-bar">
          <span className="lc-brand">RP Terminal</span>
          <button className="lc-crumb" onClick={() => setSelected(null)}>
            ← Worlds
          </button>
          <span className="lc-sep">/</span>
          <span className="lc-crumb-cur">{selected.card?.data?.name || 'World'}</span>
        </div>
        <div className="lc-scroll">
          <div className="lc-h">{selected.card?.data?.name || 'World'} — sessions</div>
          <div className="lc-sub">Pick up where you left off, or start fresh.</div>
          <div className="lc-slist">
            <button className="lc-new" onClick={() => createChat(profileId, selected.id)}>
              + New session
            </button>
            {worldChats.length === 0 && (
              <div className="lc-empty">No sessions yet — start a new one.</div>
            )}
            {worldChats.map((c) => {
              const last = c.floor_index?.[c.floor_index.length - 1]
              const preview = last?.response_preview || 'Empty session'
              return (
                <button
                  key={c.id}
                  className="lc-srow"
                  onClick={() => setActiveChat(profileId, c.id)}
                >
                  <span className="lc-sprev">{preview}</span>
                  <span className="lc-smeta">
                    {new Date(c.updated_at).toLocaleString()} · {c.floor_count ?? 0} ✦
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="launcher">
      <div className="lc-bar">
        <span className="lc-brand">RP Terminal</span>
        <span className="lc-crumb-cur">Worlds</span>
        <span className="lc-spacer" />
        <button className="lc-import" onClick={() => importCharacter(profileId)}>
          + Import a card
        </button>
      </div>
      <div className="lc-scroll">
        <div className="lc-h">Choose a world</div>
        <div className="lc-sub">Each world is a character card — its PNG art is the avatar.</div>
        {characters.length === 0 ? (
          <div className="lc-empty">No worlds yet. Import a character card to begin.</div>
        ) : (
          <div className="lc-wlist">
            {characters.map((c) => {
              const d = c.card?.data ?? {}
              const desc = String(d.creator_notes || d.description || '').trim()
              const count = chats.filter((ch) => ch.character_id === c.id).length
              const url = avatars[c.id]
              return (
                <button key={c.id} className="lc-wrow" onClick={() => openWorld(c)}>
                  {url ? (
                    <img className="lc-av" src={url} alt="" />
                  ) : (
                    <span className="lc-av lc-av-ph">{String(d.name || '?').slice(0, 1)}</span>
                  )}
                  <span className="lc-wtext">
                    <span className="lc-wname">{d.name || 'Untitled'}</span>
                    {desc && <span className="lc-wdesc">{desc}</span>}
                    <span className="lc-wmeta">
                      {count} session{count === 1 ? '' : 's'}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
