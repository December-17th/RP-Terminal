#!/usr/bin/env node
// Normalize a raw oracle capture (extension /capture snapshot) into the frozen
// conformance fixture schema. Mechanical only — no interpretation. See
// test/conformance/fixtureSchema.ts for the target shape and RUNBOOK.md step 6.
//
// Usage:
//   node tools/oracle/normalize-capture.mjs \
//     --in tools/oracle/captures/<file>__capture.json \
//     --scenario wp-2.1-markers-basic \
//     --out test/conformance/fixtures/wp-2.1-markers-basic.json \
//     [--apply] [--force]
//
// The default is a non-mutating dry-run. --apply writes a new fixture. Existing
// output is refused so operator-completed data cannot be erased; replacing it
// requires the deliberately destructive combination --apply --force.

import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const options = { apply: false, force: false }
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]
    if (name === '--apply') options.apply = true
    else if (name === '--force') options.force = true
    else if (name === '--in' || name === '--scenario' || name === '--out') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
      options[name.slice(2)] = value
    } else {
      throw new Error(`unknown argument: ${name}`)
    }
  }
  if (!options.in || !options.scenario || !options.out) {
    throw new Error('--in, --scenario, and --out are required')
  }
  if (options.force && !options.apply) {
    throw new Error('--force is only valid together with --apply')
  }
  options.in = path.resolve(options.in)
  options.out = path.resolve(options.out)
  return options
}

function usage(message) {
  if (message) console.error(`normalize-capture: ${message}`)
  console.error(
    'usage: normalize-capture.mjs --in <raw> --scenario <id> --out <fixture> [--apply] [--force]'
  )
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function copyMessages(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value.map((message, index) => {
    if (
      !message ||
      typeof message !== 'object' ||
      typeof message.role !== 'string' ||
      typeof message.content !== 'string'
    ) {
      throw new Error(`${field}[${index}] must have string role and content`)
    }
    return { role: message.role, content: message.content }
  })
}

function availableBackupPath(file) {
  const first = `${file}.bak`
  if (!fs.existsSync(first)) return first
  for (let suffix = 2; ; suffix++) {
    const candidate = `${first}.${suffix}`
    if (!fs.existsSync(candidate)) return candidate
  }
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (err) {
  usage(err.message)
  process.exit(2)
}

let raw
try {
  raw = JSON.parse(fs.readFileSync(options.in, 'utf8'))
} catch (err) {
  console.error(`normalize-capture: cannot read capture ${options.in}: ${err.message}`)
  process.exit(1)
}

const body =
  raw && typeof raw === 'object' && raw.body && typeof raw.body === 'object' ? raw.body : raw // tolerate both wrapped and bare snapshots

if (!body || typeof body !== 'object' || Array.isArray(body)) {
  console.error('normalize-capture: capture body must be a JSON object')
  process.exit(1)
}

// Machine-readable INPUT (what was fed). The extension captures what it can observe from the
// public context (chat messages, preset name, token budget); fields it cannot see — the
// pre-activated World Info entries and any inline preset/character override — the operator
// fills in by hand after normalization (RUNBOOK step 5). Never invented here.
const capturedInput = body.input || {}
if (!capturedInput || typeof capturedInput !== 'object' || Array.isArray(capturedInput)) {
  console.error('normalize-capture: input must be a JSON object')
  process.exit(1)
}

let fixture
try {
  const generationType =
    typeof capturedInput.generationType === 'string' && capturedInput.generationType
      ? capturedInput.generationType
      : typeof body.dryRun === 'boolean'
        ? body.dryRun
          ? 'dry-run'
          : 'normal'
        : null
  if (!generationType) throw new Error('input.generationType is missing')

  const macroEngine =
    capturedInput.macroEngine === 'new' || capturedInput.macroEngine === 'legacy'
      ? capturedInput.macroEngine
      : 'new'

  const input = {
    chatMessages: copyMessages(capturedInput.chatMessages, 'input.chatMessages'),
    generationType,
    macroEngine
  }

  // Copy optional fields only when the capture actually contains them. Missing
  // stays missing, explicit null stays null, and an explicit empty array stays
  // empty; normalization never guesses one state from another.
  for (const key of ['presetName', 'preset', 'character', 'userName', 'worldInfo', 'tokenBudget']) {
    if (hasOwn(capturedInput, key)) input[key] = capturedInput[key]
  }
  if (hasOwn(body, 'settings')) input.settings = body.settings

  fixture = {
    schemaVersion: 1,
    scenarioId: options.scenario,
    source: 'captured',
    st: {
      version:
        body.st && typeof body.st.version === 'string' && body.st.version
          ? body.st.version
          : '1.18.0',
      commit: '51ad27f',
      macroEngine
    },
    generationType,
    input,
    expected: {
      chat: copyMessages(body.promptReady && body.promptReady.chat, 'promptReady.chat')
    }
  }
  if (hasOwn(body, 'capturedAt')) fixture.capturedAt = body.capturedAt
  else if (hasOwn(raw, 'receivedAt')) fixture.capturedAt = raw.receivedAt
  if (hasOwn(body, 'settings')) fixture.settings = body.settings
} catch (err) {
  console.error(`normalize-capture: invalid capture: ${err.message}`)
  process.exit(1)
}

const exists = fs.existsSync(options.out)
if (exists && !options.force) {
  console.error(
    `normalize-capture: refused to replace existing output ${options.out}; ` +
      'operator-completed data is preserved. Use a new path, or use --apply --force to replace it.'
  )
  process.exit(3)
}

const serialized = JSON.stringify(fixture, null, 2) + '\n'
if (!options.apply) {
  const directory = path.dirname(options.out)
  if (!fs.existsSync(directory)) console.log(`[dry-run] would create directory ${directory}`)
  console.log(
    `[dry-run] would write ${options.out} (${fixture.expected.chat.length} messages); ` +
      'rerun with --apply to persist'
  )
  process.exit(0)
}

fs.mkdirSync(path.dirname(options.out), { recursive: true })
if (exists) {
  const backup = availableBackupPath(options.out)
  fs.copyFileSync(options.out, backup, fs.constants.COPYFILE_EXCL)
  console.log(`backed up existing output to ${backup}`)
}
fs.writeFileSync(options.out, serialized)
console.log(
  `${exists ? 'replaced' : 'wrote'} ${options.out} (${fixture.expected.chat.length} messages)`
)
