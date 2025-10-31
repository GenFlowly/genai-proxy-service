// src/context/AIContext.tsx
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { AIVendor } from '../constants/vendors'
import { CacheManager } from '../utils/cache'
import { countTokens } from '../utils/tokenizer'

export interface AIConfig {
    vendorSelections: Record<AIVendor, string>
    temperature: number
    maxTokens: number
    tone?: string
}

interface AIContextType {
    config: AIConfig
    activeText: string
    tokenCount: number
    isTokenLoading: boolean
    setActiveText: (text: string) => void
    setVendorModel: (vendor: AIVendor, model: string | null) => void
    setTemperature: (temp: number) => void
    setMaxTokens: (max: number) => void
    setTone: (tone: string) => void
    getActiveModel: (vendor?: AIVendor) => string
    resetConfig: () => void
}

const AIContext = createContext<AIContextType | undefined>(undefined)

const defaultVendorSelections: Record<AIVendor, string> = Object.values(AIVendor).reduce(
    (acc, vendor) => {
        acc[vendor as AIVendor] = ''
        return acc
    },
    {} as Record<AIVendor, string>
)

const defaultConfig: AIConfig = {
    vendorSelections: defaultVendorSelections,
    temperature: 0.7,
    maxTokens: 1024,
    tone: 'neutral',
}

const aiConfigCache = new CacheManager({
    ttlMs: 30 * 24 * 60 * 60 * 1000,
    prefix: 'ai_config_',
})

const CONFIG_CACHE_KEY = 'current_config'

export const AIProvider = ({ children }: { children: ReactNode }) => {
    const [config, setConfig] = useState<AIConfig>(defaultConfig)
    const [activeText, setActiveText] = useState<string>('')
    const [tokenCount, setTokenCount] = useState<number>(0)
    const [isTokenLoading, setIsTokenLoading] = useState(false)
    const [isHydrated, setIsHydrated] = useState(false)

    useEffect(() => {
        try {
            const cached = aiConfigCache.get<AIConfig>(CONFIG_CACHE_KEY)
            if (cached) setConfig(cached)
        } catch (e) {
            console.error('Failed to load config:', e)
        } finally {
            setIsHydrated(true)
        }
    }, [])

    useEffect(() => {
        if (!isHydrated) return
        aiConfigCache.set(CONFIG_CACHE_KEY, config)
    }, [config, isHydrated])

    // 🔹 Token count auto-update (debounced)
    useEffect(() => {
        if (!activeText) {
            setTokenCount(0)
            return
        }

        const timeout = setTimeout(async () => {
            setIsTokenLoading(true)
            try {
                const model = getActiveModel()
                const count = await countTokens(activeText, model)
                setTokenCount(count)
            } catch (err) {
                console.error('Token counting failed:', err)
                setTokenCount(0)
            } finally {
                setIsTokenLoading(false)
            }
        }, 400) // debounce typing

        return () => clearTimeout(timeout)
    }, [activeText, config.vendorSelections])

    const setVendorModel = (vendor: AIVendor, model: string | null) => {
        setConfig(prev => ({
            ...prev,
            vendorSelections: { ...prev.vendorSelections, [vendor]: model ?? '' },
        }))
    }

    const setTemperature = (temp: number) => setConfig(prev => ({ ...prev, temperature: temp }))
    const setMaxTokens = (max: number) => setConfig(prev => ({ ...prev, maxTokens: max }))
    const setTone = (tone: string) => setConfig(prev => ({ ...prev, tone }))

    const getActiveModel = (vendor: AIVendor = AIVendor.OPENAI): string =>
        config.vendorSelections[vendor] || 'gpt-4-turbo'

    const resetConfig = () => {
        setConfig(defaultConfig)
        aiConfigCache.delete(CONFIG_CACHE_KEY)
    }

    return (
        <AIContext.Provider
            value={{
                config,
                activeText,
                tokenCount,
                isTokenLoading,
                setActiveText,
                setVendorModel,
                setTemperature,
                setMaxTokens,
                setTone,
                getActiveModel,
                resetConfig,
            }}
        >
            {children}
        </AIContext.Provider>
    )
}

export const useAI = (): AIContextType => {
    const ctx = useContext(AIContext)
    if (!ctx) throw new Error('useAI must be used within AIProvider')
    return ctx
}
