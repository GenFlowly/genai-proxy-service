/**
 * Custom Next.js server with a WebSocket relay for the GenFlowly voice API.
 *
 * Why a relay: the voice session endpoint (`WS /api/v1/voice/session`) accepts
 * developer API keys (`gfy_...`) only in the `Authorization: Bearer` header,
 * and browsers cannot set headers on WebSocket connections. Relaying through
 * this server also keeps the API key out of the browser entirely.
 *
 *   browser ──WS /api/voice/relay──> this server ──WS──> genai-proxy-server
 *                                    (adds Authorization: Bearer gfy_...)
 */
const { createServer } = require('node:http')
const next = require('next')
const { WebSocket, WebSocketServer } = require('ws')

const dev = process.env.NODE_ENV !== 'production'
const port = parseInt(process.env.PORT || '3000', 10)

// Load .env.local / .env the same way `next dev` would, so GENFLOWLY_* vars
// are available to both the relay below and the Next.js route handlers.
require('@next/env').loadEnvConfig(process.cwd(), dev)

const app = next({ dev })
const handleRequest = app.getRequestHandler()

function proxyBaseUrl() {
  return (process.env.GENFLOWLY_PROXY_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
}

/** Bridge one browser connection to the proxy server's voice session. */
function relay(client) {
  const apiKey = process.env.GENFLOWLY_API_KEY
  if (!apiKey) {
    client.send(JSON.stringify({ type: 'error', message: 'GENFLOWLY_API_KEY is not set on the example server (.env.local)' }))
    client.close(1011, 'server not configured')
    return
  }

  const url = proxyBaseUrl().replace(/^http/, 'ws') + '/api/v1/voice/session'
  const upstream = new WebSocket(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  // The client immediately sends session.init; buffer until upstream is open.
  const pending = []

  client.on('message', (data, isBinary) => {
    if (isBinary) return // protocol is JSON text frames only
    const text = data.toString()
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text)
    else if (upstream.readyState === WebSocket.CONNECTING) pending.push(text)
  })

  upstream.on('open', () => {
    for (const text of pending) upstream.send(text)
    pending.length = 0
  })

  upstream.on('message', (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(data.toString())
  })

  upstream.on('close', () => {
    if (client.readyState === WebSocket.OPEN) client.close(1000, 'session ended')
  })

  upstream.on('error', (err) => {
    console.error('[relay] upstream error:', err.message)
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'error', message: `Proxy connection failed: ${err.message}` }))
      client.close(1011, 'upstream error')
    }
  })

  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close(1000, 'client disconnected')
    }
  })

  client.on('error', () => upstream.terminate())
}

app.prepare().then(() => {
  const handleUpgrade = app.getUpgradeHandler() // Next's own upgrades (HMR in dev)
  const server = createServer((req, res) => handleRequest(req, res))
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost')
    if (pathname === '/api/voice/relay') {
      wss.handleUpgrade(req, socket, head, relay)
    } else {
      handleUpgrade(req, socket, head) // e.g. /_next/webpack-hmr in dev
    }
  })

  server.listen(port, () => {
    console.log(`> Realtime voice example ready on http://localhost:${port}`)
    console.log(`> Relaying voice sessions to ${proxyBaseUrl()}`)
  })
})
