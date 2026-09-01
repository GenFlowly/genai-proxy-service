/**
 * Typed client for the GenFlowly realtime voice WebSocket protocol
 * (`WS /api/v1/voice/session`), reached via this app's authenticated relay
 * at `/api/voice/relay`. Protocol reference: genai-proxy-server README and
 * the endpoint description in /docs.
 */

export type AIVendor = 'OPENAI' | 'GEMINI'

export interface SessionOptions {
  vendor: AIVendor
  model: string
  voice?: string
  agentic: boolean
  conversationId?: string
  instructionId?: string
  instructionVersion?: string
}

export type ServerEvent =
  | { type: 'session.created'; conversationId: string }
  | { type: 'session.ready'; provider: string; model: string; input_rate: number; output_rate: number }
  | { type: 'output_audio.delta'; audio: string }
  | { type: 'output_audio.done' }
  | { type: 'transcript.delta'; role: 'user' | 'assistant'; text: string }
  | { type: 'transcript.done'; role: 'user' | 'assistant'; text: string }
  | { type: 'tool.started'; name: string }
  | { type: 'tool.completed'; name: string }
  | {
      type: 'usage'
      usage: { input_tokens: number; output_tokens: number; total_tokens: number; cache_read_tokens: number }
    }
  | { type: 'interrupted' }
  | { type: 'error'; message: string }

export class VoiceSession {
  private ws: WebSocket | null = null
  private closedByUs = false

  constructor(
    private options: SessionOptions,
    private handlers: {
      onEvent: (event: ServerEvent) => void
      onClose: (byUser: boolean) => void
    }
  ) {}

  connect(): void {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new WebSocket(`${scheme}://${window.location.host}/api/voice/relay`)

    this.ws.onopen = () => {
      const { vendor, model, voice, agentic, conversationId, instructionId, instructionVersion } = this.options
      this.ws?.send(
        JSON.stringify({
          type: 'session.init',
          aiConfig: { aiVendor: vendor, model, maxTokens: 4096 },
          ...(instructionId ? { prompt: { instructionId, instructionVersion: instructionVersion ?? '1' } } : {}),
          ...(conversationId ? { conversationId } : {}),
          ...(voice ? { voice } : {}),
          client: 'web',
          agentic,
        })
      )
    }

    this.ws.onmessage = (e) => {
      let event: ServerEvent
      try {
        event = JSON.parse(e.data)
      } catch {
        return
      }
      this.handlers.onEvent(event)
    }

    this.ws.onclose = () => this.handlers.onClose(this.closedByUs)
    this.ws.onerror = () => {
      this.handlers.onEvent({ type: 'error', message: 'WebSocket connection failed' })
    }
  }

  sendAudio(b64: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'input_audio.append', audio: b64 }))
    }
  }

  close(): void {
    this.closedByUs = true
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'session.close' }))
    }
    this.ws?.close()
  }
}
