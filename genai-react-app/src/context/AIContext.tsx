import React, { createContext, useContext, useState, ReactNode, useEffect } from 'react'
import { AIVendor } from '../constants/vendors'
import { CacheManager } from '../utils/cache'

/**
 * Base configuration for AI generation — scalable beyond vendor selection.
 */
export interface AIConfig {
    vendorSelections: Record<AIVendor, string> // Vendor → Selected Model
    temperature: number
    maxTokens: number
    tone?: string
}

interface AIContextType {
    config: AIConfig
    setVendorModel: (vendor: AIVendor, model: string | null) => void
    setTemperature: (temp: number) => void
    setMaxTokens: (max: number) => void
    setTone: (tone: string) => void
    resetConfig: () => void
}

const AIContext = createContext<AIContextType | undefined>(undefined)

/**
 * Default initial config — generated dynamically from AIVendor enum.
 */
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

// Initialize cache manager for AI config
const aiConfigCache = new CacheManager({
    ttlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    prefix: 'ai_config_',
})

const CONFIG_CACHE_KEY = 'current_config'

export const AIProvider = ({ children }: { children: ReactNode }) => {
    const [config, setConfig] = useState<AIConfig>(defaultConfig)
    const [isHydrated, setIsHydrated] = useState(false)

    // Load config from cache on mount
    useEffect(() => {
        try {
            const cachedConfig = aiConfigCache.get<AIConfig>(CONFIG_CACHE_KEY)
            if (cachedConfig) {
                setConfig(cachedConfig)
                console.log('Loaded AI config from cache')
            }
        } catch (err) {
            console.error('Failed to load AI config from cache:', err)
        } finally {
            setIsHydrated(true)
        }
    }, [])

    // Save config to cache whenever it changes (after hydration)
    useEffect(() => {
        if (!isHydrated) return

        try {
            aiConfigCache.set(CONFIG_CACHE_KEY, config)
        } catch (err) {
            console.error('Failed to save AI config to cache:', err)
        }
    }, [config, isHydrated])

    const setVendorModel = (vendor: AIVendor, model: string | null) => {
        setConfig(prev => {
            const updatedSelections = { ...prev.vendorSelections }
            if (model) updatedSelections[vendor] = model
            else updatedSelections[vendor] = ''
            return { ...prev, vendorSelections: updatedSelections }
        })
    }

    const setTemperature = (temp: number) => setConfig(prev => ({ ...prev, temperature: temp }))
    const setMaxTokens = (max: number) => setConfig(prev => ({ ...prev, maxTokens: max }))
    const setTone = (tone: string) => setConfig(prev => ({ ...prev, tone }))

    const resetConfig = () => {
        setConfig(defaultConfig)
        aiConfigCache.delete(CONFIG_CACHE_KEY)
    }

    return (
        <AIContext.Provider
            value={{
                config,
                setVendorModel,
                setTemperature,
                setMaxTokens,
                setTone,
                resetConfig,
            }}
        >
            {children}
        </AIContext.Provider>
    )
}

export const useAI = (): AIContextType => {
    const ctx = useContext(AIContext)
    if (!ctx) throw new Error('useAI must be used within an AIProvider')
    return ctx
}