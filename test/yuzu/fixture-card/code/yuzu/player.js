;(() => {
  const commandPattern = /^<\|\s*(.*?)\s*\|>$/
  const positions = new Set(['left', 'center', 'right'])
  const unsupported = new Set([
    'mood',
    'music',
    'ambience',
    'sfx',
    'cg',
    'choice',
    'effect',
    'enter',
    'move'
  ])

  function parseLine(line) {
    const match = commandPattern.exec(line)
    if (!match) return null
    const parts = match[1].trim().split(/\s+/).filter(Boolean)
    if (unsupported.has(parts[0])) return { type: 'unsupported' }
    if (parts.length === 1 && (parts[0] === 'block' || parts[0] === 'end')) {
      return { type: parts[0] }
    }
    if (parts[0] === 'bg' && parts.length > 1) {
      return { type: 'command', command: { type: 'bg', location: parts.slice(1).join(' ') } }
    }
    if (parts.length === 2 && parts[1] === 'exit') {
      return { type: 'command', command: { type: 'exit', actor: parts[0] } }
    }
    const position = parts.at(-1)
    if (parts.length >= 2 && positions.has(position)) {
      return {
        type: 'command',
        command: {
          type: 'actor',
          actor: parts[0],
          expression: parts.length > 2 ? parts.slice(1, -1).join(' ') : undefined,
          position
        }
      }
    }
    return { type: 'unsupported' }
  }

  function parseAnnotatedFloor(text) {
    const blocks = []
    let current = null
    let ended = false
    for (const line of String(text || '').split(/\r?\n/)) {
      const parsed = parseLine(line)
      if (parsed?.type === 'unsupported') return null
      if (ended) {
        if (line.trim()) return null
        continue
      }
      if (parsed?.type === 'block') {
        current = { commands: [], lines: [] }
        blocks.push(current)
      } else if (parsed?.type === 'end') {
        if (!current) return null
        ended = true
      } else if (parsed?.type === 'command') {
        if (!current) return null
        current.commands.push(parsed.command)
      } else {
        if (!current) return null
        current.lines.push(line)
      }
    }
    if (!ended || !blocks.length) return null
    const result = blocks.map((block) => ({
      commands: block.commands,
      content: block.lines.join('\n')
    }))
    return result.some((block) => block.content.trim()) ? result : null
  }

  window.YuzuFixturePlayer = { parseAnnotatedFloor }

  async function boot() {
    const stage = document.querySelector('.stage')
    const content = document.querySelector('.script__content')
    const advance = document.querySelector('.script__advance')
    const backdrop = document.querySelector('.stage__backdrop')
    if (!stage || !content || !advance || !backdrop) return

    const messages = await Promise.resolve(window.getChatMessages?.(-1) || [])
    const latest = messages.find((message) => message.role === 'assistant')
    const raw = typeof latest?.message === 'string' ? latest.message : ''
    const blocks = parseAnnotatedFloor(raw) || [{ commands: [], content: raw }]
    const actors = new Map()
    let index = 0
    let advancing = false

    async function asset(name, type, expression) {
      if (typeof window.assetUrl !== 'function') return null
      return window.assetUrl(name, type, expression)
    }

    async function applyCommands(commands) {
      for (const command of commands) {
        if (command.type === 'bg') {
          const url =
            (await asset(command.location, '背景')) || (await asset(command.location, '全景'))
          if (url) backdrop.src = url
        } else if (command.type === 'exit') {
          actors.delete(command.actor)
        } else {
          actors.set(command.actor, command)
        }
      }
      for (const position of positions) {
        const slot = document.querySelector(`.actor[data-position="${position}"]`)
        if (slot) slot.replaceChildren()
      }
      for (const actor of actors.values()) {
        const slot = document.querySelector(`.actor[data-position="${actor.position}"]`)
        if (!slot) continue
        const url = await asset(actor.actor, '立绘', actor.expression)
        if (url) {
          const image = document.createElement('img')
          image.alt = actor.actor
          image.src = url
          slot.append(image)
        }
        const name = document.createElement('span')
        name.className = 'actor__name'
        name.textContent = actor.actor
        slot.append(name)
      }
    }

    async function reveal() {
      const block = blocks[index]
      await applyCommands(block.commands)
      const formatted =
        typeof window.formatAsTavernRegexedString === 'function'
          ? window.formatAsTavernRegexedString(block.content)
          : block.content
      content.innerHTML = typeof formatted === 'string' ? formatted : block.content
      advance.disabled = index >= blocks.length - 1
      advance.textContent = advance.disabled ? '本幕结束' : '下一幕'
      stage.dataset.state = raw ? 'ready' : 'empty'
    }

    advance.addEventListener('click', async () => {
      if (advancing || index >= blocks.length - 1) return
      advancing = true
      index += 1
      try {
        await reveal()
      } finally {
        advancing = false
      }
    })
    await reveal()
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  else void boot()
})()
