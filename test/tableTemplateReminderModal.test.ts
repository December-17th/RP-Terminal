import React from 'react'
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
})
