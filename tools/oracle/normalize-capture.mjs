#!/usr/bin/env node
// Normalize a raw oracle capture (extension /capture snapshot) into the frozen
// conformance fixture schema. Mechanical only — no interpretation. See
// test/conformance/fixtureSchema.ts for the target shape and RUNBOOK.md step 6.
//
// Usage:
//   node tools/oracle/normalize-capture.mjs \
//     --in tools/oracle/captures/<file>__capture.json \
//     --scenario wp-2.1-markers-basic \
//     --out test/conformance/fixtures/wp-2.1-markers-basic.json

import fs from 'node:fs'
import path from 'node:path'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const inPath = arg('--in')
const scenarioId = arg('--scenario')
const outPath = arg('--out')

if (!inPath || !scenarioId || !outPath) {
  console.error('usage: normalize-capture.mjs --in <raw> --scenario <id> --out <fixture>')
  process.exit(2)
}

const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'))
const body = raw.body || raw // tolerate both wrapped and bare snapshots

// Machine-readable INPUT (what was fed). The extension captures what it can observe from the
// public context (chat messages, preset name, token budget); fields it cannot see — the
// pre-activated World Info entries and any inline preset/character override — the operator
// fills in by hand after normalization (RUNBOOK step 5). Never invented here.
const capturedInput = body.input || {}
const input = {
  presetName: capturedInput.presetName ?? null,
  chatMessages: Array.isArray(capturedInput.chatMessages)
    ? capturedInput.chatMessages.map((m) => ({ role: m.role, content: m.content }))
    : [],
  generationType: capturedInput.generationType || (body.dryRun ? 'dry-run' : 'normal'),
  macroEngine: capturedInput.macroEngine || 'new',
  settings: body.settings || {},
  worldInfo: Array.isArray(capturedInput.worldInfo) ? capturedInput.worldInfo : [],
  tokenBudget: typeof capturedInput.tokenBudget === 'number' ? capturedInput.tokenBudget : null
}

const fixture = {
  schemaVersion: 1,
  scenarioId,
  source: 'captured',
  st: {
    version: (body.st && body.st.version) || '1.18.0',
    commit: '51ad27f',
    macroEngine: 'new'
  },
  capturedAt: body.capturedAt || raw.receivedAt || new Date().toISOString(),
  generationType: input.generationType,
  settings: body.settings || {},
  input,
  expected: {
    chat:
      body.promptReady && Array.isArray(body.promptReady.chat)
        ? body.promptReady.chat.map((m) => ({ role: m.role, content: m.content }))
        : []
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2))
console.log(`wrote ${outPath} (${fixture.expected.chat.length} messages)`)
