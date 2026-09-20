/**
 * Minimal client for POST /api/v1/generate-text-stream, the proxy's streaming
 * generation endpoint (NDJSON chunks over chunked HTTP). Mirrors the Kotlin
 * request/response models in genai-proxy-server (GenerateTextStreamRequest,
 * ToolDefinition, ToolResult) — see the "Computer use" section of the
 * server's OpenAPI description for the full contract.
 *
 * Requests go same-origin to /api/...; the Vite dev server proxies them to
 * the genai-proxy-server and attaches the developer API key server-side.
 */
import type { ThinkingStep } from '@genflowly/component-library'

export interface AIConfig {
  aiVendor: string
  model: string
  maxTokens?: number
}

export interface PromptPayload {
  instructionId: string
  instructionVersion: string
  prompt: string
}

/**
 * Tool the model may call. For Claude's native computer-use tool, `type` is
 * the Anthropic tool version (e.g. "computer_20250124") and `options` carries
 * the display size; `parameters` stays undefined (Anthropic defines the
 * action space). The proxy applies the required beta header automatically.
 */
export interface ToolDefinition {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  type?: string
  options?: Record<string, unknown>
}

export interface ToolResultImage {
  /** Base64 PNG (no data: prefix) — simplest way to return screenshots */
  data?: string
  /** Alternative: s3Key of an object uploaded via POST /api/v1/attachments */
  s3Key?: string
  mediaType: string
}

export interface ToolResult {
  toolCallId: string
  content: string
  images?: ToolResultImage[]
}

export interface GenerateTextStreamRequest {
  aiConfig: AIConfig
  prompt: PromptPayload
  selectedResponseId: string | null
  conversationId: string | null
  client: string
  agentic: boolean
  tools: ToolDefinition[]
  toolChoice?: string | null
  toolResults?: ToolResult[]
  learnFromConversation?: boolean
  useLearnedPreferences?: boolean
}

/** One action Claude wants executed: args like {"action":"left_click","coordinate":[x,y]} */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface StreamTurnResult {
  /** Non-empty → execute the actions and continue the turn with toolResults */
  toolCalls: ToolCall[]
  conversationId: string | null
  /** X-Response-Message-Id — pass as selectedResponseId to continue this turn */
  responseMessageId: string | null
}

export interface StreamCallbacks {
  onDelta: (chunk: string) => void
  onThinkingStep?: (step: ThinkingStep) => void
  onThinkingDuration?: (millis: number) => void
}

/** Vendor failure relayed mid-stream by the proxy ({"t":"err"} chunk). */
export class StreamGenerationError extends Error {}

export async function generateTextStreamOnce(
  request: GenerateTextStreamRequest,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<StreamTurnResult> {
  const response = await fetch('/api/v1/generate-text-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })

  if (!response.ok) {
    let reason = ''
    try {
      const body = await response.text()
      try {
        reason = JSON.parse(body)?.error ?? ''
      } catch {
        reason = body
      }
    } catch {
      // body unreadable — status line only
    }
    reason = (reason || '').trim()
    throw new Error(reason ? `${reason} (HTTP ${response.status})` : `Generation failed: HTTP ${response.status}`)
  }

  const result: StreamTurnResult = {
    toolCalls: [],
    conversationId: response.headers.get('X-Conversation-Id'),
    responseMessageId: response.headers.get('X-Response-Message-Id'),
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('Response body is not readable')

  const decoder = new TextDecoder('utf-8')
  let lineBuffer = ''

  const processLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: { t: string; v: unknown }
    try {
      msg = JSON.parse(trimmed)
    } catch {
      // The proxy emits "[Error: <reason>]" as a raw line on mid-stream failures
      const errorMatch = trimmed.match(/^\[Error: ([\s\S]*)\]$/)
      if (errorMatch) throw new Error(errorMatch[1] || 'Stream failed')
      callbacks.onDelta(line)
      return
    }
    switch (msg.t) {
      case 'c':
        callbacks.onDelta(String(msg.v ?? ''))
        break
      case 'tc':
        if (Array.isArray(msg.v)) {
          for (const call of msg.v) {
            if (call && typeof call.id === 'string' && typeof call.name === 'string') {
              result.toolCalls.push({ id: call.id, name: call.name, args: call.args ?? {} })
            }
          }
        }
        break
      case 'ks': {
        const step = msg.v as ThinkingStep
        if (step && typeof step === 'object' && typeof step.node === 'string') callbacks.onThinkingStep?.(step)
        break
      }
      case 'kd': {
        const millis = Number(msg.v)
        if (Number.isFinite(millis)) callbacks.onThinkingDuration?.(millis)
        break
      }
      case 'err':
        throw new StreamGenerationError(typeof msg.v === 'string' && msg.v ? msg.v : 'Generation failed')
      default:
        // k (legacy thinking) / ws / ga / heartbeats — not used in this demo
        break
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      lineBuffer += decoder.decode(value, { stream: true })
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) processLine(line)
    }
    if (lineBuffer) processLine(lineBuffer)
  } finally {
    reader.releaseLock()
  }

  return result
}

export interface VendorModels {
  aiVendor: string
  modelsList: string[]
}

/** POST /api/v1/models — used to populate the Claude model picker. */
export async function fetchClaudeModels(signal?: AbortSignal): Promise<string[]> {
  const response = await fetch('/api/v1/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aiVendor: ['CLAUDE'] }),
    signal,
  })
  if (!response.ok) throw new Error(`models failed: HTTP ${response.status}`)
  const data: { aiVendorModelList: VendorModels[] } = await response.json()
  return data.aiVendorModelList.find((v) => v.aiVendor === 'CLAUDE')?.modelsList ?? []
}
