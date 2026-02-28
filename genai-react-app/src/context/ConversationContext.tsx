// src/context/ConversationContext.tsx
import React, { createContext, useContext, useState, ReactNode, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { AIVendor } from '../constants/vendors'
import { useAuth } from './AuthContext'
import { AIConfig, useAI } from './AIContext'
import { useLayout } from './LayoutContext'
import { useToast } from './ToastContext'
import { generateText } from '../services/generateTextService'
import { generateTextStream, StreamMetadata } from '../services/generateTextStreamService'
import { getConversation } from '../services/conversationService'
import {
    ConversationBlock,
    IConversationContext,
    Message,
} from '../models/conversation.models'

const ConversationContext = createContext<IConversationContext | undefined>(undefined)

export const ConversationProvider = ({ children }: { children: ReactNode }) => {
    const { customerId, getAccessTokenSilently, isAuthenticated } = useAuth()
    const { showToast } = useToast()

    const {
        config,
        setSupplementalText,
        systemPrompt,
        setSystemPrompt,
        selectedInstructionId,
        setSelectedInstructionId,
        customerInstructions,
    } = useAI()
    const { setLeftSidebarExpanded, setRightSidebarExpanded } = useLayout()
    const navigate = useNavigate()


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
        instructionId: string,
        instructionVersion: string
    ): Promise<Message[]> => {
        const response = await generateText(token, {
            aiConfig: aiConfigs.filter(c => c.aiVendor && c.model),
            prompt: {
                instructionId,
                instructionVersion,
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
        instructionId: string,
        instructionVersion: string,
        onDelta: (chunk: string) => void,
        onMetadata?: (metadata: StreamMetadata) => void,
        // Added idOverride to support explicit conversation targeting (parallel streams)
        idOverride?: string
    ): Promise<void> => {
        await generateTextStream(token, {
            aiConfig: aiConfig,
            prompt: {
                instructionId,
                instructionVersion,
                prompt,
            },
            selectedResponseId: selectedResponseId ?? '',
            conversationId: idOverride || conversationIdRef.current,
            client: 'REACT_APP',
        }, onDelta, onMetadata)
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
            showToast('Please log in first.')
            return null
        }

        const aiConfigs = config.filter(c => c.aiVendor && c.model && c.model.trim() !== '')
        if (aiConfigs.length === 0) {
            showToast('Select at least one vendor and model.')
            return null
        }

        const index = conversationBlockList.findIndex(c => c.conversationBlockId === id)
        let parentResponseId = ''

        // Should use the selected response from the PREVIOUS block as the parent
        if (index > 0) {
            const prevBlock = conversationBlockList[index - 1]
            const prevSelectedId = getSelectedResponseForBlock(prevBlock.conversationBlockId)

            // If explicit selection exists, use it. Otherwise default to first response.
            if (prevSelectedId) {
                parentResponseId = prevSelectedId
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

        updateConversationBlock(id, { isLoading: true, responseMessages: [] })

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
                instructionVersion
            )

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
            const runStream = async (conf: AIConfig, msgId: string, onIdResolved?: (id: string) => void, explicitConversationId?: string, index: number = 0) => {
                let accumulatedText = ""
                // Track the active message ID (starts as placeholder, updates to real backend ID)
                let currentMsgId = msgId

                // Use explicit ID if provided (for parallel launches), otherwise ref (for first launch)
                const idToUse = explicitConversationId || conversationIdRef.current

                const instruction = customerInstructions.find(i => i.id === selectedInstructionId)
                const instructionVersion = instruction ? instruction.version.toString() : ""
                const instructionId = selectedInstructionId || ""

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
                    },
                    idToUse
                )

                // ✅ Mark this specific message stream as finished using reliable Index targeting
                setConversationBlockList(prev =>
                    prev.map(block => {
                        if (block.conversationBlockId === id) {
                            const newMsgs = [...block.responseMessages]
                            if (newMsgs[index]) {
                                newMsgs[index] = { ...newMsgs[index], isLoading: false }
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
                const firstConfig = aiConfigs[0]
                const firstMsgId = initialResponseMessages[0].messageId

                // Create a promise that resolves when ID is received
                let resolveId: (id: string) => void = () => { }
                const idPromise = new Promise<string>(r => { resolveId = r })

                // Start first stream
                const firstStreamPromise = runStream(firstConfig, firstMsgId, resolveId, undefined, 0)

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

                    // Small delay to ensure backend stability and initial write settlement
                    await new Promise(r => setTimeout(r, 200))

                    const others = remainingConfigs.map((config, i) =>
                        // Note: index for remaining is i + 1
                        runStream(config, remainingMsgs[i].messageId, undefined, result.value, i + 1)
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

            // Navigate securely after all streams are done to avoid cancellation
            if (conversationIdRef.current && conversationIdRef.current !== id) {
                // Sync state so LandingPage knows we match
                setConversationId(conversationIdRef.current)
                navigate(`/chat/${conversationIdRef.current}`)
            }


        } catch (err) {
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
