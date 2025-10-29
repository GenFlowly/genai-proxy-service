import React, { createContext, useContext, useState, ReactNode } from 'react'
import { AIVendor } from '../constants/vendors'
import { useAuth } from './AuthContext'
import { useAI } from './AIContext'
import { generateText } from '../services/textGenService'
import { useLayout } from './LayoutContext'

interface ConversationContextType {
    markdown: string
    setMarkdown: (value: string) => void
    responses: { vendor: AIVendor; text: string }[]
    isLoading: boolean
    generateResponses: () => Promise<void>
    clearResponses: () => void
}

const ConversationContext = createContext<ConversationContextType | undefined>(undefined)

export const ConversationProvider = ({ children }: { children: ReactNode }) => {
    const { customerId, getAccessTokenSilently, isAuthenticated } = useAuth()
    const { config } = useAI()
    const { setLeftVisible, setRightVisible } = useLayout() // 🟦 Import layout controls

    const [markdown, setMarkdown] = useState('What is the capital of France?')
    const [responses, setResponses] = useState<{ vendor: AIVendor; text: string }[]>([])
    const [isLoading, setIsLoading] = useState(false)

    // 🟩 Generate AI responses
    const generateResponses = async () => {
        if (!isAuthenticated || !customerId) {
            alert('Please log in first.')
            return
        }

        const activeVendors = Object.entries(config.vendorSelections).filter(([_, model]) => model)
        if (activeVendors.length === 0) {
            alert('Please select at least one vendor and model.')
            return
        }

        setIsLoading(true)
        setResponses([])

        try {
            const token = await getAccessTokenSilently()
            const results: { vendor: AIVendor; text: string }[] = []

            for (const [vendor, model] of activeVendors) {
                const res = await generateText(token, {
                    vendor: vendor as AIVendor,
                    model,
                    prompt: markdown,
                    customerId,
                })
                results.push({ vendor: vendor as AIVendor, text: res.text ?? '' })
            }

            setResponses(results)

            // ✅ Once responses arrive, toggle sidebars appropriately
            if (results.length > 0) {
                setLeftVisible(false)
                setRightVisible(false)
            }

        } catch (error) {
            console.error('❌ Error generating text:', error)
            setResponses([{ vendor: AIVendor.OPENAI, text: 'Error generating text. Check console.' }])
        } finally {
            setIsLoading(false)
        }
    }

    const clearResponses = () => {
        setResponses([])
        // Optionally hide right sidebar again when clearing
        setRightVisible(false)
    }

    return (
        <ConversationContext.Provider
            value={{
                markdown,
                setMarkdown,
                responses,
                isLoading,
                generateResponses,
                clearResponses,
            }}
        >
            {children}
        </ConversationContext.Provider>
    )
}

export const useConversation = (): ConversationContextType => {
    const ctx = useContext(ConversationContext)
    if (!ctx) throw new Error('useConversation must be used within a ConversationProvider')
    return ctx
}
