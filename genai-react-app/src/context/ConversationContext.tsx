import React, { createContext, useContext, useState, ReactNode } from 'react'
import { AIVendor } from '../constants/vendors'
import { useAuth } from './AuthContext'
import { useAI } from './AIContext'
import { useLayout } from './LayoutContext'
import { generateText } from '../services/generateTextService'
import { batchGenerateText } from '../services/batchGenerateTextService'
import {
    ConversationBlock,
    ConversationContextType,
    ResponseType,
} from '../models/conversation.models'

/* ---------- Context ---------- */

const ConversationContext = createContext<ConversationContextType | undefined>(undefined)

/* ---------- Provider ---------- */

export const ConversationProvider = ({ children }: { children: ReactNode }) => {
    const { customerId, getAccessTokenSilently, isAuthenticated } = useAuth()
    const { config } = useAI()
    const { setLeftSidebarExpanded, setRightSidebarExpanded } = useLayout()

    const [conversationBlockList, setConversationBlockList] = useState<ConversationBlock[]>([
        { id: `conv-${Date.now()}`, markdown: '', responses: [], isLoading: false },
    ])

    /* ---------- Helpers ---------- */

    const updateConversationBlock = (id: string, updater: Partial<ConversationBlock>) => {
        setConversationBlockList(prev =>
            prev.map(block => (block.id === id ? { ...block, ...updater } : block))
        )
    }

    /* ---------- Private API Methods ---------- */

    const fetchSingleVendorResponse = async (
        token: string,
        vendor: string,
        model: string,
        prompt: string
    ): Promise<ResponseType[]> => {
        const res = await generateText(token, {
            vendor: vendor as AIVendor,
            model,
            prompt: prompt,
            customerId: customerId!,
        })

        return [{ vendor: vendor as AIVendor, text: res.text ?? '' }]
    }

    const fetchBatchVendorResponses = async (
        token: string,
        activeVendors: [string, string][],
        prompt: string
    ): Promise<ResponseType[]> => {
        const batchRequest = {
            requests: activeVendors.map(([vendor, model]) => ({
                vendor,
                model,
                prompt: prompt,
                customerId: customerId!,
            })),
        }


        const batchResponse = await batchGenerateText(token, batchRequest)

        return batchResponse.results.map(r => ({
            vendor: r.vendor as AIVendor,
            text: r.text ?? '',
        }))
    }

    /* ---------- Actions ---------- */

    const addNewConversationBlock = () => {
        const newConversation: ConversationBlock = {
            id: `conv-${Date.now()}`,
            markdown: '',
            responses: [],
            isLoading: false,
        }
        setConversationBlockList(prev => [...prev, newConversation])
    }

    const updateResponseInConversationBlock = (id: string, value: string) => {
        updateConversationBlock(id, { markdown: value })
    }

    const generateResponses = async (id: string) => {
        const conversationBlock = conversationBlockList.find(c => c.id === id)
        if (!conversationBlock) return
        if (!isAuthenticated || !customerId) return alert('Please log in first.')

        const activeVendors = Object.entries(config.vendorSelections).filter(([_, model]) => model)
        if (activeVendors.length === 0) return alert('Select at least one vendor and model.')

        updateConversationBlock(id, { isLoading: true, responses: [] })

        try {
            const token = await getAccessTokenSilently()
            let responses: ResponseType[] = []

            if (activeVendors.length === 1) {
                const [vendor, model] = activeVendors[0]
                responses = await fetchSingleVendorResponse(token, vendor, model, conversationBlock.markdown)
            } else {
                responses = await fetchBatchVendorResponses(token, activeVendors, conversationBlock.markdown)
            }

            updateConversationBlock(id, { responses, isLoading: false })

            // Hide sidebars after generating
            setLeftSidebarExpanded(false)
            setRightSidebarExpanded(false)
        } catch (err) {
            console.error(err)
            updateConversationBlock(id, {
                responses: [{ vendor: AIVendor.OPENAI, text: 'Error generating text.' }],
                isLoading: false,
            })
        }
    }

    /* ---------- Render ---------- */

    return (
        <ConversationContext.Provider
            value={{
                conversationBlockList,
                addNewConversationBlock,
                updateResponseInConversationBlock,
                generateResponses,
            }}
        >
            {children}
        </ConversationContext.Provider>
    )
}

/* ---------- Hook ---------- */

export const useConversation = () => {
    const ctx = useContext(ConversationContext)
    if (!ctx) throw new Error('useConversation must be used within a ConversationProvider')
    return ctx
}
