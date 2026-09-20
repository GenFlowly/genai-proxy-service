import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ConversationWidget } from '@genflowly/component-library'
import ComputerUseProvider from './ComputerUseProvider'
import LiveScreen from './computer/LiveScreen'
import { PlaywrightSurface } from './computer/playwrightSurface'
import { fetchClaudeModels } from './api/generateTextStream'
import './App.css'

const DEFAULT_MODEL = 'claude-sonnet-4-6'

interface Shot {
  index: number
  dataUrl: string
}

export default function App() {
  const surface = useMemo(() => new PlaywrightSurface(), [])
  const [shots, setShots] = useState<Shot[]>([])
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [proxyStatus, setProxyStatus] = useState<'checking' | 'ok' | 'error'>('checking')
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const filmstripRef = useRef<HTMLDivElement | null>(null)

  // Model list doubles as the connection check: it exercises auth end to end
  useEffect(() => {
    const abort = new AbortController()
    fetchClaudeModels(abort.signal)
      .then((list) => {
        setProxyStatus('ok')
        if (list.length > 0) {
          setModels(list)
          if (!list.includes(DEFAULT_MODEL)) setModel(list[0])
        }
      })
      .catch(() => setProxyStatus('error'))
    return () => abort.abort()
  }, [])

  const showToast = (message: string) => {
    setToast(message)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 4000)
  }

  const handleShot = ({ dataUrl }: { dataUrl: string }) => {
    setShots((prev) => [...prev, { index: prev.length + 1, dataUrl }])
    // Keep the newest screenshot in view
    requestAnimationFrame(() => {
      const el = filmstripRef.current
      if (el) el.scrollLeft = el.scrollWidth
    })
  }

  return (
    <ComputerUseProvider surface={surface} model={model} onShot={handleShot} showToast={showToast}>
      <div className="app">
        <header className="app-header">
          <div className="app-title">
            <span className="app-logo">🖥️</span>
            <div>
              <h1>Claude Computer Use</h1>
              <p>genai-proxy-server example — Claude drives the real browser below</p>
            </div>
          </div>
          <div className="app-controls">
            <label className="model-label">
              Model
              {models.length > 0 ? (
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
              )}
            </label>
            <span className={`proxy-status proxy-status--${proxyStatus}`}>
              {proxyStatus === 'checking' && 'connecting…'}
              {proxyStatus === 'ok' && 'proxy connected'}
              {proxyStatus === 'error' && 'proxy unreachable — check .env.local'}
            </span>
          </div>
        </header>

        <main className="split">
          <section className="screen-pane" aria-label="Screen">
            <div className="screen-live">
              <LiveScreen surface={surface} />
            </div>
            <div className="filmstrip-wrapper">
              <div className="filmstrip-label">
                Screenshots sent to Claude {shots.length > 0 && <span>({shots.length})</span>}
              </div>
              <div className="filmstrip" ref={filmstripRef}>
                {shots.length === 0 && (
                  <div className="filmstrip-empty">
                    None yet — ask Claude to do something below (it starts by taking a screenshot).
                  </div>
                )}
                {shots.map((shot) => (
                  <a
                    key={shot.index}
                    className="shot"
                    href={shot.dataUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Screenshot #${shot.index} — open full size`}
                  >
                    <img src={shot.dataUrl} alt={`Screenshot ${shot.index}`} />
                    <span className="shot-index">#{shot.index}</span>
                  </a>
                ))}
              </div>
            </div>
          </section>

          <section className="chat-pane" aria-label="Chat" data-testid="center-section">
            <ConversationWidget />
          </section>
        </main>

        {toast && <div className="toast">{toast}</div>}
      </div>
    </ComputerUseProvider>
  )
}
