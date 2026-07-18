#!/usr/bin/env node
// Self-test for the oracle capture server (WP-0.4). Spawns the server on an
// ephemeral port with a temp output dir, POSTs a synthetic OpenAI wire body and a
// synthetic extension /capture snapshot, then asserts:
//   - both routes produced a capture file,
//   - the files are valid JSON,
//   - a secret-like header was redacted (never persisted).
// Exit 0 on success, non-zero on failure. This is the automated proof that the
// capture path works even when no browser is available to drive ST.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = 8912
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-selftest-'))

function fail(msg) {
  console.error('SELF-TEST FAIL:', msg)
  process.exitCode = 1
}

async function post(route, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  return res
}

async function waitForHealth(deadlineMs) {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`)
      if (r.ok) return true
    } catch (_) {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const child = spawn(
  process.execPath,
  [path.join(__dirname, 'capture-server.mjs'), '--port', String(PORT), '--out', outDir],
  { stdio: 'inherit' }
)

try {
  const up = await waitForHealth(5000)
  if (!up) {
    fail('server did not become healthy in time')
  } else {
    // (1) synthetic wire request, with a secret header that MUST be redacted.
    const wire = await post(
      '/v1/chat/completions',
      { model: 'oracle-stub', messages: [{ role: 'system', content: 'SELFTEST_PROMPT' }] },
      { authorization: 'Bearer sk-should-be-redacted' }
    )
    if (wire.status !== 200) fail(`wire request status ${wire.status}`)
    const wireJson = await wire.json()
    if (!wireJson.choices) fail('wire response missing choices')

    // (2) synthetic extension snapshot.
    const cap = await post('/capture', {
      schemaVersion: 1,
      scenarioId: 'self-test',
      promptReady: { chat: [{ role: 'system', content: 'SELFTEST_PROMPT' }] }
    })
    if (cap.status !== 200) fail(`capture status ${cap.status}`)

    // Give the server a tick to flush files.
    await new Promise((r) => setTimeout(r, 150))

    const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.json'))
    const wireFile = files.find((f) => f.includes('wire-request'))
    const capFile = files.find((f) => f.includes('capture'))
    if (!wireFile) fail('no wire-request capture file written')
    if (!capFile) fail('no /capture snapshot file written')

    if (wireFile) {
      const j = JSON.parse(fs.readFileSync(path.join(outDir, wireFile), 'utf8'))
      if (j.headers.authorization !== '[[redacted]]') {
        fail('authorization header was NOT redacted: ' + JSON.stringify(j.headers.authorization))
      }
      if (!j.body || !Array.isArray(j.body.messages)) fail('wire body messages not logged')
    }

    if (process.exitCode !== 1) {
      console.log('SELF-TEST OK:', files.length, 'capture files in', outDir)
    }
  }
} finally {
  child.kill()
  try {
    fs.rmSync(outDir, { recursive: true, force: true })
  } catch (_) {
    /* ignore */
  }
}
