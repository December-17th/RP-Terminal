import { createContext, useContext } from 'react'

/**
 * Ambient context for views rendered inside the workspace. Panels render registry views
 * with no per-instance props, so the few things a view needs from the shell (the active
 * profile id) flow through here instead of being threaded down the split-tree.
 */
export const WorkspaceContext = createContext<{ profileId: string }>({ profileId: '' })

export const useWorkspaceContext = (): { profileId: string } => useContext(WorkspaceContext)
