import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { AIVendor } from '../constants/vendors'
import { CacheManager } from '../utils/cache'
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
}

const AIContext = createContext<AIContextType | undefined>(undefined)

const aiConfigCache = new CacheManager({
    ttlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    prefix: 'ai_config_',
})

const CONFIG_CACHE_KEY = 'current_config'

export const AIProvider = ({ children }: { children: ReactNode }) => {
    const [config, setConfig] = useState<AIConfig[]>([])
    const [prompt, setPrompt] = useState<string>('')
    const [tokenCount, setTokenCount] = useState<number>(0)
    const [isTokenLoading, setIsTokenLoading] = useState(false)
    const [isHydrated, setIsHydrated] = useState(false)

    // 🔹 Load cached config safely
    useEffect(() => {
        try {
            const cached = aiConfigCache.get<AIConfig[]>(CONFIG_CACHE_KEY)
            if (cached && Array.isArray(cached)) {
                // Normalize and remove invalid entries
                const normalized = cached
                    .filter(c => c?.aiVendor && typeof c.model === 'string')
                    .map(c => ({
                        ...c,
                        aiVendor: c.aiVendor as AIVendor,
                        model: c.model.trim(),
                    }))
                setConfig(normalized)
            }
        } catch (e) {
            console.error('Failed to load config:', e)
        } finally {
            setIsHydrated(true)
        }
    }, [])

    // 🔹 Persist config to cache safely
    useEffect(() => {
        if (!isHydrated) return
        try {
            aiConfigCache.set(CONFIG_CACHE_KEY, config)
        } catch (e) {
            console.error('Failed to save config:', e)
        }
    }, [config, isHydrated])

    // 🔹 Token count auto-update (debounced, safe for missing model)
    useEffect(() => {
        if (!isHydrated) return

        if (!prompt?.trim()) {
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
                const count = await countTokens(prompt, model)
                setTokenCount(count)
            } catch (err) {
                console.error('Token counting failed:', err)
                setTokenCount(0)
            } finally {
                setIsTokenLoading(false)
            }
        }, 400)

        return () => clearTimeout(timeout)
    }, [prompt, config, isHydrated])

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

    // 🔹 Always return OPENAI model (gracefully handles missing)
    const getOpenAIActiveModel = (): string => {
        const openaiConfig = config.find(
            c => c.aiVendor === AIVendor.OPENAI && !!c.model?.trim()
        )

        if (!openaiConfig) {
            // Don't throw — just return empty
            return ''
        }

        return openaiConfig.model
    }

    const resetConfig = () => {
        try {
            setConfig([])
            aiConfigCache.delete(CONFIG_CACHE_KEY)
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
            setPrompt: () => {},
            setSelectedModelForAIVendor: () => {},
            getOpenAIActiveModel: () => '',
            resetConfig: () => {},
        }
    }
    return ctx
}
