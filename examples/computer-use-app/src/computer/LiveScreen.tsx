import React, { useEffect, useRef, useState } from 'react'
import { PlaywrightSurface } from './playwrightSurface'
import { SCREEN_HEIGHT, SCREEN_WIDTH } from './constants'

/**
 * Live view of the server-side Playwright page: polls /computer/screenshot and
 * shows the latest frame as an <img>, with a slim read-only address bar so you
 * can see where the browser is. The image keeps the page's native
 * SCREEN_WIDTH x SCREEN_HEIGHT aspect ratio; CSS scales it to fit the pane.
 */
export default function LiveScreen({ surface, pollMs = 1200 }: { surface: PlaywrightSurface; pollMs?: number }) {
  const [src, setSrc] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    const tick = async () => {
      try {
        const view = await surface.view()
        if (cancelled) return
        setSrc(`data:image/png;base64,${view.screenshotBase64}`)
        setUrl(view.url)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'screen unavailable')
      }
      if (!cancelled) timer.current = setTimeout(tick, pollMs)
    }
    tick()

    return () => {
      cancelled = true
      if (timer.current) clearTimeout(timer.current)
    }
  }, [surface, pollMs])

  const displayUrl = url.startsWith('data:') ? 'about:start' : url

  return (
    <div className="live-screen">
      <div className="live-urlbar" title={displayUrl}>
        <span className="live-urlbar-dot" />
        {displayUrl || 'loading…'}
      </div>
      <div className="live-screen-frame">
        {src ? (
          <img
            src={src}
            alt="Live browser page driven by Claude"
            style={{ aspectRatio: `${SCREEN_WIDTH} / ${SCREEN_HEIGHT}` }}
          />
        ) : (
          <div className="live-screen-placeholder">
            {error ? `Browser not ready: ${error}` : 'Starting the browser…'}
          </div>
        )}
      </div>
    </div>
  )
}
