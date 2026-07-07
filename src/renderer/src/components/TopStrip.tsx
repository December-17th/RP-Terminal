import { useEffect, useRef, useState } from 'react'
import { useCharacterStore } from '../stores/characterStore'
import { usePresetStore } from '../stores/presetStore'
import { useLorebookStore } from '../stores/lorebookStore'
import { useChatStore } from '../stores/chatStore'
import { useUiStore, type SettingsSection } from '../stores/uiStore'
import { useT } from '../i18n'

/**
 * The play-mode top strip — a menu-bar shell that REPLACES the old tab TopNav. The tab nav was
 * retired (workspace panels are now game + debug only); instead the config/authoring surfaces are
 * reached from per-item dropdowns here, and the full editors live in the Settings hub
 * (useUiStore.openSettings(section)). Layout: brand · world/session breadcrumb · ‹spacer› ·
 * Persona / Preset / Lorebook / Assets / Connection dropdowns · settings gear. The right padding
 * (in CSS) reserves the OS window-control overlay; the strip is the window drag region.
 */

/** A single dropdown on the strip: a mono trigger button + a popover the caller fills. Closes on
 *  outside-click (an invisible full-screen backdrop) or when an item calls the passed `close`. */
function StripMenu({
  label,
  render
}: {
  label: string
  render: (close: () => void) => React.ReactNode
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const close = (): void => setOpen(false)

  // Focus the first item when the menu opens (after the popover renders).
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('.tmenu-item')?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [open])

  // When the menu closes while focus was still inside it, return focus to the trigger.
  useEffect(() => {
    if (open) return
    if (menuRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
  }, [open])

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('.tmenu-item') ?? [])
    if (items.length === 0) return
    const idx = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(idx + 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(idx - 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      items[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      items[items.length - 1]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      triggerRef.current?.focus()
    } else if (e.key === 'Tab') {
      close()
    }
  }

  return (
    <div className="tmenu-wrap">
      <button
        ref={triggerRef}
        className={`tmenu-btn ${open ? 'open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        {label} <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <>
          <button className="tmenu-backdrop" aria-hidden="true" tabIndex={-1} onClick={close} />
          <div className="tmenu" role="menu" ref={menuRef} onKeyDown={onMenuKeyDown}>
            {render(close)}
          </div>
        </>
      )}
    </div>
  )
}

/** The Lorebook dropdown body — the world's lorebook library with per-SESSION enable toggles
 *  (mirrors LorebookManager: the effective active set is the explicit session list, or the default
 *  of just the card's own book). Loads the library + this session's selection when opened. Toggling
 *  keeps the menu open (multi-select); only "Edit world books…" closes it and opens the editor. */
function LorebookMenu({ profileId, close }: { profileId: string; close: () => void }): React.ReactElement {
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const library = useLorebookStore((s) => s.library)
  const sessionIds = useLorebookStore((s) => s.sessionIds)
  const t = useT()

  useEffect(() => {
    void useLorebookStore.getState().loadLibrary(profileId)
    if (activeChatId) void useLorebookStore.getState().loadSession(profileId, activeChatId)
  }, [profileId, activeChatId])

  const characterId = activeCharacter?.id
  const effective = sessionIds ?? (characterId ? [characterId] : [])
  const toggle = (id: string): void => {
    if (!activeChatId) return
    const next = effective.includes(id) ? effective.filter((i) => i !== id) : [...effective, id]
    void useLorebookStore.getState().setSession(profileId, activeChatId, next)
  }

  return (
    <>
      <div className="tmenu-head">{t('strip.sessionBooks')}</div>
      {library.length === 0 && <div className="tmenu-empty">{t('strip.none')}</div>}
      {library.map((b) => {
        const on = effective.includes(b.id)
        return (
          <button
            key={b.id}
            className={`tmenu-item ${on ? 'sel' : 'muted'}`}
            role="menuitemcheckbox"
            aria-checked={on}
            onClick={() => toggle(b.id)}
          >
            <span className="mark" aria-hidden="true">
              ✓
            </span>
            {b.name}
          </button>
        )
      })}
      <div className="tmenu-sep" />
      <button
        className="tmenu-item action"
        role="menuitem"
        onClick={() => {
          close()
          useUiStore.getState().openSettings('lorebook')
        }}
      >
        <span className="mark" aria-hidden="true">
          ⚙
        </span>
        {t('strip.editBooks')}
      </button>
    </>
  )
}

export function TopStrip({
  profileId,
  profileName
}: {
  profileId: string
  profileName: string
}): React.ReactElement {
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const presets = usePresetStore((s) => s.presets)
  const activePresetId = usePresetStore((s) => s.activeId)
  const activePresetName = usePresetStore((s) => s.preset?.name)
  const t = useT()

  const worldName = activeCharacter?.card.data.name || t('nav.session')
  const openSettings = (section: SettingsSection): void => useUiStore.getState().openSettings(section)

  // A dropdown whose only content is "open this Settings section" — the shared shape for the
  // surfaces without inline quick-select (Persona / Lorebook / Assets / Connection).
  const openAction = (label: string, section: SettingsSection) => (
    <StripMenu
      label={label}
      render={(close) => (
        <button
          className="tmenu-item action"
          role="menuitem"
          onClick={() => {
            close()
            openSettings(section)
          }}
        >
          <span className="mark" aria-hidden="true">
            ⚙
          </span>
          {t('strip.open', { name: label })}
        </button>
      )}
    />
  )

  return (
    <div className="tstrip">
      <button
        className="tstrip-brand"
        onClick={() => useChatStore.getState().clearActiveChat()}
        title={t('nav.backToWorlds')}
      >
        <span className="dot" aria-hidden="true">
          ▮
        </span>
        RP Terminal
      </button>

      <div className="tstrip-crumbs">
        <button
          className="tmenu-btn crumb"
          onClick={() => {
            useUiStore.getState().setLauncherWorldId(null)
            useChatStore.getState().clearActiveChat()
          }}
          title={t('nav.switchWorld')}
        >
          <span className="tstrip-crumb-label">{worldName}</span>
          <span className="caret" aria-hidden="true">
            ⌄
          </span>
        </button>
        <span className="tstrip-sep">/</span>
        <button
          className="tmenu-btn crumb"
          onClick={() => {
            if (activeCharacter) useUiStore.getState().setLauncherWorldId(activeCharacter.id)
            useChatStore.getState().clearActiveChat()
          }}
          title={t('nav.switchSession')}
        >
          <span className="tstrip-crumb-label">{t('nav.session')}</span>
          <span className="caret" aria-hidden="true">
            ⌄
          </span>
        </button>
      </div>

      <span className="tstrip-spacer" title={`${profileName} · ${activePresetName || ''}`} />

      <div className="tstrip-menus">
        {openAction(t('nav.persona'), 'persona')}

        {/* Preset — inline quick-select (the store exposes a list + active id + select). */}
        <StripMenu
          label={t('nav.preset')}
          render={(close) => (
            <>
              <div className="tmenu-head">{t('strip.activePreset')}</div>
              {presets.length === 0 && <div className="tmenu-empty">{t('strip.none')}</div>}
              {presets.map((p) => (
                <button
                  key={p.id}
                  className={`tmenu-item ${p.id === activePresetId ? 'sel' : 'muted'}`}
                  role="menuitemradio"
                  aria-checked={p.id === activePresetId}
                  onClick={() => {
                    close()
                    if (p.id !== activePresetId) void usePresetStore.getState().select(profileId, p.id)
                  }}
                >
                  <span className="mark" aria-hidden="true">
                    ✓
                  </span>
                  {p.name}
                </button>
              ))}
              <div className="tmenu-sep" />
              <button
                className="tmenu-item action"
                role="menuitem"
                onClick={() => {
                  close()
                  openSettings('preset')
                }}
              >
                <span className="mark" aria-hidden="true">
                  ⚙
                </span>
                {t('strip.managePresets')}
              </button>
            </>
          )}
        />

        <StripMenu
          label={t('nav.lorebook')}
          render={(close) => <LorebookMenu profileId={profileId} close={close} />}
        />

        {openAction(t('nav.assets'), 'assets')}
        {openAction(t('settings.connection'), 'connection')}

        <button
          className="tmenu-btn"
          onClick={() => useUiStore.getState().openWorkflowEditor()}
          title={t('nav.workflowTitle')}
        >
          {t('nav.workflow')}
        </button>

        <button
          className="tmenu-btn gear"
          onClick={() => openSettings('app')}
          title={t('nav.settings')}
        >
          ⚙
        </button>
      </div>
    </div>
  )
}
