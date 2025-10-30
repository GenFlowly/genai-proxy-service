// ConversationContext.tsx
import React, { createContext, useContext, useState, ReactNode, useRef } from 'react'
import { AIVendor } from '../constants/vendors'
import { useAuth } from './AuthContext'
import { useAI } from './AIContext'
import { generateText } from '../services/textGenService'
import { useLayout } from './LayoutContext'
import {batchGenerateText} from "../services/batchTextGenService";

interface ResponseType {
    vendor: AIVendor
    text: string
}

interface ConversationBlock {
    id: string
    markdown: string
    responses: ResponseType[]
    isLoading: boolean
}

interface ConversationContextType {
    conversations: ConversationBlock[]
    addConversation: () => void
    updateMarkdown: (id: string, value: string) => void
    generateResponses: (id: string) => Promise<void>
}

const ConversationContext = createContext<ConversationContextType | undefined>(undefined)

export const ConversationProvider = ({ children }: { children: ReactNode }) => {
    const { customerId, getAccessTokenSilently, isAuthenticated } = useAuth()
    const { config } = useAI()
    const { setLeftVisible, setRightVisible } = useLayout()
    const [conversations, setConversations] = useState<ConversationBlock[]>([
        { id: 'conv-1', markdown: '', responses: [], isLoading: false },
    ])

    // 🟢 Add new conversation
    const addConversation = () => {
        setConversations(prev => [
            ...prev,
            { id: `conv-${Date.now()}`, markdown: '', responses: [], isLoading: false },
        ])
    }

    // 🟡 Update markdown for a specific block
    const updateMarkdown = (id: string, value: string) => {
        setConversations(prev =>
            prev.map(block =>
                block.id === id ? { ...block, markdown: value } : block
            )
        )
    }

    // 🔵 Generate responses for a specific block
    const generateResponses = async (id: string) => {
        const block = conversations.find(c => c.id === id)
        if (!block || !isAuthenticated || !customerId) return alert("Please log in first.")

        const activeVendors = Object.entries(config.vendorSelections).filter(([_, model]) => model)
        if (activeVendors.length === 0) return alert("Select at least one vendor and model.")

        setConversations(prev =>
            prev.map(c => (c.id === id ? { ...c, isLoading: true, responses: [] } : c))
        )

        try {
            const token = await getAccessTokenSilently()

            // 🟡 If only one vendor -> single API call
            if (activeVendors.length === 1) {
                const [vendor, model] = activeVendors[0]
                const res = await generateText(token, {
                    vendor: vendor as AIVendor,
                    model,
                    prompt: block.markdown,
                    customerId,
                })
                setConversations(prev =>
                    prev.map(c =>
                        c.id === id
                            ? {
                                ...c,
                                responses: [{ vendor: vendor as AIVendor, text: res.text ?? "" }],
                                isLoading: false,
                            }
                            : c
                    )
                )
            } else {
                // 🟢 Multiple vendors → batch call
                const batchRequest = {
                    requests: activeVendors.map(([vendor, model]) => ({
                        vendor,
                        model,
                        prompt: block.markdown,
                        customerId,
                    })),
                }

                const batchResponse = await batchGenerateText(token, batchRequest)
                const results = batchResponse.results.map(r => ({
                    vendor: r.vendor as AIVendor,
                    text: r.text ?? "",
                }))

                setConversations(prev =>
                    prev.map(c =>
                        c.id === id ? { ...c, responses: results, isLoading: false } : c
                    )
                )
            }

            // toggle layout visibility
            setLeftVisible(false)
            setRightVisible(false)
        } catch (err) {
            console.error(err)
            setConversations(prev =>
                prev.map(c =>
                    c.id === id
                        ? {
                            ...c,
                            responses: [{ vendor: AIVendor.OPENAI, text: "Error generating text." }],
                            isLoading: false,
                        }
                        : c
                )
            )
        }
    }


    return (
        <ConversationContext.Provider
            value={{ conversations, addConversation, updateMarkdown, generateResponses }}
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
