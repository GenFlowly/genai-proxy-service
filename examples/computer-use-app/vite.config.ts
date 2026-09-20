/**
 * Vite config for the computer-use example.
 *
 * Two server-side pieces live here so the app stays a single `npm run dev`:
 *  1. A proxy for /api/* → genai-proxy-server that attaches the developer API
 *     key as a Bearer token. The key comes from .env.local (no VITE_ prefix,
 *     so Vite never exposes it to browser code) — same rule as
 *     examples/realtime-voice-app.
 *  2. A Playwright "computer" surface: a real Chromium page the browser tab
 *     can't host, driven over /computer/* endpoints (see playwright/surface.ts).
 */
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PlaywrightSurfaceServer } from './playwright/surface'

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

/** Wrap an async handler so thrown errors become a 500 JSON response. */
function handler(
  fn: (req: IncomingMessage, res: ServerResponse) => Promise<void>
): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.method !== 'POST' && req.method !== 'GET') return next()
    fn(req, res).catch((e) => sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) }))
  }
}

function playwrightSurfacePlugin(headed: boolean): Plugin {
  const surface = new PlaywrightSurfaceServer({ headed })
  return {
    name: 'playwright-computer-surface',
    configureServer(server) {
      server.middlewares.use(
        '/computer/execute',
        handler(async (req, res) => {
          const { args } = (await readJson(req)) as { args?: Record<string, unknown> }
          sendJson(res, 200, await surface.execute(args ?? {}))
        })
      )
      server.middlewares.use(
        '/computer/navigate',
        handler(async (req, res) => {
          const { url } = (await readJson(req)) as { url?: string }
          sendJson(res, 200, await surface.navigate(url ?? ''))
        })
      )
      server.middlewares.use(
        '/computer/back',
        handler(async (_req, res) => sendJson(res, 200, await surface.goBack()))
      )
      server.middlewares.use(
        '/computer/screenshot',
        handler(async (_req, res) => sendJson(res, 200, await surface.view()))
      )
      server.httpServer?.once('close', () => void surface.close())
    },
  }
}

export default defineConfig(({ mode }) => {
  // Third arg '' loads ALL env vars (not just VITE_*) for server-side use
  const env = loadEnv(mode, process.cwd(), '')
  const target = (env.GENFLOWLY_PROXY_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')

  // http-proxy adds these headers to the outgoing (target) request
  const headers: Record<string, string> = {}
  if (env.GENFLOWLY_API_KEY) headers.Authorization = `Bearer ${env.GENFLOWLY_API_KEY}`

  return {
    plugins: [react(), playwrightSurfacePlugin(env.PLAYWRIGHT_HEADED === '1')],
    server: {
      port: parseInt(env.PORT || '3006', 10),
      proxy: {
        '/api': { target, changeOrigin: true, headers },
      },
    },
  }
})
