// English UI strings (the source locale). Keys are dot-namespaced by area. `{{var}}` = interpolation.
const en: Record<string, string> = {
  'nav.persona': 'Persona',
  'nav.preset': 'Preset',
  'nav.lorebook': 'Lorebook',
  'nav.api': 'API',
  'nav.settings': 'Settings',
  'nav.logs': 'Logs',
  'nav.backToWorlds': 'Back to worlds',
  'nav.switchWorld': 'Switch world',
  'nav.switchSession': 'Switch session',
  'nav.session': 'Session',

  'launcher.worlds': 'Worlds',
  'launcher.chooseWorld': 'Choose a world',
  'launcher.chooseWorldSub': 'Each world is a character card — its PNG art is the avatar.',
  'launcher.importCard': '+ Import a card',
  'launcher.noWorlds': 'No worlds yet. Import a character card to begin.',
  'launcher.untitled': 'Untitled',
  'launcher.sessionsTitle': '{{name}} — sessions',
  'launcher.sessionsSub': 'Pick up where you left off, or start fresh.',
  'launcher.newSession': '+ New session',
  'launcher.noSessions': 'No sessions yet — start a new one.',
  'launcher.emptySession': 'Empty session',
  'launcher.sessionOne': '{{count}} session',
  'launcher.sessionMany': '{{count}} sessions',

  'settings.title': 'Settings',
  'settings.groupApp': 'App',
  'settings.groupWorld': 'World',
  'settings.preferences': 'Preferences',
  'settings.regex': 'Regex',
  'settings.scripts': 'Scripts',
  'settings.language': 'Language',

  'chat.sessionMode': 'Session mode',
  'chat.modeExplore': 'Explore',
  'chat.modeDialogue': 'Dialogue',
  'chat.modeCombat': 'Combat',
  'chat.switchToMode': 'Switch to {{mode}} mode',
  'chat.modeDisabledHint': 'Set Agent Mode to Manual or Agentic in Settings to switch scenes',
  'chat.regenerate': 'Regenerate',
  'chat.regenerateTitle': 'Re-roll the last response',

  'composer.placeholder': 'What do you do?  (type / for commands)',
  'composer.send': 'Send',
  'composer.stop': 'Stop generation',

  'profile.selectProfile': 'Select Profile',
  'profile.newProfileName': 'New Profile Name',
  'profile.create': 'Create'
}

export default en
