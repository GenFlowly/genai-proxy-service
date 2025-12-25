import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { AIVendor } from '../constants/vendors'
import { countTokens } from '../utils/tokenizer'

export interface AIConfig {
    aiVendor: AIVendor
    model: string
}

interface AIContextType {
    config: AIConfig[]
    activeText: string
    tokenCount: number
    isTokenLoading: boolean
    setPrompt: (prompt: string) => void
    setSelectedModelForAIVendor: (aiVendor: AIVendor, model: string) => void
    getOpenAIActiveModel: () => string
    resetConfig: () => void
    activeBlockId: string
    setActiveBlockId: (id: string) => void
    supplementalText: string
    setSupplementalText: (text: string) => void
}

const AIContext = createContext<AIContextType | undefined>(undefined)

export const AIProvider = ({ children }: { children: ReactNode }) => {
    // 🔹 Initialize state (empty by default, to be filled by backend)
    const [config, setConfig] = useState<AIConfig[]>([])
    const [prompt, setPrompt] = useState<string>('')
    const [tokenCount, setTokenCount] = useState<number>(0)
    const [isTokenLoading, setIsTokenLoading] = useState(false)
    const [activeBlockId, setActiveBlockId] = useState<string>('')
    const [supplementalText, setSupplementalText] = useState<string>('')

    // 🔹 Always return OPENAI model (gracefully handles missing)
    const getOpenAIActiveModel = React.useCallback((): string => {
        const openaiConfig = config.find(
            c => c.aiVendor === AIVendor.OPENAI && !!c.model?.trim()
        )

        if (!openaiConfig) {
            // Don't throw — just return empty
            return ''
        }

        return openaiConfig.model
    }, [config])

    // 🔹 Token count auto-update (debounced, safe for missing model)
    useEffect(() => {
        const fullText = (prompt || '') + (supplementalText || '')
        if (!fullText.trim()) {
            setTokenCount(0)
            return
        }

        const timeout = setTimeout(async () => {
            const model = getOpenAIActiveModel()
            if (!model) {
                // Graceful fallback — no model selected yet
                setTokenCount(0)
                return
            }

            setIsTokenLoading(true)
            try {
                const count = await countTokens(fullText, model)
                setTokenCount(count)
            } catch (err) {
                console.error('Token counting failed:', err)
                setTokenCount(0)
            } finally {
                setIsTokenLoading(false)
            }
        }, 400)

        return () => clearTimeout(timeout)
    }, [prompt, supplementalText, config, getOpenAIActiveModel])

    // 🔹 Update or insert vendor+model config safely
    const setSelectedModelForAIVendor = (aiVendor: AIVendor, model: string) => {
        if (!aiVendor) return // skip invalid vendor
        setConfig(prevConfigs => {
            const existingIndex = prevConfigs.findIndex(c => c.aiVendor === aiVendor)

            if (existingIndex !== -1) {
                const updated = [...prevConfigs]
                updated[existingIndex] = {
                    ...updated[existingIndex],
                    aiVendor,
                    model: model ?? updated[existingIndex].model ?? '',
                }
                return updated
            }

            // otherwise add new vendor config
            return [
                ...prevConfigs,
                {
                    aiVendor,
                    model: model ?? '',
                },
            ]
        })
    }



    const resetConfig = () => {
        try {
            setConfig([])
        } catch (e) {
            console.error('Failed to reset config:', e)
        }
    }

    return (
        <AIContext.Provider
            value={{
                config,
                activeText: prompt,
                tokenCount,
                isTokenLoading,
                setPrompt,
                setSelectedModelForAIVendor,
                getOpenAIActiveModel,
                resetConfig,
                activeBlockId,
                setActiveBlockId,
                supplementalText,
                setSupplementalText,
            }}
        >
            {children}
        </AIContext.Provider>
    )
}

export const useAI = (): AIContextType => {
    const ctx = useContext(AIContext)
    if (!ctx) {
        // Graceful fallback instead of throwing
        console.warn('useAI must be used within AIProvider — returning fallback.')
        return {
            config: [],
            activeText: '',
            tokenCount: 0,
            isTokenLoading: false,
            setPrompt: () => { },
            setSelectedModelForAIVendor: () => { },
            getOpenAIActiveModel: () => '',
            resetConfig: () => { },
            activeBlockId: '',
            setActiveBlockId: () => { },
            supplementalText: '',
            setSupplementalText: () => { },
        }
    }
    return ctx
}
