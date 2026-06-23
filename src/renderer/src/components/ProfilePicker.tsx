import { useState } from 'react'
import { useProfileStore } from '../stores/profileStore'

/** Shown before a profile is active: pick an existing profile or create one. */
export function ProfilePicker(): React.ReactElement {
  const { profiles, createProfile } = useProfileStore()
  const [newProfileName, setNewProfileName] = useState('')

  return (
    <div style={{ padding: 20 }}>
      <h2>RP Terminal</h2>
      <div>
        <h3>Select Profile</h3>
        {profiles.map((p) => (
          <button
            key={p.id}
            onClick={() => useProfileStore.getState().setActiveProfile(p)}
            style={{ display: 'block', margin: '5px 0' }}
          >
            {p.name}
          </button>
        ))}
        <div style={{ marginTop: 20 }}>
          <input
            value={newProfileName}
            onChange={(e) => setNewProfileName(e.target.value)}
            placeholder="New Profile Name"
          />
          <button onClick={() => createProfile(newProfileName)} style={{ marginTop: 10 }}>
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
