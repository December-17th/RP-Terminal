#!/usr/bin/env node
// End-to-end contract test for the oracle tooling (WP-0.4).
//
// All temporary artifacts live under tools/oracle inside this repository and
// are removed before exit. The test proves:
//   - capture-server dry-run writes nothing;
//   - capture-server --apply writes valid, redacted captures;
//   - normalize-capture dry-run writes nothing;
//   - normalize-capture --apply creates a fixture;
//   - an existing fixture is refused and preserved by default;
//   - --force alone is rejected and --apply --force replaces deliberately;
//   - missing, empty, null, and zero capture values remain distinguishable;
//   - malformed capture input fails without producing output;
//   - the self-test artifact directory is cleaned.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverScript = path.join(__dirname, 'capture-server.mjs')
const normalizeScript = path.join(__dirname, 'normalize-capture.mjs')
const artifactRoot = path.join(__dirname, `.self-test-artifacts-${process.pid}`)
const DRY_PORT = 8912
const APPLY_PORT = 8913
const children = new Set()

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function post(port, route, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
}

async function waitForHealth(port, deadlineMs) {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return response.json()
    } catch {
      // The child may still be binding the port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

async function startServer(port, out, apply) {
  const args = [serverScript, '--port', String(port), '--out', out]
  if (apply) args.push('--apply')
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })
  const health = await waitForHealth(port, 5000)
  if (!health) {
    throw new Error(`server on port ${port} did not become healthy:\n${output}`)
  }
  return { child, health, output: () => output }
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return
  const exited = new Promise((resolve) => server.child.once('exit', resolve))
  server.child.kill()
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`server pid ${server.child.pid} did not stop`)), 2000)
    )
  ])
  children.delete(server.child)
}

function runNormalizer(args) {
  return spawnSync(process.execPath, [normalizeScript, ...args], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8'
  })
}

function commandOutput(result) {
  return `${result.stdout || ''}${result.stderr || ''}`
}

async function testCaptureServer() {
  const dryOut = path.join(artifactRoot, 'server-dry-run', 'captures')
  const dryServer = await startServer(DRY_PORT, dryOut, false)
  try {
    assert(dryServer.health.apply === false, 'dry-run health did not report apply=false')
    const response = await post(DRY_PORT, '/capture', {
      promptReady: { chat: [{ role: 'system', content: 'DRY_RUN' }] }
    })
    assert(response.status === 200, `dry-run capture status ${response.status}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert(!fs.existsSync(dryOut), 'capture-server dry-run created its output directory')
    assert(
      dryServer.output().includes('[dry-run] would write'),
      'capture-server dry-run did not report the intended write'
    )
  } finally {
    await stopServer(dryServer)
  }

  const applyOut = path.join(artifactRoot, 'server-apply', 'captures')
  const applyServer = await startServer(APPLY_PORT, applyOut, true)
  try {
    assert(applyServer.health.apply === true, 'apply health did not report apply=true')
    const wire = await post(
      APPLY_PORT,
      '/v1/chat/completions',
      { model: 'oracle-stub', messages: [{ role: 'system', content: 'SELFTEST_PROMPT' }] },
      { authorization: 'Bearer sk-should-be-redacted' }
    )
    assert(wire.status === 200, `wire request status ${wire.status}`)
    assert((await wire.json()).choices, 'wire response missing choices')

    const capture = await post(APPLY_PORT, '/capture', {
      schemaVersion: 1,
      scenarioId: 'self-test',
      promptReady: { chat: [{ role: 'system', content: 'SELFTEST_PROMPT' }] }
    })
    assert(capture.status === 200, `capture status ${capture.status}`)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const files = fs.readdirSync(applyOut).filter((file) => file.endsWith('.json'))
    const wireFile = files.find((file) => file.includes('wire-request'))
    const captureFile = files.find((file) => file.includes('capture'))
    assert(wireFile, 'no wire-request capture file written with --apply')
    assert(captureFile, 'no /capture snapshot file written with --apply')

    const saved = JSON.parse(fs.readFileSync(path.join(applyOut, wireFile), 'utf8'))
    assert(
      saved.headers.authorization === '[[redacted]]',
      `authorization header was not redacted: ${JSON.stringify(saved.headers.authorization)}`
    )
    assert(saved.body && Array.isArray(saved.body.messages), 'wire body messages not logged')
  } finally {
    await stopServer(applyServer)
  }
}

function testNormalizer() {
  const rawPath = path.join(artifactRoot, 'raw-capture.json')
  const raw = {
    body: {
      st: { version: '1.18.0' },
      input: {
        presetName: '',
        preset: null,
        chatMessages: [],
        generationType: 'normal',
        macroEngine: 'new',
        tokenBudget: 0
      },
      promptReady: { chat: [{ role: 'system', content: '' }] }
    }
  }
  fs.writeFileSync(rawPath, JSON.stringify(raw))

  const dryOut = path.join(artifactRoot, 'normalize-dry-run', 'nested', 'fixture.json')
  const commonDryArgs = ['--in', rawPath, '--scenario', 'self-test', '--out', dryOut]
  const dry = runNormalizer(commonDryArgs)
  assert(dry.status === 0, `normalize dry-run failed:\n${commandOutput(dry)}`)
  assert(!fs.existsSync(path.dirname(dryOut)), 'normalize dry-run created an output directory')
  assert(
    commandOutput(dry).includes('[dry-run] would write'),
    'normalize dry-run did not report the intended write'
  )

  const outPath = path.join(artifactRoot, 'normalize-apply', 'fixture.json')
  const commonArgs = ['--in', rawPath, '--scenario', 'self-test', '--out', outPath]
  const apply = runNormalizer([...commonArgs, '--apply'])
  assert(apply.status === 0, `normalize --apply failed:\n${commandOutput(apply)}`)
  assert(fs.existsSync(outPath), 'normalize --apply did not create output')

  const fixture = JSON.parse(fs.readFileSync(outPath, 'utf8'))
  assert(fixture.input.presetName === '', 'explicit empty string was not preserved')
  assert(fixture.input.preset === null, 'explicit null was not preserved')
  assert(fixture.input.tokenBudget === 0, 'explicit numeric zero was not preserved')
  assert(Array.isArray(fixture.input.chatMessages), 'explicit empty chatMessages was not preserved')
  assert(!('worldInfo' in fixture.input), 'missing worldInfo was invented as empty or null')
  assert(!('capturedAt' in fixture), 'missing capturedAt was invented')
  assert(
    fixture.expected.chat[0].content === '',
    'explicit empty message content was not preserved'
  )

  fixture.input.worldInfo = [{ position: 'before_char', content: 'OPERATOR_DATA' }]
  fixture.input.character = { name: 'OPERATOR_CHARACTER' }
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n')
  const operatorCompleted = fs.readFileSync(outPath, 'utf8')

  const refused = runNormalizer([...commonArgs, '--apply'])
  assert(refused.status === 3, `existing output was not refused:\n${commandOutput(refused)}`)
  assert(
    fs.readFileSync(outPath, 'utf8') === operatorCompleted,
    'refused normalization changed operator-completed data'
  )

  const forceWithoutApply = runNormalizer([...commonArgs, '--force'])
  assert(
    forceWithoutApply.status === 2,
    `--force without --apply was not rejected:\n${commandOutput(forceWithoutApply)}`
  )
  assert(
    fs.readFileSync(outPath, 'utf8') === operatorCompleted,
    '--force without --apply changed output'
  )

  const forced = runNormalizer([...commonArgs, '--apply', '--force'])
  assert(forced.status === 0, `--apply --force failed:\n${commandOutput(forced)}`)
  const backupPath = `${outPath}.bak`
  assert(fs.existsSync(backupPath), 'forced replacement did not back up existing output')
  assert(
    fs.readFileSync(backupPath, 'utf8') === operatorCompleted,
    'forced replacement backup does not contain the operator-completed output'
  )
  const replaced = JSON.parse(fs.readFileSync(outPath, 'utf8'))
  assert(!('worldInfo' in replaced.input), 'forced replacement retained old worldInfo unexpectedly')
  assert(!('character' in replaced.input), 'forced replacement retained old character unexpectedly')

  const malformedPath = path.join(artifactRoot, 'malformed.json')
  const malformedOut = path.join(artifactRoot, 'malformed-output', 'fixture.json')
  fs.writeFileSync(malformedPath, '{"body":')
  const malformed = runNormalizer([
    '--in',
    malformedPath,
    '--scenario',
    'self-test',
    '--out',
    malformedOut,
    '--apply'
  ])
  assert(malformed.status === 1, 'malformed capture did not fail gracefully')
  assert(!fs.existsSync(malformedOut), 'malformed capture produced output')
}

let failure = null
try {
  assert(!fs.existsSync(artifactRoot), `refusing to reuse existing artifact path ${artifactRoot}`)
  fs.mkdirSync(artifactRoot)
  await testCaptureServer()
  testNormalizer()
} catch (err) {
  failure = err
} finally {
  for (const child of children) {
    if (child.exitCode === null) child.kill()
  }
  try {
    fs.rmSync(artifactRoot, { recursive: true, force: true })
  } catch (err) {
    failure ||= new Error(`could not clean ${artifactRoot}: ${err.message}`)
  }
}

if (fs.existsSync(artifactRoot)) {
  failure ||= new Error(`self-test artifact directory remains: ${artifactRoot}`)
}

if (failure) {
  console.error('SELF-TEST FAIL:', failure.message)
  process.exitCode = 1
} else {
  console.log('SELF-TEST OK: dry-run, apply, refusal, force, value fidelity, and cleanup')
}
