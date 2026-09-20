/**
 * Host driver for the shared ConversationWidget: implements the widget's
 * injected conversation API on top of the proxy's computer-use loop, driving a
 * real Playwright Chromium page.
 *
 * One user turn = one loop:
 *   1. POST /generate-text-stream with the computer tool + navigate/go_back
 *      function tools declared
 *   2. stream text into the message; a "tc" chunk delivers tool calls
 *   3. run each call against the PlaywrightSurface, collect toolResults
 *      (screenshots ride inline as base64 PNG)
 *   4. continue the same endpoint with empty prompt + selectedResponseId
 *      until Claude answers with text only (or the iteration cap hits)
 *
 * Every executed action is surfaced in the chat as a structured thinking
 * step, so the response card shows the full action trace.
 */
import React, { useMemo, useRef, useState } from 'react'
import {
  ConversationWidgetProvider,
  ConversationWidgetContextValue,
  ConversationBlock,
  Message,
  ThinkingStep,
  AIVendor,
} from '@genflowly/component-library'
import {
  generateTextStreamOnce,
  GenerateTextStreamRequest,
  StreamGenerationError,
  StreamTurnResult,
  ToolDefinition,
  ToolResult,
} from './api/generateTextStream'
import { describeAction } from './computer/actions'
import { SCREEN_WIDTH, SCREEN_HEIGHT } from './computer/constants'
import { ActionOutcome, PlaywrightSurface } from './computer/playwrightSurface'

/** Claude may keep acting until this many round-trips — then we cut it off. */
const MAX_TOOL_ITERATIONS = 30

/**
 * Function tools declared alongside the native computer tool so Claude can
 * open any site directly (Playwright screenshots only the page, so there's no
 * address bar for it to click). Function tools mix freely with the native
 * computer tool in one request — the proxy passes both through.
 */
const NAVIGATE_TOOL: ToolDefinition = {
  name: 'navigate',
  description:
    'Open a URL in the browser. Use this to go to any website (a bare domain like "example.com" or a full https URL) instead of trying to click a browser address bar — the screenshot only shows the page content, not browser chrome.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'The URL or domain to open.' } },
    required: ['url'],
  },
}
const GO_BACK_TOOL: ToolDefinition = {
  name: 'go_back',
  description: 'Go back to the previous page in the browser history.',
  parameters: { type: 'object', properties: {} },
}

/**
 * Anthropic ships the computer tool in versioned generations, and models only
 * accept the generation they were trained with: Claude <= 4.5 wants
 * computer_20250124 (beta applied automatically by the proxy), Claude >= 4.6
 * wants computer_20251124, whose beta we pass explicitly through the
 * `anthropic_beta` option (the retrieval-server forwards it as the beta
 * header). We start with the modern version and fall back once per model if
 * Anthropic rejects the tool type.
 */
type ComputerToolVariant = 'modern' | 'legacy'

const COMPUTER_TOOLS: Record<ComputerToolVariant, ToolDefinition> = {
  modern: {
    name: 'computer',
    type: 'computer_20251124',
    options: {
      display_width_px: SCREEN_WIDTH,
      display_height_px: SCREEN_HEIGHT,
      anthropic_beta: 'computer-use-2025-11-24',
    },
  },
  legacy: {
    name: 'computer',
    type: 'computer_20250124',
    options: { display_width_px: SCREEN_WIDTH, display_height_px: SCREEN_HEIGHT },
  },
}

// The retrieval-server strips the vendor's error detail, so the relayed
// message is only "...(anthropic): code: 400 -". A provider 400 on a
// computer-use request is always the tool-type/beta mismatch (auth is
// 401/403, quota 429), so a 400 on the first attempt triggers the variant
// fallback.
const TOOL_TYPE_REJECTED_RE = /does not support tool types|(returned an error|HTTP)[^{]*\b400\b/i

interface ComputerUseProviderProps {
  surface: PlaywrightSurface
  model: string
  onShot: (shot: { dataUrl: string }) => void
  showToast: (message: string) => void
  children: React.ReactNode
}

export default function ComputerUseProvider({ surface, model, onShot, showToast, children }: ComputerUseProviderProps) {
  const [blocks, setBlocks] = useState<ConversationBlock[]>([
    { conversationBlockId: 'block-1', prompt: '', responseMessages: [], isLoading: false, status: 'draft' },
  ])
  const [conversationId, setConversationId] = useState('')

  const lastAssistantMessageIdRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const selectionsRef = useRef<Record<string, string[]>>({})
  const modelRef = useRef(model)
  modelRef.current = model
  /** Which computer-tool generation each model accepted (learned at runtime). */
  const toolVariantByModelRef = useRef<Record<string, ComputerToolVariant>>({})

  const patchBlock = (blockId: string, patch: (b: ConversationBlock) => ConversationBlock) =>
    setBlocks((prev) => prev.map((b) => (b.conversationBlockId === blockId ? patch(b) : b)))

  const patchMessage = (blockId: string, patch: (m: Message) => Message) =>
    patchBlock(blockId, (b) => ({ ...b, responseMessages: b.responseMessages.map((m) => patch(m)) }))

  const runTurn = async (blockId: string, prompt: string) => {
    if (abortRef.current) {
      showToast('A generation is already running — stop it first')
      return
    }
    const abort = new AbortController()
    abortRef.current = abort

    const placeholderId = `resp-${Date.now()}`
    patchBlock(blockId, (b) => ({
      ...b,
      prompt,
      status: 'resolved',
      isLoading: true,
      sentAt: Date.now(),
      responseMessages: [
        {
          aiVendor: AIVendor.CLAUDE,
          model: modelRef.current,
          text: '',
          messageId: placeholderId,
          isLoading: true,
          thinkingStepList: [],
        },
      ],
    }))

    const appendStep = (step: ThinkingStep) =>
      patchMessage(blockId, (m) => {
        const steps = m.thinkingStepList ?? []
        const runningIdx = steps.findIndex((s) => s.node === step.node && s.status === 'running')
        const next =
          step.status === 'done' && runningIdx !== -1
            ? steps.map((s, i) => (i === runningIdx ? { ...s, ...step } : s))
            : [...steps, step]
        return { ...m, thinkingStepList: next }
      })

    let convId: string | null = conversationId || null
    let selectedResponseId: string | null = lastAssistantMessageIdRef.current
    let toolResults: ToolResult[] = []
    let actionNumber = 0

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const activeModel = modelRef.current
        const toolVariant = toolVariantByModelRef.current[activeModel] ?? 'modern'
        const request: GenerateTextStreamRequest = {
          aiConfig: { aiVendor: 'CLAUDE', model: activeModel },
          prompt: { instructionId: '', instructionVersion: '', prompt: iteration === 0 ? prompt : '' },
          selectedResponseId,
          conversationId: convId,
          client: 'computer-use-example',
          // Pure GUI-driving turns: skip the agent graph / retrieval
          agentic: false,
          tools: [COMPUTER_TOOLS[toolVariant], NAVIGATE_TOOL, GO_BACK_TOOL],
          toolResults,
          learnFromConversation: false,
          useLearnedPreferences: false,
        }

        let turn: StreamTurnResult
        try {
          turn = await generateTextStreamOnce(
            request,
            {
              onDelta: (chunk) => {
                patchMessage(blockId, (m) => ({ ...m, text: m.text + chunk }))
              },
              onThinkingStep: appendStep,
              onThinkingDuration: (millis) => patchMessage(blockId, (m) => ({ ...m, thinkingDurationMs: millis })),
            },
            abort.signal
          )
        } catch (err) {
          // Wrong computer-tool generation for this model — switch once and
          // retry the same iteration with the other version
          if (
            err instanceof Error &&
            TOOL_TYPE_REJECTED_RE.test(err.message) &&
            toolVariantByModelRef.current[activeModel] === undefined
          ) {
            toolVariantByModelRef.current[activeModel] = toolVariant === 'modern' ? 'legacy' : 'modern'
            iteration -= 1
            continue
          }
          throw err
        }

        // The variant worked — remember it so a later transient 400 on this
        // model can't wrongly flip a tool version that was already accepted.
        if (toolVariantByModelRef.current[activeModel] === undefined) {
          toolVariantByModelRef.current[activeModel] = toolVariant
        }

        if (turn.conversationId) {
          convId = turn.conversationId
          setConversationId(turn.conversationId)
        }
        if (turn.responseMessageId) {
          selectedResponseId = turn.responseMessageId
          lastAssistantMessageIdRef.current = turn.responseMessageId
          patchMessage(blockId, (m) => ({ ...m, messageId: turn.responseMessageId! }))
        }

        if (turn.toolCalls.length === 0) break // final text answer — done

        if (iteration === MAX_TOOL_ITERATIONS - 1) {
          showToast(`Stopped after ${MAX_TOOL_ITERATIONS} tool iterations`)
          break
        }

        // Add a paragraph break so commentary from the next iteration doesn't
        // glue onto this one's text
        patchMessage(blockId, (m) => (m.text && !m.text.endsWith('\n') ? { ...m, text: m.text + '\n\n' } : m))

        toolResults = []
        for (const call of turn.toolCalls) {
          actionNumber += 1
          const label = describeAction(call.name, call.args)
          const stepNode = `computer-${actionNumber}`
          appendStep({ node: stepNode, name: label, status: 'running', label: `${label}…` })

          let outcome: ActionOutcome
          if (call.name === 'navigate') {
            outcome = await surface.navigate(String(call.args.url ?? ''))
          } else if (call.name === 'go_back') {
            outcome = await surface.goBack()
          } else {
            outcome = await surface.execute(call.args)
          }

          appendStep({
            node: stepNode,
            name: label,
            status: 'done',
            detail: outcome.screenshotBase64 ? 'screenshot sent to Claude' : outcome.content,
          })

          if (outcome.screenshotBase64) {
            onShot({ dataUrl: `data:image/png;base64,${outcome.screenshotBase64}` })
            toolResults.push({
              toolCallId: call.id,
              content: '',
              images: [{ data: outcome.screenshotBase64, mediaType: 'image/png' }],
            })
          } else {
            toolResults.push({ toolCallId: call.id, content: outcome.content })
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted) {
        patchMessage(blockId, (m) => ({ ...m, error: 'Stopped by user' }))
      } else {
        const reason =
          err instanceof StreamGenerationError || err instanceof Error ? err.message : 'Generation failed'
        patchMessage(blockId, (m) => ({ ...m, error: reason }))
        showToast(reason)
      }
    } finally {
      abortRef.current = null
      patchBlock(blockId, (b) => ({
        ...b,
        isLoading: false,
        responseMessages: b.responseMessages.map((m) => ({ ...m, isLoading: false })),
      }))
    }
  }

  const value = useMemo<ConversationWidgetContextValue>(
    () => ({
      conversation: {
        conversationBlockList: blocks,
        conversationId,
        setActiveBlockId: () => undefined,
        addNewConversationBlockWithId: (id) =>
          setBlocks((prev) => [
            ...prev,
            { conversationBlockId: id, prompt: '', responseMessages: [], isLoading: false, status: 'draft' },
          ]),
        generateResponsesStream: (blockId, prompt) => {
          const block = blocks.find((b) => b.conversationBlockId === blockId)
          const effectivePrompt = prompt ?? block?.prompt ?? ''
          if (!effectivePrompt.trim()) {
            showToast('Type a task for Claude first')
            return
          }
          void runTurn(blockId, effectivePrompt)
        },
        stopGenerating: () => abortRef.current?.abort(),
        setSelectedResponseForBlock: () => undefined,
        getSelectedResponseForBlock: () => null,
        getVendorSelectionForBlock: (blockId) => selectionsRef.current[blockId] ?? [],
        setVendorSelectionForBlock: (blockId, vendors) => {
          selectionsRef.current[blockId] = vendors
        },
      },
      conversationUI: {
        setEditorPrompt: () => undefined,
        setActiveViewportItem: () => undefined,
      },
      auth: {
        isAuthenticated: true,
        customerId: 'computer-use-example',
        customerName: 'You',
        aiVendorAPIKeyStatusList: [{ aiVendor: AIVendor.CLAUDE, isAPIKeyValid: true, priority: 1 }],
        // The Vite dev server injects the real bearer key on proxied requests;
        // the browser never holds a token
        getAccessTokenSilently: async () => '',
      },
      services: {
        getVendorDisplayName: (vendorId) => (vendorId === AIVendor.CLAUDE ? 'Claude' : vendorId),
      },
      layout: { isLeftSidebarExpanded: false, isRightSidebarExpanded: false },
      showToast,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blocks, conversationId, showToast]
  )

  return <ConversationWidgetProvider value={value}>{children}</ConversationWidgetProvider>
}
