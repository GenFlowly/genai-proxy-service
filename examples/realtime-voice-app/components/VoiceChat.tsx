'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MicCapture, PcmPlayer } from '@/lib/audio'
import { VoiceSession, type AIVendor, type ServerEvent } from '@/lib/voiceClient'

type Status = 'idle' | 'connecting' | 'live'

interface TranscriptItem {
  id: number
  role: 'user' | 'assistant'
  text: string
  final: boolean
}

interface Usage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_read_tokens: number
}

interface VendorModels {
  aiVendor: string
  modelsList: string[]
}

let nextId = 1

export default function VoiceChat() {
  const [models, setModels] = useState<VendorModels[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [selected, setSelected] = useState('') // "VENDOR|model"
  const [voice, setVoice] = useState('')
  const [agentic, setAgentic] = useState(false)

  const [status, setStatus] = useState<Status>('idle')
  const [statusDetail, setStatusDetail] = useState('Not connected')
  const [error, setError] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<TranscriptItem[]>([])
  const [usage, setUsage] = useState<Usage | null>(null)
  const [activeTool, setActiveTool] = useState<string | null>(null)

  const sessionRef = useRef<VoiceSession | null>(null)
  const micRef = useRef<MicCapture | null>(null)
  const playerRef = useRef<PcmPlayer | null>(null)
  const transcriptEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    fetch('/api/voice/models')
      .then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
        const list: VendorModels[] = (data.aiVendorModelList || []).filter(
          (v: VendorModels) => v.modelsList.length > 0
        )
        setModels(list)
        const openai = list.find((v) => v.aiVendor === 'OPENAI') || list[0]
        if (openai) setSelected(`${openai.aiVendor}|${openai.modelsList[0]}`)
      })
      .catch((e) => setModelsError(String(e.message || e)))
  }, [])

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript])

  const teardown = useCallback(() => {
    micRef.current?.stop()
    micRef.current = null
    playerRef.current?.close()
    playerRef.current = null
    sessionRef.current = null
    setActiveTool(null)
  }, [])

  const handleEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case 'session.created':
        setConversationId(event.conversationId)
        setStatusDetail('Session created, waiting for the voice model…')
        break

      case 'session.ready': {
        setStatusDetail(`Live — ${event.provider} / ${event.model}`)
        playerRef.current = new PcmPlayer(event.output_rate)
        const mic = new MicCapture()
        micRef.current = mic
        mic
          .start(event.input_rate, (b64) => sessionRef.current?.sendAudio(b64))
          .then(() => setStatus('live'))
          .catch((e) => {
            setError(`Microphone access failed: ${e.message || e}`)
            sessionRef.current?.close()
          })
        break
      }

      case 'output_audio.delta':
        playerRef.current?.play(event.audio)
        break

      case 'output_audio.done':
        break

      case 'transcript.delta':
        setTranscript((items) => {
          const last = items[items.length - 1]
          if (last && last.role === event.role && !last.final) {
            return [...items.slice(0, -1), { ...last, text: last.text + event.text }]
          }
          return [...items, { id: nextId++, role: event.role, text: event.text, final: false }]
        })
        break

      case 'transcript.done':
        setTranscript((items) => {
          const last = items[items.length - 1]
          if (last && last.role === event.role && !last.final) {
            return [...items.slice(0, -1), { ...last, text: event.text, final: true }]
          }
          return [...items, { id: nextId++, role: event.role, text: event.text, final: true }]
        })
        break

      case 'tool.started':
        setActiveTool(event.name)
        break

      case 'tool.completed':
        setActiveTool(null)
        break

      case 'usage':
        setUsage((prev) => ({
          input_tokens: (prev?.input_tokens ?? 0) + event.usage.input_tokens,
          output_tokens: (prev?.output_tokens ?? 0) + event.usage.output_tokens,
          total_tokens: (prev?.total_tokens ?? 0) + event.usage.total_tokens,
          cache_read_tokens: (prev?.cache_read_tokens ?? 0) + event.usage.cache_read_tokens,
        }))
        break

      case 'interrupted':
        playerRef.current?.interrupt()
        break

      case 'error':
        setError(event.message)
        break
    }
  }, [])

  const start = useCallback(() => {
    const [vendor, model] = selected.split('|')
    if (!vendor || !model) return

    setError(null)
    setUsage(null)
    setTranscript([])
    setConversationId(null)
    setStatus('connecting')
    setStatusDetail('Connecting…')

    const session = new VoiceSession(
      { vendor: vendor as AIVendor, model, voice: voice.trim() || undefined, agentic },
      {
        onEvent: handleEvent,
        onClose: () => {
          teardown()
          setStatus('idle')
          setStatusDetail('Not connected')
        },
      }
    )
    sessionRef.current = session
    session.connect()
  }, [selected, voice, agentic, handleEvent, teardown])

  const stop = useCallback(() => {
    sessionRef.current?.close()
    teardown()
    setStatus('idle')
    setStatusDetail('Not connected')
  }, [teardown])

  useEffect(() => () => sessionRef.current?.close(), [])

  const running = status !== 'idle'

  return (
    <>
      <section className="panel">
        <div className="controls">
          <div className="field">
            <label htmlFor="model">Voice model</label>
            <select id="model" value={selected} onChange={(e) => setSelected(e.target.value)} disabled={running}>
              {models.length === 0 && <option value="">{modelsError ? 'unavailable' : 'loading…'}</option>}
              {models.map((v) => (
                <optgroup key={v.aiVendor} label={v.aiVendor}>
                  {v.modelsList.map((m) => (
                    <option key={m} value={`${v.aiVendor}|${m}`}>
                      {m}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="voice">Voice (optional)</label>
            <input
              id="voice"
              type="text"
              placeholder="e.g. marin"
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              disabled={running}
            />
          </div>

          <label className="checkbox">
            <input type="checkbox" checked={agentic} onChange={(e) => setAgentic(e.target.checked)} disabled={running} />
            agentic (knowledge-base tool)
          </label>

          {running ? (
            <button className="danger" onClick={stop}>
              Stop
            </button>
          ) : (
            <button className="primary" onClick={start} disabled={!selected}>
              Start talking
            </button>
          )}
        </div>

        <div className="status-row">
          <span className={`dot ${status === 'live' ? 'live' : status === 'connecting' ? 'connecting' : error ? 'error' : ''}`} />
          <span>{statusDetail}</span>
          {activeTool && <span className="tool-badge">🔎 {activeTool}…</span>}
          {conversationId && (
            <span>
              conversation <code>{conversationId}</code>
            </span>
          )}
        </div>

        {(error || modelsError) && <div className="error-box">{error || modelsError}</div>}
      </section>

      <section className="panel transcript">
        {transcript.length === 0 ? (
          <div className="empty">
            {status === 'live' ? 'Listening — say something!' : 'Transcript will appear here.'}
          </div>
        ) : (
          transcript.map((item) => (
            <div key={item.id} className={`bubble ${item.role} ${item.final ? '' : 'pending'}`}>
              <span className="role">{item.role}</span>
              {item.text}
            </div>
          ))
        )}
        <div ref={transcriptEndRef} />
      </section>

      {usage && (
        <section className="panel usage">
          <span>
            input <b>{usage.input_tokens.toLocaleString()}</b>
          </span>
          <span>
            output <b>{usage.output_tokens.toLocaleString()}</b>
          </span>
          <span>
            cache read <b>{usage.cache_read_tokens.toLocaleString()}</b>
          </span>
          <span>
            total <b>{usage.total_tokens.toLocaleString()}</b>
          </span>
        </section>
      )}
    </>
  )
}
