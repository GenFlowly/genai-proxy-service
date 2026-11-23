// src/context/ConversationContext.tsx
import React, { createContext, useContext, useState, ReactNode, useRef, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router'
import { AIVendor } from '../constants/vendors'
import { useAuth } from './AuthContext'
import { AIConfig, useAI } from './AIContext'
import { useToast } from './ToastContext'
import { generateText } from '../services/generateTextService'
import { generateTextStream, StreamMetadata, AwaitingInput, StreamGenerationError, STOP_REASON_CANCELLED } from '../services/generateTextStreamService'
import { reattachRun } from '../services/reattachRunService'
import { resumeRun as resumeRunApi } from '../services/resumeRunService'
import { getAIUsageActivity } from '../services/getAIUsageService'
import { getConversation } from '../services/conversationService'
import { cancelGeneration } from '../services/cancelGenerationService'
import {
    ConversationBlock,
    IConversationContext,
    IConversationUIContext,
    Message,
    WebSource,
} from '../models/conversation.models'
import { ActivityEvent, appendActivity } from '@genflowly/component-library'
import { customerKey, StorageSuffix } from '../utils/storageKeys'
import { AttachmentRef } from '../models/attachment.models'
import { createConversationTitle } from '../services/createConversationTitleService'
import { forkConversation as forkConversationApi } from '../services/conversationHistoryService'
import { CONVERSATION_FORKED_EVENT } from '../constants/events'
import i18n from '../i18n'

const ConversationContext = createContext<IConversationContext | undefined>(undefined)
const ConversationUIContext = createContext<IConversationUIContext | undefined>(undefined)

// crypto.randomUUID requires a secure context — fall back for plain-HTTP dev hosts and jsdom
const newGenerationId = (): string =>
    globalThis.crypto?.randomUUID?.() ??
    `gen-${Date.now()}-${Math.random().toString(36).slice(2)}`

// How long a reply stopped before its response headers keeps its request open
// waiting for them, before giving up on the conversation id they carry.
const STOP_HEADERS_TIMEOUT_MS = 30_000

/** A reply frozen by Stop: no longer loading, marked stopped. The activity
 * panel reads its open steps as stopped from that alone. */
const markStopped = (m: Message): Message => ({
    ...m,
    isLoading: false,
    stopReason: STOP_REASON_CANCELLED,
})

/**
 * Human-in-the-loop state for durable runs paused on an in-graph interrupt().
 * Kept in a small app-owned context because the main conversation value is typed
 * by the component library's IConversationContext (which doesn't model this).
 */
export interface RunHitlContextValue {
    /** messageId -> the run's pending input request ({prompt, run_id, node, ...}). */
    awaitingInputs: Record<string, AwaitingInput>
    /** Deliver a reply to the durable run generating [messageId]; resumes it. */
    submitRunReply: (messageId: string, reply: string) => Promise<void>
}
const RunHitlContext = createContext<RunHitlContextValue | undefined>(undefined)
export const useRunHitl = (): RunHitlContextValue => {
    const ctx = useContext(RunHitlContext)
    if (!ctx) throw new Error('useRunHitl must be used within a ConversationProvider')
    return ctx
}

/**
 * Fast-changing UI state (draft prompt text, viewport tracking) lives in its
 * own provider ABOVE the data provider. Typing and scrolling update only
 * this context, so the conversation tree — every block's markdown — no
 * longer re-renders on each editor debounce tick or viewport change.
 */
const ConversationUIProvider = ({ children }: { children: ReactNode }) => {
    const [editorPrompt, setEditorPrompt] = useState<string>('')
    const [activeViewportItem, setActiveViewportItem] = useState<{ blockId: string, type: 'request' | 'response' } | null>(null)

    const value = useMemo(
        () => ({ editorPrompt, setEditorPrompt, activeViewportItem, setActiveViewportItem }),
        [editorPrompt, activeViewportItem]
    )

    return (
        <ConversationUIContext.Provider value={value}>
            {children}
        </ConversationUIContext.Provider>
    )
}

const ConversationDataProvider = ({ children }: { children: ReactNode }) => {
    const { customerId, getAccessTokenSilently, isAuthenticated, isSessionAuthenticated, logout, loginWithRedirect } = useAuth()
    const { showToast } = useToast()

    const {
        config,
        setSupplementalText,
        systemPrompt,
        setSystemPrompt,
        selectedInstructionId,
        setSelectedInstructionId,
        customerInstructions,
        selectedAgentId,
    } = useAI()
    const navigate = useNavigate()


    const [conversationId, setConversationId] = useState<string>('')
    const [activeBlockId, setActiveBlockId] = useState<string>('')
    const [conversationTitle, setConversationTitle] = useState<string | null>(null)
    const [conversationRole, setConversationRole] = useState<'OWNER' | 'EDIT' | 'VIEW'>('OWNER')
    // Durable-run HITL: messageId -> the run's pending input request. Set when an
    // "ai" frame arrives; cleared on reply or when the message finishes.
    const [awaitingInputs, setAwaitingInputs] = useState<Record<string, AwaitingInput>>({})
    
    // Manage aborted streams natively
    const abortControllers = useRef<Map<string, AbortController>>(new Map())
    // Client-generated id per in-flight stream (same key as abortControllers),
    // sent with the generate request so Stop can cancel server-side at any
    // moment — the server's responseMessageId only arrives in the response
    // headers, too late for a Stop pressed during the "thinking" phase.
    const generationIds = useRef<Map<string, string>>(new Map())
    // Streams Stop was pressed for, and streams whose response headers have
    // arrived. A stream stopped before its headers keeps its request open
    // until they come: they carry the conversation id a new chat's other
    // vendors join, and without it the next vendor starts a conversation of
    // its own. A vendor stopped before it launched still sends its request,
    // so the server records it as stopped.
    const stopRequested = useRef<Set<string>>(new Set())
    const headersReceived = useRef<Set<string>>(new Set())

    const stopGenerating = useCallback((blockId?: string, vendor?: string) => {
        const idToAbort = blockId || activeBlockId;
        if (!idToAbort) return;

        const keysToStop = (vendor
            ? [`${idToAbort}-${vendor}`]
            : Array.from(abortControllers.current.keys()).filter(
                key => key.startsWith(`${idToAbort}-`) || key === idToAbort
            )
        ).filter(key => abortControllers.current.has(key) && !stopRequested.current.has(key))
        if (keysToStop.length === 0) return

        const idsToCancel: string[] = []
        keysToStop.forEach(key => {
            stopRequested.current.add(key)
            const controller = abortControllers.current.get(key)
            if (headersReceived.current.has(key)) {
                controller?.abort()
            } else {
                setTimeout(() => controller?.abort(), STOP_HEADERS_TIMEOUT_MS)
            }
            const generationId = generationIds.current.get(key)
            if (generationId) idsToCancel.push(generationId)
        })

        const stoppedVendors = new Set(keysToStop.map(key => key.slice(idToAbort.length + 1)))
        setConversationBlockList(prev => prev.map(block =>
            block.conversationBlockId !== idToAbort ? block : {
                ...block,
                responseMessages: block.responseMessages.map(m =>
                    m.isLoading && stoppedVendors.has(m.aiVendor) ? markStopped(m) : m),
            }))

        if (idsToCancel.length === 0) return
        // Aborting the fetch only detaches this client — generation survives
        // disconnects by design and keeps consuming tokens/tools, so a true
        // Stop must also cancel server-side. Awaited with retries: an
        // unacknowledged cancel means the model keeps generating and billing.
        void (async () => {
            try {
                const token = await getAccessTokenSilently()
                await Promise.all(idsToCancel.map(generationId => cancelGeneration(token, generationId)))
            } catch (e) {
                console.warn('Failed to cancel generation server-side', e)
            }
        })()
    }, [activeBlockId, getAccessTokenSilently])

    // ✅ Ref to always hold the latest conversationId
    const conversationIdRef = useRef(conversationId)
    useEffect(() => {
        conversationIdRef.current = conversationId
    }, [conversationId])

    const [conversationBlockList, setConversationBlockList] = useState<ConversationBlock[]>([
        {
            conversationBlockId: `conv-default`,
            prompt: '',
            responseMessages: [],
            isLoading: false,
            status: 'draft',
        },
    ])

    const [selectedResponseByBlock, setSelectedResponseByBlock] = useState<Record<string, string | null>>({})
    const [vendorSelectionByBlock, setVendorSelectionByBlock] = useState<Record<string, string[]>>({})

    const getSelectedResponseForBlock = useCallback((blockId: string) => {
        return selectedResponseByBlock[blockId] ?? null
    }, [selectedResponseByBlock])

    // Sync Supplemental Text Effect
    useEffect(() => {
        if (!activeBlockId) {
            setSupplementalText('')
            return
        }

        // 1. Get Supplemental Text (Previous Response)
        let currentSupplementalText = ''
        const index = conversationBlockList.findIndex(b => b.conversationBlockId === activeBlockId)
        if (index > 0) {
            const prevBlock = conversationBlockList[index - 1]
            if (prevBlock && prevBlock.responseMessages.length > 0) {
                const selectedId = getSelectedResponseForBlock(prevBlock.conversationBlockId)
                const selectedMsg = prevBlock.responseMessages.find(m => m.messageId === selectedId)
                const finalMsg = selectedMsg || prevBlock.responseMessages[0]
                currentSupplementalText = finalMsg?.text || ''
            }
        }

        // Sync to AIContext
        setSupplementalText(currentSupplementalText)

    }, [activeBlockId, conversationBlockList, getSelectedResponseForBlock, setSupplementalText])

    const updateConversationBlock = useCallback((conversationBlockId: string, updater: Partial<ConversationBlock>) => {
        setConversationBlockList(prev =>
            prev.map(block =>
                block.conversationBlockId === conversationBlockId
                    ? { ...block, ...updater }
                    : block
            )
        )
    }, [])

    const setSelectedResponseForBlock = useCallback((blockId: string, responseId: string) => {
        setSelectedResponseByBlock(prev => ({ ...prev, [blockId]: responseId }))
    }, [])

    const getVendorSelectionForBlock = useCallback((blockId: string): string[] => {
        return vendorSelectionByBlock[blockId] ?? []
    }, [vendorSelectionByBlock])

    const setVendorSelectionForBlock = useCallback((blockId: string, vendors: string[]) => {
        setVendorSelectionByBlock(prev => ({ ...prev, [blockId]: vendors }))
    }, [])

    // --- API Calls ---

    /**
     * Background-recovery for interrupted streams: mobile browsers kill the
     * network stream when the app/tab is backgrounded, but the server keeps
     * generating and persists the response under its deterministic message id.
     * Poll the conversation until that message appears and return its text.
     * Timers are throttled while the tab is hidden, so in practice this
     * resumes polling the moment the user returns.
     */
    const recoverPersistedResponse = async (
        token: string,
        conversationId: string,
        responseMessageId: string,
        maxAttempts = 36
    ): Promise<Message | null> => {
        const POLL_INTERVAL_MS = 5000
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
            try {
                const data = await getConversation(token, conversationId)
                const found = data?.blocks
                    ?.flatMap(b => b.responseMessages)
                    .find(m => m.messageId === responseMessageId)
                if (found?.text) return found
            } catch (e) {
                console.warn('Recovery poll failed, will retry', e)
            }
        }
        return null
    }

    // Project the NEXT brand-new conversation is created into (set by the
    // history sidebar's per-project "new conversation" action; cleared by
    // resetConversation). Sent only when the generate request carries no
    // conversationId. Ref + state pair: the ref gives the request builders an
    // always-current read regardless of closure age, the state lets consumers
    // (the history sidebar) react to it.
    const [pendingProjectId, setPendingProjectIdState] = useState<string | null>(null)
    const pendingProjectIdRef = useRef<string | null>(null)
    const setPendingProjectId = useCallback((projectId: string | null) => {
        pendingProjectIdRef.current = projectId
        setPendingProjectIdState(projectId)
    }, [])

    const fetchVendorResponses = async (
        token: string,
        aiConfigs: AIConfig[],
        prompt: string,
        selectedResponseId: string | null,
        instructionId: string,
        instructionVersion: string,
        attachments: AttachmentRef[] = []
    ): Promise<Message[]> => {
        const response = await generateText(token, {
            aiConfig: aiConfigs.filter(c => c.aiVendor && c.model),
            prompt: {
                instructionId,
                instructionVersion,
                prompt,
                attachments,
            },
            // customerId: customerId!,
            selectedResponseId: selectedResponseId ?? '',
            conversationId: conversationIdRef.current,
            client: 'REACT_APP',
            agentId: selectedAgentId,
            // Starting fresh inside a project: the new conversation is born in it
            projectId: conversationIdRef.current ? undefined : pendingProjectIdRef.current,
        })

        console.log('DEBUGGING response RECEVIEVED:', response)

        // ✅ Extract conversationId from the first result if missing at root
        const newConversationId =
            response.conversationId ??
            response.results?.[0]?.conversationId ??
            ''

        // Update conversation ID and navigate if changed
        if (newConversationId && newConversationId !== conversationIdRef.current) {
            setConversationId(newConversationId)
            conversationIdRef.current = newConversationId
            console.log('SET Conversation ID', newConversationId)

            // Sync URL
            navigate(`/chat/${newConversationId}`)
        }

        console.log('DEBUG response:', response)

        // ✅ Normalize single vs multi-response structure
        const rawResults = Array.isArray(response.results)
            ? response.results
            : (response.text || response.aiVendor ? [response] : [])

        return rawResults.map((r: any) => ({
            aiVendor: r.aiVendor as AIVendor,
            model: r.model ?? aiConfigs.find(c => c.aiVendor === r.aiVendor)?.model ?? null,
            text: r.text ?? '',
            messageId: r.messageId ?? '',
            inputTokens: r.inputTokens ?? null,
            outputTokens: r.outputTokens ?? null,
            totalTokens: r.totalTokens ?? null,
            tokensReadFromCache: r.tokensReadFromCache ?? null,
        }))
    }

    const fetchVendorResponseStream = async (
        token: string,
        aiConfig: AIConfig,
        prompt: string,
        selectedResponseId: string | null,
        instructionId: string,
        instructionVersion: string,
        onDelta: (chunk: string) => void,
        onMetadata?: (metadata: StreamMetadata) => void,
        // Added idOverride to support explicit conversation targeting (parallel streams)
        idOverride?: string,
        onActivity?: (event: ActivityEvent) => void,
        signal?: AbortSignal,
        attachments: AttachmentRef[] = [],
        onWebSources?: (sources: WebSource[]) => void,
        onGeneratedAttachments?: (attachments: AttachmentRef[]) => void,
        onAwaitingInput?: (payload: AwaitingInput) => void,
        onContentReset?: () => void,
        onStopReason?: (reason: string) => void,
        regenerateMessageId?: string,
        generationId?: string,
        turnResponseCount?: number
    ): Promise<void> => {
        await generateTextStream(token, {
            aiConfig: aiConfig,
            prompt: {
                instructionId,
                instructionVersion,
                prompt,
                attachments,
            },
            selectedResponseId: selectedResponseId ?? '',
            conversationId: idOverride || conversationIdRef.current,
            client: 'REACT_APP',
            agentId: selectedAgentId,
            // Starting fresh inside a project: the new conversation is born in it
            projectId: (idOverride || conversationIdRef.current) ? undefined : pendingProjectIdRef.current,
            regenerateMessageId,
            generationId,
            turnResponseCount,
        }, onDelta, onMetadata, onActivity, signal, onWebSources, onGeneratedAttachments, onAwaitingInput, onContentReset, onStopReason)
    }

    const loadConversation = useCallback(async (id: string) => {
        try {
            let token = ''
            // Auth0-level check, NOT strict isAuthenticated: right after the
            // login redirect /onboard hasn't returned a customerId yet, and
            // fetching anonymously here 403s and bounces straight back to
            // login — an infinite loop on deep-linked logins.
            if (isSessionAuthenticated) {
                try {
                    token = await getAccessTokenSilently()
                } catch (e) {
                    console.warn("Could not get access token", e)
                }
            }
            const data = await getConversation(token, id)

            if (data && data.blocks) {
                setConversationId(data.conversationId)
                setConversationBlockList(data.blocks)
                setConversationRole(data.role)

                // Restore the page title from the saved conversation title
                if (data.title) {
                    document.title = data.title
                    setConversationTitle(data.title)
                } else {
                    setConversationTitle(null)
                }

                // Restore the selected instruction from the conversation
                setSelectedInstructionId(data.instructionId ?? null)

                // Durable runs are still generating the latest reply — reattach to
                // each so the responses continue live after this reload. A
                // multi-vendor turn has one run per vendor (data.pendingRuns), each
                // feeding its own response card.
                const pendingRuns = data.pendingRuns ?? []
                if (data.blocks.length > 0 && (pendingRuns.length > 0 || data.pendingRunId)) {
                    const lastBlock = data.blocks[data.blocks.length - 1]
                    const bId = lastBlock.conversationBlockId

                    // Reattach one response message to its durable run: reset text,
                    // stream the replay in, then (for a real backend id) fetch
                    // usage/cost and poll for the persisted message if the run already
                    // finished. `synthetic` = we invented the id (legacy proxy, no
                    // placeholder), so there's no server record to fetch usage for.
                    const reattachOne = (targetId: string, runId: string, synthetic: boolean) => {
                        const patch = (fn: (m: any) => any) => setConversationBlockList(prev => prev.map(b =>
                            b.conversationBlockId === bId
                                ? { ...b, responseMessages: b.responseMessages.map(m => m.messageId === targetId ? fn(m) : m) }
                                : b))
                        // Reset text: the reattach replays the run from the start.
                        patch(m => ({ ...m, isLoading: true, text: '' }))
                        let acc = ''
                        let gotContent = false
                        let runFailed = false
                        const finish = async () => {
                            if (!synthetic) {
                                // Run finished before we reconnected → poll for the
                                // persisted message so we never leave an empty card.
                                // A failed run saved nothing to wait for.
                                if (!gotContent && !runFailed) {
                                    try {
                                        const recovered = await recoverPersistedResponse(token, data.conversationId, targetId)
                                        if (recovered) patch(m => ({
                                            ...m,
                                            text: recovered.text,
                                            webSources: recovered.webSources ?? m.webSources,
                                            generatedAttachments: recovered.generatedAttachments ?? m.generatedAttachments,
                                        }))
                                    } catch (e) { console.warn('Recover after reattach failed', e) }
                                }
                                try {
                                    const metrics = await getAIUsageActivity(token, data.conversationId, targetId)
                                    if (metrics) patch(m => ({
                                        ...m,
                                        inputTokens: metrics.inputTokens,
                                        outputTokens: metrics.outputTokens,
                                        totalTokens: metrics.totalTokens,
                                        tokensReadFromCache: metrics.tokensReadFromCache ?? 0,
                                        costUsd: metrics.costUsd ?? null,
                                    }))
                                } catch (e) { console.warn('Usage fetch after reattach failed', e) }
                            }
                            setConversationBlockList(prev => prev.map(b =>
                                b.conversationBlockId === bId
                                    ? { ...b, isLoading: b.responseMessages.some(m => m.messageId !== targetId && m.isLoading), responseMessages: b.responseMessages.map(m => m.messageId === targetId ? { ...m, isLoading: false } : m) }
                                    : b))
                        }
                        reattachRun(token, runId, data.conversationId, {
                            onDelta: (c) => { acc += c; gotContent = true; patch(m => ({ ...m, text: acc })) },
                            onContentReset: () => { acc = ''; patch(m => ({ ...m, text: '' })) },
                            onStopReason: (reason) => patch(m => ({ ...m, stopReason: reason })),
                            onActivity: (event) => { gotContent = true; patch(m => ({ ...m, activity: appendActivity(m.activity, event) })) },
                            onWebSources: (ws) => patch(m => ({ ...m, webSources: ws })),
                            onGeneratedAttachments: (ga) => patch(m => ({ ...m, generatedAttachments: [...(m.generatedAttachments ?? []), ...ga] })),
                            onAwaitingInput: (p) => setAwaitingInputs(prev => ({ ...prev, [targetId]: { ...p, run_id: runId } })),
                        }).catch(e => {
                            console.warn('Reattach to pending run failed', e)
                            if (e instanceof StreamGenerationError) {
                                runFailed = true
                                patch(m => ({ ...m, error: e.message }))
                            }
                        }).finally(finish)
                    }

                    if (pendingRuns.length > 0) {
                        // Backend surfaced a placeholder per run (real ids already in
                        // the block via the service mapping) — reattach to every one.
                        pendingRuns.forEach(pr => reattachOne(pr.messageId, pr.runId, false))
                    } else if (data.pendingRunId) {
                        // Legacy single-run proxy without placeholders: synthesize one
                        // to receive the stream (no server record → usage-fetch skipped).
                        const existing = lastBlock.responseMessages[lastBlock.responseMessages.length - 1]
                        const targetId = existing?.messageId ?? `reattach-${data.pendingRunId}`
                        if (!existing) {
                            const priorMsg = [...data.blocks].reverse()
                                .flatMap(b => b.responseMessages)
                                .find(m => m.aiVendor)
                            const placeholder: Message = {
                                aiVendor: priorMsg?.aiVendor ?? '',
                                model: priorMsg?.model ?? null,
                                text: '',
                                messageId: targetId,
                                isLoading: true,
                            }
                            setConversationBlockList(prev => prev.map(b =>
                                b.conversationBlockId === bId
                                    ? { ...b, isLoading: true, responseMessages: [...b.responseMessages, placeholder] }
                                    : b))
                        }
                        reattachOne(targetId, data.pendingRunId, !existing)
                    }
                }
            }
        } catch (err: any) {
            if (err?.status === 403) {
                if (!isSessionAuthenticated) {
                    loginWithRedirect({ appState: { returnTo: window.location.pathname } })
                } else {
                    // 403 with a live Auth0 session is "no access", not
                    // "logged out" — redirecting to login here would loop.
                    showToast(i18n.t('toasts.conversation.noAccess'))
                    navigate('/chat')
                }
            } else {
                console.error("Failed to load conversation", err)
            }
        }
    }, [isSessionAuthenticated, getAccessTokenSilently, showToast, navigate, setSelectedInstructionId, loginWithRedirect])

    // Deliver a human/client reply to the durable run generating [messageId]. The
    // run resumes from its checkpoint; the still-open stream delivers what follows.
    const submitRunReply = useCallback(async (messageId: string, reply: string) => {
        const pending = awaitingInputs[messageId]
        const runId = (pending?.run_id ?? (pending as any)?.runId) as string | undefined
        if (!runId) {
            console.warn('No run id for awaiting message', messageId)
            return
        }
        let token = ''
        try {
            token = await getAccessTokenSilently()
        } catch (e) {
            console.warn('Could not get access token', e)
        }
        // Optimistically clear the prompt; the open stream delivers the continuation.
        setAwaitingInputs(prev => {
            const next = { ...prev }
            delete next[messageId]
            return next
        })
        const ok = await resumeRunApi(token, runId, conversationIdRef.current, { reply })
        if (!ok) showToast('Failed to send your reply — please try again')
    }, [awaitingInputs, getAccessTokenSilently, showToast])

    /**
     * Fork the loaded conversation at [messageId]: the backend copies every
     * message up to and including it into a new conversation titled
     * "Forked <title>", recording the parent id. The history sidebar owns its
     * list in component-local state, so the fork is announced via a window
     * event (it nests the fork under its parent immediately); then we
     * navigate to the fork, which loads it like any other conversation.
     */
    const forkConversation = useCallback(async (messageId: string) => {
        const sourceConversationId = conversationIdRef.current
        if (!sourceConversationId) return
        try {
            const token = await getAccessTokenSilently()
            const fork = await forkConversationApi(token, sourceConversationId, messageId)
            window.dispatchEvent(new CustomEvent(CONVERSATION_FORKED_EVENT, { detail: fork }))
            showToast(i18n.t('conversation.conversationHistory.forkedToast'))
            navigate(`/chat/${fork.conversationId}`)
        } catch (err) {
            console.error('Failed to fork conversation:', err)
            showToast(i18n.t('conversation.conversationHistory.forkFailed'))
        }
    }, [getAccessTokenSilently, navigate, showToast])

    const resetConversation = useCallback(() => {
        navigate('/chat')
        if (customerId) {
            // Drafts older component-library versions left in localStorage
            Object.keys(localStorage).forEach(key => {
                if (key.startsWith(customerKey(customerId, StorageSuffix.promptEditorContentPrefix))) {
                    localStorage.removeItem(key)
                }
            })
        }

        setConversationId('')
        setConversationBlockList([
            {
                conversationBlockId: `conv-default`,
                prompt: '',
                responseMessages: [],
                isLoading: false,
                status: 'draft',
            },
        ])
        setSelectedResponseByBlock({})
        setConversationTitle(null)
        setConversationRole('OWNER')
        setPendingProjectId(null)
    }, [navigate, customerId, setPendingProjectId])

    /**
     * Start a fresh conversation that will be created inside the given
     * project when its first message is sent (the message+ action on a
     * project row). Same reset as a plain new chat, plus the pending
     * project — reset clears it, so it is set after.
     */
    const startConversationInProject = useCallback((projectId: string) => {
        resetConversation()
        setPendingProjectId(projectId)
    }, [resetConversation, setPendingProjectId])

    const clearPendingProject = useCallback(() => {
        setPendingProjectId(null)
    }, [setPendingProjectId])

    // --- Core Actions ---
    const addNewConversationBlock = useCallback(() => {
        const newConversation: ConversationBlock = {
            conversationBlockId: `conv-${Date.now()}`,
            prompt: '',
            responseMessages: [],
            isLoading: false,
            status: 'draft',
        }
        setConversationBlockList(prev => [...prev, newConversation])
    }, [])

    const updatePromptInConversationBlock = useCallback((conversationBlockId: string, prompt: string) => {
        updateConversationBlock(conversationBlockId, { prompt })
    }, [updateConversationBlock])

    const validateAndPrepareGeneration = (id: string, overridePrompt?: string, selectedMessageId?: string | null) => {
        const conversationBlock = conversationBlockList.find(c => c.conversationBlockId === id)
        if (!conversationBlock) return null
        if (!isAuthenticated || !customerId) {
            showToast(i18n.t('toasts.auth.loginFirst'))
            return null
        }

        const aiConfigs = config.filter(c => c.aiVendor && c.model && c.model.trim() !== '')
        if (aiConfigs.length === 0) {
            showToast(i18n.t('toasts.ai.selectVendorAndModel'))
            return null
        }

        const index = conversationBlockList.findIndex(c => c.conversationBlockId === id)
        let parentResponseId = ''

        // Should use the selected response from the PREVIOUS block as the parent.
        // handleFollowUp stores the selection on the current (new) block, so check there first.
        if (index > 0) {
            const prevBlock = conversationBlockList[index - 1]
            const currentBlockSelectedId = getSelectedResponseForBlock(id)
            const prevBlockSelectedId = getSelectedResponseForBlock(prevBlock.conversationBlockId)

            if (currentBlockSelectedId) {
                parentResponseId = currentBlockSelectedId
            } else if (prevBlockSelectedId) {
                parentResponseId = prevBlockSelectedId
            } else if (prevBlock.responseMessages.length > 0) {
                parentResponseId = prevBlock.responseMessages[0].messageId
            }
        }

        // If an explicit override was passed (e.g. from a specific "Regenerate" button?), use that. 
        // Otherwise use the resolved parent from context.
        const finalSelectedResponseId = selectedMessageId !== undefined && selectedMessageId !== null
            ? selectedMessageId
            : parentResponseId

        const promptToUse = overridePrompt ?? conversationBlock.prompt

        return { conversationBlock, aiConfigs, finalSelectedResponseId, promptToUse }
    }

    const generateResponses = async (id: string, overridePrompt?: string, selectedMessageId?: string | null) => {
        const prep = validateAndPrepareGeneration(id, overridePrompt, selectedMessageId)
        if (!prep) return

        const { aiConfigs, finalSelectedResponseId, promptToUse } = prep

        updateConversationBlock(id, { isLoading: true, responseMessages: [], sentAt: Date.now() })
        try {
            const token = await getAccessTokenSilently()

            const instruction = customerInstructions.find(i => i.id === selectedInstructionId)
            const instructionVersion = instruction ? instruction.version.toString() : ""
            const instructionId = selectedInstructionId || ""

            const responses = await fetchVendorResponses(
                token,
                aiConfigs,
                promptToUse,
                finalSelectedResponseId,
                instructionId,
                instructionVersion,
                prep.conversationBlock.attachments ?? []
            )

            updateConversationBlock(id, {
                responseMessages: responses,
                isLoading: false,
                status: 'resolved',
                // Commit the prompt to context only on success
                prompt: promptToUse
            })
            setSelectedResponseForBlock(id, '')
        } catch (err: any) {
            // One error card per requested vendor with the real reason — the
            // batched call failed for all of them, not just OpenAI
            const reason = err?.message || i18n.t('errors.ai.generateTextFailed')
            updateConversationBlock(id, {
                responseMessages: aiConfigs.map((c, index) => ({
                    aiVendor: c.aiVendor,
                    model: c.model ?? null,
                    text: '',
                    messageId: `error-${index}`,
                    error: reason,
                })),
                isLoading: false,
                status: 'resolved',
            })
        }
    }

    const generateResponsesStream = async (id: string, overridePrompt?: string, selectedMessageId?: string | null, vendorToRegenerate?: AIVendor, attachments?: AttachmentRef[]) => {
        const prep = validateAndPrepareGeneration(id, overridePrompt, selectedMessageId)
        if (!prep) return

        let { aiConfigs, finalSelectedResponseId, promptToUse } = prep

        // Regeneration resends the turn's original attachments as part of the input
        const attachmentsToUse = attachments ?? prep.conversationBlock.attachments ?? []

        // Regenerate reuses the turn's existing user message — its id travels
        // on every response in the block as previousMessageId — instead of
        // letting the backend guess from prompt text, which only works while
        // the original send is still mid-flight, never for a later Regenerate.
        const regenerateMessageId = vendorToRegenerate
            ? prep.conversationBlock.responseMessages.find(m => m.previousMessageId)?.previousMessageId
            : undefined

        if (vendorToRegenerate) {
             aiConfigs = aiConfigs.filter(c => c.aiVendor === vendorToRegenerate)
             if (aiConfigs.length === 0) {
                 showToast(i18n.t('toasts.ai.selectValidModelForVendor', { vendor: vendorToRegenerate }))
                 return
             }
             // A stopped reply's request can stay open until its headers
             // arrive; regenerating it before then would race that stream.
             if (abortControllers.current.has(`${id}-${vendorToRegenerate}`)) return
        }
        
        const turnControllers = new Map<string, AbortController>()
        aiConfigs.forEach(c => {
             const key = `${id}-${c.aiVendor}`
             const controller = new AbortController()
             turnControllers.set(key, controller)
             abortControllers.current.set(key, controller)
             generationIds.current.set(key, newGenerationId())
             stopRequested.current.delete(key)
             headersReceived.current.delete(key)
        })
        // Drops a vendor's stream once it is over, unless a newer turn (a
        // regenerate) already took the key over. Its stop flags stay until
        // the key's next turn: the launcher reads them after the stream ends.
        const releaseStream = (key: string) => {
            if (abortControllers.current.get(key) !== turnControllers.get(key)) return
            abortControllers.current.delete(key)
            generationIds.current.delete(key)
        }

        const timestamp = Date.now()
        
        // Ensure we conditionally scope message injections (avoid overriding siblings)
        let initialResponseMessages: Message[] = []
        
        setConversationBlockList(prev => prev.map(block => {
             if (block.conversationBlockId === id) {
                 let newMsgs = [...block.responseMessages]
                 
                 if (vendorToRegenerate) {
                     const existingIndex = newMsgs.findIndex(m => m.aiVendor === vendorToRegenerate)
                     const newMsg: Message = {
                         aiVendor: vendorToRegenerate,
                         model: aiConfigs[0]?.model ?? null,
                         text: '',
                         messageId: `resp-${timestamp}-regen`,
                         isLoading: true
                     }
                     if (existingIndex !== -1) {
                         newMsgs[existingIndex] = newMsg
                     } else {
                         newMsgs.push(newMsg)
                     }
                     initialResponseMessages = [newMsg] // RunStream only gets this element
                 } else {
                     newMsgs = aiConfigs.map((config, index) => ({
                         aiVendor: config.aiVendor,
                         model: config.model ?? null,
                         text: '',
                         messageId: `resp-${timestamp}-${index}`,
                         isLoading: true
                     }))
                     initialResponseMessages = newMsgs
                 }
                 
                 // Regenerating a single vendor re-uses the original send time
                 return { ...block, isLoading: true, prompt: promptToUse, attachments: attachmentsToUse, responseMessages: newMsgs, sentAt: vendorToRegenerate ? block.sentAt : timestamp }
             }
             return block
        }))

        try {
            const token = await getAccessTokenSilently()

            const currentConversationId = conversationIdRef.current
            // Helper to perform the fetch for a specific config
            const runStream = async (conf: AIConfig, msgId: string, onIdResolved?: (id: string) => void, explicitConversationId?: string, index: number = 0) => {
                try {
                    await streamVendor(conf, msgId, onIdResolved, explicitConversationId, index)
                } finally {
                    releaseStream(`${id}-${conf.aiVendor}`)
                }
            }
            const streamVendor = async (conf: AIConfig, msgId: string, onIdResolved?: (id: string) => void, explicitConversationId?: string, index: number = 0) => {
                const streamKey = `${id}-${conf.aiVendor}`
                let accumulatedText = ""
                // Track the active message ID (starts as placeholder, updates to real backend ID)
                let currentMsgId = msgId

                // Use explicit ID if provided (for parallel launches), otherwise ref (for first launch)
                const idToUse = explicitConversationId || conversationIdRef.current

                const instruction = customerInstructions.find(i => i.id === selectedInstructionId)
                const instructionVersion = instruction ? instruction.version.toString() : ""
                const instructionId = selectedInstructionId || ""

                const handleActivity = (event: ActivityEvent) => {
                    setConversationBlockList(prev => prev.map(block => {
                        if (block.conversationBlockId !== id) return block
                        const msgs = block.responseMessages.map(m => {
                            if (m.messageId !== currentMsgId && m.messageId !== msgId) return m
                            return { ...m, activity: appendActivity(m.activity, event) }
                        })
                        return { ...block, responseMessages: msgs }
                    }))
                }

                const handleGeneratedAttachments = (attachments: AttachmentRef[]) => {
                    setConversationBlockList(prev => prev.map(block => {
                        if (block.conversationBlockId !== id) return block
                        const msgs = block.responseMessages.map(m => {
                            if (m.messageId !== currentMsgId && m.messageId !== msgId) return m
                            // Multiple "ga" events per turn are possible — merge by id
                            const existing = m.generatedAttachments ?? []
                            const merged = [
                                ...existing,
                                ...attachments.filter(a => !existing.some(e => e.attachmentId === a.attachmentId)),
                            ]
                            return { ...m, generatedAttachments: merged }
                        })
                        return { ...block, responseMessages: msgs }
                    }))
                }

                const handleWebSources = (sources: WebSource[]) => {
                    setConversationBlockList(prev => prev.map(block => {
                        if (block.conversationBlockId !== id) return block
                        const msgs = block.responseMessages.map(m => {
                            if (m.messageId !== currentMsgId && m.messageId !== msgId) return m
                            return { ...m, webSources: sources }
                        })
                        return { ...block, responseMessages: msgs }
                    }))
                }

                // Durable run paused on interrupt() — record the pending input
                // request against this message so the UI can prompt + reply.
                const handleAwaitingInput = (payload: AwaitingInput) => {
                    setAwaitingInputs(prev => ({ ...prev, [currentMsgId]: payload }))
                }

                // The round that just streamed ended in in-graph tool calls —
                // its text was a preamble, not the answer. Clear it so the
                // next round starts from empty; the narration stays visible in
                // the activity panel (the round's `reasoning`).
                const handleContentReset = () => {
                    accumulatedText = ""
                    setConversationBlockList(prev => prev.map(block => {
                        if (block.conversationBlockId !== id) return block
                        const msgs = block.responseMessages.map(m => {
                            if (m.messageId !== currentMsgId && m.messageId !== msgId) return m
                            return { ...m, text: "" }
                        })
                        return { ...block, responseMessages: msgs }
                    }))
                }

                // The vendor's raw finish reason for the turn — recorded on the
                // message so the card can always show why generation ended.
                const handleStopReason = (reason: string) => {
                    setConversationBlockList(prev => prev.map(block => {
                        if (block.conversationBlockId !== id) return block
                        const msgs = block.responseMessages.map(m => {
                            if (m.messageId !== currentMsgId && m.messageId !== msgId) return m
                            return { ...m, stopReason: reason }
                        })
                        return { ...block, responseMessages: msgs }
                    }))
                }

                // Finish THIS vendor's message only — on failure the streamed
                // text is kept and the reason is attached; other vendors'
                // streams are untouched
                const finishVendorMessage = (errorReason: string | null, stopReason?: string) => {
                    setAwaitingInputs(prev => {
                        if (!(currentMsgId in prev) && !(msgId in prev)) return prev
                        const next = { ...prev }
                        delete next[currentMsgId]
                        delete next[msgId]
                        return next
                    })
                    setConversationBlockList(prev => prev.map(block => {
                        if (block.conversationBlockId !== id) return block
                        const msgs = block.responseMessages.map(m => {
                            if (m.messageId !== currentMsgId && m.messageId !== msgId) return m
                            return {
                                ...m,
                                isLoading: false,
                                ...(errorReason ? { error: errorReason } : {}),
                                ...(stopReason ? { stopReason } : {}),
                            }
                        })
                        return { ...block, responseMessages: msgs }
                    }))
                }

                try {
                    await fetchVendorResponseStream(
                        token,
                        conf,
                        promptToUse,
                        finalSelectedResponseId,
                        instructionId,
                        instructionVersion,
                        (chunk) => {
                            accumulatedText += chunk
                            setConversationBlockList(prev =>
                                prev.map(block => {
                                    if (block.conversationBlockId === id) {
                                        const msgs = block.responseMessages.map(m => {
                                            // Match either the current active ID (which might be new) OR the original placeholder ID (if state update hasn't landed yet)
                                            const isMatch = (m.messageId === currentMsgId || m.messageId === msgId)
                                            if (isMatch) {
                                                return { ...m, text: accumulatedText }
                                            }
                                            return m
                                        })
                                        return { ...block, responseMessages: msgs }
                                    }
                                    return block
                                })
                            )
                        },
                        (metadata: StreamMetadata) => {
                            const newConversationId = metadata.conversationId

                            if (newConversationId && newConversationId !== conversationIdRef.current) {
                                const sanitizedId = newConversationId.split(',')[0].trim()

                                if (sanitizedId && sanitizedId !== conversationIdRef.current) {
                                    conversationIdRef.current = sanitizedId
                                }
                            }

                            // The server may have applied the customer's default
                            // instruction to a request that sent none — reflect it
                            // so the header badge appears without a reload
                            if (metadata.instructionId && metadata.instructionId !== selectedInstructionId) {
                                setSelectedInstructionId(metadata.instructionId)
                                const applied = customerInstructions.find(i => i.id === metadata.instructionId)
                                if (applied) setSystemPrompt(applied.instruction)
                            }

                            // Capture currentMsgId BEFORE updating it later in this callback.
                            // Essential because the functional state update below executes asynchronously/later, 
                            // and if we don't capture it here, the closure might see the updated value!
                            const targetId = currentMsgId

                            // Update metadata in the conversation block
                            setConversationBlockList(prev =>
                                prev.map(block => {
                                    if (block.conversationBlockId === id) {
                                        const msgs = block.responseMessages.map(m => {
                                            // 1. Link to User Message (previousMessageId)
                                            // 2. Update to Real Assistant Message ID (metadata.responseMessageId)
                                            if (m.messageId === targetId) {
                                                const updates: any = {}
                                                if (metadata.messageId) updates.previousMessageId = metadata.messageId
                                                if (metadata.responseMessageId) updates.messageId = metadata.responseMessageId
                                                if (metadata.inputTokens != null) updates.inputTokens = metadata.inputTokens
                                                if (metadata.outputTokens != null) updates.outputTokens = metadata.outputTokens
                                                if (metadata.totalTokens != null) updates.totalTokens = metadata.totalTokens
                                                if (metadata.tokensReadFromCache != null) updates.tokensReadFromCache = metadata.tokensReadFromCache
                                                return { ...m, ...updates }
                                            }
                                            return m
                                        })
                                        return { ...block, responseMessages: msgs }
                                    }
                                    return block
                                })
                            )

                            // Update local reference so subsequent chunks target the new ID
                            if (metadata.responseMessageId) {
                                currentMsgId = metadata.responseMessageId
                            }

                            if (onIdResolved && newConversationId) onIdResolved(newConversationId)

                            headersReceived.current.add(streamKey)
                            // Stopped before the headers: the request stayed
                            // open only for the ids passed on above.
                            if (stopRequested.current.has(streamKey)) turnControllers.get(streamKey)?.abort()
                        },
                        idToUse,
                        handleActivity,
                        turnControllers.get(streamKey)?.signal,
                        attachmentsToUse,
                        handleWebSources,
                        handleGeneratedAttachments,
                        handleAwaitingInput,
                        handleContentReset,
                        handleStopReason,
                        regenerateMessageId,
                        generationIds.current.get(streamKey),
                        aiConfigs.length
                    )
                } catch (err: any) {
                    // Session problems affect every vendor — let the outer
                    // handler deal with logout
                    if (
                        err?.error === 'login_required' ||
                        err?.error === 'consent_required' ||
                        err?.message?.includes('Login required')
                    ) {
                        throw err
                    }
                    if (err?.name === 'AbortError') {
                        // User stopped this vendor — keep whatever streamed, no
                        // error. The stop reason keeps the card on screen even
                        // when nothing streamed yet (stopped while thinking).
                        // stopGenerating already issued the server-side
                        // cancel, keyed by the client-generated generationId so
                        // it works even before response headers arrive.
                        finishVendorMessage(null, STOP_REASON_CANCELLED)
                        return
                    }
                    console.error(`Stream failed for vendor ${conf.aiVendor}`, err)
                    // The server keeps generating after a dropped connection
                    // (backgrounded mobile app). When the server-side response
                    // id is already known (metadata arrived before the drop),
                    // poll for the persisted message instead of failing the turn.
                    // A StreamGenerationError is the server's final word, so nothing
                    // more is coming: it saves a response only when text streamed,
                    // and one look is enough to pick up that copy's usage and sources.
                    const isFinal = err instanceof StreamGenerationError
                    if (currentMsgId !== msgId && (!isFinal || accumulatedText)) {
                        const recovered = await recoverPersistedResponse(
                            token,
                            explicitConversationId || conversationIdRef.current,
                            currentMsgId,
                            isFinal ? 1 : undefined
                        )
                        if (recovered) {
                            setConversationBlockList(prev => prev.map(block => {
                                if (block.conversationBlockId !== id) return block
                                const msgs = block.responseMessages.map(m => {
                                    if (m.messageId !== currentMsgId && m.messageId !== msgId) return m
                                    return {
                                        ...m,
                                        text: recovered.text,
                                        webSources: recovered.webSources ?? m.webSources,
                                        generatedAttachments: recovered.generatedAttachments ?? m.generatedAttachments,
                                        inputTokens: recovered.inputTokens ?? m.inputTokens,
                                        outputTokens: recovered.outputTokens ?? m.outputTokens,
                                        totalTokens: recovered.totalTokens ?? m.totalTokens,
                                        costUsd: recovered.costUsd ?? m.costUsd,
                                    }
                                })
                                return { ...block, responseMessages: msgs }
                            }))
                            // A StreamGenerationError is the server explicitly
                            // saying generation failed (vendor error / dropped
                            // retrieval-server connection) — the recovered text
                            // is whatever was salvaged, not a complete answer,
                            // so still flag it rather than presenting it as a
                            // clean finish. Any other error reaching here (e.g.
                            // a plain dropped connection while the server-side
                            // generation kept running, as with a backgrounded
                            // mobile tab) recovered a real, complete answer —
                            // stay silent.
                            finishVendorMessage(err instanceof StreamGenerationError ? err.message : null)
                            return
                        }
                    }
                    finishVendorMessage(err?.message || i18n.t('errors.ai.generateTextStreamFailed'))
                    return
                }

                const finalConversationId = explicitConversationId || conversationIdRef.current

                if (currentMsgId && finalConversationId) {
                    try {
                        const metrics = await getAIUsageActivity(token, finalConversationId, currentMsgId)
                        if (metrics) {
                            setConversationBlockList(prev => prev.map(block => {
                                if (block.conversationBlockId === id) {
                                    const newMsgs = [...block.responseMessages]
                                    const indexToUpdate = newMsgs.findIndex(m => m.messageId === currentMsgId || m.messageId === msgId)
                                    if (indexToUpdate !== -1) {
                                        newMsgs[indexToUpdate] = {
                                            ...newMsgs[indexToUpdate],
                                            inputTokens: metrics.inputTokens,
                                            outputTokens: metrics.outputTokens,
                                            totalTokens: metrics.totalTokens,
                                            tokensReadFromCache: metrics.tokensReadFromCache ?? 0,
                                            costUsd: metrics.costUsd ?? null
                                        }
                                    }
                                    return { ...block, responseMessages: newMsgs }
                                }
                                return block
                            }))
                        }
                    } catch (e) {
                         console.warn("Failed retrieving AI usage manually after stream", e)
                    }
                }

                // ✅ Mark this specific message stream as finished using reliable Index targeting
                setConversationBlockList(prev =>
                    prev.map(block => {
                        if (block.conversationBlockId === id) {
                            const newMsgs = [...block.responseMessages]
                            const indexToUpdate = newMsgs.findIndex(m => m.messageId === currentMsgId || m.messageId === msgId)
                            if (indexToUpdate !== -1) {
                                newMsgs[indexToUpdate] = { ...newMsgs[indexToUpdate], isLoading: false }
                            }
                            return { ...block, responseMessages: newMsgs }
                        }
                        return block
                    })
                )
            }

            if (currentConversationId) {
                // Scenario A: Parallel execution for existing chat
                await Promise.all(aiConfigs.map((config, index) =>
                    // Pass the index!
                    runStream(config, initialResponseMessages[index].messageId, undefined, undefined, index)
                ))
            } else {
                // Scenario B: Smart Sequential Start for new conversation
                // Try each vendor in turn as the "starter" until one yields a
                // conversation ID — a starter that fails (e.g. bad API key)
                // marks only its own message as errored, and the next vendor
                // takes over so the rest still run.
                const pendingPromises: Promise<any>[] = []
                let starterIndex = 0
                let establishedId: string | null = null

                while (starterIndex < aiConfigs.length && !establishedId) {
                    // Create a promise that resolves when ID is received
                    let resolveId: (id: string) => void = () => { }
                    const idPromise = new Promise<string>(r => { resolveId = r })

                    const starterPromise = runStream(
                        aiConfigs[starterIndex],
                        initialResponseMessages[starterIndex].messageId,
                        resolveId,
                        undefined,
                        starterIndex
                    )

                    // Race: Wait for ID or Stream Completion (in case of error/no-ID)
                    const result = await Promise.race([
                        idPromise.then(id => ({ type: 'id', value: id })),
                        starterPromise.then(() => ({ type: 'done', value: null }))
                    ])
                    pendingPromises.push(starterPromise)

                    if (result.type === 'id' && result.value) {
                        establishedId = result.value
                    } else if (stopRequested.current.has(`${id}-${aiConfigs[starterIndex].aiVendor}`)) {
                        // Stopped before the server answered: the stopped
                        // request may already have opened the conversation, so
                        // another starter would open a second one.
                        break
                    } else {
                        // Stream ended without a conversation ID (it failed
                        // before streaming) — promote the next vendor to starter
                        starterIndex++
                    }
                }

                if (!establishedId) {
                    // Vendors that never launched: the turn was stopped.
                    const unlaunched = new Set(aiConfigs.slice(starterIndex + 1).map(c => c.aiVendor))
                    setConversationBlockList(prev => prev.map(block =>
                        block.conversationBlockId !== id ? block : {
                            ...block,
                            responseMessages: block.responseMessages.map(m =>
                                m.isLoading && unlaunched.has(m.aiVendor) ? markStopped(m) : m),
                        }))
                }

                if (establishedId) {
                    const instruction = customerInstructions.find(i => i.id === selectedInstructionId)
                    // Fire-and-forget title generation
                    createConversationTitle(token, {
                        conversationId: establishedId,
                        prompt: promptToUse,
                        instructionName: instruction?.name
                    }).then(res => {
                        if (res.title) {
                            document.title = res.title
                            setConversationTitle(res.title)
                        }
                    }).catch(err => console.warn("Background title generation failed", err))

                    if (starterIndex + 1 < aiConfigs.length) {
                        // ID established! Launch the rest immediately.
                        const remainingConfigs = aiConfigs.slice(starterIndex + 1)
                        const remainingMsgs = initialResponseMessages.slice(starterIndex + 1)

                        // Small delay to ensure backend stability and initial write settlement
                        await new Promise(r => setTimeout(r, 200))

                        const others = remainingConfigs.map((config, i) =>
                            // Note: index for remaining is offset past the starter
                            runStream(config, remainingMsgs[i].messageId, undefined, establishedId!, starterIndex + 1 + i)
                        )
                        pendingPromises.push(...others)
                    }
                }

                await Promise.all(pendingPromises)
            }


            updateConversationBlock(id, {
                isLoading: false,
                status: 'resolved',
                prompt: promptToUse
            })
            setSelectedResponseForBlock(id, '')

            // Navigate securely after all streams are done to avoid cancellation
            if (conversationIdRef.current && conversationIdRef.current !== id) {
                // Sync state so LandingPage knows we match
                setConversationId(conversationIdRef.current)
                navigate(`/chat/${conversationIdRef.current}`)
            }

        } catch (err: any) {
            if (err.name === 'AbortError') {
                updateConversationBlock(id, {
                    isLoading: false,
                    status: 'resolved',
                })
            } else if (
                err?.error === 'login_required' ||
                err?.error === 'consent_required' ||
                err?.message?.includes('Login required')
            ) {
                // Session expired mid-use. Draft is already persisted to localStorage by the
                // editor (Request.tsx). Reset block state then logout so the Login button appears.
                updateConversationBlock(id, { isLoading: false, status: 'draft' })
                showToast(i18n.t('toasts.auth.sessionExpiredDraftSaved'))
                logout({ returnTo: window.location.origin, localOnly: true })
            } else {
                // Per-vendor failures are handled inside runStream; this only
                // fires for errors outside the streams (e.g. token fetch).
                // Mark still-loading messages as failed with the real reason —
                // never wipe out text that already streamed.
                const reason = err?.message || i18n.t('errors.ai.generateTextStreamFailed')
                setConversationBlockList(prev => prev.map(block => {
                    if (block.conversationBlockId !== id) return block
                    const msgs = block.responseMessages.map(m =>
                        m.isLoading ? { ...m, isLoading: false, error: reason } : m
                    )
                    return { ...block, responseMessages: msgs, isLoading: false, status: 'resolved' as const }
                }))
            }
        } finally {
            aiConfigs.forEach(c => releaseStream(`${id}-${c.aiVendor}`))
        }
    }

    const addNewConversationBlockWithId = useCallback((id: string) => {
        const newConversation: ConversationBlock = {
            conversationBlockId: id,
            prompt: '',
            responseMessages: [],
            isLoading: false,
            status: 'draft',
        }
        setConversationBlockList(prev => [...prev, newConversation])
    }, [])

    // Latest-ref pattern for the two generation entry points: they close
    // over a lot of state (config, prompts, auth) and are only ever invoked
    // from event handlers, so the context exposes stable wrappers that call
    // the closure from the latest render. This keeps them out of the value
    // memo below without risking stale closures.
    const generateResponsesRef = useRef(generateResponses)
    generateResponsesRef.current = generateResponses
    const generateResponsesStreamRef = useRef(generateResponsesStream)
    generateResponsesStreamRef.current = generateResponsesStream

    const generateResponsesStable = useCallback(
        (id: string, overridePrompt?: string, selectedMessageId?: string | null) =>
            generateResponsesRef.current(id, overridePrompt, selectedMessageId),
        []
    )
    const generateResponsesStreamStable = useCallback(
        (id: string, overridePrompt?: string, selectedMessageId?: string | null, vendorToRegenerate?: AIVendor, attachments?: AttachmentRef[]) =>
            generateResponsesStreamRef.current(id, overridePrompt, selectedMessageId, vendorToRegenerate, attachments),
        []
    )

    // Memoized so provider re-renders with unchanged data hand out the same
    // value object and consumers can skip re-rendering. Every non-stable
    // field is a dep; render-time getters (getSelectedResponseForBlock,
    // getVendorSelectionForBlock) are useCallbacks keyed to their state so
    // the value refreshes exactly when their data changes.
    const value = useMemo<IConversationContext>(() => ({
        conversationBlockList,
        conversationId,
        activeBlockId,
        setActiveBlockId,
        systemPrompt,
        setSystemPrompt,
        selectedInstructionId,
        setSelectedInstructionId,
        addNewConversationBlock,
        addNewConversationBlockWithId,
        updateResponseInConversationBlock: updatePromptInConversationBlock,
        generateResponses: generateResponsesStable,
        generateResponsesStream: generateResponsesStreamStable,
        stopGenerating,
        forkConversation,
        selectedResponseByBlock,
        setSelectedResponseForBlock,
        getSelectedResponseForBlock,
        loadConversation,
        resetConversation,
        startConversationInProject,
        clearPendingProject,
        pendingProjectId,
        conversationTitle,
        conversationRole,
        getVendorSelectionForBlock,
        setVendorSelectionForBlock,
    }), [
        conversationBlockList,
        conversationId,
        activeBlockId,
        systemPrompt,
        setSystemPrompt,
        selectedInstructionId,
        setSelectedInstructionId,
        addNewConversationBlock,
        addNewConversationBlockWithId,
        updatePromptInConversationBlock,
        generateResponsesStable,
        generateResponsesStreamStable,
        stopGenerating,
        forkConversation,
        selectedResponseByBlock,
        setSelectedResponseForBlock,
        getSelectedResponseForBlock,
        loadConversation,
        resetConversation,
        startConversationInProject,
        clearPendingProject,
        pendingProjectId,
        conversationTitle,
        conversationRole,
        getVendorSelectionForBlock,
        setVendorSelectionForBlock,
    ])

    const hitlValue = useMemo<RunHitlContextValue>(() => ({
        awaitingInputs,
        submitRunReply,
    }), [awaitingInputs, submitRunReply])

    return (
        <ConversationContext.Provider value={value}>
            <RunHitlContext.Provider value={hitlValue}>
                {children}
            </RunHitlContext.Provider>
        </ConversationContext.Provider>
    )
}

export const ConversationProvider = ({ children }: { children: ReactNode }) => (
    <ConversationUIProvider>
        <ConversationDataProvider>{children}</ConversationDataProvider>
    </ConversationUIProvider>
)

export const useConversation = () => {
    const ctx = useContext(ConversationContext)
    if (!ctx) throw new Error('useConversation must be used within a ConversationProvider')
    return ctx
}

/**
 * Fast-changing UI state (draft prompt, viewport tracking). Subscribe here
 * instead of useConversation when you need these fields — they update on
 * every editor debounce tick / scroll, and this context keeps that churn
 * away from the conversation tree.
 */
export const useConversationUI = () => {
    const ctx = useContext(ConversationUIContext)
    if (!ctx) throw new Error('useConversationUI must be used within a ConversationProvider')
    return ctx
}
