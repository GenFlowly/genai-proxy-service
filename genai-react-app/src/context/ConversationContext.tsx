// src/context/ConversationContext.tsx
import React, { createContext, useContext, useState, ReactNode, useRef, useEffect } from 'react'
import { AIVendor } from '../constants/vendors'
import { useAuth } from './AuthContext'
import { AIConfig, useAI } from './AIContext'
import { useLayout } from './LayoutContext'
import { generateText } from '../services/generateTextService'
import {
    ConversationBlock,
    ConversationContextType,
    Message,
} from '../models/conversation.models'

const ConversationContext = createContext<ConversationContextType | undefined>(undefined)

export const ConversationProvider = ({ children }: { children: ReactNode }) => {
    const { customerId, getAccessTokenSilently, isAuthenticated } = useAuth()
    const { config } = useAI() // now an array of AIConfig[]
    const { setLeftSidebarExpanded, setRightSidebarExpanded } = useLayout()

    const [conversationId, setConversationId] = useState<string>('')

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

    const updateConversationBlock = (conversationBlockId: string, updater: Partial<ConversationBlock>) => {
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

    const getSelectedResponseForBlock = (blockId: string) => {
        return selectedResponseByBlock[blockId] ?? null
    }

    // --- API Calls ---
    const fetchVendorResponses = async (
        token: string,
        aiConfigs: AIConfig[],
        prompt: string,
        selectedResponseId: string | null
    ): Promise<Message[]> => {
        const response = await generateText(token, {
            aiConfig: aiConfigs.filter(c => c.aiVendor && c.model),
            prompt,
            // customerId: customerId!,
            selectedResponseId: selectedResponseId ?? '',
            conversationId: conversationIdRef.current,
            client: 'REACT_APP',
        })

        // ✅ Extract conversationId from the first result if missing at root
        const newConversationId =
            response.conversationId ??
            response.results?.[0]?.conversationId ??
            ''

        if (newConversationId && newConversationId !== conversationIdRef.current) {
            setConversationId(newConversationId)
            conversationIdRef.current = newConversationId
            console.log('SET Conversation ID', newConversationId)
        }

        console.log('DEBUG response:', response)

        return (
            response.results?.map((r: any) => ({
                aiVendor: r.aiVendor as AIVendor,
                text: r.text ?? '',
                messageId: r.messageId ?? '',
            })) ?? []
        )
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

    const generateResponses = async (id: string) => {
        const conversationBlock = conversationBlockList.find(c => c.conversationBlockId === id)
        if (!conversationBlock) return
        if (!isAuthenticated || !customerId) return alert('Please log in first.')

        const aiConfigs = config
        if (aiConfigs.length === 0) return alert('Select at least one vendor and model.')

        updateConversationBlock(id, { isLoading: true, responseMessages: [] })

        try {
            const token = await getAccessTokenSilently()
            const selectedResponseId = getSelectedResponseForBlock(id)
            console.log('DEBUG selectedResponseId for block', id, selectedResponseId)

            const responses = await fetchVendorResponses(
                token,
                aiConfigs,
                conversationBlock.prompt,
                selectedResponseId
            )

            updateConversationBlock(id, { responseMessages: responses, isLoading: false })
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
                addNewConversationBlock,
                addNewConversationBlockWithId,
                updateResponseInConversationBlock: updatePromptInConversationBlock,
                generateResponses,
                selectedResponseByBlock,
                setSelectedResponseForBlock,
                getSelectedResponseForBlock,
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
