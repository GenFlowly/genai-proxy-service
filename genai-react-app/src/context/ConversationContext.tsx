// src/context/ConversationContext.tsx
import React, { createContext, useContext, useState, ReactNode, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { AIVendor } from '../constants/vendors'
import { useAuth } from './AuthContext'
import { AIConfig, useAI } from './AIContext'
import { useLayout } from './LayoutContext'
import { generateText } from '../services/generateTextService'
import { getConversation } from '../services/conversationService'
import {
    ConversationBlock,
    ConversationContextType,
    Message,
} from '../models/conversation.models'

const ConversationContext = createContext<ConversationContextType | undefined>(undefined)

export const ConversationProvider = ({ children }: { children: ReactNode }) => {
    const { customerId, getAccessTokenSilently, isAuthenticated } = useAuth()
    const { config, activeBlockId, setSupplementalText } = useAI() // now an array of AIConfig[]
    const { setLeftSidebarExpanded, setRightSidebarExpanded } = useLayout()
    const navigate = useNavigate()

    const [conversationId, setConversationId] = useState<string>('')
    const [systemPrompt, setSystemPrompt] = useState<string>('')
    const [isSystemPromptLoaded, setIsSystemPromptLoaded] = useState<boolean>(false)

    useEffect(() => {
        if (customerId) {
            const saved = localStorage.getItem(`${customerId}_system_prompt`)
            setSystemPrompt(saved || '')
            setIsSystemPromptLoaded(true)
        } else {
            setIsSystemPromptLoaded(false)
        }
    }, [customerId])

    useEffect(() => {
        if (customerId && isSystemPromptLoaded) {
            const key = `${customerId}_system_prompt`
            if (systemPrompt.trim()) {
                localStorage.setItem(key, systemPrompt)
            } else {
                localStorage.removeItem(key)
            }
        }
    }, [systemPrompt, customerId, isSystemPromptLoaded])

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

    // Sync Supplemental Text (Last Response) for Token Counting
    useEffect(() => {
        if (!activeBlockId) {
            setSupplementalText('')
            return
        }

        const index = conversationBlockList.findIndex(b => b.conversationBlockId === activeBlockId)
        if (index <= 0) {
            // No previous block
            setSupplementalText('')
            return
        }

        const prevBlock = conversationBlockList[index - 1]
        if (!prevBlock || prevBlock.responseMessages.length === 0) {
            setSupplementalText('')
            return
        }

        const selectedId = getSelectedResponseForBlock(prevBlock.conversationBlockId)
        const selectedMsg = prevBlock.responseMessages.find(m => m.messageId === selectedId)
        // Fallback to first message if selection invalid or not set
        const finalMsg = selectedMsg || prevBlock.responseMessages[0]

        setSupplementalText(finalMsg?.text || '')
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

    const loadConversation = async (id: string) => {
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
    }

    const resetConversation = () => {
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
    }

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

    const generateResponses = async (id: string, overridePrompt?: string, selectedMessageId?: string | null) => {
        const conversationBlock = conversationBlockList.find(c => c.conversationBlockId === id)
        if (!conversationBlock) return
        if (!isAuthenticated || !customerId) return alert('Please log in first.')

        const aiConfigs = config
        if (aiConfigs.length === 0) return alert('Select at least one vendor and model.')

        updateConversationBlock(id, { isLoading: true, responseMessages: [] })

        try {
            const token = await getAccessTokenSilently()
            // Prefer explicit ID, fallback to context state
            const contextSelectedId = getSelectedResponseForBlock(id)
            const finalSelectedResponseId = selectedMessageId !== undefined ? selectedMessageId : contextSelectedId

            console.log('DEBUG generateResponses', {
                id,
                explicitId: selectedMessageId,
                contextId: contextSelectedId,
                finalId: finalSelectedResponseId
            })

            // Use overridePrompt if provided, otherwise fall back to block.prompt (compatibility)
            const promptToUse = overridePrompt ?? conversationBlock.prompt

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
                systemPrompt,
                setSystemPrompt,
                addNewConversationBlock,
                addNewConversationBlockWithId,
                updateResponseInConversationBlock: updatePromptInConversationBlock,
                generateResponses,
                selectedResponseByBlock,
                setSelectedResponseForBlock,
                getSelectedResponseForBlock,
                loadConversation, // Expose this
                resetConversation,
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
