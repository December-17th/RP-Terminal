import React from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  dismiss: vi.fn(),
  ensureLeftPanel: vi.fn(),
  openMemoryManager: vi.fn(),
  updateSettings: vi.fn()
}))

vi.mock('../src/renderer/src/stores/chatStore', () => ({
  useChatStore: (selector: (state: unknown) => unknown) =>
    selector({ templateReminderOpen: true, dismissTemplateReminder: h.dismiss })
}))

vi.mock('../src/renderer/src/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: {}, updateSettings: h.updateSettings })
}))

vi.mock('../src/renderer/src/stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({ ensureLeftPanel: h.ensureLeftPanel })
}))

vi.mock('../src/renderer/src/stores/uiStore', () => ({
  useUiStore: (selector: (state: unknown) => unknown) =>
    selector({ openMemoryManager: h.openMemoryManager })
}))

vi.mock('../src/renderer/src/i18n', () => ({ useT: () => (key: string) => key }))

import { TableTemplateReminderModal } from '../src/renderer/src/components/TableTemplateReminderModal'

type ButtonElement = React.ReactElement<{
  children?: React.ReactNode
  onClick?: () => void
}>

function findButton(node: React.ReactNode, label: string): ButtonElement | null {
  if (React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(node)) {
    if (node.type === 'button' && node.props.children === label) return node
    return findButton(node.props.children, label)
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label)
      if (found) return found
    }
  }
  return null
}

function findClass(node: React.ReactNode, className: string): React.ReactElement | null {
  if (React.isValidElement<{ children?: React.ReactNode; className?: string }>(node)) {
    if (node.props.className?.split(/\s+/).includes(className)) return node
    return findClass(node.props.children, className)
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findClass(child, className)
      if (found) return found
    }
  }
  return null
}

describe('TableTemplateReminderModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens the full-window Memory Manager from the primary action', () => {
    const modal = TableTemplateReminderModal({ profileId: 'profile-1' })
    const button = findButton(modal, 'tableReminder.openMemory')

    expect(button).not.toBeNull()
    button?.props.onClick?.()

    expect(h.openMemoryManager).toHaveBeenCalledOnce()
    expect(h.ensureLeftPanel).not.toHaveBeenCalled()
    expect(h.dismiss).toHaveBeenCalledOnce()
  })

  it('uses a compact, content-height shell for the reminder only', () => {
    const modal = TableTemplateReminderModal({ profileId: 'profile-1' })
    const css = readFileSync(resolve(__dirname, '../src/renderer/src/assets/index.css'), 'utf8')
    const panelRule = css.match(/\.modal-panel:has\(\.rpt-table-reminder\)\s*\{[^}]*\}/)?.[0]
    const bodyRule = css.match(/\.modal-body:has\(\.rpt-table-reminder\)\s*\{[^}]*\}/)?.[0]

    expect(findClass(modal, 'rpt-table-reminder')).not.toBeNull()
    expect(panelRule).toContain('width: min(500px, 92vw)')
    expect(panelRule).toContain('height: auto')
    expect(panelRule).toContain('max-height: 90vh')
    expect(bodyRule).toContain('flex: 0 1 auto')
  })
})
