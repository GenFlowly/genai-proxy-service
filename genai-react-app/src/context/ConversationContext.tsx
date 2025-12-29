// src/context/ConversationContext.tsx
import React, { createContext, useContext, useState, ReactNode, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { AIVendor } from '../constants/vendors'
import { useAuth } from './AuthContext'
import { AIConfig, useAI } from './AIContext'
import { useLayout } from './LayoutContext'
import { generateText } from '../services/generateTextService'
import { generateTextStream } from '../services/generateTextStreamService'
import { getConversation } from '../services/conversationService'
import {
    ConversationBlock,
    IConversationContext,
    Message,
} from '../models/conversation.models'

const ConversationContext = createContext<IConversationContext | undefined>(undefined)

export const ConversationProvider = ({ children }: { children: ReactNode }) => {
    const { customerId, getAccessTokenSilently, isAuthenticated } = useAuth()

    const {
        config,
        setSupplementalText,
        // Consumed from AIContext
        systemPrompt,
        setSystemPrompt,
        selectedInstructionId,
        setSelectedInstructionId,
    } = useAI()
    const { setLeftSidebarExpanded, setRightSidebarExpanded } = useLayout()
    const navigate = useNavigate()

    // State previously handled here is now in AIContext

    // State previously handled here is now in AIContext

    // ✅ Conversation Identity (Owned by ConversationContext)
    const [conversationId, setConversationId] = useState<string>('')
    const [activeBlockId, setActiveBlockId] = useState<string>('')

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
        },
    ])

    const [selectedResponseByBlock, setSelectedResponseByBlock] = useState<Record<string, string | null>>({})

    const getSelectedResponseForBlock = useCallback((blockId: string) => {
        return selectedResponseByBlock[blockId] ?? null
    }, [selectedResponseByBlock])

    // Editor State
    const [editorPrompt, setEditorPromptInternal] = useState<string>('') // Active text being edited

    const setEditorPrompt = useCallback((prompt: string) => {
        // console.log('[ConversationContext] setEditorPrompt:', prompt.length)
        setEditorPromptInternal(prompt)
    }, [])

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

    const updateConversationBlock = (conversationBlockId: string, updater: Partial<ConversationBlock>) => {
        // console.log('DEBUG updateConversationBlock', conversationBlockId, updater)
        setConversationBlockList(prev =>
            prev.map(block =>
                block.conversationBlockId === conversationBlockId
                    ? { ...block, ...updater }
                    : block
            )
        )
    }

    const setSelectedResponseForBlock = (blockId: string, responseId: string) => {
        setSelectedResponseByBlock(prev => ({ ...prev, [blockId]: responseId }))
    }

    // --- API Calls ---
    const fetchVendorResponses = async (
        token: string,
        aiConfigs: AIConfig[],
        prompt: string,
        selectedResponseId: string | null,
        currentSystemPrompt: string
    ): Promise<Message[]> => {
        const response = await generateText(token, {
            aiConfig: aiConfigs.filter(c => c.aiVendor && c.model),
            prompt: {
                systemPrompt: currentSystemPrompt || "You are a helpful assistant",
                prompt,
            },
            // customerId: customerId!,
            selectedResponseId: selectedResponseId ?? '',
            conversationId: conversationIdRef.current,
            client: 'REACT_APP',
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
            text: r.text ?? '',
            messageId: r.messageId ?? '',
        }))
    }

    const fetchVendorResponseStream = async (
        token: string,
        aiConfig: AIConfig,
        prompt: string,
        selectedResponseId: string | null,
        currentSystemPrompt: string,
        onDelta: (chunk: string) => void,
        onConversationId?: (id: string) => void
    ): Promise<void> => {
        await generateTextStream(token, {
            aiConfig: aiConfig,
            prompt: {
                systemPrompt: currentSystemPrompt || "You are a helpful assistant",
                prompt,
            },
            selectedResponseId: selectedResponseId ?? '',
            conversationId: conversationIdRef.current,
            client: 'REACT_APP',
        }, onDelta, onConversationId)
    }

    const loadConversation = useCallback(async (id: string) => {
        if (!isAuthenticated || !customerId) return

        try {
            const token = await getAccessTokenSilently()
            const data = await getConversation(token, id)

            if (data && data.blocks) {
                setConversationId(data.conversationId)
                setConversationBlockList(data.blocks)
                // If system prompt is stored, set it too
            }
        } catch (err) {
            console.error("Failed to load conversation", err)
            // Handle error (maybe redirect to new chat?)
        }
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    const resetConversation = useCallback(() => {
        navigate('/chat')
        if (customerId) {
            // Clear all prompt editor content for this user from localStorage
            Object.keys(localStorage).forEach(key => {
                if (key.startsWith(`${customerId}_prompt_editor_content_`)) {
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
            },
        ])
        setSelectedResponseByBlock({})
    }, [navigate, customerId])

    // --- Core Actions ---
    const addNewConversationBlock = () => {
        const newConversation: ConversationBlock = {
            conversationBlockId: `conv-${Date.now()}`,
            prompt: '',
            responseMessages: [],
            isLoading: false,
        }
        setConversationBlockList(prev => [...prev, newConversation])
    }

    const updatePromptInConversationBlock = (conversationBlockId: string, prompt: string) => {
        updateConversationBlock(conversationBlockId, { prompt })
    }

    const validateAndPrepareGeneration = (id: string, overridePrompt?: string, selectedMessageId?: string | null) => {
        const conversationBlock = conversationBlockList.find(c => c.conversationBlockId === id)
        if (!conversationBlock) return null
        if (!isAuthenticated || !customerId) {
            alert('Please log in first.')
            return null
        }

        const aiConfigs = config
        if (aiConfigs.length === 0) {
            alert('Select at least one vendor and model.')
            return null
        }

        const contextSelectedId = getSelectedResponseForBlock(id)
        const finalSelectedResponseId = selectedMessageId !== undefined ? selectedMessageId : contextSelectedId
        const promptToUse = overridePrompt ?? conversationBlock.prompt

        return { conversationBlock, aiConfigs, finalSelectedResponseId, promptToUse }
    }

    const generateResponses = async (id: string, overridePrompt?: string, selectedMessageId?: string | null) => {
        const prep = validateAndPrepareGeneration(id, overridePrompt, selectedMessageId)
        if (!prep) return

        const { aiConfigs, finalSelectedResponseId, promptToUse } = prep

        updateConversationBlock(id, { isLoading: true, responseMessages: [] })

        try {
            const token = await getAccessTokenSilently()

            console.log('DEBUG generateResponses', {
                id,
                explicitId: selectedMessageId,
                finalId: finalSelectedResponseId
            })

            const responses = await fetchVendorResponses(
                token,
                aiConfigs,
                promptToUse,
                finalSelectedResponseId,
                systemPrompt
            )

            console.log('DEBUG responses array:', responses)

            updateConversationBlock(id, {
                responseMessages: responses,
                isLoading: false,
                // Commit the prompt to context only on success
                prompt: promptToUse
            })
            setSelectedResponseForBlock(id, '')
            setLeftSidebarExpanded(false)
            setRightSidebarExpanded(false)
        } catch (err) {
            console.error(err)
            updateConversationBlock(id, {
                responseMessages: [
                    {
                        aiVendor: AIVendor.OPENAI,
                        text: 'Error generating text.',
                        messageId: 'error',
                    },
                ],
                isLoading: false,
            })
        }
    }

    const generateResponsesStream = async (id: string, overridePrompt?: string, selectedMessageId?: string | null) => {
        const prep = validateAndPrepareGeneration(id, overridePrompt, selectedMessageId)
        if (!prep) return

        const { aiConfigs, finalSelectedResponseId, promptToUse } = prep

        // Initialize placeholders for all selected vendors
        const timestamp = Date.now()
        const initialResponseMessages: Message[] = aiConfigs.map((config, index) => ({
            aiVendor: config.aiVendor,
            text: '',
            messageId: `resp-${timestamp}-${index}`,
            isLoading: true
        }))

        updateConversationBlock(id, {
            isLoading: true,
            prompt: promptToUse,
            responseMessages: initialResponseMessages
        })

        try {
            const token = await getAccessTokenSilently()

            const currentConversationId = conversationIdRef.current
            // Helper to perform the fetch for a specific config
            const runStream = async (conf: AIConfig, msgId: string, onIdResolved?: (id: string) => void) => {
                let accumulatedText = ""
                await fetchVendorResponseStream(
                    token,
                    conf,
                    promptToUse,
                    finalSelectedResponseId,
                    systemPrompt,
                    (chunk) => {
                        accumulatedText += chunk
                        setConversationBlockList(prev =>
                            prev.map(block => {
                                if (block.conversationBlockId === id) {
                                    const msgs = block.responseMessages.map(m =>
                                        m.messageId === msgId ? { ...m, text: accumulatedText } : m
                                    )
                                    return { ...block, responseMessages: msgs }
                                }
                                return block
                            })
                        )
                    },
                    (newConversationId) => {
                        if (newConversationId && newConversationId !== conversationIdRef.current) {
                            setConversationId(newConversationId)
                            conversationIdRef.current = newConversationId
                            console.log('SET Conversation ID Stream', newConversationId)
                            navigate(`/chat/${newConversationId}`)
                        }
                        if (onIdResolved) onIdResolved(newConversationId)
                    }
                )
            }

            if (currentConversationId) {
                // Scenario A: Parallel execution for existing chat
                await Promise.all(aiConfigs.map((config, index) =>
                    runStream(config, initialResponseMessages[index].messageId)
                ))
            } else {
                // Scenario B: Smart Sequential Start for new conversation
                const firstConfig = aiConfigs[0]
                const firstMsgId = initialResponseMessages[0].messageId

                // Create a promise that resolves when ID is received
                let resolveId: (id: string) => void = () => { }
                const idPromise = new Promise<string>(r => { resolveId = r })

                // Start first stream
                const firstStreamPromise = runStream(firstConfig, firstMsgId, resolveId)

                // Race: Wait for ID or First Stream Completion (in case of error/no-ID)
                const result = await Promise.race([
                    idPromise.then(id => ({ type: 'id', value: id })),
                    firstStreamPromise.then(() => ({ type: 'done', value: null }))
                ])

                const pendingPromises: Promise<any>[] = [firstStreamPromise]

                if (result.type === 'id' && result.value && aiConfigs.length > 1) {
                    // ID established! Launch the rest immediately.
                    const remainingConfigs = aiConfigs.slice(1)
                    const remainingMsgs = initialResponseMessages.slice(1)
                    const others = remainingConfigs.map((config, index) =>
                        runStream(config, remainingMsgs[index].messageId)
                    )
                    pendingPromises.push(...others)
                }

                await Promise.all(pendingPromises)
            }

            updateConversationBlock(id, {
                isLoading: false,
                prompt: promptToUse
            })
            setSelectedResponseForBlock(id, '')
            setLeftSidebarExpanded(false)
            setRightSidebarExpanded(false)


        } catch (err) {
            console.error(err)
            updateConversationBlock(id, {
                responseMessages: [
                    {
                        aiVendor: AIVendor.OPENAI,
                        text: 'Error generating text stream.',
                        messageId: 'error',
                    },
                ],
                isLoading: false,
            })
        }
    }

    const addNewConversationBlockWithId = (id: string) => {
        const newConversation: ConversationBlock = {
            conversationBlockId: id,
            prompt: '',
            responseMessages: [],
            isLoading: false,
        }
        setConversationBlockList(prev => [...prev, newConversation])
    }

    return (
        <ConversationContext.Provider
            value={{
                conversationBlockList,
                conversationId,
                activeBlockId,
                setActiveBlockId,
                // Pass-through from AIContext
                systemPrompt,
                setSystemPrompt,
                selectedInstructionId,
                setSelectedInstructionId,
                addNewConversationBlock,
                addNewConversationBlockWithId,
                updateResponseInConversationBlock: updatePromptInConversationBlock,
                generateResponses,
                generateResponsesStream,
                selectedResponseByBlock,
                setSelectedResponseForBlock,
                getSelectedResponseForBlock,
                loadConversation, // Expose this
                resetConversation,
                editorPrompt,
                setEditorPrompt,

            }}
        >
            {children}
        </ConversationContext.Provider>
    )
}

export const useConversation = () => {
    const ctx = useContext(ConversationContext)
    if (!ctx) throw new Error('useConversation must be used within a ConversationProvider')
    return ctx
}
