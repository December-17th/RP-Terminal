import { create } from 'zustand'

export interface Profile {
  id: string
  name: string
}

interface ProfileState {
  profiles: Profile[]
  activeProfile: Profile | null
  loadProfiles: () => Promise<void>
  createProfile: (name: string) => Promise<void>
  setActiveProfile: (profile: Profile) => void
}

export const useProfileStore = create<ProfileState>((set) => ({
  profiles: [],
  activeProfile: null,
  loadProfiles: async () => {
    const profiles = await window.api.getProfiles()
    set({ profiles })
    if (profiles.length > 0) {
      set({ activeProfile: profiles[0] })
    }
  },
  createProfile: async (name: string) => {
    const newProfile = await window.api.createProfile(name)
    set((state) => ({ profiles: [...state.profiles, newProfile], activeProfile: newProfile }))
  },
  setActiveProfile: (profile) => set({ activeProfile: profile })
}))
