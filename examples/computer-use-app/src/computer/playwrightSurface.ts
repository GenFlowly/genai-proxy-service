/**
 * Browser-side client for the Node Playwright surface (see playwright/surface.ts,
 * served by the Vite dev-server plugin over /computer/*). Same shape the old
 * canvas VirtualDesktop exposed, but async — every call is a round-trip to the
 * real Chromium page.
 */
export interface ActionOutcome {
  content: string
  /** Base64 PNG (no data: prefix) for screenshot actions */
  screenshotBase64?: string
}

export interface ViewState {
  screenshotBase64: string
  url: string
  title: string
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${path} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`)
  }
  return res.json() as Promise<T>
}

export class PlaywrightSurface {
  /** Run one computer-use action against the real page. */
  execute(args: Record<string, unknown>): Promise<ActionOutcome> {
    return postJson<ActionOutcome>('/computer/execute', { args })
  }

  /** Open a URL (the `navigate` function tool). */
  navigate(url: string): Promise<ActionOutcome> {
    return postJson<ActionOutcome>('/computer/navigate', { url })
  }

  /** Go back in history (the `go_back` function tool). */
  goBack(): Promise<ActionOutcome> {
    return postJson<ActionOutcome>('/computer/back', {})
  }

  /** Current live view — for the top pane's polling. */
  async view(): Promise<ViewState> {
    const res = await fetch('/computer/screenshot')
    if (!res.ok) throw new Error(`/computer/screenshot failed: HTTP ${res.status}`)
    return res.json() as Promise<ViewState>
  }
}
