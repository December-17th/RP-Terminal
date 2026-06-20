import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getAppDir, ensureDir, writeJsonSyncAtomic, readJsonSync, listDirectoriesSync } from './storageService';
import { ChatSession } from '../types/chat';

export const getChatsDir = (profileId: string) => path.join(getAppDir(), 'profiles', profileId, 'chats');

export const getChats = (profileId: string): ChatSession[] => {
  const chatsDir = getChatsDir(profileId);
  if (!require('fs').existsSync(chatsDir)) return [];
  
  const chatIds = listDirectoriesSync(chatsDir);
  const sessions: ChatSession[] = [];
  
  for (const id of chatIds) {
    const chatJsonPath = path.join(chatsDir, id, 'chat.json');
    const session = readJsonSync<ChatSession>(chatJsonPath);
    if (session) sessions.push(session);
  }
  
  return sessions.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
};

export const createChat = (profileId: string, characterId: string): ChatSession => {
  const newSession: ChatSession = {
    id: uuidv4(),
    character_id: characterId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    floor_count: 0,
    floor_index: []
  };
  
  const chatDir = path.join(getChatsDir(profileId), newSession.id);
  ensureDir(chatDir);
  writeJsonSyncAtomic(path.join(chatDir, 'chat.json'), newSession);
  
  return newSession;
};

export const updateChatIndex = (profileId: string, chat: ChatSession) => {
  chat.updated_at = new Date().toISOString();
  const chatJsonPath = path.join(getChatsDir(profileId), chat.id, 'chat.json');
  writeJsonSyncAtomic(chatJsonPath, chat);
};
