#!/usr/bin/env node
// Oracle capture server — WP-0.4 / ADR 0016.
//
// A minimal, dependency-free OpenAI-compatible HTTP endpoint used ONCE to freeze
// SillyTavern 1.18.0's prompt-assembly output into golden fixtures. It does two
// things:
//
//   1. Acts as a fake "Custom (OpenAI-compatible)" Chat Completion source. Point
//      ST's API at http://127.0.0.1:8899/v1 and it will POST the exact wire body
//      here on every generation. We log that body verbatim and return a fixed
//      stub completion so ST is satisfied and never calls a real model.
//
//   2. Exposes POST /capture, which OUR ST capture extension calls from
//      CHAT_COMPLETION_PROMPT_READY with the post-extension mutable chat array +
//      a settings snapshot. This is the higher-fidelity fixture: it sees the
//      prompt after ST's own regex/macro passes but is still a plain JS object.
//
// Nothing here is copied from SillyTavern. It is a generic HTTP logger.
//
// Usage:
//   node tools/oracle/capture-server.mjs [--port 8899] [--out tools/oracle/captures] [--apply]
//
// The default is a non-mutating dry-run. Pass --apply to create the output
// directory and persist captures.
//
// Then in ST: Chat Completion source = Custom (OpenAI-compatible),
//   Custom Endpoint = http://127.0.0.1:8899/v1 , any non-empty key.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const args = { port: 8899, out: path.join(__dirname, 'captures'), apply: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error('--port requires a value')
      args.port = Number(value)
    } else if (argv[i] === '--out') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error('--out requires a path')
      args.out = path.resolve(value)
    } else if (argv[i] === '--apply') {
      args.apply = true
    } else {
      throw new Error(`unknown argument: ${argv[i]}`)
    }
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    throw new Error('--port must be an integer from 0 to 65535')
  }
  return args
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (err) {
  console.error(`capture-server: ${err.message}`)
  console.error('usage: capture-server.mjs [--port <port>] [--out <directory>] [--apply]')
  process.exit(2)
}
const { port, out, apply } = options
if (apply) fs.mkdirSync(out, { recursive: true })

// Header allow-list: never persist anything credential-like. We keep only inert
// routing metadata so a committed fixture can never leak a key.
const SECRET_HEADER =
  /^(authorization|proxy-authorization|api-key|x-api-key|cookie|set-cookie|openai-organization|x-goog-api-key)$/i
function scrubHeaders(headers) {
  const kept = {}
  for (const [k, v] of Object.entries(headers)) {
    kept[k] = SECRET_HEADER.test(k) ? '[[redacted]]' : v
  }
  return kept
}

function tsName(route) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const slug = route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root'
  return `${ts}__${slug}.json`
}

function availableCapturePath(route) {
  const first = path.join(out, tsName(route))
  if (!fs.existsSync(first)) return first
  const extension = path.extname(first)
  const stem = first.slice(0, -extension.length)
  for (let suffix = 2; ; suffix++) {
    const candidate = `${stem}__${suffix}${extension}`
    if (!fs.existsSync(candidate)) return candidate
  }
}

function writeCapture(route, payload) {
  const file = availableCapturePath(route)
  const displayPath = path.relative(process.cwd(), file) || file
  if (!apply) {
    process.stdout.write(`[dry-run] would write ${route} capture to ${displayPath}\n`)
    return null
  }
  fs.writeFileSync(file, JSON.stringify(payload, null, 2))
  process.stdout.write(`[capture] ${route} -> ${displayPath}\n`)
  return file
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

function tryJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    return { ok: false, value: text, error: String(err && err.message) }
  }
}

const STUB_MODEL = 'oracle-stub'
const STUB_TEXT =
  'ORACLE_STUB_COMPLETION — capture server acknowledged the request. This text is never used in a fixture.'

function stubCompletion() {
  const base = {
    id: 'chatcmpl-oracle-stub',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: STUB_MODEL,
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: STUB_TEXT } }
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
  return base
}

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const route = url.pathname

  // CORS/preflight — the ST extension runs in-page and may POST cross-origin.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && route === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, out, apply }))
    return
  }

  // ST probes model lists on some sources; answer benignly.
  if (req.method === 'GET' && (route === '/v1/models' || route === '/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: STUB_MODEL, object: 'model' }] }))
    return
  }

  const raw = await readBody(req)

  // (2) Extension snapshot: the post-extension chat array + settings.
  if (req.method === 'POST' && route === '/capture') {
    const parsed = tryJson(raw)
    writeCapture('capture', {
      kind: 'st-extension-snapshot',
      receivedAt: new Date().toISOString(),
      headers: scrubHeaders(req.headers),
      bodyParsed: parsed.ok,
      body: parsed.ok ? parsed.value : parsed.value
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // (1) Fake OpenAI Chat Completion endpoint: log the exact wire body.
  if (
    req.method === 'POST' &&
    (route === '/v1/chat/completions' || route === '/chat/completions')
  ) {
    const parsed = tryJson(raw)
    const body = parsed.ok ? parsed.value : null
    writeCapture('wire-request', {
      kind: 'openai-wire-request',
      receivedAt: new Date().toISOString(),
      route,
      headers: scrubHeaders(req.headers),
      bodyParsed: parsed.ok,
      body: parsed.ok ? parsed.value : { rawText: parsed.value, parseError: parsed.error }
    })

    const stream = !!(body && body.stream)
    if (stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      const id = 'chatcmpl-oracle-stub'
      const created = Math.floor(Date.now() / 1000)
      res.write(
        sseChunk({
          id,
          object: 'chat.completion.chunk',
          created,
          model: STUB_MODEL,
          choices: [{ index: 0, delta: { role: 'assistant', content: STUB_TEXT } }]
        })
      )
      res.write(
        sseChunk({
          id,
          object: 'chat.completion.chunk',
          created,
          model: STUB_MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        })
      )
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(stubCompletion()))
    }
    return
  }

  // Anything else: log it too (helps discover unexpected ST probes) and 404.
  if (req.method === 'POST') {
    writeCapture('other', {
      kind: 'unexpected-post',
      route,
      headers: scrubHeaders(req.headers),
      body: tryJson(raw).value
    })
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found', route }))
})

server.listen(port, '127.0.0.1', () => {
  const outputLine = apply
    ? `  writing fixtures to: ${out}\n`
    : `  DRY-RUN: would write fixtures to: ${out}\n` +
      '  no directories or files will be created; restart with --apply to persist\n'
  process.stdout.write(
    `Oracle capture server on http://127.0.0.1:${port}\n` +
      `  OpenAI endpoint: http://127.0.0.1:${port}/v1\n` +
      `  extension route: POST http://127.0.0.1:${port}/capture\n` +
      outputLine
  )
})
