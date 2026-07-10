import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const roots = [
  'AGENTS.md',
  'CLAUDE.md',
  'CONTEXT.md',
  'README.md',
  'THIRD-PARTY-NOTICES.md',
  'docs',
  path.join('resources', 'cardlibs', 'README.md')
]

const markdownFiles = []

function collect(relativePath) {
  const absolutePath = path.join(root, relativePath)
  if (!fs.existsSync(absolutePath)) return
  const stat = fs.statSync(absolutePath)
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolutePath)) collect(path.join(relativePath, name))
    return
  }
  if (relativePath.toLowerCase().endsWith('.md')) markdownFiles.push(relativePath)
}

for (const entry of roots) collect(entry)

const missing = []
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g

for (const relativePath of markdownFiles) {
  const absolutePath = path.join(root, relativePath)
  const text = fs.readFileSync(absolutePath, 'utf8')
  for (const match of text.matchAll(linkPattern)) {
    let target = match[1].trim().replace(/^<|>$/g, '')
    if (/^(?:https?:\/\/|mailto:|#)/i.test(target)) continue
    const titleStart = target.match(/\s+["']/)?.index
    if (titleStart !== undefined) target = target.slice(0, titleStart)
    target = target.split('#', 1)[0].split('?', 1)[0]
    if (!target) continue
    const resolved = path.resolve(path.dirname(absolutePath), decodeURIComponent(target))
    if (!fs.existsSync(resolved)) {
      const line = text.slice(0, match.index).split('\n').length
      missing.push(`${relativePath}:${line} -> ${match[1].trim()}`)
    }
  }
}

if (missing.length) {
  console.error(`Broken local documentation links (${missing.length}):`)
  for (const item of missing) console.error(`- ${item}`)
  process.exitCode = 1
} else {
  console.log(`Documentation links OK (${markdownFiles.length} Markdown files checked)`)
}
