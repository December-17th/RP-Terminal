import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getAppDir, ensureDir, writeJsonSyncAtomic, readJsonSync } from './storageService';
import { Profile } from '../types/models';

const getProfilesDir = () => path.join(getAppDir(), 'profiles');
const getProfilesRegistryPath = () => path.join(getAppDir(), 'profiles.json');

// Get all profiles from registry
export const getProfiles = (): Profile[] => {
  return readJsonSync<Profile[]>(getProfilesRegistryPath()) || [];
};

// Get a specific profile by ID
export const getProfile = (id: string): Profile | undefined => {
  return getProfiles().find(p => p.id === id);
};

// Create a new profile
export const createProfile = (name: string, passwordHash?: string): Profile => {
  const profiles = getProfiles();
  const newProfile: Profile = {
    id: uuidv4(),
    name,
    password_hash: passwordHash,
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString()
  };
  
  profiles.push(newProfile);
  writeJsonSyncAtomic(getProfilesRegistryPath(), profiles);
  
  // Create profile specific directories
  const profileDir = path.join(getProfilesDir(), newProfile.id);
  ensureDir(profileDir);
  ensureDir(path.join(profileDir, 'characters'));
  ensureDir(path.join(profileDir, 'chats'));
  ensureDir(path.join(profileDir, 'lorebooks'));
  
  // Write the individual profile.json inside its directory for backup
  writeJsonSyncAtomic(path.join(profileDir, 'profile.json'), newProfile);
  
  return newProfile;
};

export const updateProfileActivity = (id: string) => {
  const profiles = getProfiles();
  const idx = profiles.findIndex(p => p.id === id);
  if (idx !== -1) {
    profiles[idx].last_active = new Date().toISOString();
    writeJsonSyncAtomic(getProfilesRegistryPath(), profiles);
    writeJsonSyncAtomic(path.join(getProfilesDir(), id, 'profile.json'), profiles[idx]);
  }
};
